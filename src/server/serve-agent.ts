/**
 * Heavy agent assembly for `rivet serve` ? loaded via dynamic import after the
 * HTTP listener is up (or on first session), so /health cold-start does not pay
 * for AgentLoop / tools / Meridian / council / MCP SDK graph.
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDelegationActivityMapper } from '../tools/worker-activity-stream.js'
import type { DelegateWorkerInput, DelegateActivityUpdate, ManagedAgent, RuntimeSessionManager } from './session-manager.js'
import { SessionPersist, getSessionDir } from '../agent/session-persist.js'
import { restoreGoalTracker } from '../agent/goal-persist.js'
import { FileHistory } from '../agent/file-history.js'
import { loadProjectRules } from '../context/rules-loader.js'
import { createDefaultToolRegistry } from '../tools/default-registry.js'
import { AgentLoop } from '../agent/loop.js'
import type { ApprovalMode } from '../agent/loop-types.js'
import { SessionContext } from '../agent/context.js'
import type { SessionRegistry } from '../agent/session-registry.js'
import { createTaskLedger } from '../agent/task-ledger.js'
import { createOwnershipLedger } from '../agent/ownership-ledger.js'
import { createWorktreeBaseline } from '../agent/worktree-baseline.js'
import { captureGitBaseline, createInteractiveToolRegistry, createAgentRuntime, type RuntimeRefs } from '../bootstrap.js'
import { TodoStore } from '../tools/todo-store.js'
import { applyConfiguredPathGrants, applyDefaultDependencyReadGrants, applyRivetRuntimeReadGrants, loadPersistedGrants } from '../tools/path-grants.js'
import { loadProjectSkills } from '../skills/skill-loader.js'
import { createMemoryTool } from '../tools/memory.js'
import { DomainKnowledgeStore } from '../agent/domain-knowledge-store.js'
import type { ProviderHealthTracker } from '../agent/provider-health.js'
import { MeridianIndexer } from '../repo/meridian-indexer.js'
import { scheduleMeridianBackfill } from '../repo/meridian-backfill.js'
import { resetLegacyMemoryIfNeeded } from '../agent/memory-epoch.js'
import { buildCockpitSnapshot } from '../tui/cockpit/state.js'
import { computeUsageCost, findModelPricing } from '../utils/pricing.js'
import { createMultiLspManager } from '../lsp/multi-manager.js'
import type { LspManager } from '../lsp/manager.js'
import { createGotoDefinitionTool, createFindReferencesTool } from '../lsp/tools.js'
import { runCouncil, runCouncilDebate, type CouncilInput } from '../agent/council/council-orchestrator.js'
import type { CouncilSeat } from '../agent/council/council-routing.js'
import { renderCouncilPlan, summarizeCouncilPlan } from '../agent/council/council-render.js'
import { DEFAULT_COUNCIL_SEATS } from '../agent/council/council-routing.js'
import { compileCouncilPlan } from '../agent/council/council-to-plan.js'
import { sealPlan } from '../agent/council/council-seal.js'
import { extractObligations, attachObligations } from '../agent/council/council-obligations.js'
import { serializeUnifiedPlan, deserializeUnifiedPlan, type UnifiedPlan } from '../agent/unified-plan.js'
import { buildCouncilSessionEvent, recordCouncilSession } from '../agent/council/council-telemetry.js'
import { persistCouncilRoutingShadow } from '../agent/council/council-routing.js'
import type { PlanItem } from '../agent/council/council-plan.js'
import type { CouncilPanelModel } from '../tui/council-panel-model.js'
import type { McpManager } from '../mcp/manager.js'
import { findProjectConfig } from '../config/manager.js'
import type { Config } from '../config/schema.js'
import { readFileSync } from 'node:fs'
import {
  type ServeContext,
  type ResolvedModelSpec,
  type HistoryRestoreInfo,
  resolveServeContext,
  resolveModelSpec,
  resolveModelSpecWithReload,
  isModelSpecUsable,
  unconfiguredSpecMessage,
  restoreHistoryMessages,
  buildDelegateSummary,
} from './serve.js'

export interface BuiltAgent {
  agent: AgentLoop
  sessionId: string
}

/**
 * Wave J: sidecar ??????????? session + switchModel ?????
 * createAgentRuntime per-call new ???????`runServe` ???????
 * ????? buildManagedAgent / assembleAgentLoop?
 *
 * ???????
 * - providerHealth: ???????? session ?? provider ????
 *   ?registerProvider ???????????
 * - domainStores: cwd-keyed ???? cwd ? session ??????????
 *   DomainKnowledgeStore????? load + ? session lessons ???
 * - sameCwdRunningCount: late-bound (Wave F)??RuntimeSessionManager ???
 *   ???? verificationSnapshotManager ?? session worktree ?????
 *   ????? () => 0 ???TUI ? session ???????sidecar ???????
 *
 * ?????bandit gates evaluation ??????? switchModel ????
 */
export interface SharedRuntime {
  providerHealth: ProviderHealthTracker
  // per-cwd ????? Map<string, X> ????? domainStores????????
  domainStores: Map<string, DomainKnowledgeStore>
  /** per-cwd MeridianIndexer??SQLite ????? cwd ? session ???????? */
  meridianIndexers: Map<string, MeridianIndexer>
  /** per-cwd LSP ????????????????? spawn ??????
   *  entry.ready ? initialize() ??? Promise?true=???? server ????
   *  ?? assembleAgentLoop ????? .then ????? agent?switchModel ???? */
  lspManagers: Map<string, { manager: LspManager; ready: Promise<boolean> }>
  /** late-bound: ? sessions = new RuntimeSessionManager(...) ??? runServe
   *  ????? null ???? 0?sessions ??????????? */
  sameCwdRunningCount: ((cwd: string, excludeSessionId?: string) => number) | null
  /** Server-level MCP manager ? one connection pool for all sessions. */
  mcpManager: McpManager | null
  /** I4: late-bound RuntimeSessionManager so hooks can emit `hook_result` events. */
  sessions: RuntimeSessionManager | null
}

