import { window, workspace, commands } from "vscode";
import type { ExtensionContext } from "vscode";
import { mkdirSync, watch, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent } from "./core/agent/agent";
import { resolveLoopGuardOptions } from "./core/agent/loop-guard";
import type { LoopGuardOptions } from "./core/agent/loop-guard";
import type { ContextOverflowEvidence } from "./core/agent/agent";
import { SubAgentRunner } from "./core/agent/subagent";
import { DefaultSystemPromptBuilder } from "./core/agent/system-prompt";
import type { ChatController } from "./core/agent/chat-controller";
import type { ChatHistory } from "./core/history/chat-history";
import type { AgentEvent } from "./core/agent/types";
import { CompositeConfigProvider } from "./core/config/composite-config-provider";
import type { ConfigProvider } from "./core/config/types";
import { HarnyFileConfigProvider } from "./core/config/harny-file-config-provider";
import { VscodeConfigProvider } from "./core/config/vscode-config-provider";
import { InMemoryEventBus } from "./core/events/in-memory-event-bus";
import { SqliteSessionStore } from "./core/sessions/sqlite-session-store";
import { SessionManager } from "./core/sessions/session-manager";
import { Compactor, DEFAULT_COMPACTION } from "./core/sessions/compactor";
import { DefaultLlmProviderFactory } from "./core/llm/llm-provider-factory";
import { DEFAULT_MAX_CONCURRENT_LLM_REQUESTS, Semaphore, limitLlmFactory } from "./core/llm/concurrency";
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
import { mcpPrefix, type ToolScope } from "./core/tools/tool-scope";
import { SkillRegistry, defaultSkillRoots } from "./core/skills";
import { McpManager } from "./core/mcp";
import { ChatViewProvider } from "./chat/chat-view";
import { SessionRegistry } from "./chat/session-registry";
import { MementoPendingOpenStore, PendingOpens } from "./chat/pending-open";
import { WorkspaceRootWatch } from "./chat/workspace-watch";
import { workspaceGoneSendNote } from "./core/agent/workspace-gone";
import { routeNotice } from "./chat/notice-policy";
import { AttachmentService } from "./chat/attachment-service";
import { resolveHome } from "./core/storage/home";
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

  const fileConfig = new HarnyFileConfigProvider(() => resolved.home, nodeFileSystem);
  // The host chain, and NOTHING per session: settings → config file. Session-scoped
  // overrides live in each SessionRuntime (`overrides`), because a shared layer is
  // read by every agent at every turn — see session-registry.ts for what that broke.
  const config = new CompositeConfigProvider(new VscodeConfigProvider(), [fileConfig]);

  const cwd = () => root ?? process.cwd();
  /**
   * Is the folder open in this window TRUSTED (VS Code Workspace Trust)?
   *
   * `false` = Restricted Mode, and it changes what Harny may DO — not whether it is here. The
   * extension declares `capabilities.untrustedWorkspaces: "limited"` (package.json) so the panel
   * stays on screen instead of vanishing (an extension that disappears in Restricted Mode is
   * indistinguishable from a broken one), and every session resolves to Analyze until the folder
   * is trusted: reads, and changes prepared as validated previews. The verdict is read LIVE, so
   * granting trust needs no reload (see the onDidGrantWorkspaceTrust handler below).
   *
   * `!== false` and NOT `=== true`: a host that does not expose Workspace Trust has not told us the
   * folder is dirty, and must not be silently downgraded to read-only.
   */
  const workspaceTrusted = (): boolean => workspace.isTrusted !== false;
  // Agent Skills: discovered from the standard ecosystem dirs (skills.sh / pi /
  // Claude / Cursor …): project `.agents|.claude|.pi/skills`, then the user-level
  // equivalents. Project skills shadow user skills of the same name.
  //
  // The PROJECT roots are workSPACE content — instructions a repo checks in and ships — so in
  // Restricted Mode only the user-level ones are read: trusting the folder is what makes a
  // repo's own skills count. The registry takes a thunk and reads it live, so granting trust is
  // enough; nothing has to be reloaded.
  const skillRoots = (): string[] => defaultSkillRoots(workspaceTrusted() ? cwd() : undefined, homedir());
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
  const llmFactory = limitLlmFactory(
    new DefaultLlmProviderFactory(nodeHttpClient, tools.definitions()),
    // ONE semaphore for the whole extension: sessions AND sub-agents come through
    // this factory, so a dozen open sessions cannot put forty requests in flight.
    new Semaphore(DEFAULT_MAX_CONCURRENT_LLM_REQUESTS),
  );
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
  // The summary's output budget is DERIVED per call (a share of the span it replaces,
  // capped by the session's DECLARED output) and travels with it as `maxReplyTokens`:
  // inheriting the chat turn's max_tokens (hundreds of thousands of tokens on a big model)
  // is what made a summary request oversized — and its failure silent.
  const compactor = new Compactor(llmFactory);

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
    const uris = await window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      title: "Attach files to the chat",
    });
    return uris?.map((u) => u.fsPath);
  });

  // Mid-run auto-compaction hook, wired once the view provider exists (below):
  // the agent awaits it at every turn boundary so a long run compacts then
  // continues.
  let midRunCompact: ((sessionId: string, signal?: AbortSignal) => Promise<void>) | undefined;
  // Context-overflow recovery (agent -> host) and the session's usable budget
  // (host -> agent). Same single assignment point, once the view provider exists.
  let overflowCompact:
    ((sessionId: string, signal?: AbortSignal, evidence?: ContextOverflowEvidence) => Promise<boolean>) | undefined;
  let sessionBudget: ((sessionId: string) => number) | undefined;
  // Overflow recovery for a SUB-AGENT: same routine as the session, applied to the
  // sub-agent's ephemeral history (see ChatViewProvider.compactSubAgentHistory).
  let subAgentOverflow:
    | ((
        history: ChatHistory,
        sessionId: string,
        signal?: AbortSignal,
        evidence?: ContextOverflowEvidence,
      ) => Promise<boolean>)
    | undefined;
  // The session's resolved Loop Guard, for the sub-agents (same source as the agent's).
  let subAgentGuard: ((sessionId: string) => LoopGuardOptions) | undefined;
  // Proactive compaction of a sub-agent's own history at a turn boundary.
  let subAgentTurnBoundary:
    ((history: ChatHistory, sessionId: string, signal?: AbortSignal) => Promise<boolean>) | undefined;

  /**
   * What ONE session may use, read LIVE at every turn (see AgentDeps.toolScope).
   *
   * Two facts meet here: the session's own decision (persisted with it) and the machines's reality
   * (which servers are installed). Names that no longer exist are dropped on READ, so a stale
   * decision can never hide a NEW tool and never resurrect a dead one — and nothing is written
   * here: the reconcile happens when the session is opened, where a write is expected anyway.
   */
  const toolScopeFor = (sessionId: string): ToolScope | undefined => {
    const declared = sessions.summary(sessionId)?.toolScope;
    if (!declared) return undefined;
    const installed = Object.keys(fileConfig.readMcpServers() ?? {});
    return {
      mcp: declared.mcp.filter((name) => installed.includes(name)),
      // Built-ins are filtered against the registry: a tool this build dropped must not linger.
      off: declared.off.filter((name) => tools.getAll().some((t) => t.name === name)),
      // Same rule for the Analyze declarations: they name `mcp__server__tool` entries, so a server
      // that is gone (or a tool it no longer offers) takes its declaration with it.
      analyze: declared.analyze.filter((name) => {
        const server = installed.find((s) => name.startsWith(mcpPrefix(s)));
        return !!server && tools.get(name) !== undefined;
      }),
    };
  };

  /**
   * The ONE precondition of working here: the session's root is configured AND still on disk.
   *
   * The two failing states are NOT the same thing: "no root configured" (0 or 2+ folders, a
   * tool-only context) has nothing to assert and changes no behaviour, while "the root was
   * deleted" is the reason to refuse every tool call and to STOP the run. It is passed to the
   * agent and to every sub-agent, so they cannot drift apart.
   */
  const workspaceReady = (): boolean => !!root && existsSync(root);

  const createAgent = (history: ChatHistory, sessionId: string, sessionConfig: ConfigProvider): ChatController => {
    // The config is BUILT BY THE VIEW for this session (`configFor` below) and derived
    // from its runtime on every read: never shared, never snapshotted, never stored.
    // That is what keeps a tab switch from rewriting the next request of a run.
    // One sub-agent runner per session: it owns the ephemeral sub-agent
    // histories and cascades Stop to any in-flight sub-agent.
    const subAgents = new SubAgentRunner({
      config: sessionConfig,
      llmFactory,
      tools,
      cwd,
      // The same precondition the agent applies: a delegated sub-agent can never write into a
      // folder that is gone either.
      workspaceReady,
      // …and the same TRUST verdict: "write access" is a request, and in Restricted Mode it
      // resolves to Analyze (see Agent.setMode), so delegating cannot launder Build.
      workspaceTrusted,
      // The SAME skills catalog as the orchestrator: a sub-agent activates a skill on
      // its own when the task matches one (progressive disclosure).
      skills: () => skills.list(),
      // A sub-agent inherits the session's scope: a tool switched off must be off for the work it
      // delegates too, or the restriction is cosmetic.
      toolScope: () => toolScopeFor(sessionId),
      log: (m) => infoLog(`[agent] ${m}`),
      // Sub-agents run on THIS session's model, so they size their own masking and
      // tool-output caps on the same window (see SubAgentRunnerDeps.contextBudget).
      contextBudget: () => sessionBudget?.(sessionId) ?? 0,
      // …and this session's Loop Guard, resolved in ONE place for the agent and the
      // sub-agents alike (a guard tuned for a flaky model must protect both).
      loopGuard: () => subAgentGuard?.(sessionId) ?? resolveLoopGuardOptions(undefined, undefined),
      // …and an overflow inside a sub-agent is recovered the SAME way: the host
      // compacts the sub-agent's own history with the session's strategy.
      onContextOverflow: (history, signal, evidence) =>
        subAgentOverflow?.(history, sessionId, signal, evidence) ?? Promise.resolve(false),
      // Free room at every turn boundary, like the session does (see deps.onTurnBoundary).
      onTurnBoundary: (history, signal) => subAgentTurnBoundary?.(history, sessionId, signal),
    });
    return new Agent({
      config: sessionConfig,
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
      // The provider rejected a request as too big: compact and let the turn retry.
      onContextOverflow: (signal, evidence) => overflowCompact?.(sessionId, signal, evidence) ?? false,
      // The USABLE context of this session: the agent sizes its masking and its
      // own overflow check against it, without knowing which model it serves.
      contextBudget: () => sessionBudget?.(sessionId) ?? 0,
      cwd,
      // The root is the ground every tool stands on: when it is gone the agent runs NO tool
      // (see runOne) and the watcher below STOPS the run, sub-agents included.
      workspaceReady,
      // Build is a promise to write and to run; in an untrusted folder it resolves to Analyze
      // (see Agent.setMode). Passed in so no caller can talk itself into Build.
      workspaceTrusted,
      // Which tools THIS session may use (MCP servers on, built-ins off): read per turn, so a
      // toggle takes effect on the next one. Sub-agents inherit it (see SubAgentRunnerDeps).
      toolScope: () => toolScopeFor(sessionId),
      // Per-session identity: stateful tools (TodoWrite) keep separate state.
      ownerId: sessionId,
    });
  };

  // The registry asks the VIEW for each session's config, lazily: the view owns the
  // derivation (runtime + provider entry), the registry only wires it into the agent.
  const registry: SessionRegistry = new SessionRegistry({
    sessions,
    store,
    createAgent,
    configFor: (id) => viewProvider.sessionConfigFor(id),
  });

  // A gesture that a folder change interrupts ("open THAT session", "start a new one")
  // leaves a marker in `globalState`, the only store that survives the reload.
  const pendingOpens = new PendingOpens(new MementoPendingOpenStore(context.globalState));
  const viewProvider = new ChatViewProvider(
    config,
    attachments,
    fileConfig,
    new HttpModelListProvider(nodeHttpClient),
    sessions,
    registry,
    {
      compactor,
      compaction: DEFAULT_COMPACTION,
      // A folder that no longer exists on disk is NOT a workspace: the panel would look
      // healthy while every tool fails with ENOENT. Losing it turns this into "no usable
      // folder", i.e. the home screen — which already speaks the language of picking one
      // ("Open folder…", red rows, "Change folder…").
      workspaceReady: () => !!root && existsSync(root),
      workspaceFolderCount: () => workspace.workspaceFolders?.length ?? 0,
      // Restricted Mode: the panel stays, the WRITES do not (see workspaceTrusted above).
      workspaceTrusted,
      currentFolder: () => root,
      pending: pendingOpens,
      configHome: resolved.home,
      // Fallback context window for hosts that don't report it (OpenCode Go).
      modelsDev: new ModelsDevCatalog(nodeHttpClient),
      // Agent Skills: catalog for the Skills card + manual `/skill` activation.
      skills,
      // MCP: status for the MCP card + reconnect after a config save.
      mcp,
      // Full-text search across session messages (SQLite FTS5).
      searchSessions: (query) => store.search(query).map((h) => ({ sessionId: h.sessionId, snippet: h.snippet })),
    },
  );
  viewProvider.setContext(context);
  midRunCompact = (id) => viewProvider.maybeCompactDuringRun(id);
  overflowCompact = (id, signal, evidence) => viewProvider.compactForOverflow(id, signal, evidence);
  sessionBudget = (id) => viewProvider.usableBudgetFor(id);
  subAgentOverflow = (history, id, signal, evidence) =>
    viewProvider.compactSubAgentHistory(history, id, signal, evidence);
  subAgentGuard = (id) => viewProvider.loopGuardOptionsFor(id);
  subAgentTurnBoundary = (history, id, signal) => viewProvider.maybeCompactSubAgentHistory(history, id, signal);

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

  // Trust granted while the panel sits still: nothing else would notice, and the panel is showing
  // read-only because of a decision the user has just reversed. Everything follows from the live
  // verdict (the mode, the Build choice, the skills catalog), so a rebuild is the whole update —
  // and a session that had Build saved gets it back without another click.
  context.subscriptions.push(
    workspace.onDidGrantWorkspaceTrust(() => {
      infoLog("workspace trust granted: Restricted Mode off");
      viewProvider.refresh();
    }),
  );

  context.subscriptions.push(
    window.registerWebviewViewProvider("harny.chatView", viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // The provider outlives the panel: its telemetry probe and coalescing timers must
    // stop with the extension (see ChatViewProvider.dispose).
    { dispose: () => viewProvider.dispose() },
  );

  // This host may exist BECAUSE of a click in the panel (a folder change reloads us):
  // finish that gesture instead of showing a home screen that forgot it. `take` answers
  // only for the folder that has just loaded, and clears the marker either way, so it can
  // never fire in another workspace nor twice.
  void pendingOpens.take(root).then((action) => {
    if (!action) return;
    if (action.kind === "session") viewProvider.resumeSession(action.sessionId);
    else viewProvider.runWhenReady(() => void viewProvider.createNew());
  });

  // Nothing else would notice the folder being DELETED while the panel sits still: every
  // other path is reactive (a click, a config change, the end of a run). One stat every few
  // seconds turns "your workspace is gone" into a screen instead of an ENOENT minutes later.
  const rootWatch = new WorkspaceRootWatch({
    root: () => root,
    exists: existsSync,
    onChange: (lostRoot, existsNow) => {
      infoLog(`workspace root ${existsNow ? "is back" : "disappeared"}:`, lostRoot);
      if (!existsNow) {
        // 1) STOP everything first (the abort cascades to the sub-agents and leaves the reason
        //    in each transcript), so what follows cannot interrupt anything.
        void viewProvider.stopAllForLostRoot(lostRoot);
        // 2) ONE surface, chosen by the notice table (see chat/notice-policy.ts): ask when a
        //    dialog can be seen AND there is something to ask about, toast when the panel is
        //    not on screen (a dialog cannot exist there), stay silent when the panel's own
        //    home already says it and offers the picker.
        const action = routeNotice("workspace-gone", {
          panelVisible: viewProvider.panelVisible(),
          sessionOpen: viewProvider.hasActiveSession(),
        });
        if (action === "ask") {
          void viewProvider.warnLostFolder();
        } else if (action === "toast") {
          void window.showWarningMessage(workspaceGoneSendNote(lostRoot), "Change folder…").then((answer) => {
            if (answer) void viewProvider.openWorkspace();
          });
        }
      }
      viewProvider.refresh();
    },
  });
  rootWatch.start();
  context.subscriptions.push({ dispose: () => rootWatch.stop() });

  // Find in the chat, bound to ⌘F/Ctrl+F while THIS view has the focus (package.json). The
  // webview cannot win that chord on its own: inside a webview the key also reaches VS Code's
  // own find, which opens its widget and takes the focus away from the panel.
  context.subscriptions.push(commands.registerCommand("harny.findInChat", () => viewProvider.openFind()));

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
