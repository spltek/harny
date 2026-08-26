import { window, workspace, commands } from "vscode";
import type { ExtensionContext } from "vscode";
import { mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { Agent } from "./core/agent/agent";
import { DefaultSystemPromptBuilder } from "./core/agent/system-prompt";
import type { ChatController } from "./core/agent/chat-controller";
import type { ChatHistory } from "./core/history/chat-history";
import type { AgentEvent } from "./core/agent/types";
import { CompositeConfigProvider } from "./core/config/composite-config-provider";
import { HarnyFileConfigProvider } from "./core/config/harny-file-config-provider";
import { MemoryOverrideConfigProvider } from "./core/config/memory-override-config-provider";
import { VscodeConfigProvider } from "./core/config/vscode-config-provider";
import { InMemoryEventBus } from "./core/events/in-memory-event-bus";
import { JsonlSessionStore } from "./core/sessions/jsonl-session-store";
import { SessionManager } from "./core/sessions/session-manager";
import { Compactor, DEFAULT_COMPACTION } from "./core/sessions/compactor";
import { DefaultLlmProviderFactory } from "./core/llm/llm-provider-factory";
import { nodeHttpClient } from "./core/llm/http-client";
import { HttpModelListProvider } from "./core/llm/model-list";
import {
  createDefaultTools,
  NodeCommandRunner,
  nodeFileSystem,
  ToolRegistry,
  VscodeDiagnosticsProvider,
} from "./core/tools";
import { ChatViewProvider } from "./chat/chat-view";
import { SessionRegistry } from "./chat/session-registry";
import { AttachmentService } from "./chat/attachment-service";
import { resolveHome, sessionsDirFor, SESSIONS_DIR_NAME } from "./core/storage/home";
import { ensureSessionGitignore } from "./core/storage/workspace-gitignore";
import { debugLog, infoLog } from "./logger";

/**
 * Harny requires EXACTLY ONE open workspace folder: sessions live in
 * `<root>/.harny-sessions` (they follow the folder). No folder, or a
 * multi-root workspace => undefined (the panel shows the "open a folder"
 * shell and session-creating commands are guarded).
 */
function singleWorkspaceRoot(): string | undefined {
  const folders = workspace.workspaceFolders;
  return folders?.length === 1 ? folders[0].uri.fsPath : undefined;
}

/**
 * Composition root. One agent = one session: the SessionRegistry keeps a
 * dedicated Agent (fresh history + event bus) per open session; a single
 * right-side view shows the sessions list + tabs and routes to the active one.
 */
export function activate(context: ExtensionContext) {
  debugLog("activate called");

  let root = singleWorkspaceRoot();
  infoLog("activate: root=", root ?? "<none>");

  const resolved = resolveHome({
    globalStorageFsPath: context.globalStorageUri.fsPath,
    env: process.env,
  });
  try {
    mkdirSync(resolved.home, { recursive: true });
  } catch (e) {
    debugLog("could not create storage home", e);
  }
  infoLog("storage home=", resolved.home);

  // The sessions folder is created LAZILY by the store on the FIRST session
  // creation (`<root>/.harny-sessions`); opening Harny never writes to the
  // workspace. Only the .gitignore entry is ensured up-front (a text append,
  // harmless before the folder exists — keeps transcripts out of git).
  const sessionsDir = (): string | undefined => (root ? sessionsDirFor(root) : undefined);
  if (root) {
    try {
      if (ensureSessionGitignore(root, nodeFileSystem)) infoLog("added", SESSIONS_DIR_NAME, "to", join(root, ".gitignore"));
    } catch (e) {
      debugLog("could not update .gitignore", e);
    }
  }

  const runtimeOverrides = new MemoryOverrideConfigProvider();
  const fileConfig = new HarnyFileConfigProvider(() => resolved.home, nodeFileSystem);
  const config = new CompositeConfigProvider(new VscodeConfigProvider(), [fileConfig, runtimeOverrides]);

  const cwd = () => root ?? process.cwd();
  const tools = new ToolRegistry(
    createDefaultTools({
      fs: nodeFileSystem,
      runner: new NodeCommandRunner(),
      http: nodeHttpClient,
      diagnostics: new VscodeDiagnosticsProvider(),
      cwd,
    }),
  );
  const llmFactory = new DefaultLlmProviderFactory(nodeHttpClient, tools.definitions());
  const systemPrompt = new DefaultSystemPromptBuilder(() => tools.definitions(), cwd);
  const compactor = new Compactor(llmFactory, () => config.get());

  const store = new JsonlSessionStore(() => sessionsDir() ?? "", nodeFileSystem);
  const sessions = new SessionManager(store);

  const attachments = new AttachmentService(nodeFileSystem, async () => {
    const uris = await window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, title: "Attach files to the chat" });
    return uris?.map((u) => u.fsPath);
  });

  const createAgent = (history: ChatHistory): ChatController =>
    new Agent({
      config,
      llmFactory,
      tools,
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt,
    });

  const registry = new SessionRegistry({ sessions, store, createAgent });

  const viewProvider = new ChatViewProvider(
    config,
    runtimeOverrides,
    attachments,
    fileConfig,
    new HttpModelListProvider(nodeHttpClient),
    sessions,
    registry,
    {
      compactor,
      compaction: DEFAULT_COMPACTION,
      workspaceReady: () => !!root,
      configHome: resolved.home,
    },
  );
  viewProvider.setContext(context);

  // The sessions live in `<root>/.harny-sessions`: when the open folder set
  // changes, re-derive the single root and rebuild the view (store reads the
  // dir through the closure, so subsequent saves land in the new root).
  context.subscriptions.push(
    workspace.onDidChangeWorkspaceFolders(() => {
      const next = singleWorkspaceRoot();
      if (next !== root) {
        root = next;
        infoLog("workspace folders changed: root=", root ?? "<none>");
        viewProvider.refresh();
      }
    }),
  );

  context.subscriptions.push(
    window.registerWebviewViewProvider("harny.chatView", viewProvider, { webviewOptions: { retainContextWhenHidden: true } }),
  );

  // Reveals the secondary side bar on the RIGHT and focuses the Harny view.
  async function revealViewInRight(): Promise<void> {
    // Opens the right-side Secondary Side Bar if closed, then focuses the view.
    await commands.executeCommand("workbench.action.focusAuxiliaryBar");
    await commands.executeCommand("harny.chatView.focus");
  }

  context.subscriptions.push(
    commands.registerCommand("harny.openChat", () => {
      void revealViewInRight();
      void viewProvider.createNew();
    }),
    commands.registerCommand("harny.newSession", () => {
      void revealViewInRight();
      void viewProvider.createNew();
    }),
  );

  context.subscriptions.push(
    commands.registerCommand("harny.reloadConfig", () => {
      debugLog("manual reload config command");
      viewProvider.refresh();
    }),
    commands.registerCommand("harny.debugConfig", () => {
      const cfg = config.get();
      window.showInformationMessage(
        `Harny config:\nprovider=${cfg.provider}\nactiveProvider=${cfg.activeProvider}\nmodel=${cfg.model}\nbaseUrl=${cfg.baseUrl}\n` +
          `availableModels (${(cfg.availableModels ?? []).length})\n` +
          `providerModels (${(cfg.providerModels ?? []).length})\n` +
          `hostModelProviders (${(cfg.hostModelProviders ?? []).length})`,
        { modal: false },
      );
    }),
  );

  // Live-reload config on file change.
  const reload = () => {
    debugLog("config file changed, refreshing");
    viewProvider.refresh();
  };
  let reloadTimer: NodeJS.Timeout | undefined;
  try {
    const watcher = watch(resolved.home, (_event, filename) => {
      if (!filename || !/^config\.(json|jsonc)$/.test(filename)) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(reload, 200);
    });
    watcher.on("error", (e) => debugLog("config watcher error:", e.message));
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch (e) {
    debugLog("could not watch", resolved.home, e);
  }

  // Auto-open the view (right side) if configured.
  if (config.get().autoOpen) {
    void revealViewInRight();
  }

  return sessions;
}

export function deactivate(): void {
  /* noop */
}