/** sidecar ???? cwd ?/? DomainKnowledgeStore?? session ??????? */
function getOrCreateDomainStore(shared: SharedRuntime, cwd: string): DomainKnowledgeStore {
  const existing = shared.domainStores.get(cwd)
  if (existing) return existing
  const store = new DomainKnowledgeStore(join(cwd, '.rivet', 'knowledge'))
  shared.domainStores.set(cwd, store)
  return store
}

/** ? cwd ?/? MeridianIndexer??? getOrCreateDomainStore??SQLite ????
 *  ? cwd ? session ???????runServe close() ?????exported for tests. */
export function getOrCreateMeridianIndexer(shared: SharedRuntime, cwd: string): MeridianIndexer {
  const existing = shared.meridianIndexers.get(cwd)
  if (existing) return existing
  const indexer = new MeridianIndexer(cwd)
  // Memory epoch reset??? TUI bootstrapInteractiveSession????????
  // ????? cwd ??????????????? memory-epoch.ts?
  try {
    resetLegacyMemoryIfNeeded(cwd, {
      clearMistakeEntries: () => indexer.getDb().clearMistakeEntries(),
    })
  } catch { /* ?????????? */ }
  shared.meridianIndexers.set(cwd, indexer)
  // ??????????? CLI bootstrap???? cwd ???????????????
  setImmediate(() => { scheduleMeridianBackfill(indexer, cwd) })
  return indexer
}

/** ? cwd ?/? LSP manager entry?????? cwd ????? initialize()
 *  ????????????????????? entry?ready resolve ?
 *  isReady()??false ??? cwd ?????????????????? */
function getOrCreateLspEntry(
  shared: SharedRuntime,
  cwd: string,
): { manager: LspManager; ready: Promise<boolean> } {
  const existing = shared.lspManagers.get(cwd)
  if (existing) return existing
  const manager = createMultiLspManager(cwd)
  const ready = manager
    .initialize()
    .then(() => manager.isReady())
    .catch(() => false)
  const entry = { manager, ready }
  shared.lspManagers.set(cwd, entry)
  return entry
}

/** Wave G: LSP late-init ???? TUI bootstrap.ts initializeLsp ? .then ????
 *  ?????switchModel ??????? assembleAgentLoop ?????????
 *  ???? agent?Promise ? resolve ??????????? switchModel
 *  ??? agent ???? updateTools()??? register ???ToolRegistry.register
 *  ? Map.set ??????? agent ?????????????????
 *  exported for tests??? mock entry???? spawn ??????? */
export function attachLspTools(
  entry: { manager: LspManager; ready: Promise<boolean> },
  toolRegistry: Pick<ReturnType<typeof createDefaultToolRegistry>, 'register'>,
  refs: Pick<RuntimeRefs, 'lspManager'>,
  updateTools: () => void,
): Promise<void> {
  return entry.ready.then((ok) => {
    if (!ok) return
    toolRegistry.register(createGotoDefinitionTool(entry.manager))
    toolRegistry.register(createFindReferencesTool(entry.manager))
    refs.lspManager = entry.manager
    updateTools()
  })
}

/** Wave G: ?? per-cwd ?????runServe close()?????? try-catch
 *  ????????MeridianDb.close ?????LspManager.dispose ???
 *  best-effort??exported for tests. */
export function disposeSharedCwdResources(shared: SharedRuntime): void {
  for (const indexer of shared.meridianIndexers.values()) {
    try { indexer.close() } catch { /* best-effort */ }
  }
  shared.meridianIndexers.clear()
  for (const entry of shared.lspManagers.values()) {
    try { entry.manager.dispose() } catch { /* best-effort */ }
  }
  shared.lspManagers.clear()
}

/**
 * Per-session, model-independent pieces. Built once and reused across model
 * rebuilds so switchModel preserves conversation (same SessionContext) and
 * shared stores (claims/file-history/playbook/tools/ledgers).
 */
interface SessionStores {
  persist: SessionPersist
  claimStore: ReturnType<SessionPersist['createClaimStore']>
  fileHistory: FileHistory
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>
  session: SessionContext
  taskLedger: ReturnType<typeof createTaskLedger>
  ownershipLedger: ReturnType<typeof createOwnershipLedger>
  /** Outcome of the boot-time history restore ? lets the session layer warn
   *  when the UI shows history but the model context came back empty. */
  historyRestore: HistoryRestoreInfo
  /** RuntimeRefs ? createInteractiveToolRegistry ???????????
   *  Wave C: assembleAgentLoop ?? createAgentRuntime ?? coordinator ?
   *  ?? refs.coordinator?? 5 ? coordinator ??????? */
  refs: RuntimeRefs
}

/**
 * Per-session SessionStores registry, keyed by sessionId. Used by
 * resolveGoalHandles (below) so the session-manager can reach the
 * RuntimeRefs.goalTrackerRef + sessionDir for goal mode wiring ? without
 * exposing the full stores surface or coupling the generic manager to the
 * serve-agent module.
 *
 * Entries are written in buildManagedAgent and overwritten on rebuild
 * (switchModel rebuilds stores' agent half on the SAME stores instance).
 * Forgetting is best-effort: a stale entry holds a modest object; rebuild
 * overwrites it. Call forgetSessionStores when a session is permanently
 * destroyed to bound memory.
 */
const sessionStoresById = new Map<string, { stores: SessionStores; cwd: string }>()

/** Late-bound goal handles for the session-manager's goal methods. Returns
 *  undefined when no stores have been built for this session yet (idle /
 *  rehydrated session whose agent hasn't been created).
 *
 *  ??`allProviders` ??? `config.provider.providers` ?????
 *  `maybeAutoTitle` / `extractCriteria` ? `!handles.allProviders` ????
 *  ?????? sidecar ?????????????????????
 *  commit `9835c856`??TUI ??? `main.ts:366` ????????? */
