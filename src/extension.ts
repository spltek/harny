import { window, workspace, commands } from "vscode";
import type { ExtensionContext } from "vscode";
import { mkdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent } from "./core/agent/agent";
import { SubAgentRunner } from "./core/agent/subagent";
import { DefaultSystemPromptBuilder } from "./core/agent/system-prompt";
import type { ChatController } from "./core/agent/chat-controller";
import type { ChatHistory } from "./core/history/chat-history";
import type { AgentEvent } from "./core/agent/types";
import { CompositeConfigProvider } from "./core/config/composite-config-provider";
import { HarnyFileConfigProvider } from "./core/config/harny-file-config-provider";
import { MemoryOverrideConfigProvider } from "./core/config/memory-override-config-provider";
import { VscodeConfigProvider } from "./core/config/vscode-config-provider";
import { InMemoryEventBus } from "./core/events/in-memory-event-bus";
import { SqliteSessionStore } from "./core/sessions/sqlite-session-store";
import { SessionManager } from "./core/sessions/session-manager";
import { Compactor, DEFAULT_COMPACTION } from "./core/sessions/compactor";
import { DefaultLlmProviderFactory } from "./core/llm/llm-provider-factory";
import { nodeHttpClient } from "./core/llm/http-client";
import { HttpModelListProvider } from "./core/llm/model-list";
import { ModelsDevCatalog } from "./core/llm/models-dev";
import {
  createDefaultTools,
  NodeCommandRunner,
  nodeFileSystem,
  ToolRegistry,
  VscodeDiagnosticsProvider,
} from "./core/tools";
import { toolDefinitionsForMode } from "./core/tools/mode-policy";
import { SkillRegistry, defaultSkillRoots } from "./core/skills";
import { McpManager } from "./core/mcp";
import { ChatViewProvider } from "./chat/chat-view";
import { SessionRegistry } from "./chat/session-registry";
import { AttachmentService } from "./chat/attachment-service";
import { resolveHome } from "./core/storage/home";
import { FileRunSnapshot } from "./core/agent/run-snapshot";
import { debugLog, infoLog } from "./logger";

