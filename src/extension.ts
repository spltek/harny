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
import { resolveHome } from "./core/storage/home";
import { debugLog, infoLog } from "./logger";

/**
 * Composition root. One agent = one session: the SessionRegistry keeps a
 * dedicated Agent (fresh history + event bus) per open session; a single
 * right-side view shows the sessions list + tabs and routes to the active one.
 */
export function activate(context: ExtensionContext) {
  debugLog("activate called");

  const cwd = () => workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  infoLog("activate: cwd=", cwd());

  const resolved = resolveHome({
    globalStorageFsPath: context.globalStorageUri.fsPath,
    workspaceCwd: cwd(),
    env: process.env,
  });
  try {
    mkdirSync(resolved.home, { recursive: true });
    mkdirSync(resolved.sessionsDir, { recursive: true });
  } catch (e) {
    debugLog("could not create storage dirs", e);
  }
  infoLog("storage home=", resolved.home, "| sessions=", resolved.sessionsDir);

  const runtimeOverrides = new MemoryOverrideConfigProvider();
  const fileConfig = new HarnyFileConfigProvider(() => resolved.home, nodeFileSystem);
  const config = new CompositeConfigProvider(new VscodeConfigProvider(), [fileConfig, runtimeOverrides]);

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

  const store = new JsonlSessionStore(() => resolved.sessionsDir, nodeFileSystem, { cwd: cwd() });
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
    },
  );
  viewProvider.setContext(context);

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

  function selectedText(): string | undefined {
    const editor = window.activeTextEditor;
    if (!editor) return undefined;
    const s = editor.selection;
    const text = s.isEmpty ? editor.document.getText() : editor.document.getText(s);
    return text.trim() ? text : undefined;
  }

  context.subscriptions.push(
    commands.registerCommand("harny.explainCode", () => {
      const text = selectedText();
      if (!text) return;
      void revealViewInRight();
      void viewProvider.createWithMessage(`Explain this code:\n\`\`\`\n${text}\n\`\`\``);
    }),
    commands.registerCommand("harny.editCode", () => {
      const text = selectedText();
      if (!text) return;
      void revealViewInRight();
      void viewProvider.createWithMessage(`Edit/improve this code:\n\`\`\`\n${text}\n\`\`\``);
    }),
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