export function resolveGoalHandles(
  sessionId: string,
  config: {
    workers?: { profiles?: { cheap?: { provider: string; model: string } } }
    provider?: { providers?: Record<string, unknown> }
  } | undefined,
): import('./session-manager.js').GoalHandles | undefined {
  const entry = sessionStoresById.get(sessionId)
  if (!entry) return undefined
  return {
    goalTrackerRef: entry.stores.refs.goalTrackerRef,
    sessionDir: getSessionDir(entry.cwd),
    ...(config?.workers?.profiles?.cheap ? { cheapProfile: config.workers.profiles.cheap } : {}),
    ...(config?.provider?.providers ? { allProviders: config.provider.providers } : {}),
  }
}

/** Drop the stores entry for a permanently-destroyed session (memory bound). */
export function forgetSessionStores(sessionId: string): void {
  sessionStoresById.delete(sessionId)
}

/** Late-bound review-gate ref for the session-manager's getReviewGate /
 *  setReviewGate. Undefined when no stores exist yet (idle / rehydrated
 *  session whose agent hasn't been built) ? the manager's session override
 *  still applies once stores are built (applySelections re-push). */
export function resolveReviewGateRef(sessionId: string): { current: 'auto' | 'off' } | undefined {
  return sessionStoresById.get(sessionId)?.stores.refs.reviewGateRef
}

function buildSessionStores(
  ctx: ServeContext,
  cwd: string,
  sessionId: string,
  registry?: SessionRegistry,
  shared?: SharedRuntime,
): SessionStores {
  const persist = new SessionPersist(sessionId, cwd)
  const claimStore = persist.createClaimStore()
  persist.injectDurableClaims(claimStore, cwd)
  for (const rule of loadProjectRules(cwd)) claimStore.propose(rule)
  // Path grants: hydrate the "remember"-persisted grants for this workspace and
  // apply standing config-declared grants (additionalReadDirs/WriteDirs). The
  // TUI does this in bootstrapInteractiveSession; without the mirror here,
  // desktop sessions silently lose every remembered/configured authorization
  // and re-block out-of-workspace paths (a major Windows papercut when the
  // project lives outside the opened folder).
  loadPersistedGrants(cwd)
  applyConfiguredPathGrants(ctx.config.agent.permissions)
  applyDefaultDependencyReadGrants()
  applyRivetRuntimeReadGrants()
  // Load skills into the shared registry (same as CLI bootstrap). Without this,
  // skillRegistry.list() returns empty and the desktop PlusMenu shows no skills.
  loadProjectSkills(cwd, { importFromClaude: ctx.config.skills?.importFromClaude })
  const fileHistory = new FileHistory(persist.getBackupDir(), sessionId)
  const session = new SessionContext()
  // Restore prior conversation from disk (sidecar restart recovery).
  // Matches TUI bootstrap.ts:1461 ? loadOai returns [] for new sessions.
  const historyRestore = restoreHistoryMessages(persist, session)

  // sidecar ???????? bootstrap ? createInteractiveToolRegistry?? TUI ?
  // ????????Wave C ??????? coordinator ????????
  // refs ????? coordinator?assembleAgentLoop ?? createAgentRuntime
  // ?? coordinator ??? refs.coordinator???????
  const refs: RuntimeRefs = {
    coordinator: null,
    fileHistory,
    claimStore,
    sessionId,
    sessionRegistry: registry ?? null,
    taskLedger: null,
    ownershipLedger: null,
    verificationSnapshotManager: null,
    deliveryGate: null,
    // Wave G: per-cwd ?? Meridian??repo_graph/related_tests ??? refs?
    // ?? createInteractiveToolRegistry ???????????legacy /prompt
    // ???? shared??? null?
    meridianIndexer: shared ? getOrCreateMeridianIndexer(shared, cwd) : null,
    // ??????sidecar ???????????? MCP ? SharedRuntime??
    // ??? refs ??? null ????????
    mcpManager: shared?.mcpManager ?? null,
    // Wave G: LSP ??? init??assembleAgentLoop ? entry.ready ????
    lspManager: null,
    banditState: null,
    promptEngine: null,
    // Wave F: ?? SharedRuntime ? RuntimeSessionManager.sameCwdRunningCount
    // ???????shared ??? manager ?????? 0??? TUI ??????
    getSameCwdRunningSessions: shared
      ? () => shared.sameCwdRunningCount?.(cwd, sessionId) ?? 0
      : undefined,
    goalTrackerRef: { current: null },
    // ???????buildAgentLoop ?? store?SharedRuntime.domainStores ???
    // ?????galaxy ?????????
    domainKnowledgeStoreRef: { current: null },
    obligationTrackerRef: { current: null },
    // ????????????? review.skipAuto ?????sidecar ? /review off
    // ???????????????? Settings ????????????
    reviewGateRef: { current: ctx.config.agent.review.skipAuto ? 'off' : 'auto' },
    // ?? hooks/commands?sidecar ???????TUI bootstrap ???????
    // ?????? RuntimeRefs ?????????????????????
    pluginHooks: [],
    pluginCommands: [],
    // ?????????????? TodoStore?????????????????????
    // ?????????????????????????????
    todoStore: new TodoStore(),
  }
  // Goal mode restore ? recover an in-flight goal across sidecar restarts.
  // restoreGoalTracker internally normalizes active?paused (safe downgrade)
  // so a restarted sidecar never auto-resumes a goal without user opt-in.
  // Aligns with the TUI bootstrap path (bootstrap.ts:1739-1745).
  const sessionDir = getSessionDir(cwd)
  try {
    const restored = restoreGoalTracker(sessionDir, sessionId, { maxJudgeRuns: ctx.config.agent?.goal?.judge?.maxRuns })
    if (restored) refs.goalTrackerRef.current = restored
  } catch { /* non-fatal ? start without a restored goal */ }
  const { registry: toolRegistry } = createInteractiveToolRegistry(refs, ctx.config, cwd)

  // memory (unified recall + remember)?bootstrap ? createInteractiveToolRegistry ??????
  // ???? sidecar ??? claimStore + session ?????
  toolRegistry.register(createMemoryTool(claimStore, {
    sessionId,
    getTurn: () => session.getTurnCount(),
    cwd,
  }))

  // taskLedger / ownershipLedger ? createInteractiveToolRegistry ? B1 ???
  // ???? refs?fallback ??????????? assembleAgentLoop ? deps?
  const taskLedger = refs.taskLedger ?? createTaskLedger({ taskId: sessionId })
  const ownershipLedger = refs.ownershipLedger ?? createOwnershipLedger({
    baseline: createWorktreeBaseline(captureGitBaseline(cwd)),
    taskLedger,
  })

  // Register MCP tools (if the server-level manager has already initialized).
  // Late-init: sessions created before MCP finishes connecting won't get MCP
  // tools, but subsequent sessions will.
  const mcpMgr = shared?.mcpManager
  if (mcpMgr) {
    const mcpTools = mcpMgr.getAllTools()
    for (const tool of mcpTools) {
      toolRegistry.register(tool)
    }
  }

  return { persist, claimStore, fileHistory, toolRegistry, session, taskLedger, ownershipLedger, refs, historyRestore }
}