/**
 * Harny requires EXACTLY ONE open workspace folder: sessions are grouped in
 * the central home bucket keyed by this root (pi/Cursor style). No folder, or
 * a multi-root workspace => undefined (the panel shows the "open a folder"
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
export async function activate(context: ExtensionContext) {
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

  const runtimeOverrides = new MemoryOverrideConfigProvider();
  const fileConfig = new HarnyFileConfigProvider(() => resolved.home, nodeFileSystem);
  const config = new CompositeConfigProvider(new VscodeConfigProvider(), [fileConfig, runtimeOverrides]);

  const cwd = () => root ?? process.cwd();
  // Agent Skills: discovered from the standard ecosystem dirs (skills.sh / pi /
  // Claude / Cursor …): project `.agents|.claude|.pi/skills`, then the user-level
  // equivalents. Project skills shadow user skills of the same name.
  const skillRoots = (): string[] => defaultSkillRoots(cwd(), homedir());
  const skills = new SkillRegistry(nodeFileSystem, skillRoots);
  const tools = new ToolRegistry(
    createDefaultTools({
      fs: nodeFileSystem,
      runner: new NodeCommandRunner(),
      http: nodeHttpClient,
      diagnostics: new VscodeDiagnosticsProvider(),
      cwd,
      skills,
    }),
  );
  const llmFactory = new DefaultLlmProviderFactory(nodeHttpClient, tools.definitions());
  // MCP servers (Model Context Protocol): connect on activation and register
  // their tools as mcp__<server>__<tool>. Reconnect is driven by the UI save.
  const mcp = new McpManager({
    servers: () => fileConfig.readMcpServers(),
    log: (m) => infoLog(m),
    onToolsChanged: () => {
      tools.removeByPrefix("mcp__");
      tools.add(mcp.getTools());
    },
  });
  void mcp.connect();
  context.subscriptions.push({ dispose: () => mcp.dispose() });
  // The tool list the system prompt advertises follows the chat mode
  // (Analyze advertises the read-only set), so the prompt never mentions
  // tools the model cannot use in the current mode.
  const systemPrompt = new DefaultSystemPromptBuilder(
    (mode) => toolDefinitionsForMode(tools.getAll(), mode),
    cwd,
    () => skills.list(),
  );
  const compactor = new Compactor(llmFactory, () => config.get());

  // Session storage: ONE SQLite database (node:sqlite, built into Node >= 22.5)
  // holding every workspace's sessions (the `folder` column groups them), so the
  // cross-folder manager is a plain query. Requires VS Code 1.101+ (Node 22.5+).
  let db: import("node:sqlite").DatabaseSync;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(join(resolved.home, "sessions.db"));
  } catch (e) {
    infoLog("node:sqlite unavailable:", e);
    void window.showErrorMessage(
      "Harny requires VS Code 1.101 or newer (Node 22.5+): session storage uses the built-in node:sqlite.",
    );
    return;
  }
  let store: SqliteSessionStore;
  try {
    store = new SqliteSessionStore({
      db,
      fs: nodeFileSystem,
      currentFolder: () => root,
      log: (m) => infoLog(m),
    });
  } catch (e) {
    infoLog("session database migration failed:", e);
    void window.showErrorMessage(
      `Harny could not open the sessions database: ${e instanceof Error ? e.message : String(e)}. ` +
        "The database may come from a newer Harny version, or be corrupted.",
    );
    return;
  }
  context.subscriptions.push({ dispose: () => store.close() });
  const sessions = new SessionManager(store);

  const attachments = new AttachmentService(nodeFileSystem, async () => {
    const uris = await window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, title: "Attach files to the chat" });
    return uris?.map((u) => u.fsPath);
  });

  // Mid-run auto-compaction hook, wired once the view provider exists (below):
  // the agent awaits it at every turn boundary so a long run compacts then
  // continues.
  let midRunCompact: ((sessionId: string, signal?: AbortSignal) => Promise<void>) | undefined;
  // Per-session file snapshots for "undo last run" (created in createAgent).
  const snapshots = new Map<string, FileRunSnapshot>();

  const createAgent = (history: ChatHistory, sessionId: string): ChatController => {
    // One sub-agent runner per session: it owns the ephemeral sub-agent
    // histories and cascades Stop to any in-flight sub-agent.
    const subAgents = new SubAgentRunner({ config, llmFactory, tools, cwd, log: (m) => infoLog(`[agent] ${m}`) });
    // One file snapshot per session: lets the user "undo last run".
    const snapshot = new FileRunSnapshot(nodeFileSystem, cwd);
    snapshots.set(sessionId, snapshot);
    return new Agent({
      config,
      llmFactory,
      tools,
      history,
      events: new InMemoryEventBus<AgentEvent>(),
      systemPrompt,
      allowDelegation: true,
      spawnSubAgent: (spec, onEvent, signal, toolCallId, onPreviewPrepared) =>
        subAgents.run(spec, onEvent, signal, toolCallId, onPreviewPrepared),
      onAbort: () => subAgents.abortAll(),
      abortSubAgent: (toolCallId) => subAgents.abort(toolCallId),
      log: (m) => infoLog(`[agent] ${m}`),
      onTurnBoundary: (signal) => midRunCompact?.(sessionId, signal),
      cwd,
      // Per-session identity: stateful tools (TodoWrite) keep separate state.
      ownerId: sessionId,
      snapshot,
    });
  };

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
      currentFolder: () => root,
      configHome: resolved.home,
      // Fallback context window for hosts that don't report it (OpenCode Go).
      modelsDev: new ModelsDevCatalog(nodeHttpClient),
      // Agent Skills: catalog for the Skills card + manual `/skill` activation.
      skills,
      // MCP: status for the MCP card + reconnect after a config save.
      mcp,
      // Full-text search across session messages (SQLite FTS5).
      searchSessions: (query) => store.search(query).map((h) => ({ sessionId: h.sessionId, snippet: h.snippet })),
      // "Undo last run": restore the active session's file snapshot.
      restoreSnapshot: (id) => {
        const s = snapshots.get(id);
        return s?.hasSnapshot() ? s.restore() : undefined;
      },
      // Release the snapshot (and the file contents it holds) when the session
      // is closed/deleted — it would otherwise stay in memory forever.
      forgetSnapshot: (id) => {
        snapshots.delete(id);
      },
      canUndo: (id) => snapshots.get(id)?.hasSnapshot() === true,
    },
  );
  viewProvider.setContext(context);
  midRunCompact = (id) => viewProvider.maybeCompactDuringRun(id);

  // The sessions live in the CENTRAL home bucket keyed by the root: when the
  // open folder set changes, re-derive the single root and rebuild the view
  // (store reads the dir through the closure, so subsequent saves land in the
  // bucket of the new root).
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

  // Live-reload config on file change: a LIGHTWEIGHT refresh, so a typed prompt
  // is not wiped (switching model persists the choice to config.json).
  const reload = () => {
    debugLog("config file changed, refreshing config");
    viewProvider.refreshConfig();
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