/**
 * Merge project-level .rivet-config.json agent block into the startup config.
 * Only agent fields are merged ? provider/model/auth stay on the startup snapshot
 * (the sidecar may have been started unconfigured, and the key was set later via
 * Settings). toolGating is deep-merged so project config can add extraCore without
 * clobbering the startup snapshot's other gating fields (enabled, disabledTools).
 *
 * Only reads the project config FILE (if it exists) ? does NOT call loadConfig()
 * which merges user-level + defaults, which would clobber the startup snapshot
 * with unrelated user settings.
 *
 * Exported for testing. Malformed project config returns the unmodified startup
 * config.
 */
export function mergeProjectAgentConfig(
  startupConfig: Config,
  cwd: string,
): Config {
  try {
    const projectPath = findProjectConfig(cwd)
    if (!projectPath) return startupConfig
    const raw = JSON.parse(readFileSync(projectPath, 'utf-8')) as Record<string, unknown>
    const agent = raw?.agent
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return startupConfig
    const projectAgent = agent as Record<string, unknown>
    const projectTG = projectAgent.toolGating
    const projectToolGating =
      projectTG && typeof projectTG === 'object' && !Array.isArray(projectTG)
        ? (projectTG as Record<string, unknown>)
        : undefined
    return {
      ...startupConfig,
      agent: {
        ...startupConfig.agent,
        ...projectAgent,
        ...(projectToolGating ? {
          toolGating: {
            ...startupConfig.agent?.toolGating,
            ...projectToolGating,
          },
        } : {}),
      },
    }
  } catch {
    return startupConfig
  }
}

/**
 * Assemble an AgentLoop from prebuilt session stores + a resolved model spec.
 * Reusing `stores.session` across calls is what lets switchModel hot-swap the
 * model while keeping the conversation history intact.
 *
 * Wave C: ?? bootstrap.createAgentRuntime ???????? DelegationCoordinator
 * ??? stores.refs.coordinator?????????? 5 ? coordinator ????
 * ?delegate_task / delegate_batch / team_orchestrate / council_convene /
 * plan_task??? deliver_task ??? worker spawn ???? TUI bootstrap ??
 * ?????????????????
 */
function assembleAgentLoop(
  ctx: ServeContext,
  cwd: string,
  sessionId: string,
  stores: SessionStores,
  spec: ResolvedModelSpec,
  approvalMode: ApprovalMode | undefined,
  registry?: SessionRegistry,
  shared?: SharedRuntime,
): AgentLoop {
  // Wave J: domainKnowledgeStore ??? sidecar SharedRuntime.domainStores
  // ? cwd ??fallback ? per-call new?? bootstrap ? session ??????
  // ?? buildAgentLoop legacy /prompt ???? shared ?????
  const domainKnowledgeStore = shared
    ? getOrCreateDomainStore(shared, cwd)
    : new DomainKnowledgeStore(join(cwd, '.rivet', 'knowledge'))
  if (stores.refs.domainKnowledgeStoreRef) stores.refs.domainKnowledgeStoreRef.current = domainKnowledgeStore

  // sessionRegistry ???bootstrap.createAgentRuntime ?? refs.sessionRegistry
  // ???? AgentLoop??????????? refs?buildSessionStores ????
  // ? registry?? switchModel ?????????????? refs ????
  if (registry) stores.refs.sessionRegistry = registry

  const mergedConfig = mergeProjectAgentConfig(ctx.config, cwd)

  const { agent } = createAgentRuntime({
    provider: spec.provider,
    apiKey: spec.apiKey,
    auth: spec.auth,
    config: mergedConfig,
    sessionId,
    cwd,
    toolRegistry: stores.toolRegistry,
    persist: stores.persist,
    claimStore: stores.claimStore,
    fileHistory: stores.fileHistory,
    refs: stores.refs,
    domainKnowledgeStore,
    modelId: spec.model.id,
    session: stores.session,
    // Wave J: ? session ?? ProviderHealthTracker?? switchModel ??
    // provider ?????coordinator ??????????
    sharedProviderHealth: shared?.providerHealth,
    // I4: user hook results ? desktop event stream via the session manager.
    emitHookResult: (results, meta) => shared?.sessions?.emitHookResult(sessionId, results, meta),
  })

  // approvalMode ? createAgentRuntime ?????????????
  // ?setApprovalMode ?? mutate config.approvalMode??????????
  if (approvalMode) {
    agent.setApprovalMode(approvalMode)
    // ?????dangerously-skip-permissions??????????????
    if (approvalMode === 'dangerously-skip-permissions') {
      agent.config.maxTurns = 0
    }
  }

  // ??????????????delivery-gate-v2.ts:330???? ctx.getImpactedTests?
  // TUI ? bootstrapInteractiveSession ????sidecar ? createAgentRuntime ???????
  // ????????????? moduleCoverage ?? undefined??????????
  stores.refs.getImpactedTests = () => [...agent.getEvidenceState().impactedTests]

  // Wave G: LSP late-init??per-assemble ???? attachLspTools ?????????
  // ????????LSP spawn ??????
  if (shared) {
    void attachLspTools(
      getOrCreateLspEntry(shared, cwd),
      stores.toolRegistry,
      stores.refs,
      () => agent.updateTools(),
    )
  }

  // Phase 2: ?? coordinator ??? session-manager???? per-worker steer/kill ?????
  // ??????? stores.refs.coordinator??switchModel ??? coordinator???????????
  shared?.sessions?.setCoordinatorRef(sessionId, () => stores.refs.coordinator ?? undefined)

  return agent
}

/**
 * Build a fully-wired AgentLoop for one session rooted at `cwd`. Each call gets
 * its own SessionPersist / claim store / FileHistory / PlaybookStore / tool
 * registry / PromptEngine (via createAgentConfig) and its own ArtifactStore
 * (created internally by AgentLoop, keyed by sessionId) ? so concurrent
 * sessions never share prompt cache state or artifacts.
 *
 * R1: when a shared `registry` is supplied (desktop multi-session path), each
 * session also gets its own TaskLedger + OwnershipLedger and the registry is
 * threaded into AgentLoop config so file claims / OwnershipGuard / cross-session
 * conflict blocking become live. Omitting `registry` (CLI / single-session)
 * keeps the previous behavior byte-for-byte.
 */
/**
 * Resolve the initial model spec for a new session. When the server started
 * in setup mode (ctx.configured=false), the user may have since configured
 * an API key via /config routes ? re-read from disk to pick it up. Falls
 * back to ctx.apiKey when the key is still unavailable.
 */
/** A resolved spec can actually authenticate when it carries either an inline
 *  API key or an OAuth provider. After a sidecar crash-restart, a provider that
 *  relies on `apiKeyEnv` whose variable is not present in the respawned process
 *  resolves to apiKey='' ? running against it produces a raw upstream 401. */
function specOfContext(ctx: ServeContext): ResolvedModelSpec {
  return {
    provider: ctx.provider,
    apiKey: ctx.apiKey,
    auth: ctx.auth,
    model: { id: ctx.model.id, maxTokens: ctx.model.maxTokens, contextWindow: ctx.model.contextWindow, reasoningEffort: ctx.model.reasoningEffort },
  }
}

/**
 * Resolve the spec a new session starts on. When `reload` is provided (the
 * production sidecar path), prefer a fresh on-disk read so a key rotated via
 * desktop Settings takes effect for the next session WITHOUT a sidecar restart
 * ? the startup snapshot's key may be stale or revoked. Tests that inject a
 * synthetic context pass no `reload` and keep the deterministic snapshot.
 */
function resolveInitialSpec(ctx: ServeContext, reload?: () => ServeContext): ResolvedModelSpec {
  if (reload) {
    try {
      const fresh = reload()
      if (fresh.configured) return specOfContext(fresh)
    } catch { /* mid-edit / broken config on disk ? fall back to the snapshot */ }
  }
  if (ctx.configured) return specOfContext(ctx)
  // Re-read config ? the user may have called POST /config/providers since startup.
  return specOfContext(resolveServeContext())
}

export function buildAgentLoop(
  ctx: ServeContext,
  cwd: string,
  sessionId: string = randomUUID(),
  registry?: SessionRegistry,
  approvalMode?: ApprovalMode,
  shared?: SharedRuntime,
  reload?: () => ServeContext,
): BuiltAgent {
  const stores = buildSessionStores(ctx, cwd, sessionId, registry, shared)
  const spec = resolveInitialSpec(ctx, reload)
  const agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, approvalMode, registry, shared)
  return { agent, sessionId }
}

/**
 * Build a ManagedAgent whose underlying AgentLoop can be hot-swapped onto a new
 * model (switchModel) without losing the conversation. The shared SessionStores
 * (including SessionContext) are built once; switchModel re-assembles only the
 * AgentLoop on a freshly resolved model spec and re-points the holder, so every
 * delegating method below transparently uses the live agent.
 */
export function buildManagedAgent(
  ctx: ServeContext,
  cwd: string,
  sessionId: string,
  registry: SessionRegistry | undefined,
  approvalMode: ApprovalMode | undefined,
  shared?: SharedRuntime,
  reload?: () => ServeContext,
  preferredModelId?: string,
): import('./session-manager.js').ManagedAgent {
  const stores = buildSessionStores(ctx, cwd, sessionId, registry, shared)
  // Register stores so the session-manager's goal methods can reach
  // refs.goalTrackerRef + sessionDir via resolveGoalHandles. Overwrites any
  // stale entry from a prior build of the same session (switchModel rebuild).
  sessionStoresById.set(sessionId, { stores, cwd })
  // Model affinity: a rehydrated session carries the model its prefix cache
  // was built on (record.model ? preferredModelId). Build directly on it so a
  // resumed conversation never silently lands on the default model. Falls back
  // to the default only when the preferred id no longer resolves ? resumeRun()
  // gates that case fail-closed before it ever reaches a run.
  let spec: ResolvedModelSpec =
    (preferredModelId
      ? reload
        ? resolveModelSpecWithReload(ctx, preferredModelId, reload)
        : resolveModelSpecWithReload(ctx, preferredModelId)
      : null) ?? resolveInitialSpec(ctx, reload)
  let agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, approvalMode, registry, shared)
  // Rebuild the loop on a new spec, preserving conversation + stores. Shared
  // by switchModel and the run pre-flight self-heal below.
  const rebuildOnSpec = (next: ResolvedModelSpec) => {
    const oldCoordinator = stores.refs.coordinator
    const oldAgent = agent
    void oldAgent.cancelIdleCompaction()
    spec = next
    const liveApprovalMode = oldAgent.config.approvalMode
    agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, liveApprovalMode, registry, shared)
    if (oldCoordinator && oldCoordinator !== stores.refs.coordinator) {
      try { oldCoordinator.shutdown() } catch { /* best-effort: shutdown is fail-open */ }
    }
    return oldAgent
  }
  return {
    run: (prompt, callbacks, images) => {
      // Auth pre-flight: if this session's model has no usable key (e.g. an
      // apiKeyEnv provider after a sidecar restart lost its env), fail with a
      // clear, actionable message instead of sending the request and surfacing
      // an opaque upstream 401. Rejecting routes through the manager's error
      // path (append 'error' event + status=failed).
      if (!isModelSpecUsable(spec)) {
        // Self-heal first: the key may have been configured or rotated via
        // Settings AFTER this agent was built. Re-resolve the same model
        // against the live config and rebuild in place ? the session then
        // just works instead of demanding a sidecar restart.
        const healed = reload ? resolveModelSpecWithReload(ctx, spec.model.id, reload) : null
        if (healed && isModelSpecUsable(healed)) {
          rebuildOnSpec(healed)
        } else {
          return Promise.reject(new Error(unconfiguredSpecMessage(spec)))
        }
      }
      return agent.run(prompt, callbacks, images)
    },
    abort: () => agent.abort(),
    setApprovalMode: (mode) => {
      agent.setApprovalMode(mode)
      // ???????????????? 200
      agent.config.maxTurns = mode === 'dangerously-skip-permissions' ? 0 : 200
    },
    enterPlanMode: () => agent.enterPlanMode(),
    exitPlanMode: () => agent.exitPlanMode(),
    setActivePlan: (plan) => agent.setActivePlan(plan),
    listArtifacts: () => agent.artifactStore?.list() ?? [],
    readArtifact: (artifactId) => agent.artifactStore?.readRaw(artifactId) ?? Promise.resolve(null),
    getMessages: () => agent.session.getMessages(),
    getHistoryRestore: () => stores.historyRestore,
    replaceMessages: (msgs) => { agent.session.replaceMessages(msgs); agent.config.promptEngine.resetAppendixBaseline() },
    rewindToMessages: (msgs) => { agent.session.rewindToMessages(msgs); agent.config.promptEngine.resetAppendixBaseline() },
    getFileHistory: () => agent.getFileHistory(),
    // PlusMenu ? star domain (delegate to the live agent).
    setSessionDomain: (domain) => agent.setSessionDomain(domain),
    resetSessionDomain: () => agent.resetSessionDomain(),
    getSessionDomain: () => agent.getSessionDomain(),
    // PlusMenu ? skills (per-session discovery filter on the live agent).
    setDisabledSkills: (names) => agent.setDisabledSkills(names),
    // PlusMenu ? model hot-switch (rebuild on the same SessionContext).
    // Wave C-followup P0: createAgentRuntime ? refs ????? coordinator/
    // providerHealth/runtimeFactory??? coordinator ? stallSweep ????
    // ?? worker AbortController ??????sidecar ???? + ??
    // switchModel ??????? capture old????? shutdown ???
    // Wave J: ?? shared ? switchModel ???? providerHealth/domainStore?
    // ???????knowledge ?? load?
    switchModel: (modelId) => {
      // First-install / post-startup config edits: resolve against the live
      // config, not just the startup snapshot. See resolveModelSpecWithReload.
      const next = resolveModelSpecWithReload(ctx, modelId)
      if (!next) return null
      // Audit: capture the outgoing model before the rebuild replaces it.
      // (rebuildOnSpec cancels the old loop's idle compaction ? it shares this
      // SessionContext with the incoming loop ? and preserves the live
      // approvalMode the user may have switched since session creation.)
      const oldAgent = rebuildOnSpec(next)
      let fromModel: string | undefined
      try { fromModel = oldAgent.config.promptEngine.getModel() } catch { /* idle/???? */ }
      // ??????? TUI bootstrap.switchAgentRuntime ????metadata.model/
      // provider ???????JSONL ? model_switch ???????????
      // ?????????????????best-effort???????
      try {
        stores.persist.updateMetadata({ model: spec.model.id, provider: spec.provider.name })
        stores.persist.appendModelSwitch({ from: fromModel, to: spec.model.id, provider: spec.provider.name })
      } catch { /* persistence is best-effort ? never block a model switch */ }
      return spec.model.id
    },
    // Context usage display (desktop header progress bar) ? real occupancy
    // (last API prompt_tokens + tail estimate), provider-agnostic.
    getEstimatedTokens: () => agent.session.getRealOccupancy(),
    getContextWindow: () => spec.model.contextWindow,
    getReasoningEffort: () => agent.getReasoningEffort(),
    // ????????????????????? config ??? visionModel ???
    // ???????????? agent ? config ???? config?
    getVisionBridge: () => agent.config.visionBridge,
    // Cockpit snapshot for the desktop cockpit panel. Assembles the full
    // runtime state (safety/verify/context/model/advisory) via the pure
    // buildCockpitSnapshot function ? same source the TUI uses (main.ts:706).
    // try/catch: the agent may be mid-rebuild (switchModel) ? degrade to null
    // instead of 500'ing the cockpit poll.
    getCockpitSnapshot: () => {
      try {
        const usage = agent.session.getTotalUsage()
        const pricing = findModelPricing(ctx.config.provider?.providers, spec.provider.name, spec.model.id)
        const cost = computeUsageCost(usage, pricing).total
        return buildCockpitSnapshot({
          agent,
          session: agent.session,
          model: spec.model.id,
          cacheHitRate: agent.session.getRecentTurnHitRate(3) ?? agent.session.getCacheHitRate(),
          cost,
          mcpManager: shared?.mcpManager ?? null,
          reasoningEffort: agent.getReasoningEffort(),
          // claimCounts / advisoryStatusNotices omitted ? safe degradation
          // (claimCounts defaults to zero counts, statusNotices to []).
        })
      } catch {
        return null
      }
    },
    // Wave L: ??????? session ? coordinator timer + in-flight worker
    // ???abort() ????? turn?shutdown() ???????
    shutdown: async () => {
      try { void agent.cancelIdleCompaction() } catch { /* best-effort */ }
      const coordinator = stores.refs.coordinator
      let settled = !coordinator
      try {
        if (coordinator?.shutdownAndWait) settled = await coordinator.shutdownAndWait()
        else if (coordinator) {
          coordinator.shutdown()
          settled = false
        }
      } catch {
        settled = false
      }
      shared?.sessions?.clearCoordinatorRef(sessionId)
      return settled
    },
    // I1: ????????????? artifact ?? council-plan-json?
    conveneCouncil: (input) => conveneCouncilOnCoordinator(agent, stores.refs.coordinator, stores.refs, input),
    // ????????????? AbortSignal???????????????
    delegateWorker: (input, opts) => delegateWorkerOnCoordinator(stores.refs.coordinator, input, opts),
    // P0-2: plan_task ??? onToolResult ??????? TodoStore ? todo_state SSE
    getTodos: () => stores.refs.todoStore.read(),
    // Hot-inject MCP tools discovered after this agent was built (mid-session
    // connector enable). register is Map.set-idempotent; updateTools refreshes
    // the prompt tool list the same way attachLspTools does for LSP tools.
    registerExternalTools: (tools) => {
      for (const tool of tools) {
        stores.toolRegistry.register(tool)
      }
      agent.updateTools()
    },
  }
}

class CouncilError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message)
    this.name = 'CouncilError'
  }
}

/**
 * I1: ??? session ????????? artifactId ????????
 * ```council-plan-json ????????????? raw ??? UnifiedPlan
 * ?? draftItems??????agent ??? turn ??????
 */
async function conveneCouncilOnCoordinator(
  agent: AgentLoop,
  coordinator: import('../agent/coordinator.js').DelegationCoordinator | null,
  refs: RuntimeRefs,
  input: {
    artifactId: string
    objective?: string
    seats?: { authority: string; charter?: string }[]
    rounds?: number
  },
): Promise<{ planMarkdown: string; artifactId: string; councilPanel?: CouncilPanelModel }> {
  if (agent.isRunning()) {
    throw new CouncilError('Session is already running a turn', 409)
  }
  if (!coordinator) {
    throw new Error('DelegationCoordinator not initialized')
  }
  const raw = await agent.artifactStore?.readRaw(input.artifactId)
  if (!raw) {
    throw new CouncilError('Artifact not found', 404)
  }
  const planJson = extractCouncilPlanJson(raw)
  if (!planJson) {
    throw new CouncilError('Artifact does not contain a valid council-plan-json block', 400)
  }
  const draftItems: PlanItem[] = planJson.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    detail: t.objective,
    files: t.files,
  }))
  const seats: CouncilSeat[] = input.seats && input.seats.length > 0
    ? input.seats.map((s) => ({ authority: s.authority, ...(s.charter ? { charter: s.charter } : {}) }))
    : [...DEFAULT_COUNCIL_SEATS]
  const abortController = new AbortController()
  const councilInput: CouncilInput = {
    draft: { objective: input.objective ?? planJson.objective, items: draftItems },
    seats,
    abortSignal: abortController.signal,
    ...(typeof input.rounds === 'number' ? { maxRounds: input.rounds } : {}),
  }
  const now = Date.now()
  const deps = {
    delegateBatch: async (
      requests: import('../agent/council/council-orchestrator.js').CouncilFanoutRequest[],
      policy: 'all_required',
      signal?: AbortSignal,
      onProgress?: (completed: number, total: number) => void,
    ) => {
      const delegationReqs: import('../agent/coordinator.js').DelegationRequest[] = requests.map((r) => ({
        parentTurnId: r.parentTurnId,
        objective: r.objective,
        kind: r.kind,
        profile: r.profile,
        scope: r.scope,
        // ????????????????????????/??????
        authority: r.authority,
        ...(r.modelOverride ? { modelOverride: r.modelOverride } : {}),
        ...(r.tierFloor ? { tierFloor: r.tierFloor } : {}),
      }))
      const run = await coordinator.delegateBatch(
        delegationReqs,
        policy,
        signal,
        onProgress,
      )
      return { results: run.results, workerModels: run.workerModels }
    },
    now: () => now,
    sessionId: refs.sessionId ?? 'unknown',
    recordRoutingShadow: (event: import('../agent/council/council-routing.js').CouncilRoutingShadowEvent) => persistCouncilRoutingShadow(refs.meridianIndexer?.getDb(), event),
  }
  const runner = councilInput.maxRounds && councilInput.maxRounds >= 2 ? runCouncilDebate : runCouncil
  const plan = await runner(councilInput, deps)
  const planMarkdown = renderCouncilPlan(plan)
  // Da'at ????? council_convene ?????????????? planJson?
  const compiled = plan.aggregate.mergedItems.length > 0 ? compileCouncilPlan(plan) : undefined
  const sealed = compiled?.ok && compiled.plan
    ? sealPlan(attachObligations(compiled.plan, extractObligations(plan)))
    : undefined
  const outputRaw = sealed
    ? [planMarkdown, '', '```council-plan-json', serializeUnifiedPlan(sealed), '```'].join('\n')
    : compiled && !compiled.ok
      ? [planMarkdown, '', '## ? ??????blocking challenge ????', ...compiled.vetoes.map(v => `- ${v.description}: ${v.left}`)].join('\n')
      : planMarkdown
  const savedArtifactId = await agent.artifactStore?.save({
    tool: 'council_convene',
    target: `council:${plan.meta.objectiveHash}`,
    rawContent: outputRaw,
    summary: summarizeCouncilPlan(plan),
    sections: [],
  })
  try {
    // ?? buildCouncilSessionEvent?? council_convene ?????????
    // ????????? schema ?????Phase 2 ?????????????
    recordCouncilSession(refs.meridianIndexer?.getDb(), buildCouncilSessionEvent({
      sessionId: refs.sessionId ?? 'unknown',
      plan,
      timestamp: Date.now(),
    }))
  } catch {
    // ?????????
  }
  if (!savedArtifactId) {
    throw new Error('Failed to save council plan artifact')
  }
  const councilPanel: CouncilPanelModel = {
    schemaVersion: 1,
    objective: plan.objective,
    seats: plan.contributions.map(c => ({
      authority: c.authority,
      status: 'passed',
      round: c.round ?? 1,
      modelUsed: c.modelUsed,
    })),
    verdict: {
      accepted: plan.aggregate.decisions.filter(d => d.verdict === 'accepted').length,
      rejected: plan.aggregate.decisions.filter(d => d.verdict === 'rejected').length,
      deferred: plan.aggregate.decisions.filter(d => d.verdict === 'deferred').length,
      conflicts: plan.aggregate.conflicts.length,
    },
    sealVersion: sealed?.seal?.version,
    pillarsMode: false,
    failedSeats: plan.meta.failedSeats,
    qliphothCount: plan.meta.qliphoth?.length,
  }
  return { planMarkdown, artifactId: savedArtifactId, councilPanel }
}

function extractCouncilPlanJson(raw: string): UnifiedPlan | null {
  const match = raw.match(/```council-plan-json\n([\s\S]*?)\n```/)
  if (!match) return null
  return deserializeUnifiedPlan(match[1]!)
}

/** Map a friendly profile to a work-order kind so patch/review/verify workers
 *  get the right execution mode (mirrors delegate_task's kind semantics). */
function kindForProfile(profile: string): import('../agent/coordinator.js').DelegationRequest['kind'] {
  switch (profile) {
    case 'patcher': return 'patch_proposal'
    case 'reviewer': return 'review'
    case 'verifier':
    case 'adversarial_verifier': return 'verify'
    case 'planner':
    case 'perspective_planner': return 'plan'
    case 'doc_scout': return 'doc_research'
    default: return 'code_search'
  }
}

/** Build the terminal digest shown in the panel + adopted into the composer by
 *  the "?????" button. Markdown: objective + outcome + changed files +
 *  worker summary (truncated). Pure ? easy to unit test. */
/** User-dispatched background subagent runner. Mirrors delegate_task's request
 *  shaping but bridges activity to a plain callback (no tool pipeline) and
 *  produces a terminal summary for the adopt-to-composer flow. */
async function delegateWorkerOnCoordinator(
  coordinator: import('../agent/coordinator.js').DelegationCoordinator | null,
  input: DelegateWorkerInput,
  opts: { workerId: string; signal: AbortSignal; onActivity: (a: DelegateActivityUpdate) => void },
): Promise<void> {
  if (!coordinator) throw new Error('DelegationCoordinator not initialized')
  const profile = input.profile && input.profile.trim() ? input.profile.trim() : 'code_scout'
  const request: import('../agent/coordinator.js').DelegationRequest = {
    // Use the manager-owned workerId as the stable node key (parentTurnId derives
    // the work order id), so every activity update merges into the same panel node.
    parentTurnId: opts.workerId,
    objective: input.objective,
    kind: kindForProfile(profile),
    profile: profile as import('../agent/work-order.js').WorkerProfile,
    scope: input.files && input.files.length ? { files: input.files } : {},
    delegationDepth: 0,
    // Reuse the shared mapper so user-dispatched workers get the same live
    // counters (toolUseCount/tokenCount) and eventKind/eventDetail passthrough
    // as agent-initiated delegations.
    onActivity: createDelegationActivityMapper(opts.workerId, (a) => {
      opts.onActivity({
        workOrderId: opts.workerId,
        parentToolId: a.parentToolId,
        profile: a.profile ?? profile,
        authority: a.authority,
        status: a.status,
        progressLine: a.progressLine,
        toolUseCount: a.toolUseCount,
        tokenCount: a.tokenCount,
        eventKind: a.eventKind,
        eventDetail: a.eventDetail,
        contract: a.contract,
      })
    }),
  }
  if (input.authority) request.authority = input.authority
  if (input.resume) request.resumeWorkOrderId = input.resume
  const run = await coordinator.delegate(request, opts.signal)
  const result = run.results[0]
  const status: DelegateActivityUpdate['status'] = result?.status ?? (run.status === 'skipped' ? 'blocked' : 'passed')
  opts.onActivity({
    workOrderId: opts.workerId,
    profile,
    status,
    progressLine: result?.summary ? result.summary.slice(0, 120) : undefined,
    failureReason: result?.failureReason,
    summary: buildDelegateSummary(input, run),
    changedFiles: result?.changedFiles && result.changedFiles.length > 0 ? result.changedFiles : undefined,
    artifactId: result?.diffArtifactId,
    model: run.selectedModel ?? result?.model,
    provider: result?.provider,
    usage: result?.usage,
    // ???????? delegate_task ? emitTerminal ????
    findingsCount: result?.findings && result.findings.length > 0 ? result.findings.length : undefined,
    topFinding: result?.findings?.[0]?.claim,
    verificationBrief: result?.verification
      ? { status: result.verification.status, passed: result.verification.passed, failed: result.verification.failed }
      : undefined,
    evidenceStatus: result?.evidenceStatus,
  })
}
