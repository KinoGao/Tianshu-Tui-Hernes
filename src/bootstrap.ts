/**
 * bootstrap.ts ? ???????? T9 ANSI ?????? src/main.ts ???
 *
 * ??????? React ??????????????? Ink ??
 * ?main.tsx????????? main-ansi.ts??? src/main.ts ???
 *
 * ???
 *   bootstrapInteractiveSession() ? BootstrapContext
 *   ??? src/main.ts ?? await ????? AgentLoop ? TuiApp?engine/app.ts?
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { randomUUID, createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, unlinkSync } from 'fs'
import { spawn } from 'child_process'
import { spawnGitSync } from './tools/spawn-git.js'

import type { Config, ProviderConfig } from './config/schema.js'
import type { AuthProvider } from './auth/types.js'
import type { BaselineSnapshot } from './agent/worktree-baseline.js'
import { buildModelCards } from './model/capability.js'
import type { ModelCapabilityCard } from './model/capability.js'

import { loadConfig as loadLayeredConfig } from './config/manager.js'
import { isProFeatureEnabled } from './config/pro-license.js'
import { lastSessionPointerDir, rivetHome, stateDir } from './config/paths.js'
import { setTargetConventions, applyConfiguredGitBashPath } from './platform.js'
import { AgentLoop } from './agent/loop.js'
import { createAgentConfig, createMainAgentConfigInput } from './agent/create-agent-config.js'
import { SessionContext } from './agent/context.js'
import { SessionPersist, evictOldSessions, getSessionDir } from './agent/session-persist.js'
import { migrateSessionFiles } from './agent/session-cd.js'
import { decideStartupSession, RESUME_FRESHNESS_MS } from './agent/session-recovery.js'
import { runResumePreflightOai } from './context/resume-preflight.js'
import { createWriteEvidenceProbe } from './context/write-evidence-probe.js'
import { FileHistory } from './agent/file-history.js'
import { PromptEngine } from './prompt/engine.js'
import { subagentPromptBlocks } from './prompt/block-policy.js'
import { applyDescriptionMode } from './tools/description-compact.js'
import { createDefaultToolRegistry } from './tools/default-registry.js'
import { presetIncludes, resolveToolPreset } from './tools/tool-preset.js'
import { BROWSER_DEBUG_TOOL } from './tools/browser-debug/tool.js'
import { defaultStore as defaultTodoStore } from './tools/todo.js'
import { TodoStore } from './tools/todo-store.js'
import { createDelegateTaskTool } from './tools/delegate-task.js'
import { createUndoTool } from './tools/undo.js'
import { maybeWarnNoSandbox, applySandboxPolicyForApprovalMode } from './tools/sandbox-profile.js'
import { applyConfiguredPathGrants, applyDefaultDependencyReadGrants, applyRivetRuntimeReadGrants, loadPersistedGrants } from './tools/path-grants.js'
import { createDelegateBatchTool } from './tools/delegate-batch.js'
import { createGalaxyTool } from './tools/galaxy.js'
import { createStarflowTool } from './tools/starflow.js'
import { createTeamOrchestrateTool } from './tools/team-orchestrate.js'
import type { PlanExecutorDeps } from './agent/plan-executor.js'
import { runTypeCheck } from './lsp/client.js'
import { GATE_TSC_TIMEOUT_MS } from './agent/typecheck-gate.js'
import { createCouncilConveneTool, type CouncilConveneCoordinator } from './tools/council-convene.js'
import { needsTemplatesInit } from './bootstrap/project-templates.js'
import { debugLog } from './utils/debug.js'
import { persistCouncilRoutingShadow } from './agent/council/council-routing.js'
import { recordCouncilSession } from './agent/council/council-telemetry.js'
import { createRecallCapsuleTool } from './tools/recall-capsule.js'
import { createRecallGeneralTool } from './tools/recall-general.js'
import { createRecordGeneralFindingTool } from './tools/record-general-finding.js'
import { createDeliverTaskTool } from './agent/deliver-task.js'
import { createUpdateGoalTool } from './tools/update-goal.js'
import { createTaskLedger } from './agent/task-ledger.js'
import { createOwnershipLedger } from './agent/ownership-ledger.js'
import { createVerificationAttribution } from './agent/verification-attribution.js'
import { createDeliveryGateV2 } from './agent/delivery-gate-v2.js'
import { createWorktreeBaseline } from './agent/worktree-baseline.js'
import { createVerificationSnapshotManager, reapOrphanSnapshots, reapOrphanHandsWorktrees } from './agent/verification-snapshot-manager.js'
import { cleanupStaleHandsBranches } from './agent/worktree.js'
import { initializePlugins } from './plugins/plugin-loader.js'
import { createProviderClient, resolveApiKey } from './api/factory.js'
import { buildReviewOverrideState } from './agent/review-model-override.js'
import type { ResolvedReviewOverride } from './agent/review-model-override.js'
import { createAuthProvider } from './auth/registry.js'
import { resolveCapabilities } from './api/provider.js'
import { DelegationCoordinator } from './agent/coordinator.js'
import { ProviderHealthTracker } from './agent/provider-health.js'
import { effectiveBanditMode, resolveBanditPromotion } from './agent/bandit-promotion.js'
import { DomainKnowledgeStore } from './agent/domain-knowledge-store.js'
import { emptyObligationStore } from './agent/evidence-obligation.js'
import { resolvePlanConstraints } from './agent/plan-constraints.js'
import { profileRegistry } from './agent/profile-registry.js'
import { starDomainRegistry } from './agent/star-domain-registry.js'
import type { WorkerRuntimeFactory } from './agent/coordinator.js'
import { mapWorkOrderKindToCapabilityTask } from './agent/work-order.js'
import { PlaybookStore } from './agent/playbook-store.js'
import { resetLegacyMemoryIfNeeded } from './agent/memory-epoch.js'
import { ASK_USER_QUESTION_TOOL } from './tools/ask-user-question.js'
import { createRepoGraphTool } from './tools/repo-graph.js'
import { createRelatedTestsTool } from './tools/related-tests.js'
import { SEMANTIC_SEARCH_TOOL } from './tools/semantic-search.js'
import { buildSearchBackends } from './tools/web-search.js'
import { buildFetchOptions } from './tools/web-fetch/build-options.js'
import { APPLY_PATCH_TOOL } from './tools/apply-patch.js'
import { createSessionVitalsTool } from './tools/session-vitals.js'
import { createAttackCaseTool } from './tools/attack-case.js'
import { createPlanTaskTool } from './tools/plan-task.js'
import { createMemoryTool } from './tools/memory.js'
import { MeridianIndexer } from './repo/meridian-indexer.js'
import { scheduleMeridianBackfill } from './repo/meridian-backfill.js'
import { detectProjectFingerprint } from './repo/project-fingerprint.js'
import { loadProjectRules } from './context/rules-loader.js'
import { loadProjectSkills } from './skills/skill-loader.js'
import { killAllSync } from './tools/process-tracker.js'
import { persistFileHistory } from './agent/file-history-persist.js'
import { cleanupOrphanedTmpFiles } from './fs-atomic.js'
import { cleanupOldArtifactSessions } from './artifact/store.js'
import { createLspManager } from './lsp/manager.js'
import { createMultiLspManager } from './lsp/multi-manager.js'
import { availableServers } from './lsp/server-registry.js'
import { createGotoDefinitionTool, createFindReferencesTool } from './lsp/tools.js'
import { createCoordinatorReviewDeps } from './agent/review-coordinator-deps.js'
import { persistTeamWaveTelemetry, type TeamWaveTelemetry } from './agent/team-wave-telemetry.js'
import { buildTeamSchedulerRewardEvent, persistTeamSchedulerReward, persistTeamSchedulerShadow, type TeamSchedulerShadowEvent } from './agent/team-scheduler-shadow.js'
import { persistGatedInfluenceAudit, type GatedInfluenceAuditEvent } from './agent/gated-influence-audit.js'
import { computeTeamWaveReward, deriveTeamWaveRewardInput } from './agent/team-reward.js'
import { teamSchedulerArmForParallelism } from './agent/team-scheduler-bandit.js'
import { recordTeamWaveRewardClosure } from './agent/reward-loop.js'
import type { TuiPerfSummary } from './tui/engine/perf-monitor.js'

// ?? Types ??????????????????????????????????????????????????????

/** ??????? ? ?? main.tsx ?? module-level _xxxRef ???? */
export interface RuntimeRefs {
  coordinator: DelegationCoordinator | null
  fileHistory: FileHistory | null
  claimStore: import('./context/claim-store.js').ContextClaimStore | null
  sessionId: string | null
  sessionRegistry: import('./agent/session-registry.js').SessionRegistry | null
  taskLedger: import('./agent/task-ledger.js').TaskLedger | null
  ownershipLedger: import('./agent/ownership-ledger.js').OwnershipLedger | null
  /** VSW: session-scoped snapshot manager (in-place by default per ?6 policy). */
  verificationSnapshotManager: import('./agent/verification-snapshot-manager.js').VerificationSnapshotManager | null
  /** Track 3: ???????v2?? badge ???????? */
  deliveryGate: import('./agent/delivery-gate-v2.js').DeliveryGateV2 | null
  meridianIndexer: MeridianIndexer | null
  mcpManager: any | null
  lspManager: ReturnType<typeof createLspManager> | null
  /** T5: bandit promotion state for /status observability. */
  banditState: import('./server/routes.js').BanditStatusEntry[] | null
  /** Prompt engine ref for depth-layer queries at deliver-task time. */
  promptEngine: import('./prompt/engine.js').PromptEngine | null
  /**
   * Wave F: ?? cwd ????? session ?????????
   * verificationSnapshotManager ?? session worktree ?????
   *
   * TUI ? session ??????createInteractiveToolRegistry ??? `() => 0`
   * ??????sidecar ? session ???? SharedRuntime ? manager.sameCwdRunningCount
   * ???????? VSW snapshot ???in-place vs worktree??????
   */
  getSameCwdRunningSessions?: () => number
  /** Mutable ref to the current GoalTracker. Set by slash-commands /goal,
   *  read by deliver_task B1Context for auto-review gating. */
  goalTrackerRef: { current: import('./agent/goal-tracker.js').GoalTracker | null }
  /** ?????????galaxy ?????? #5 ????????????
   *  getter ?????/cd ?? cwd ?? switchAgentCwd ????? store? */
  domainKnowledgeStoreRef?: { current: DomainKnowledgeStore | null }
  /** ?????????????? #2 ??????createAgentRuntime ? agent
   *  ??????deliver_task ? store ????galaxy DP ??/??????? */
  obligationTrackerRef?: { current: import('./agent/obligation-tracker.js').ObligationTracker | null }
  /** ????? Phase 2?claim tracker getter ??????createAgentRuntime ???
   *  deliver_task ?????????? */
  claimTrackerRef?: { current: (() => import('./agent/hooks/external-claim-tracking-hook.js').ClaimTracker) | null }
  /** ?????????TUI /review off|on ???deliver_task B1Context ?
   *  isAutoReviewOff ??????? review.skipAuto ????????????? */
  reviewGateRef: { current: 'auto' | 'off' }
  /** Plugin-contributed hooks (absolute script paths). initializePlugins fills
   *  this; the user-hooks bridge reads it at fire time so plugin hooks are
   *  picked up even though plugins load after agent assembly. */
  pluginHooks: import('./plugins/plugin-loader.js').PluginHookEntry[]
  /** Plugin-contributed slash commands (absolute .md paths). Same lazy-binding
   *  pattern as pluginHooks ? read by resolveCustomCommand at input time. */
  pluginCommands: import('./plugins/plugin-loader.js').PluginCommandEntry[]
  /** ?3 ????????????? getter?agent ???????
   *  deliver_task ??? regressionInventory / objective ???????? */
  getTaskContract?: () => import('./context/task-contract.js').TaskContract | undefined
  /** W1 ?????EvidenceTracker.impactedTests getter?agent ???????
   *  deliver_task ???????????????module_unverified?? */
  getImpactedTests?: () => string[]
  /** W5 ???????session_vitals ????agent ???????
   *  ???"????"????????????????????? */
  getSessionVitals?: () => import('./tools/session-vitals.js').SessionVitalsData
  /** PAL ????????????agent ???????attack_case ????
   *  ? problem-attack-hook ???? store? */
  getProblemAttackStore?: () => import('./agent/problem-attack-loop.js').ProblemAttackStore
  /** H2 ??????agent ???????? recentToolHistory / ObligationStore
   *  ?? evidence_ref?????????? */
  getAttackEvidenceVerifier?: () => import('./tools/attack-case.js').AttackEvidenceVerifier
  /** ???????????? todo ?? store??????/??todo ???plan_task
   *  ???turn-end ???????todo-reminder ????????TUI ????
   *  defaultStore??? setTodoSession/loadTodos ????????????server ??? new?
   *  ????????????????????loop ???? refs ?????? new? */
  todoStore: TodoStore
}

/** bootstrapInteractiveSession ?????? */
export interface BootstrapContext {
  config: Config
  provider: ProviderConfig
  apiKey: string
  auth: AuthProvider | undefined
  sessionId: string
  session: SessionContext
  persist: SessionPersist
  claimStore: import('./context/claim-store.js').ContextClaimStore
  fileHistory: FileHistory
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>
  agent: AgentLoop
  refs: RuntimeRefs
  domainKnowledgeStore: DomainKnowledgeStore
  meridianIndexer: MeridianIndexer
  cwd: string
  shutdown: () => Promise<void>
  /** Persist the final TUI perf summary through the existing telemetry writer. */
  flushTuiPerfSummary: (summary: TuiPerfSummary) => Promise<void>
  heartbeatInterval: ReturnType<typeof setInterval>
  /** True when first-run template init is pending ? TUI layer handles the
   *  AGENTS.md prompt. Set by needsTemplatesInit() during bootstrap. */
  templatesPendingAgents?: boolean
}

// ?? HTTP Proxy ?????????????????????????????????????????????????

let _proxySetup = false

export function setupHttpProxy(): void {
  if (_proxySetup) return
  _proxySetup = true
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (proxyUrl) {
    setGlobalDispatcher(new EnvHttpProxyAgent())
  }
}

// ?? Config ?????????????????????????????????????????????????????

function approvalOverlayFromArgs(args: string[]): Record<string, unknown> | undefined {
  if (args.includes('--dangerously-skip-permissions') || args.includes('--dangerously-skip-approvals')) {
    return { agent: { approval: 'dangerously-skip-permissions' } }
  }
  const modeIndex = args.indexOf('--approval-mode')
  if (modeIndex >= 0) {
    const mode = args[modeIndex + 1]
    if (!mode) {
      console.error('--approval-mode requires a value')
      process.exit(2)
    }
    return { agent: { approval: mode } }
  }
  return undefined
}

export function loadRivetConfig(cwd?: string, args: string[] = process.argv.slice(2)): Config {
  return loadLayeredConfig({ cwd, sessionOverlay: approvalOverlayFromArgs(args) })
}

// ?? Provider + Auth ????????????????????????????????????????????

export function resolveProviderAndAuth(
  config: Config,
  providerName?: string,
  opts?: { allowMissingKey?: boolean },
): { provider: ProviderConfig; apiKey: string; auth: AuthProvider | undefined } {
  const name = providerName ?? config.provider.default
  const provider = config.provider.providers[name]
  if (!provider) {
    console.error(`Provider "${name}" not configured. Available: ${Object.keys(config.provider.providers).join(', ')}`)
    process.exit(1)
  }

  if (provider.auth?.type === 'oauth') {
    const auth = createAuthProvider(provider.auth, process.env, provider.apiKey)
    return { provider, apiKey: '', auth }
  }

  // ?????allowMissingKey??? key ??????? apiKey?
  // ?????? wizard ?????? TUI ????????????? key?
  // ??????????????????OAuth ?????? apiKey??????
  if (opts?.allowMissingKey) {
    try {
      const apiKey = resolveApiKey(provider)
      return { provider, apiKey, auth: undefined }
    } catch {
      return { provider, apiKey: '', auth: undefined }
    }
  }

  const apiKey = resolveApiKey(provider)
  return { provider, apiKey, auth: undefined }
}

// ?? Git Baseline ???????????????????????????????????????????????

export function captureGitBaseline(cwd: string): BaselineSnapshot {
  try {
    const branch = spawnGitSync(['-c', 'core.quotePath=false', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 5000 }).stdout.trim()
    const head = spawnGitSync(['-c', 'core.quotePath=false', 'rev-parse', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 5000 }).stdout.trim()
    const dirty = spawnGitSync(['-c', 'core.quotePath=false', 'diff', '--name-only'], { cwd, encoding: 'utf-8', timeout: 5000 }).stdout.trim()
    const untracked = spawnGitSync(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf-8', timeout: 5000 }).stdout.trim()
    return {
      branch,
      head,
      preExistingDirty: dirty ? dirty.split(/\r?\n/) : [],
      preExistingUntracked: untracked ? untracked.split(/\r?\n/) : [],
      capturedAt: Date.now(),
    }
  } catch {
    return { branch: '', head: '', preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() }
  }
}

// ?? Session ID ?????????????????????????????????????????????????

let _cachedSessionId: string | null = null
let _sessionWasResumed = false

/** True when the active session id was explicitly resumed (--continue / --resume [id]). */
export function wasSessionResumed(): boolean {
  return _sessionWasResumed
}

/** Per-cwd last-session pointer file (so `--continue` returns *this* project's
 *  session, never another project's). Hashed cwd mirrors the memory-store
 *  convention (sha256(cwd).slice(0,12)). */
function lastSessionPointerFile(cwd: string): string {
  const dir = lastSessionPointerDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(dir, `${hash}.txt`)
}

/**
 * Resolve the session id for this run. Default is a FRESH session ? there is NO
 * implicit/crash auto-resume. We only return to a previous session when the
 * user explicitly asks:
 *   - RIVET_RESUME_ID=<full-id>  ? resume that specific session (highest prio)
 *   - RIVET_RESUME=1             ? resume the most recent session for this cwd
 * See `decideStartupSession` for the full contract. Resuming reuses the existing
 * startup path (`persist.loadOai()` + `replaceMessages()`) to rehydrate ? the
 * resumed id becomes this run's session id = log id = pointer id.
 *
 * Escape hatches: RIVET_NEW_SESSION=1 forces fresh; RIVET_NO_AUTO_RESUME=1 is a
 * no-op for default startup (kept for back-compat) since fresh is already default.
 */
export function getOrCreateSessionId(): string {
  if (_cachedSessionId) return _cachedSessionId
  const cwd = process.cwd()
  const dir = rivetHome()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const pointerFile = lastSessionPointerFile(cwd)
  let lastSessionId: string | null = null
  try {
    if (existsSync(pointerFile)) lastSessionId = readFileSync(pointerFile, 'utf-8').trim() || null
  } catch { /* ignore */ }
  // One-time compatibility fallback to the legacy global pointer. The cwd gate
  // in decideStartupSession rejects it if it belongs to a different project.
  if (!lastSessionId) {
    try {
      const legacy = join(dir, 'session-id.txt')
      if (existsSync(legacy)) lastSessionId = readFileSync(legacy, 'utf-8').trim() || null
    } catch { /* ignore */ }
  }

  const decision = decideStartupSession({
    lastSessionId,
    now: Date.now(),
    freshnessMs: RESUME_FRESHNESS_MS,
    forceNew: process.env.RIVET_NEW_SESSION === '1',
    resume: process.env.RIVET_RESUME === '1',
    resumeSessionId: process.env.RIVET_RESUME_ID || undefined,
    disableAutoResume: process.env.RIVET_NO_AUTO_RESUME === '1',
    currentCwd: cwd,
    load: (id) => {
      try {
        const persist = new SessionPersist(id, cwd)
        const meta = persist.loadMetadata()
        return {
          hasContent: persist.loadOai().length > 0,
          status: meta?.status,
          updatedAt: meta?.updatedAt,
          cwd: meta?.cwd,
          cleanExit: meta?.cleanExit,
        }
      } catch {
        return null
      }
    },
  })

  const id = decision.sessionId ?? randomUUID()
  _sessionWasResumed = decision.resumed
  try { writeFileSync(pointerFile, id) } catch { /* ignore */ }
  _cachedSessionId = id
  return id
}

/**
 * Clean up stale worker session directories under ~/.rivet/sessions/<slug>/.
 * Worker sessions (worker-*) create per-session dirs here (pheromones.json,
 * sensorium.jsonl). Removes worker dirs older than STALE_THRESHOLD_MS to
 * avoid deleting dirs that might still be in use by a concurrent worker.
 */
export const WORKER_DIR_STALE_THRESHOLD_MS = 3_600_000 // 1 hour
/** worker ???jsonl/meta ????????????? worker ??/????
 *  ??????????7 ?????????(1h)??????????/???
 *  ?????????????? */
export const WORKER_FILE_STALE_THRESHOLD_MS = 7 * 24 * 3_600_000 // 7 days

export function cleanupStaleWorkerSessionDirs(
  cwd: string,
  thresholdMs = WORKER_DIR_STALE_THRESHOLD_MS,
  fileThresholdMs = WORKER_FILE_STALE_THRESHOLD_MS,
): number {
  const sessionsDir = getSessionDir(cwd)
  if (!existsSync(sessionsDir)) return 0
  let cleaned = 0
  try {
    const entries = readdirSync(sessionsDir)
    for (const entry of entries) {
      if (!entry.startsWith('worker-')) continue
      const fullPath = join(sessionsDir, entry)
      try {
        const st = statSync(fullPath)
        const age = Date.now() - st.mtimeMs
        if (st.isDirectory()) {
          if (age > thresholdMs) {
            rmSync(fullPath, { recursive: true, force: true })
            cleaned++
          }
        } else if (age > fileThresholdMs) {
          // worker-<id>.jsonl ????.meta.json/.claims.jsonl???evict ???
          // ??? worker??????????????????????????????
          unlinkSync(fullPath)
          cleaned++
        }
      } catch { /* best-effort ? skip unreadable entries */ }
    }
  } catch { /* best-effort */ }
  return cleaned
}

// ?? Tool Registry (with all tools registered) ??????????????????

export function createInteractiveToolRegistry(
  refs: RuntimeRefs,
  config: Config,
  cwd: string,
): { registry: ReturnType<typeof createDefaultToolRegistry> } {
  const toolPreset = resolveToolPreset(cwd)
  const reg = createDefaultToolRegistry([], {
    preset: toolPreset,
    desktopTools: config.agent.desktopTools,
    todoStore: refs.todoStore,
    // Computer Use??? GUI ?????EXTENDED ??????????tool gating
    // ????@Computer / /tools enable ??????????darwin/win32 + Pro gated?
    computerUse: (process.platform === 'darwin' || process.platform === 'win32') && process.env.RIVET_COMPUTER_USE !== '0',
    proEnabled: isProFeatureEnabled(config, 'computerUse'),
    // web_search ????bing/DDG ?? / Brave / Tavily??? config.search ?? fallback?
    // ?? network.{proxy,noProxy}?web_search ? web_fetch ??????????
    // ???????????? GFW ?? backend ????
    searchBackends: buildSearchBackends(config, {
      proxy: {
        ...(config.network.proxy ? { proxyUrl: config.network.proxy } : {}),
        ...(config.network.noProxy ? { noProxy: config.network.noProxy } : {}),
      },
    }),
    // web_fetch ???????/????/UA/?????
    fetchOptions: buildFetchOptions(config),
  })

  // delegate_task
  reg.register(createDelegateTaskTool(
    {
      delegate: async (request, signal) => {
        if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
        // ?????????? H3??delegate_task ?? params.abortSignal?
        // ?????? parentSignal ? undefined??abort ??/??????????
        return refs.coordinator.delegate(request, signal)
      },
    },
    () => refs.claimStore ?? undefined,
    () => refs.sessionId ?? undefined,
    () => refs.getProblemAttackStore?.() ?? null,
  ))

  // undo ? preset full ???????????
  if (presetIncludes(toolPreset, 'undo')) {
    reg.register(createUndoTool(() => refs.fileHistory ?? undefined))
  }

  // delegate_batch
  reg.register(createDelegateBatchTool(
    {
      delegateBatch: async (requests, policy, abortSignal, onProgress) => {
        if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
        return refs.coordinator.delegateBatch(requests, policy, abortSignal, onProgress)
      },
    },
    () => refs.claimStore ?? undefined,
    () => refs.sessionId ?? undefined,
    () => refs.getProblemAttackStore?.() ?? null,
  ))

  // galaxy ? ???????? Agent ???? Agent ???
  // ?????? starflow???????????????????
  const galaxyTool = createGalaxyTool(
    {
      delegateBatch: async (requests, policy, abortSignal, onProgress, onWorkerSettled) => {
        if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
        return refs.coordinator.delegateBatch(requests, policy, abortSignal, onProgress, onWorkerSettled)
      },
      getRuntimeSnapshot: () => refs.coordinator?.getRuntimeSnapshot() ?? {
        activeWorkers: 0,
        maxWorkers: 0,
        pendingWorkers: 0,
        stalledWorkers: 0,
        inFlightFileScopes: 0,
        backgroundRunning: 0,
        activeClaims: 0,
        providerDegradation: 0,
        shuttingDown: true,
      },
      // ??????? #5??????getter ?????/cd ? store ?????????
      get domainKnowledgeStore() { return refs.domainKnowledgeStoreRef?.current ?? undefined },
      // DP ??????? #2???agent ???? createAgentRuntime ???
      get obligationTracker() { return refs.obligationTrackerRef?.current ?? undefined },
    },
  )
  reg.register(galaxyTool)

  // Shared plan-execution kernel deps: team_orchestrate and plan_task(execute:true)
  // run the SAME closed loop through executePlan (dispatch + scope-health +
  // telemetry + reward/episode closure). plan_task opts out of the review gate
  // (its post-commit auto review covers the diff).
  const planExecutorDeps: PlanExecutorDeps = {
    delegate: async (request, abortSignal) => {
      if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
      return refs.coordinator.delegate(request, abortSignal)
    },
    delegateBatch: async (requests, policy, abortSignal, onProgress) => {
      if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
      return refs.coordinator.delegateBatch(requests, policy, abortSignal, onProgress)
    },
    recordTeamWaveTelemetry: (event: TeamWaveTelemetry) => {
      persistTeamWaveTelemetry(refs.meridianIndexer?.getDb(), event)
    },
    recordTeamWaveRewardClosure: (event: TeamWaveTelemetry) => {
      recordTeamWaveRewardClosure(refs.meridianIndexer?.getDb(), event)
    },
    recordTeamSchedulerShadow: (event: TeamSchedulerShadowEvent) => {
      persistTeamSchedulerShadow(refs.meridianIndexer?.getDb(), event)
    },
    recordGatedInfluenceAudit: (event: GatedInfluenceAuditEvent) => {
      persistGatedInfluenceAudit(refs.meridianIndexer?.getDb(), event)
    },
    recordTeamSchedulerReward: (event: TeamWaveTelemetry) => {
      const rewardInput = deriveTeamWaveRewardInput(event)
      persistTeamSchedulerReward(refs.meridianIndexer?.getDb(), buildTeamSchedulerRewardEvent({
        sessionId: event.sessionId,
        objective: event.objectiveHash,
        waveId: event.waveId,
        arm: teamSchedulerArmForParallelism(event.outcome.dispatched),
        rewardInput: {
          teamWaveReward: computeTeamWaveReward(rewardInput),
          conflictRate: Number(rewardInput.normalizedConflict),
          scopeLeakRate: Number(rewardInput.normalizedScopeLeak),
          falseGreen: rewardInput.falseGreen,
        },
        timestamp: event.timestamp,
      }))
    },
    getTeamSchedulerRewardStore: () => refs.meridianIndexer?.getDb(),
    isTeamSchedulerBanditEnabled: () => resolveBanditPromotion({
      source: 'team_scheduler_bandit',
      mode: effectiveBanditMode(config.agent.banditPromotion?.teamScheduler, config.agent.teamSchedulerBanditEnabled, config.agent.banditPromotion?.killSwitch),
      store: refs.meridianIndexer?.getDb(),
    }).enabled,
    getSessionId: () => refs.sessionId ?? undefined,
    getMeridianIndexer: () => refs.meridianIndexer,
    // ?????5 ??????? 2 ????? runner ? wave-gate ????
    // ???? tsc ?????? passed ???2026-07-07??
    getTypecheckRunner: () => (cwd: string) => runTypeCheck(cwd, '*', GATE_TSC_TIMEOUT_MS),
  }
  let teamOrchestrateTool: ReturnType<typeof createTeamOrchestrateTool> | undefined
  if (presetIncludes(toolPreset, 'team_orchestrate')) {
    teamOrchestrateTool = createTeamOrchestrateTool(planExecutorDeps, {
      defaultMaxParallel: config.agent.maxTeamParallel,
      // Pro gate??????????? Rust ????? RIVET_PRO=1?CLI ??? gate?
      teamMaxEnabled: isProFeatureEnabled(config, 'teamMax'),
    })
    reg.register(teamOrchestrateTool)
  }

  // council_convene ? ???????????? team_orchestrate ???????????
  // autoExecute ? executor ??? executePlan ???? team_orchestrate ?????
  const councilCoordinator: CouncilConveneCoordinator = {
    delegateBatch: async (requests, policy, abortSignal, onProgress) => {
      if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
      return refs.coordinator.delegateBatch(requests, policy, abortSignal, onProgress)
    },
    getSessionId: () => refs.sessionId ?? undefined,
    recordRoutingShadow: event => persistCouncilRoutingShadow(refs.meridianIndexer?.getDb(), event),
    recordCouncilSession: event => recordCouncilSession(refs.meridianIndexer?.getDb(), event),
    executor: planExecutorDeps,
  }
  const councilDefaultSeats = config.agent.council.seats.length > 0 ? config.agent.council.seats : undefined
  const councilOptions = { multiRoundEnabled: isProFeatureEnabled(config, 'councilMultiRound') }
  let councilConveneTool: ReturnType<typeof createCouncilConveneTool> | undefined
  if (presetIncludes(toolPreset, 'council_convene')) {
    councilConveneTool = createCouncilConveneTool(councilCoordinator, councilDefaultSeats, councilOptions)
    reg.register(councilConveneTool)
  }

  // starflow ? ????????council?team?galaxy ?????????? prompt ????
  // minimal/frontend ? preset ?? council_convene ???? preset ???????
  // ???????????????????????????????????
  reg.register(createStarflowTool({
    councilTool: councilConveneTool ?? createCouncilConveneTool(councilCoordinator, councilDefaultSeats, councilOptions),
    teamTool: teamOrchestrateTool ?? createTeamOrchestrateTool(planExecutorDeps, {
      defaultMaxParallel: config.agent.maxTeamParallel,
      teamMaxEnabled: isProFeatureEnabled(config, 'teamMax'),
    }),
    galaxyTool,
    cwd,
  }))

  // recall_capsule
  reg.register(createRecallCapsuleTool(() => cwd))

  // ?????B1/B2??recall_general ????record_general_finding ?????
  // ?? = ???????? = ????????preset full ???
  if (presetIncludes(toolPreset, 'recall_general')) reg.register(createRecallGeneralTool(() => cwd))
  if (presetIncludes(toolPreset, 'record_general_finding')) reg.register(createRecordGeneralFindingTool(() => cwd))

  // ask_user_question
  reg.register(ASK_USER_QUESTION_TOOL)

  // browser_debug ? persistent browser for local frontend/backend?? (CDP route).
  // preset frontend/full ??RIVET_BROWSER_DEBUG=1 ?????
  // render-verify-hook ????????
  if (presetIncludes(toolPreset, 'browser_debug') || process.env.RIVET_BROWSER_DEBUG === '1') {
    reg.register(BROWSER_DEBUG_TOOL)
  }

  // repo_graph ? meridian ????preset full ??RIVET_REPO_GRAPH=1 ?????
  if (presetIncludes(toolPreset, 'repo_graph') || process.env.RIVET_REPO_GRAPH === '1') {
    reg.register(createRepoGraphTool(() => refs.meridianIndexer))
  }

  // related_tests ? override the no-indexer default with a meridian-aware factory
  if (presetIncludes(toolPreset, 'related_tests')) {
    reg.register(createRelatedTestsTool(() => refs.meridianIndexer))
  }

  if (presetIncludes(toolPreset, 'semantic_search')) reg.register(SEMANTIC_SEARCH_TOOL)
  // APPLY_PATCH: EXTENDED layer ? overlap with hash_edit covers >90% of
  // use cases; kept here (interactive) for edge cases (e.g. git-format patches).
  reg.register(APPLY_PATCH_TOOL)
  // W5 session_vitals: EXTENDED layer?interactive ????? kernel budget??
  // ???????????"????"??????????incident 20b9714e??
  // ??????????????? = ????? miss???????
  if (presetIncludes(toolPreset, 'session_vitals')) {
    reg.register(createSessionVitalsTool(() => refs.getSessionVitals?.() ?? null))
  }
  // PAL attack_case????????????? + ???? + ?????
  // preset full ????????????2026-07-19 ????????
  if (presetIncludes(toolPreset, 'attack_case')) {
    reg.register(createAttackCaseTool({
      getStore: () => refs.getProblemAttackStore?.() ?? null,
      getVerifier: () => refs.getAttackEvidenceVerifier?.() ?? null,
    }))
  }

  // web_search is now in the kernel default-registry (CORE layer).
  // Remove the interactive registration to avoid double-registration.
  // PLAN_MODE_ALLOWED_TOOLS already references web_search alongside recall.
  reg.register(createPlanTaskTool({
    getCoordinator: () => refs.coordinator,
    getExecutorDeps: () => planExecutorDeps,
    getSessionId: () => refs.sessionId ?? undefined,
    // ??????plan_task ???? store?TUI ? defaultStore???????
    writeTodos: todos => refs.todoStore.write(todos),
  }))

  // B1 deliver_task
  // sidecar ? session ????? refs.sessionId??? session ??????
  // ?? getOrCreateSessionId ?? TUI ? session ????? fallback?
  const b1TaskLedger = createTaskLedger({ taskId: refs.sessionId ?? getOrCreateSessionId() })
  refs.taskLedger = b1TaskLedger
  const b1Baseline = createWorktreeBaseline(captureGitBaseline(cwd))
  const b1Ownership = createOwnershipLedger({
    baseline: b1Baseline,
    taskLedger: b1TaskLedger,
  })
  refs.ownershipLedger = b1Ownership
  // VSW: best-effort reap of worktrees left by dead sessions, then a session-scoped
  // manager. ?6 policy keeps a single clean session in-place (head==='' ? not a git
  // repo ? in-place; no other sessions on this cwd in the CLI path ? in-place),
  // so behavior is unchanged unless the baseline is dirty or RIVET_VSW=1 forces it.
  try { reapOrphanSnapshots({ baseCwd: cwd, currentSessionId: refs.sessionId ?? undefined }) } catch { /* best-effort */ }
  try { reapOrphanHandsWorktrees({ baseCwd: cwd, currentSessionId: refs.sessionId ?? undefined }) } catch { /* best-effort */ }
  try { cleanupStaleHandsBranches(cwd) } catch { /* best-effort */ }
  // C4: config-declared VSW mode. 'off' skips the manager entirely (pipeline
  // degrades to in-place); 'always' forces isolation; 'auto' = ?6 matrix.
  // RIVET_VSW=1 keeps its historical force semantics on top of any mode.
  const vswMode = config.agent.verificationSnapshot
  const b1SnapshotManager = vswMode === 'off' ? null : createVerificationSnapshotManager({
    baseCwd: cwd,
    sessionId: refs.sessionId ?? getOrCreateSessionId(),
    baselineHead: b1Baseline.getHead() || undefined,
    isGitRepo: b1Baseline.getHead().length > 0,
    preExistingDirtyCount: b1Baseline.getExternalDirtyCount(),
    preExistingUntrackedCount: b1Baseline.getExternalUntrackedCount(),
    // C2: sameCwdRunningSessions fallback now queries SessionRegistry (cross-process,
    // registry.db in shared stateDir). Previously hardcoded () => 0 so VSW never
    // activated for multi-TUI scenarios. Sidecar-provided getSameCwdRunningSessions
    // still takes priority when available.
    sameCwdRunningSessions: refs.getSameCwdRunningSessions
      ?? (() => refs.sessionRegistry?.countSameCwdActive(cwd, refs.sessionId ?? '') ?? 0),
    forceSnapshot: process.env.RIVET_VSW === '1' || vswMode === 'always',
  })
  refs.verificationSnapshotManager = b1SnapshotManager
  const b1Attribution = createVerificationAttribution({ ownership: b1Ownership })
  const b1Gate = createDeliveryGateV2({
    taskLedger: b1TaskLedger,
    ownership: b1Ownership,
    attribution: b1Attribution,
  })
  refs.deliveryGate = b1Gate
  reg.register(createDeliverTaskTool((params) => ({
    taskLedger: b1TaskLedger,
    ownership: b1Ownership,
    gate: b1Gate,
    getCurrentSnapshotRef: () => b1SnapshotManager?.currentSnapshotRef() ?? undefined,
    sessionRegistry: refs.sessionRegistry ?? undefined,
    sessionId: refs.sessionId ?? undefined,
    reviewDepth: params?.reviewDepth ?? 0,
    getDepthLayer: () => refs.promptEngine?.getTaskDepthLayer(),
    reviewDeps: createCoordinatorReviewDeps({
      delegate: async (request, abortSignal) => {
        if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
        return refs.coordinator.delegate(request, abortSignal)
      },
      delegateBatch: async (requests, policy, abortSignal, onProgress) => {
        if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
        return refs.coordinator.delegateBatch(requests, policy, abortSignal, onProgress)
      },
    }, { reviewDepth: params?.reviewDepth ?? 0 }),
    isGoalActive: () => refs.goalTrackerRef.current?.isActive() ?? false,
    isGoalAchieved: () => refs.goalTrackerRef.current?.isGoalAchieved() ?? false,
    getLastVerdict: () => refs.goalTrackerRef.current?.getLastVerdict() ?? null,
    reviewConfig: config.agent.review,
    autoCommit: config.agent.delivery?.autoCommit !== false,
    isAutoReviewOff: () => refs.reviewGateRef.current === 'off',
    meridianIndexer: refs.meridianIndexer,
    getTaskContract: () => refs.getTaskContract?.(),
    getImpactedTests: () => refs.getImpactedTests?.() ?? [],
    // P4 ????PAL ??????????? store??B1Context ????????
    // hook ??"??"??????? getter ??????????
    getPalConvergedCases: () => refs.getProblemAttackStore?.()?.convergedCasesSnapshot() ?? [],
    // ???? W-A1?needs_user ?????minimalQuestion ? store ????
    getPalNeedsUserCases: () => refs.getProblemAttackStore?.()?.needsUserCasesSnapshot() ?? [],
    // ?? #2???????????????????????????????
    getObligationStore: () => refs.obligationTrackerRef?.current?.getStore() ?? emptyObligationStore(),
    getClaimTracker: () => refs.claimTrackerRef?.current?.() ?? undefined,
    scoutFirewallConfig: config.agent.scoutEvidenceFirewall,
  })))

  // update_goal ? model-driven goal lifecycle control (paused/blocked/complete)
  if (presetIncludes(toolPreset, 'update_goal')) {
    reg.register(createUpdateGoalTool(
      () => refs.goalTrackerRef.current,
      () => ({ sessionId: refs.sessionId ?? undefined, cwd }),
    ))
  }

  return { registry: reg }
}

// ?? Agent Runtime ??????????????????????????????????????????????

/**
 * resume ?????????????? user ??????????
 * ???? `<id>.frozen.json`?best-effort?????????????
 * ???? resume ?????????startup / /resume ?? / /cd ??????
 */
function wireFrozenSnapshotPersist(persist: SessionPersist, engine: import('./prompt/engine.js').PromptEngine): void {
  engine.setOnFrozenSnapshotCommit(() => {
    try { persist.writeFrozenSnapshot(engine.exportFrozenSnapshot()) } catch { /* best-effort */ }
  })
}

export function createAgentRuntime(deps: {
  provider: ProviderConfig
  apiKey: string
  auth: AuthProvider | undefined
  config: Config
  sessionId: string
  cwd: string
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>
  persist: SessionPersist
  claimStore: import('./context/claim-store.js').ContextClaimStore
  fileHistory: FileHistory
  refs: RuntimeRefs
  domainKnowledgeStore: DomainKnowledgeStore
  modelId?: string
  session: SessionContext
  /**
   * Wave J: ???? ProviderHealthTracker?sidecar ? session + switchModel
   * ??????per-call new ?????? provider ????????/????
   * coordinator ????????????????????registerProvider
   * ???????????TUI ? session ???????????
   */
  sharedProviderHealth?: ProviderHealthTracker
  /** I4: optional callback to surface user hook results to the desktop event stream. */
  emitHookResult?: import('./agent/loop-types.js').AgentConfig['emitHookResult']
  /** /cd: previous PromptEngine whose frozen snapshots the new engine inherits
   *  (keeps the historical prefix byte-stable across the cwd switch).
   *  resume ????? FrozenSnapshotData?<id>.frozen.json?????? */
  inheritFrozenFrom?: import('./prompt/engine.js').PromptEngine | import('./prompt/frozen-snapshot.js').FrozenSnapshotData
}): { agent: AgentLoop } {
  const {
    provider, apiKey, auth, config, sessionId, cwd,
    toolRegistry, persist, claimStore, fileHistory, refs,
    domainKnowledgeStore, modelId,
  } = deps

  const currentModel = modelId
    ? (provider.models.find(m => m.id === modelId || m.alias === modelId) ?? provider.models[0]!)
    : provider.models[0]!

  const agentCfg = createAgentConfig(createMainAgentConfigInput({
    apiKey,
    model: {
      id: currentModel.id,
      maxTokens: currentModel.maxTokens,
      contextWindow: currentModel.contextWindow,
      reasoningEffort: currentModel.reasoningEffort,
      supportsVision: currentModel.supportsVision,
    },
    cwd,
    provider,
    allProviders: config.provider.providers,
    config,
    sessionId,
    // ?????????? createAgentConfig ?? gateToolDefinitions ???
    // ? AgentLoop.updateTools() ??????????? MCP/LSP ??????????
    toolDefinitions: toolRegistry.getDefinitions(),
    sessionMemoryBlock: persist.buildMemoryBlock(),
    auth,
    inheritFrozenFrom: deps.inheritFrozenFrom,
  }))

  // Model capability cards?????? model/capability.ts??v4-flash ???????
  const modelCards: ModelCapabilityCard[] = buildModelCards(provider)

  // Review override: pre-resolve each profile's provider/model + validate
  // credentials eagerly, but defer StreamClient construction to runtimeFactory
  // so maxTokens/thinkingBudget can be set from per-call isWrite (read vs write
  // profile). Without this deferral, override workers were hardcoded to 4096
  // even for write profiles like 'patcher' ? half the token budget of normal
  // workers. Mirrors create-agent-config.ts:162-168 cross-provider client
  // factory. Skip on credential failure ? fall through to primary client.
  const overrideState = config.agent.review?.profiles
    ? buildReviewOverrideState(config.agent.review.profiles, config.provider.providers)
    : { cards: new Map<string, ModelCapabilityCard>(), overrides: new Map<string, ResolvedReviewOverride>() }
  const reviewOverrideCards = overrideState.cards
  const reviewOverrides = overrideState.overrides
  const reviewOverrideApiKeys = new Map<string, string>()
  for (const [profileName, resolved] of reviewOverrides) {
    try { reviewOverrideApiKeys.set(profileName, resolveApiKey(resolved.providerConfig)) } catch {
      debugLog(`[review-override] skip ${profileName}: no API key for ${resolved.providerName}`)
      reviewOverrides.delete(profileName)
      reviewOverrideCards.delete(profileName)
    }
  }

  // Worker routing
  const workerRouting = config.workers?.profiles && Object.keys(config.workers.profiles).length > 0
    ? { profiles: config.workers.profiles, routing: config.workers.routing, providers: config.provider.providers }
    : undefined

  // Physarum provider health: shared between main loop (sensorium stability)
  // and coordinator (cold-tier routing skip). Stream outcomes feed weights.
  // Wave J: sidecar ?? sharedProviderHealth ? health ??? session +
  // switchModel ???registerProvider ???????????TUI ?????
  // per-call new ?????? session ????????
  const providerHealth = deps.sharedProviderHealth ?? new ProviderHealthTracker()
  providerHealth.registerProvider(provider.name)
  if (workerRouting?.providers) {
    for (const name of Object.keys(workerRouting.providers)) providerHealth.registerProvider(name)
  }

  const runtimeFactory: WorkerRuntimeFactory = (_order, card, workerRegistry) => {
    const writeProfiles = profileRegistry.listWriteProfiles()
    const isWrite = writeProfiles.includes(_order.profile)
    // ????????? project-instructions ?? + compact ????????
    // ?modelOverride / review-override / ???????????????????
    const blocks = subagentPromptBlocks()
    const subagentTools = () => applyDescriptionMode(workerRegistry.getDefinitions(), blocks.toolDescriptions)

    // Per-order modelOverride: highest precedence (above review override and
    // workers routing). Builds a dedicated client for the seat's provider/model
    // so e.g. a council with one DeepSeek-Pro seat and one GLM seat runs each on
    // its own server-side cache. Falls through to normal routing when the
    // provider is unknown / lacks the model / has no credentials (silent
    // fallback, consistent with the other routing layers).
    if (_order.modelOverride) {
      const ovProvider = config.provider.providers[_order.modelOverride.provider]
      const ovModel = _order.modelOverride.model
      const ovModelOk = ovProvider?.models.some(m => m.id === ovModel || m.alias === ovModel)
      if (ovProvider && ovModelOk) {
        let ovApiKey = ''
        let ovAuth: ReturnType<typeof createAuthProvider> | undefined
        let ovReady = false
        try {
          if (ovProvider.auth?.type === 'oauth') {
            ovAuth = ovProvider.name === provider.name ? auth : createAuthProvider(ovProvider.auth, process.env)
            ovReady = Boolean(ovAuth?.isAuthenticated())
          } else {
            ovApiKey = resolveApiKey(ovProvider)
            ovReady = Boolean(ovApiKey)
          }
        } catch {
          ovReady = false
        }
        if (ovReady) {
          const ovSpec = ovProvider.models.find(m => m.id === ovModel || m.alias === ovModel)
          const ovContextWindow = ovSpec?.contextWindow ?? card.contextWindow
          const ovMaxTokens = isWrite
            ? Math.min(16384, ovSpec?.maxTokens ?? ovContextWindow)
            : Math.min(16384, ovSpec?.maxTokens ?? ovContextWindow)
          const ovCapabilities = resolveCapabilities(ovProvider.name, ovProvider.capabilities)
          debugLog(`[worker-model] modelOverride active: profile=${_order.profile} authority=${_order.authority} ? ${ovProvider.name}/${ovModel} isWrite=${isWrite}`)
          return {
            order: _order,
            providerName: ovProvider.name,
            client: createProviderClient(ovProvider, ovCapabilities, {
              apiKey: ovApiKey,
              model: ovModel,
              reasoningEffort: undefined,
              maxTokens: ovMaxTokens,
              thinkingBudget: isWrite ? 8192 : 4096,
              auth: ovAuth,
            }),
            promptEngine: new PromptEngine({
              model: ovModel,
              maxTokens: ovMaxTokens,
              staticCtx: { tools: subagentTools(), audience: 'subagent' },
              volatileCtx: { cwd, sessionMemoryBlock: persist.buildMemoryBlock(), blockCaps: blocks.caps },
            }),
            toolRegistry: workerRegistry,
            blockPolicy: blocks,
            cwd,
            maxTurns: 40,
            contextWindow: ovContextWindow,
            compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
            activeClaims: claimStore.listActiveClaims(),
            domainKnowledgeStore,
            forceJsonRepair: ovCapabilities.supportsResponseFormat,
          }
        }
        debugLog(`[worker-model] modelOverride skip: ${_order.modelOverride.provider}/${ovModel} no credentials ? fallback`)
      } else {
        debugLog(`[worker-model] modelOverride skip: provider=${_order.modelOverride.provider} modelOk=${ovModelOk} ? fallback`)
      }
    }

    // Review override fast path: if the profile is configured for a different
    // provider, use the pre-resolved override (different provider+model from
    // session primary). This is the whole point of the override ? review
    // workers must NOT touch the session primary's server-side cache (GLM
    // cache-killer mechanism). StreamClient is built lazily here (not at
    // bootstrap) so maxTokens/thinkingBudget reflect this call's isWrite ?
    // ???? 16384????????? 4096 ???????????????
    // ??????????????matching the non-override worker path.
    const overrideResolved = reviewOverrides.get(_order.profile)
    if (overrideResolved) {
      const overrideApiKey = reviewOverrideApiKeys.get(_order.profile)
      if (!overrideApiKey) {
        debugLog(`[review-override] skip ${_order.profile}: no cached API key (credential failure at bootstrap)`)
      } else {
        const overrideSpec = overrideResolved.providerConfig.models.find(
          m => m.id === overrideResolved.modelId || m.alias === overrideResolved.modelId,
        )
        const overrideContextWindow = overrideSpec?.contextWindow ?? card.contextWindow
        const overrideMaxTokens = isWrite
          ? Math.min(16384, overrideSpec?.maxTokens ?? overrideContextWindow)
          : Math.min(16384, overrideSpec?.maxTokens ?? overrideContextWindow)
        debugLog(`[worker-model] review-override active: profile=${_order.profile} model=${overrideResolved.modelId} isWrite=${isWrite}`)
        const overrideCapabilities = resolveCapabilities(overrideResolved.providerName, overrideResolved.providerConfig.capabilities)
        return {
          order: _order,
          providerName: overrideResolved.providerName,
          client: createProviderClient(
            overrideResolved.providerConfig,
            overrideCapabilities,
            {
              apiKey: overrideApiKey,
              model: overrideResolved.modelId,
              reasoningEffort: undefined,
              maxTokens: overrideMaxTokens,
              thinkingBudget: isWrite ? 8192 : 4096,
            },
          ),
          promptEngine: new PromptEngine({
            model: overrideResolved.modelId,
            maxTokens: overrideMaxTokens,
            staticCtx: { tools: subagentTools(), audience: 'subagent' },
            volatileCtx: { cwd, sessionMemoryBlock: persist.buildMemoryBlock(), blockCaps: blocks.caps },
          }),
          toolRegistry: workerRegistry,
          blockPolicy: blocks,
          cwd,
          maxTurns: 40,
          contextWindow: overrideContextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
          activeClaims: claimStore.listActiveClaims(),
          domainKnowledgeStore,
          forceJsonRepair: overrideCapabilities.supportsResponseFormat,
        }
      }
    }

    let workerProvider = provider
    let workerApiKey = apiKey
    let workerAuth = auth
    let workerModel = card.model

    if (workerRouting) {
      const routeName = workerRouting.routing[mapWorkOrderKindToCapabilityTask(_order.kind)]
      if (routeName && workerRouting.profiles[routeName]) {
        const routeProfile = workerRouting.profiles[routeName]
        const resolved = config.provider.providers[routeProfile.provider]
        // Route to the configured provider+model as long as the provider exists and
        // actually offers the configured model. The previous guard required
        // `routeProfile.model === card.model`, which defeated the whole point of
        // worker routing (independent model ? isolated server-side prefix cache):
        // any profile configured with a DIFFERENT model was silently skipped and
        // workers fell back to the primary model, competing with the primary
        // session's cache entries. Now we allow a distinct model and set it on
        // workerModel so the worker actually runs on the routed model.
        if (resolved && resolved.models.some(m => m.id === routeProfile.model || m.alias === routeProfile.model)) {
          try {
            if (resolved.auth?.type === 'oauth') {
              const routedAuth = resolved.name === provider.name
                ? auth
                : createAuthProvider(resolved.auth, process.env)
              if (routedAuth?.isAuthenticated()) {
                workerProvider = resolved
                workerModel = routeProfile.model
                workerApiKey = ''
                workerAuth = routedAuth
              }
            } else {
              workerProvider = resolved
              workerModel = routeProfile.model
              workerApiKey = resolveApiKey(resolved)
              workerAuth = undefined
            }
          } catch {
            workerProvider = provider
            workerApiKey = apiKey
            workerAuth = auth
          }
        }
      }
    }

    if (!workerProvider.models.some(m => m.id === workerModel || m.alias === workerModel)) {
      workerModel = currentModel.id
    }
    const workerModelSpec = workerProvider.models.find(m => m.id === workerModel || m.alias === workerModel)
    const workerContextWindow = workerModelSpec?.contextWindow ?? card.contextWindow
    const workerMaxTokens = isWrite
      ? Math.min(16384, workerModelSpec?.maxTokens ?? workerContextWindow)
      : Math.min(16384, workerModelSpec?.maxTokens ?? workerContextWindow)

    debugLog(`[worker-model] runtimeFactory: kind=${_order.kind} profile=${_order.profile} model=${workerModel} provider=${workerProvider.name} contextWindow=${workerContextWindow}`)

    const workerCapabilities = resolveCapabilities(workerProvider.name, workerProvider.capabilities)
    return {
      order: _order,
      providerName: workerProvider.name,
      client: createProviderClient(workerProvider, workerCapabilities, {
        apiKey: workerApiKey,
        model: workerModel,
        reasoningEffort: undefined,
        maxTokens: workerMaxTokens,
        thinkingBudget: isWrite ? 8192 : 4096,
        auth: workerAuth,
      }),
      promptEngine: new PromptEngine({
        model: workerModel,
        maxTokens: workerMaxTokens,
        // audience:'subagent' ? ????? system ?????????/???
        // ?????? worker ???????????????????????
        staticCtx: { tools: subagentTools(), audience: 'subagent' },
        volatileCtx: { cwd, sessionMemoryBlock: persist.buildMemoryBlock(), blockCaps: blocks.caps },
      }),
      toolRegistry: workerRegistry,
      blockPolicy: blocks,
      cwd,
      maxTurns: 40,
      contextWindow: workerContextWindow,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      activeClaims: claimStore.listActiveClaims(),
      domainKnowledgeStore,
      // Use response_format: json_object on repair turns when the provider
      // supports it ? forces valid JSON output, eliminating the most common
      // worker-result parse-failure cause (free-text prose / truncation).
      // Only applied to the tool-free repair turn, so it never conflicts with
      // function calling on normal turns.
      forceJsonRepair: workerCapabilities.supportsResponseFormat,
    }
  }

  // EFE routing pulls per-turn signals from the agent. Build the agent first so
  // its ArtifactStore can be wired into the coordinator for worker artifact fallback.
  let agentForSignals: AgentLoop | undefined

  // Track 1: unified shadow?gated promotion gate. Evidence is evaluated once
  // per session; `banditPromotion.killSwitch` rolls every path back at once.
  const promo = config.agent.banditPromotion
  const promotionStore = refs.meridianIndexer?.getDb()
  const modelTierGate = resolveBanditPromotion({
    source: 'model_tier_bandit',
    mode: effectiveBanditMode(promo?.modelTier, config.agent.modelTierBanditEnabled, promo?.killSwitch),
    store: promotionStore,
  })
  const modelRoutingGate = resolveBanditPromotion({
    source: 'model_routing',
    mode: effectiveBanditMode(promo?.modelRouting, config.agent.modelRoutingGatedEnabled, promo?.killSwitch),
    store: promotionStore,
  })
  const effortGate = resolveBanditPromotion({
    source: 'effort_bandit',
    mode: effectiveBanditMode(promo?.effort, undefined, promo?.killSwitch),
    store: promotionStore,
  })

  // T5: expose bandit state for /status observability
  refs.banditState = [modelTierGate, modelRoutingGate, effortGate].map(g => ({
    source: g.source,
    mode: g.mode,
    enabled: g.enabled,
    reason: g.reason,
    totalShadowSamples: g.evidence.totalShadowSamples,
  }))

  const agent = new AgentLoop(
    {
      ...agentCfg,
      toolRegistry,
      // YOLO ?????????????????????/yes??????sidecar
      // serve.ts???? maxTurns ? 0??????? YOLO ??? ? ??????
      // ???????YOLO ??? config maxTurns?? 50???turn 45 ????
      // ???turn 50 ? GUARD ????session 92a38900?????=??????
      maxTurns: config.agent.approval === 'dangerously-skip-permissions' ? 0 : config.agent.maxTurns,
      checkpointEveryTurns: config.agent.checkpointEveryTurns,
      getSessionMemoryState: () => persist.getSessionMemoryState(),
      fileHistory,
      contextClaimStore: claimStore,
      // Playbook ?????2026-07-06?RIVET_PLAYBOOK=1 ???????????
      // ?????????????deliver_task ???????context ?? merge
      // ?????? matchScore ? useCount ?? + recordUsage ?????????
      // ???????????????????????? 2 ??? ?8 ??????
      // ??? store ????????? / dream ?? / playbook-reflect ?? /
      // recordUsage ??????????????????????? 80e0c530??
      playbookStore: process.env['RIVET_PLAYBOOK'] === '1' ? new PlaybookStore(cwd) : undefined,
      providerHealth,
      effortBanditEnabled: effortGate.enabled,
      taskLedger: refs.taskLedger ?? undefined,
      ownershipLedger: refs.ownershipLedger ?? undefined,
      verificationSnapshotManager: refs.verificationSnapshotManager ?? undefined,
      // T4: late-bound LSP manager ? initialized asynchronously after agent creation
      getLspManager: () => refs.lspManager,
      // Track 3 ?????badge ???????? v2 ???
      deliveryGateV2: refs.deliveryGate
        ? (dirty) => refs.deliveryGate!.assess([], dirty)
        : undefined,
      meridianIndexer: refs.meridianIndexer,
      modelRoutingShadowModelCards: modelCards,
      domainKnowledgeStore,
      emitHookResult: deps.emitHookResult,
      // ??????turn-end ??????? todo-reminder ???????? store?
      // TUI ? refs.todoStore ??? defaultStore???????server ???????
      // ???? refs?switchModel ?? loop ????? refs/todoStore?? ????????
      getTodos: () => refs.todoStore.read(),
      getTodoRegressionStats: () => refs.todoStore.getRegressionStats(),
    },
    deps.session,
    cwd,
  )
  agentForSignals = agent

  refs.coordinator = new DelegationCoordinator({
    baseToolRegistry: toolRegistry,
    modelCards,
    // P1-6 ????????????? 3?????? resolveCoordinatorMaxWorkers??
    // ????? CoordinatorState ?????? WorkOrderQueue ???????
    // ??????activeWorkerCount ? maxWorkers?? coordinator ????
    maxWorkers: resolveCoordinatorMaxWorkers(config),
    ...resolveCoordinatorPoolCaps(config),
    providers: config.provider.providers,
    runtimeFactory,
    routing: workerRouting,
    providerHealth,
    domainKnowledgeStore,
    modelTierShadowStore: refs.meridianIndexer?.getDb(),
    modelTierBanditEnabled: modelTierGate.enabled,
    gatedInfluenceAuditStore: refs.meridianIndexer?.getDb(),
    efeRouting: {
      enabled: modelRoutingGate.enabled,
      getSignals: () => agentForSignals?.getPolicySignals(),
    },
    sessionRegistry: refs.sessionRegistry ?? undefined,
    sessionId: refs.sessionId ?? undefined,
    artifactStore: agent.artifactStore,
    // Wave 3 ????????episode ???writeGate/falseGreen?+ aggregation
    // ???verifyWorkerEvidence ?????????????shadow ????
    onControlSignal: signal => { agent.controlPlane.submit(signal) },
    // ???????evidence-driven reasoning loop??worker ???????
    // ?? external_claim ????delegate ??????????? read/grep/
    // ???????worker_claim_requires_primary_evidence????????
    // ?? worker unverified ?????single voice??
    onVerifiedResults: results => {
      for (const result of results) {
        if (result.evidenceStatus === 'unverified' && result.changedFiles.length > 0) {
          agent.obligations.upsert({
            family: 'external_claim',
            claim: `worker ${result.workOrderId} ?????????????`,
            targets: result.changedFiles,
            risk: 'high',
          })
        }
      }
    },
    resumeEnabled: true,
    reviewOverrideCards: reviewOverrideCards.size > 0 ? reviewOverrideCards : undefined,
    maxDelegationDepth: config.agent.maxDelegationDepth,
    // Shared-worktree mode: write workers run directly in the controller's single
    // shared cwd/branch (no per-worker git worktree, no diff??/apply_patch merge).
    // Orthogonal shards write disjoint files; the file-claim registry +
    // groupTeamTasks same-file serialization prevent stomping. Mirrors the real
    // "multiple sessions, one branch" workflow.
    sharedWorktree: true,
    patcherTier: config.workers.patcherTier,
    escalationCap: config.workers.escalationCap,
    // Downward trust delegation: a primary running dangerously-skip-permissions
    // opted out of all prompts, so its workers inherit that. Any other mode is
    // ignored downstream ? workers rely on headless approval semantics instead.
    parentApprovalMode: config.agent.approval as import('./agent/loop-types.js').ApprovalMode,
    // D8 L2???????????objective ?? .md ?????????????????
    // ?? worker ???best-effort?????????????????
    getPlanConstraints: objective =>
      resolvePlanConstraints(cwd, {
        objective,
        fromContract: agent.getTaskContract()?.planConstraints,
      }),
  })

  // H4-D3 ?????session meta ?? PAL ?????????? resume?
  // ????????????? agent ??????????????????
  // schemaVersion ?? ? ??? store?fail-closed???????
  try {
    const palSnapshot = persist.loadMetadata()?.palSnapshot
    if (palSnapshot) agent.problemAttack.restoreSnapshot(palSnapshot)
  } catch { /* best-effort???????? agent ?? */ }

  // ??????????deliver_task ??? store??? #2 ????????
  // galaxy DP ????/???????switchModel ?????????????
  if (refs.obligationTrackerRef) refs.obligationTrackerRef.current = agent.obligations
  if (refs.claimTrackerRef) refs.claimTrackerRef.current = agent.externalClaimTracker ?? null

  return { agent }
}

// ?? MCP Initialization ?????????????????????????????????????????

export async function initializeMcp(
  config: Config,
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>,
  refs: RuntimeRefs,
): Promise<void> {
  if (!config.mcp.enabled || Object.keys(config.mcp.servers).length === 0) return

  try {
    const { McpManager } = await import('./mcp/manager.js')
    const mgr = new McpManager(config.mcp)
    refs.mcpManager = mgr

    await mgr.initialize()
    const mcpTools = mgr.getAllTools()
    for (const tool of mcpTools) {
      toolRegistry.register(tool)
    }

    const states = mgr.getStates()
    const connected = states.filter(s => s.status === 'connected')
    const failed = states.filter(s => s.status === 'error')
    if (connected.length > 0 || failed.length > 0) {
      const parts: string[] = []
      if (connected.length > 0) {
        const toolCount = connected.reduce((s, c) => s + c.toolCount, 0)
        parts.push(`${connected.length} server(s) connected (${toolCount} tools)`)
      }
      if (failed.length > 0) {
        parts.push(`${failed.length} server(s) failed: ${failed.map(s => `${s.serverId}: ${s.error}`).join(', ')}`)
      }
      // Use debugLog instead of console.error ? console.error writes directly
      // to stderr, bypassing the LiveEngine's row management. When MCP loads
      // asynchronously after the TUI's first frame, this rogue line corrupts
      // the engine's cursor tracking, causing double-border ghost rendering
      // on the next slash-command redraw.
      debugLog(`[MCP] ${parts.join('; ')}`)
    }
  } catch (err) {
    console.error('[MCP] Initialization failed:', (err as Error).message)
  }
}

// ?? LSP Initialization ?????????????????????????????????????????

export async function initializeLsp(
  cwd: string,
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>,
): Promise<ReturnType<typeof createLspManager>> {
  // Polyglot: the multi-language manager routes each file to its matching
  // server (typescript-language-server / pyright / gopls / rust-analyzer /
  // clangd / jdtls), lazily spawning installed ones on first use.
  const lspManager = createMultiLspManager(cwd)

  try {
    await lspManager.initialize()
    if (lspManager.isReady()) {
      toolRegistry.register(createGotoDefinitionTool(lspManager))
      toolRegistry.register(createFindReferencesTool(lspManager))
      if (process.env['RIVET_DEBUG']) {
        const servers = availableServers().map(s => s.id).join(', ')
        console.error(`[LSP] polyglot LSP ready ? available servers: ${servers}`)
      }
    } else if (process.env['RIVET_DEBUG']) {
      console.error('[LSP] no language servers installed ? code-intelligence tools not registered')
    }
  } catch (err) {
    console.error('[LSP] Initialization error:', (err as Error).message)
  }

  return lspManager
}

// ?? Session Infrastructure ?????????????????????????????????????

export async function createSessionInfrastructure(): Promise<{
  registry: import('./agent/session-registry.js').SessionRegistry
  sessionId: string
  heartbeatInterval: ReturnType<typeof setInterval>
}> {
  const stateDirPath = stateDir()
  const { SessionRegistry } = await import('./agent/session-registry.js')
  const registry = await SessionRegistry.create(stateDirPath)

  // Reap dead sessions' registry rows/claims so they don't block fresh claims.
  // Default startup is fresh ? we do NOT auto-resume crashed sessions; this only
  // releases their locks. Recover a crashed session explicitly with
  // `rivet --continue` (most recent) or `rivet --resume <id>`.
  const crashedSessions = registry.detectCrashedSessions()
  if (crashedSessions.length > 0) {
    // ??????????????--continue/--resume?? /help ???????????
    console.error(`? ??? ${crashedSessions.length} ??????????`)
  }

  const sessionId = getOrCreateSessionId()
  registry.register(sessionId, process.cwd())

  const heartbeatInterval = setInterval(() => {
    try { registry.heartbeat(sessionId) } catch { /* ignore */ }
  }, 10_000).unref()

  return { registry, sessionId, heartbeatInterval }
}

// ?? Shutdown Handler ???????????????????????????????????????????

/** H2 ???????????????recentToolHistory / ObligationStore?
 *  ?? attack_case ? evidence_ref????????????
 *  tool: ?????? + ?????????????????? = unverified
 *  ?????????obligation: ?????? id? */
function makeAttackEvidenceVerifier(agent: AgentLoop): import('./tools/attack-case.js').AttackEvidenceVerifier {
  return {
    toolRan: (name, targetHint) => agent.recentToolHistory.some(e => {
      if (e.tool !== name) return false
      if (!targetHint || !e.target) return true
      return e.target.includes(targetHint) || targetHint.includes(e.target)
    }),
    obligationExists: id => agent.obligations.getStore().obligations.some(o => o.id === id),
    // H4-D4?worker ??????? orderId ?????????"?????"?
    workerCompleted: orderId => agent.problemAttack.hasWorkerCompleted(orderId),
    // P4 ????close(converged) ???"??????"?????
    openObligationIdsForTargets: targets => agent.obligations.getStore().obligations
      .filter(o => (o.state === 'open' || o.state === 'attempted')
        && o.targets.some(t => targets.some(ht => t.includes(ht) || ht.includes(t))))
      .map(o => o.id),
  }
}

export function createShutdownHandler(ctx: BootstrapContext): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined
  return () => {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      try {
        // Mark a clean exit. Next startup mints a fresh session by default;
        // returning here requires explicit --continue / --resume <id> (R1).
        try { ctx.persist.updateMetadata({ cleanExit: true }) } catch { /* best-effort */ }
        // resume ????? shutdown flush??? collapse watermark ???
        // commit ?????????? wireFrozenSnapshotPersist ?????
        try { ctx.persist.writeFrozenSnapshot(ctx.agent.config.promptEngine.exportFrozenSnapshot()) } catch { /* best-effort */ }
        ctx.persist.compactOai(ctx.session.getMessages())
        if (ctx.fileHistory) {
          persistFileHistory(
            join(getSessionDir(ctx.cwd), ctx.sessionId, 'file-history.json'),
            ctx.fileHistory.getAllSnapshots(),
          )
        }
        ctx.agent.flushStigmergySync()
        ctx.agent.abort()
      } catch (err) {
        try { process.stderr.write(`[shutdown] callback error: ${(err as Error)?.message}\n`) } catch { /* noop */ }
      } finally {
        if (ctx.heartbeatInterval) clearInterval(ctx.heartbeatInterval)
        try { ctx.refs.lspManager?.dispose() } catch { /* best-effort */ }
        try { ctx.refs.mcpManager?.killChildrenSync?.() } catch { /* best-effort */ }
        void ctx.refs.mcpManager?.shutdown?.()
        // Wait for coordinator finally blocks so session claims are released
        // before a handoff or the next process can enter this workspace.  Do
        // not unregister on a timeout: an abort is advisory for providers that
        // ignore AbortSignal, and their worker may still be writing files.
        let workersSettled = !ctx.refs.coordinator
        try {
          if (ctx.refs.coordinator?.shutdownAndWait) {
            workersSettled = await ctx.refs.coordinator.shutdownAndWait()
          } else if (ctx.refs.coordinator) {
            ctx.refs.coordinator.shutdown()
            workersSettled = false
          }
        } catch {
          workersSettled = false
        }
        let mainRunSettled = false
        try { mainRunSettled = !ctx.agent.isRunning() } catch { /* fail closed */ }
        if (workersSettled && mainRunSettled) {
          try { ctx.refs.sessionRegistry?.unregister(ctx.sessionId) } catch { /* best-effort */ }
        }
        if (process.stdin.isTTY && process.stdin.setRawMode) {
          process.stdin.setRawMode(false)
        }
        killAllSync()
        // Note: does NOT call process.exit ? callers should do so after additional cleanup
      }
    })()
    return shutdownPromise
  }
}

// ?? Model Switch (T9 + React ??) ?????????????????????????????

export interface SwitchModelResult {
  ok: boolean
  error?: string
  /** ??????????alias ??????????? UI ?? */
  modelName?: string
  contextWindow?: number
}

/** ? provider ???? + ???switchAgentRuntime ? resume ?????????
 *  ?????? provider ? null???? API key ?? ? { error }?oauth ? key??
 *  ??????? ? ?????provider/apiKey/auth ???? provider ???? */
export interface ResolvedModelTarget {
  provider: ProviderConfig
  providerName: string
  apiKey: string
  auth: AuthProvider | undefined
  modelId: string
  alias?: string
  contextWindow?: number
}
export function resolveProviderForModel(ctx: Pick<BootstrapContext, 'config' | 'provider' | 'apiKey' | 'auth'>, modelId: string): ResolvedModelTarget | { error: string } | null {
  for (const [provName, prov] of Object.entries(ctx.config.provider.providers)) {
    const found = prov.models.find(m => m.id === modelId || m.alias === modelId)
    if (!found) continue
    let provider = ctx.provider
    let apiKey = ctx.apiKey
    let auth = ctx.auth
    if (prov.auth?.type === 'oauth') {
      if (provName !== ctx.provider.name) {
        provider = prov
        apiKey = ''
        auth = createAuthProvider(prov.auth, process.env, prov.apiKey)
      }
    } else {
      const provKey = prov.apiKey ?? process.env[prov.apiKeyEnv ?? ''] ?? (() => {
        try { return resolveApiKey(prov) } catch { return undefined }
      })()
      if (!provKey) {
        return { error: `API key not set for ${provName}. Set ${prov.apiKeyEnv ?? 'apiKey'} in config or environment.` }
      }
      if (provName !== ctx.provider.name || provKey !== apiKey) {
        provider = prov
        apiKey = provKey
        auth = undefined
      }
    }
    return { provider, providerName: provName, apiKey, auth, modelId: found.id, alias: found.alias, contextWindow: found.contextWindow }
  }
  return null
}

/**
 * ? provider ??????? ?? ?? AgentLoop?? React main.tsx ? useMemo ?????
 * ?????? client ??????????**????** ctx ? agent/provider/apiKey/auth?
 * ????? ctx ??????onSubmit/onAbort?????? agent?
 *
 * session / persist / toolRegistry / refs / fileHistory ??????????????????
 */
export function switchAgentRuntime(ctx: BootstrapContext, modelId: string): SwitchModelResult {
  // ????????? id?? JSONL ????? from ???
  let fromModel: string | undefined
  try { fromModel = ctx.agent.config.promptEngine.getModel() } catch { /* idle/???? */ }
  const resolved = resolveProviderForModel(ctx, modelId)
  if (!resolved) return { ok: false, error: `Model "${modelId}" not found in any provider.` }
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const { provider, apiKey, auth, providerName: provName } = resolved

  // Wave K (P0 ????): createAgentRuntime ??? new DelegationCoordinator
    // ?? refs.coordinator?? coordinator ????? stallSweep ??????
    // worker AbortController ???????TUI ? session ?? + switch ????
    // ???????? sidecar ?? (serve.ts ??)??????????????
    // ???????
    const oldCoordinator = ctx.refs.coordinator
    // ? agent ? fs.watch ?????????? switch ????????
    try { ctx.agent.stopFsWatcher() } catch { /* best-effort */ }

    const { agent } = createAgentRuntime({
      provider,
      apiKey,
      auth,
      config: ctx.config,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      toolRegistry: ctx.toolRegistry,
      persist: ctx.persist,
      claimStore: ctx.claimStore,
      fileHistory: ctx.fileHistory,
      refs: ctx.refs,
      domainKnowledgeStore: ctx.domainKnowledgeStore,
      modelId: resolved.modelId,
      session: ctx.session,
    })

    // ???? job ????? agent????? AgentLoop ??? SessionJobs?
    // ? agent ?????? job ????????????/?????setJobs ?
    // ??????? EventEmitter ????????TUI ??? main ?? attach
    // ??????
    const carriedJobs = ctx.agent.jobs
    if (carriedJobs) { try { agent.setJobs(carriedJobs) } catch { /* best-effort */ } }

    ctx.agent = agent
    ctx.refs.promptEngine = agent.config.promptEngine
    // /model ?????????????????????????????????
    wireFrozenSnapshotPersist(ctx.persist, agent.config.promptEngine)
    ctx.refs.getTaskContract = () => agent.getTaskContract()
    ctx.refs.getImpactedTests = () => [...agent.getEvidenceState().impactedTests]
    ctx.refs.getSessionVitals = () => agent.getSessionVitals()
    ctx.refs.getProblemAttackStore = () => agent.problemAttack
    ctx.refs.getAttackEvidenceVerifier = () => makeAttackEvidenceVerifier(agent)
    ctx.provider = provider
    ctx.apiKey = apiKey
    ctx.auth = auth

    // ????????????????? coordinator??????????????
    if (oldCoordinator && oldCoordinator !== ctx.refs.coordinator) {
      try { oldCoordinator.shutdown() } catch { /* best-effort: shutdown is fail-open */ }
    }

    // ??????metadata.model/provider ???????????/???????
    // ?? JSONL ?????????????????best-effort???????
    try {
      ctx.persist.updateMetadata({ model: resolved.modelId, provider: provName })
      ctx.persist.appendModelSwitch({ from: fromModel, to: resolved.modelId, provider: provName })
    } catch { /* persistence is best-effort ? never block a model switch */ }

    return { ok: true, modelName: resolved.alias ?? resolved.modelId, contextWindow: resolved.contextWindow }
}

export interface SwitchSessionResult {
  ok: boolean
  error?: string
  /** ???:??????? / ???? orphan ?? / preflight ?? apiSafe */
  messageCount?: number
  repaired?: boolean
  safe?: boolean
}

/**
 * ??????????TUI /resume <id>??? switchAgentRuntime ??:??
 * createAgentRuntime ???? AgentLoop ?? ??????? targetId ????
 * sessionId-bound ???(persist / telemetryWriter / stigmergyStore /
 * artifactStore / sessionStateManager ??????),?? ??id = ??id =
 * pointer id = registry id ????,????"???????????? id"??????
 *
 * targetId ????????? id(???? SessionPersist.resolveSessionId ?????)?
 * resume ?? replay ????(????????????),???????????
 */
export interface StartupResumeModelDecision {
  target: ResolvedModelTarget | null
  originalModel?: string
  fallbackUsed: boolean
  degradedWarning?: string
}

/**
 * ?? resume ???????????????????? per-model ?????
 * resume ??????????????????????? --model/--provider
 * ??????? > ????????????? resumeFallbackModel ???
 * ????? ? ?????? fail-closed??startup ??????????
 * ????????????????? --new?? switchAgentSession ?
 * fail-closed ??????????
 */
export function decideStartupResumeModel(input: {
  resumed: boolean
  explicitModel?: string
  explicitProvider?: string
  originalModel?: string
  fallbackModelId?: string
  resolve: (modelId: string) => ResolvedModelTarget | { error: string } | null
}): StartupResumeModelDecision {
  if (!input.resumed || input.explicitModel || input.explicitProvider) {
    return { target: null, fallbackUsed: false }
  }
  if (!input.originalModel) return { target: null, fallbackUsed: false }
  const hit = input.resolve(input.originalModel)
  if (hit && !('error' in hit)) {
    return { target: hit, originalModel: input.originalModel, fallbackUsed: false }
  }
  const fb = input.fallbackModelId ? input.resolve(input.fallbackModelId) : null
  if (fb && !('error' in fb)) {
    return { target: fb, originalModel: input.originalModel, fallbackUsed: true }
  }
  return {
    target: null,
    originalModel: input.originalModel,
    fallbackUsed: false,
    degradedWarning: `? ??? ${input.originalModel} ?????????????????agent.resumeFallbackModel?????????????????????`,
  }
}

export function switchAgentSession(ctx: BootstrapContext, targetId: string): SwitchSessionResult {
  if (targetId === ctx.sessionId) {
    return { ok: false, error: '????????' }
  }

  let targetPersist: SessionPersist
  try {
    targetPersist = new SessionPersist(targetId, ctx.cwd)
  } catch (err) {
    return { ok: false, error: `?????? ${targetId.slice(0, 8)}: ${(err as Error).message}` }
  }

  // ? cwd ??:???????????? cwd?
  const meta = targetPersist.loadMetadata()
  if (meta?.cwd && meta.cwd !== ctx.cwd) {
    return { ok: false, error: '???????????,?????' }
  }

  // ?????2026-07-25????? resumeRun ?????resume ?????????
  // ??????????????????????da015480 ??????????
  // ?????????~10x ??????????????meta ? model ????
  // ??????????????????? agent.resumeFallbackModel ????
  // ??????? fail-closed????????????????????????????
  const originalModel = meta?.model
  let resumeTarget: ResolvedModelTarget | null = null
  let resumeFallbackUsed = false
  if (originalModel) {
    const hit = resolveProviderForModel(ctx, originalModel)
    if (hit && !('error' in hit)) {
      resumeTarget = hit
    } else {
      const fallbackId = ctx.config.agent?.resumeFallbackModel
      const fb = fallbackId ? resolveProviderForModel(ctx, fallbackId) : null
      if (fb && !('error' in fb)) {
        resumeTarget = fb
        resumeFallbackUsed = true
      } else {
        return {
          ok: false,
          error: `??? ${originalModel} ?????????????????agent.resumeFallbackModel??????????`,
        }
      }
    }
  }

  const rawMsgs = targetPersist.loadOai()
  const preflight = runResumePreflightOai(rawMsgs, { writeProbe: createWriteEvidenceProbe(ctx.cwd) })

  // ????? model ???????????????
  let currentModelId: string | undefined
  try { currentModelId = ctx.agent.config.promptEngine.getModel() } catch { /* idle/???? */ }

  // flush ???? volatile store(???),????????
  try { ctx.agent.stigmergyStore.flushSync() } catch { /* best-effort */ }
  // ? agent ? fs.watch ?????????? switch ????????
  try { ctx.agent.stopFsWatcher() } catch { /* best-effort */ }

  const oldId = ctx.sessionId
  // Wave K (P0 ????): ? switchAgentRuntime ????createAgentRuntime ?
  // new DelegationCoordinator ?? refs.coordinator????????????
  // stallSweep ??? + ?? worker ?????
  const oldCoordinator = ctx.refs.coordinator

  // ???? AgentLoop ?? ??????? targetId ??????????????
  // ?????????????????/??? ? undefined ? ?? byte-0 ????
  const { agent } = createAgentRuntime({
    provider: resumeTarget?.provider ?? ctx.provider,
    apiKey: resumeTarget?.apiKey ?? ctx.apiKey,
    auth: resumeTarget ? resumeTarget.auth : ctx.auth,
    config: ctx.config,
    sessionId: targetId,
    cwd: ctx.cwd,
    toolRegistry: ctx.toolRegistry,
    persist: targetPersist,
    claimStore: ctx.claimStore,
    fileHistory: ctx.fileHistory,
    refs: ctx.refs,
    domainKnowledgeStore: ctx.domainKnowledgeStore,
    modelId: resumeTarget?.modelId ?? currentModelId,
    session: ctx.session,
    inheritFrozenFrom: targetPersist.readFrozenSnapshot(),
  })

  // ???? ctx ?? ?? ctx ?????(onSubmit/onAbort/handlerCtx)?????
  ctx.agent = agent
  ctx.persist = targetPersist
  ctx.sessionId = targetId
  ctx.refs.sessionId = targetId
  ctx.refs.promptEngine = agent.config.promptEngine
  wireFrozenSnapshotPersist(targetPersist, agent.config.promptEngine)
  ctx.refs.getTaskContract = () => agent.getTaskContract()
  ctx.refs.getImpactedTests = () => [...agent.getEvidenceState().impactedTests]
  ctx.refs.getSessionVitals = () => agent.getSessionVitals()
  ctx.refs.getProblemAttackStore = () => agent.problemAttack
  ctx.refs.getAttackEvidenceVerifier = () => makeAttackEvidenceVerifier(agent)
  // resume ?????? provider ??????/???????????
  //?? switchAgentRuntime ?????????
  if (resumeTarget) {
    ctx.provider = resumeTarget.provider
    ctx.apiKey = resumeTarget.apiKey
    ctx.auth = resumeTarget.auth
  }
  // ???????meta + JSONL ??????? resume-fallback ???
  if (resumeFallbackUsed && resumeTarget) {
    try {
      targetPersist.updateMetadata({ model: resumeTarget.modelId, provider: resumeTarget.providerName })
      targetPersist.appendModelSwitch({ from: originalModel, to: resumeTarget.modelId, provider: resumeTarget.providerName })
    } catch { /* best-effort */ }
  }

  // ?????2026-07-25??resume ????????????????????
  // ?? = ???????meta.domain ? setSessionDomain/bindSessionDomain ??
  // ???shutdown ?????????????????defaultDomain ? auto ???
  // auto ?????????????????????????
  try {
    const configuredDefault = ctx.config.agent?.defaultDomain
    const defaultPinned = configuredDefault && configuredDefault !== 'auto'
      ? starDomainRegistry.get(configuredDefault)
      : undefined
    const restoredDomain = (meta?.domain ? starDomainRegistry.get(meta.domain) : undefined) ?? defaultPinned
    if (restoredDomain) {
      agent.setSessionDomain({
        id: restoredDomain.id as import('./agent/star-domain.js').StarDomainId,
        name: restoredDomain.name,
        volatileBlock: restoredDomain.volatileBlock,
        motto: restoredDomain.motto,
        courageThreshold: restoredDomain.courageThreshold,
      })
    }
  } catch { /* domain restore best-effort */ }

  // ??????????????? coordinator ?????
  if (oldCoordinator && oldCoordinator !== ctx.refs.coordinator) {
    try { oldCoordinator.shutdown() } catch { /* best-effort */ }
  }

  // ???? ?? ? AgentLoop ???????? replace ??? targetPersist?
  ctx.session.replaceMessages(preflight.messages)

  // pointer + registry + ?? sessionId ???? targetId,??? --continue ????
  try { writeFileSync(lastSessionPointerFile(ctx.cwd), targetId) } catch { /* ignore */ }
  _cachedSessionId = targetId
  _sessionWasResumed = true
  try {
    ctx.refs.sessionRegistry?.unregister(oldId)
    ctx.refs.sessionRegistry?.register(targetId, ctx.cwd)
  } catch { /* registry best-effort */ }

  return {
    ok: true,
    messageCount: preflight.messages.length,
    repaired: preflight.repaired,
    safe: preflight.safe,
  }
}

// ?? Plan-mode restore?resume/????????????????????????????

/**
 * Re-enter plan mode from persisted session metadata after a resume or an
 * in-app session switch. The runtime plan-mode state lives in AgentLoop memory
 * and dies with the process; the meta mirror (written by syncPlanModeToConfig)
 * lets us restore it. Returns the restored draft path, or null when the session
 * was not planning / the draft file no longer exists (silent downgrade to off).
 */
export function restorePlanModeFromMeta(
  agent: AgentLoop,
  cwd: string,
  meta: Pick<import('./context/types.js').SessionMetadata, 'planModeState' | 'activePlanFilePath'> | null | undefined,
): string | null {
  if (meta?.planModeState !== 'planning' || !meta.activePlanFilePath) return null
  const rel = meta.activePlanFilePath.replace(/\\/g, '/')
  if (!existsSync(join(cwd, rel))) return null
  agent.enterPlanMode({ planFilePath: rel })
  return rel
}

// ?? /cd????????????????????????????????????????

export interface SwitchCwdResult {
  ok: boolean
  error?: string
  from?: string
  to?: string
  /** ???? slug ????????????? */
  movedFiles?: string[]
}

/**
 * ??????????TUI /cd??? switchAgentSession ?????
 * createAgentRuntime ???? AgentLoop?? ~12 ?????? cwd ????
 * ?????/????/hooks/persist/stigmergy/artifact/telemetry?????
 * ???????????????
 *
 * ?????? /resume ???????? PromptEngine ? inheritFrozenFrom
 * ?????? frozen ?? + T7 ?????? user ????????????
 * user ?????? /domain ???????? /resume ? byte-0 ? miss?
 * ???? volatile ??? cwd ???AGENTS.md/verify/project-memory ???
 * ????????
 *
 * ????????????? slug ???move ????meta.cwd/pointer/
 * registry ???????? /resume ? --continue ????????
 */
export async function switchAgentCwd(ctx: BootstrapContext, target: string): Promise<SwitchCwdResult> {
  // 1. ???????~ ?? + ???? cwd?????
  const expanded = target.startsWith('~') ? target.replace(/^~(?=$|[\\/])/, homedir()) : target
  const newCwd = resolve(ctx.cwd, expanded)
  if (newCwd === ctx.cwd) {
    return { ok: false, error: '????????' }
  }
  if (!existsSync(newCwd) || !statSync(newCwd).isDirectory()) {
    return { ok: false, error: `??????${newCwd}` }
  }
  // 2. worker ??????worker ??/artifact ??? cwd????????
  if (ctx.refs.coordinator?.hasRunningWork()) {
    return { ok: false, error: '?????? worker????????? /tasks ?????????' }
  }
  // 2b. plan mode ???????????? .rivet/plans/ ??activePlanFilePath
  //     ?????????????????????? close/approve ????
  if (ctx.agent.getPlanModeState() !== 'off') {
    return { ok: false, error: 'Plan Mode ?????????????????? /plan-close ??????????????' }
  }

  const oldCwd = ctx.cwd
  const sessionId = ctx.sessionId

  // 3. flush ???????????????????????+ drain ????
  //    ?????????????????????????? jsonl??
  try { ctx.agent.stigmergyStore.flushSync() } catch { /* best-effort */ }
  try { await ctx.agent.drainPersistWrites() } catch { /* best-effort */ }

  // 4. ???????? slug ???????????????????????
  let movedFiles: string[] = []
  try {
    movedFiles = migrateSessionFiles(sessionId, oldCwd, newCwd).moved
  } catch (err) {
    return { ok: false, error: `????????: ${(err as Error).message}` }
  }

  // 5. ? cwd ? persist + ?????? volatile ??????/hooks cwd??
  //    frozen ?????????????????
  let currentModelId: string | undefined
  try { currentModelId = ctx.agent.config.promptEngine.getModel() } catch { /* idle/???? */ }
  const oldEngine = ctx.agent.config.promptEngine
  const oldCoordinator = ctx.refs.coordinator
  const newPersist = new SessionPersist(sessionId, newCwd)

  const { agent } = createAgentRuntime({
    provider: ctx.provider,
    apiKey: ctx.apiKey,
    auth: ctx.auth,
    config: ctx.config,
    sessionId,
    cwd: newCwd,
    toolRegistry: ctx.toolRegistry,
    persist: newPersist,
    claimStore: ctx.claimStore,
    fileHistory: ctx.fileHistory,
    refs: ctx.refs,
    domainKnowledgeStore: ctx.domainKnowledgeStore,
    modelId: currentModelId,
    session: ctx.session,
    inheritFrozenFrom: oldEngine,
  })

  // 6. ???? ctx ?? ?? ctx ??????onSubmit/handlerCtx??????
  const oldAgent = ctx.agent
  const oldLspManager = ctx.refs.lspManager
  ctx.agent = agent
  ctx.persist = newPersist
  ctx.cwd = newCwd
  ctx.refs.promptEngine = agent.config.promptEngine
  wireFrozenSnapshotPersist(newPersist, agent.config.promptEngine)
  ctx.refs.getTaskContract = () => agent.getTaskContract()
  ctx.refs.getImpactedTests = () => [...agent.getEvidenceState().impactedTests]
  ctx.refs.getSessionVitals = () => agent.getSessionVitals()
  ctx.refs.getProblemAttackStore = () => agent.problemAttack
  ctx.refs.getAttackEvidenceVerifier = () => makeAttackEvidenceVerifier(agent)

  if (oldCoordinator && oldCoordinator !== ctx.refs.coordinator) {
    try { oldCoordinator.shutdown() } catch { /* best-effort */ }
  }
  // ? agent ? fs.watch ????????/model?/resume ????????
  try { oldAgent.stopFsWatcher() } catch { /* best-effort */ }

  // 7. ???????meta.cwd?? cwd resume ?????+ pointer + registry?
  try { newPersist.updateMetadata({ cwd: newCwd }) } catch { /* best-effort */ }
  try { writeFileSync(lastSessionPointerFile(newCwd), sessionId) } catch { /* ignore */ }
  try {
    // ? pointer ??????????????? --continue ???????
    const oldPointer = lastSessionPointerFile(oldCwd)
    if (existsSync(oldPointer) && readFileSync(oldPointer, 'utf-8').trim() === sessionId) {
      rmSync(oldPointer, { force: true })
    }
  } catch { /* ignore */ }
  try {
    ctx.refs.sessionRegistry?.unregister(sessionId)
    ctx.refs.sessionRegistry?.register(sessionId, newCwd)
  } catch { /* registry best-effort */ }

  // 8. LSP ?? cwd ???????????? re-attach + updateTools ????
  //    ? manager ?????????????Meridian/domain knowledge ???
  //    MCP ????????????? cwd???????????????
  initializeLsp(newCwd, ctx.toolRegistry).then(lsp => {
    ctx.refs.lspManager = lsp
    agent.updateTools()
  }).catch(() => {})
  if (oldLspManager) {
    try { oldLspManager.dispose() } catch { /* best-effort */ }
  }
  try {
    ctx.meridianIndexer = new MeridianIndexer(newCwd)
    ctx.refs.meridianIndexer = ctx.meridianIndexer
  } catch { /* ?????????????repo ???????? */ }
  try {
    ctx.domainKnowledgeStore = new DomainKnowledgeStore(join(newCwd, '.rivet', 'knowledge'))
    if (ctx.refs.domainKnowledgeStoreRef) ctx.refs.domainKnowledgeStoreRef.current = ctx.domainKnowledgeStore
  } catch { /* best-effort */ }

  // 9. ???????????????????????functional ???
  //    ?? discipline ???????????
  ctx.session.appendSystemReminder(
    `?????? ${oldCwd} ??? ${newCwd}?????????????????? claim ??????????????????`,
    'functional',
  )

  return { ok: true, from: oldCwd, to: newCwd, movedFiles }
}


// ?? Aggregate Bootstrap ????????????????????????????????????????

/**
 * P1-6 ????????coordinator ? maxWorkers ????
 *
 * ??????config.agent.maxWorkers?schema ?????????
 * src/config/schema.ts agentSchema?? ???? RIVET_MAX_WORKERS ? ?? 3?
 * ?????????????????????
 * ?activeWorkerCount ? maxWorkers?delegate()/delegateBackground/??
 * worker ????????? coordinator ???????????????
 * ?? 3??fail-closed ????
 */
function resolveCoordinatorMaxWorkers(config: Config): number {
  const raw = (config.agent as { maxWorkers?: unknown }).maxWorkers
  const n = typeof raw === 'number' ? raw : Number(process.env['RIVET_MAX_WORKERS'])
  return Number.isInteger(n) && n >= 1 ? n : 3
}

/** S1 ????????/???????????? undefined?= maxWorkers??
 *  ?????????fail-closed ???? */
function resolveCoordinatorPoolCaps(config: Config): { maxExploreWorkers?: number; maxWriteWorkers?: number } {
  const agent = config.agent as { maxExploreWorkers?: unknown; maxWriteWorkers?: unknown }
  const cap = (raw: unknown): number | undefined =>
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : undefined
  return {
    ...(cap(agent.maxExploreWorkers) !== undefined ? { maxExploreWorkers: cap(agent.maxExploreWorkers) } : {}),
    ...(cap(agent.maxWriteWorkers) !== undefined ? { maxWriteWorkers: cap(agent.maxWriteWorkers) } : {}),
  }
}

export interface BootstrapOptions {
  cwd?: string
  args?: string[]
  modelId?: string
  providerName?: string
  /** If true, MCP and LSP are initialized asynchronously (non-blocking) */
  asyncExtras?: boolean
  /** ???? wizard ??????? key ????? TUI ????
   *  ????????? key?????????????????? */
  allowMissingKey?: boolean
}

/**
 * ?????? ? ?? BootstrapContext?
 *
 * main-ansi.ts ?? await ???
 * main.tsx ? React hooks ?????handleShutdown ????? shutdown??
 */
export async function bootstrapInteractiveSession(opts: BootstrapOptions = {}): Promise<BootstrapContext> {
  const cwd = opts.cwd ?? process.cwd()

  // 1. HTTP Proxy
  setupHttpProxy()

  // 2. Config
  const config = loadRivetConfig(cwd, opts.args)
  setTargetConventions(config.editor.platform, config.editor.eol)
  applyConfiguredGitBashPath(config.env.gitBashPath)

  // YOLO removes the approval boundary, so the kernel write boundary becomes
  // the only one. Turn the sandbox on before the startup notice is computed.
  applySandboxPolicyForApprovalMode(config.agent.approval)

  // Announce the command sandbox's protection level up-front. Stays silent when
  // a real kernel boundary is active; warns loudly (esp. on native Windows, or
  // when RIVET_SANDBOX was requested but no backend exists) ? in that case
  // writes are unbounded and rollback is the only, after-the-fact, file-only
  // safety net.
  maybeWarnNoSandbox({ cwd })

  // Re-activate out-of-workspace path grants the user chose to "remember" for
  // this workspace, so previously-approved external paths work from turn one.
  loadPersistedGrants(cwd)
  // Standing config-declared grants (permissions.additionalReadDirs/WriteDirs):
  // Codex-style folder authorization without an approval round-trip.
  applyConfiguredPathGrants(config.agent.permissions)
  // Default read-only grants for common dependency/toolchain caches under $HOME
  // (.pub-cache, .cargo, .gradle, node package stores?). Lets read_file/grep
  // inspect third-party dependency source without hitting a hang-prone approval
  // gate ? see path-grants.ts::applyDefaultDependencyReadGrants.
  applyDefaultDependencyReadGrants()
  // Read grants for dirs Rivet itself writes and then tells the model to read
  // back ($TMPDIR/rivet-raw full tool output). Without this the truncation
  // footer's `read_file <rawPath>` instruction is a closed dead end.
  applyRivetRuntimeReadGrants()

  // 3. Provider + Auth
  const { provider, apiKey, auth } = resolveProviderAndAuth(config, opts.providerName, {
    ...(opts.allowMissingKey ? { allowMissingKey: true } : {}),
  })

  // 4. Session infrastructure
  const { registry: sessionRegistry, sessionId, heartbeatInterval } = await createSessionInfrastructure()

  // 4a. First-run template detection ? set flag for TUI layer to prompt.
  // We only detect here; actual file creation + sentinel write happens in
  // main.ts after the user decides (so file creation and sentinel stay atomic).
  const templatesPendingAgents = needsTemplatesInit(cwd)

  // 5. Session persist + claim store
  const persist = new SessionPersist(sessionId, cwd)
  const claimStore = persist.createClaimStore()
  persist.injectDurableClaims(claimStore, cwd)
  for (const rule of loadProjectRules(cwd)) {
    claimStore.propose(rule)
  }
  // A3: no-test-infra advisory ? recomputed live each session (disappears the
  // moment tests exist). Only for recognized languages: docs/unknown repos
  // would be pure noise. Makes the delivery-gate impact explicit and nudges
  // ?? to offer a minimal test scaffold instead of silently degrading.
  try {
    const fp = detectProjectFingerprint(cwd)
    if (fp.language !== 'unknown' && !fp.hasTestInfra) {
      const now = Date.now()
      claimStore.propose({
        kind: 'project_rule',
        scope: 'project',
        text: `????${fp.language}???????????????deliver_task ?????????????? YELLOW???????????????????????????????????????????????????????????`,
        confidence: 1.0,
        fitness: 5,
        source: { actor: 'hook', sessionId: 'project', turn: 0, eventId: 'fingerprint:no-test-infra' },
        evidence: [{ id: 'fingerprint:no-test-infra', kind: 'file', summary: `project fingerprint: language=${fp.language}, hasTestInfra=false`, path: cwd, createdAt: now }],
        createdAt: now,
        tags: ['no_test_infra'],
      })
    }
  } catch { /* advisory only ? never block bootstrap */ }
  const skillLoad = loadProjectSkills(cwd, { importFromClaude: config.skills?.importFromClaude })
  if (skillLoad.loaded.length > 0 && process.env['RIVET_DEBUG']) {
    // ???????/skills ????????????????????
    console.error(`[skills] Loaded ${skillLoad.loaded.length} skill(s)`)
  }
  for (const err of skillLoad.errors) {
    console.warn(`[skills] ${err}`)
  }
  const fileHistory = new FileHistory(persist.getBackupDir(), sessionId)
  const session = new SessionContext()

  // Load prior messages. When the session id was explicitly resumed
  // (--continue / --resume <id>), this rehydrates that session's history.
  const existingMessages = persist.loadOai()
  // resume ????????????????????<id>.frozen.json??
  // ??? inheritFrozenFrom ????????? user ?????????
  // ????? TTL ??? byte-0 ? miss????/??????????
  const resumedFrozen = wasSessionResumed() ? persist.readFrozenSnapshot() : undefined
  if (existingMessages.length > 0) {
    session.replaceMessages(existingMessages)
    if (wasSessionResumed()) {
      const anchorNote = resumedFrozen
        ? `?? ${resumedFrozen.frozenUserMerged.reduce((n, [, arr]) => n + arr.length, 0)} ?????`
        : '?????????????'
      console.error(`?? ????? ${sessionId.slice(0, 8)}: ${existingMessages.length} ????${anchorNote}????????????????? rivet --resume <id>,????? rivet --list?`)
    }
  }

  // Evict old sessions
  evictOldSessions(sessionId, cwd)

  // Clean up stale worker session directories under ~/.rivet/sessions/<slug>/.
  // Worker sessions create worker-xxx/ (pheromones, sensorium).
  cleanupStaleWorkerSessionDirs(cwd)

  // Clean up orphaned files
  const rivetDir = join(cwd, '.rivet')
  const dirsToScan = [
    rivetDir,
    join(rivetDir, 'sessions'),
    join(rivetDir, 'artifacts'),
    join(rivetDir, 'checkpoints'),
  ]
  const tmpCleaned = cleanupOrphanedTmpFiles(dirsToScan)
  if (tmpCleaned > 0) {
    console.error(`[startup] Cleaned ${tmpCleaned} orphaned .tmp file(s)`)
  }
  const artifactCleaned = cleanupOldArtifactSessions(join(rivetDir, 'artifacts'), sessionId)
  if (artifactCleaned > 0) {
    console.error(`[startup] Cleaned ${artifactCleaned} old artifact session(s)`)
  }

  // 6. Meridian indexer
  const meridianIndexer = new MeridianIndexer(cwd)
  // ??????????????? agent ??????backfill ???????
  // ?hash ????????????????????????? hash ????
  setImmediate(() => { scheduleMeridianBackfill(meridianIndexer, cwd) })

  // Memory epoch reset ? ??/?????????????????????
  // ?playbook.jsonl / recovery-journal / advisory-efficacy / mistake_entries??
  // ? memory-epoch.ts ???????? loadSessionMemories warmup ????
  // ??? mistake entries ????????????????
  try {
    const memReset = resetLegacyMemoryIfNeeded(cwd, {
      clearMistakeEntries: () => meridianIndexer.getDb().clearMistakeEntries(),
    })
    if (!memReset.skipped && memReset.cleared.length > 0) {
      console.error(`[startup] Memory epoch ${memReset.epoch}: cleared ${memReset.cleared.join(', ')}`)
    }
  } catch { /* ???????? */ }

  // 7. Domain knowledge store
  const domainKnowledgeStore = new DomainKnowledgeStore(join(cwd, '.rivet', 'knowledge'))

  // 8. Load profiles + star domains
  const agentsDir = join(cwd, '.rivet', 'agents')
  const agentLoadResult = await profileRegistry.loadFromDirectory(agentsDir)
  if (agentLoadResult.loaded.length > 0 || agentLoadResult.errors.length > 0) {
    for (const err of agentLoadResult.errors) {
      console.warn(`[agents] ${err}`)
    }
  }
  const domainsDir = join(cwd, '.rivet', 'domains')
  const domainLoadResult = await starDomainRegistry.loadFromDirectory(domainsDir)
  if (domainLoadResult.errors.length > 0) {
    for (const err of domainLoadResult.errors) {
      console.warn(`[domains] ${err}`)
    }
  }

  // 9. Runtime refs
  const refs: RuntimeRefs = {
    coordinator: null,
    fileHistory,
    claimStore,
    sessionId,
    sessionRegistry,
    taskLedger: null,
    ownershipLedger: null,
    verificationSnapshotManager: null,
    deliveryGate: null,
    meridianIndexer,
    mcpManager: null,
    lspManager: null,
    banditState: null,
    promptEngine: null,
    goalTrackerRef: { current: null },
    domainKnowledgeStoreRef: { current: domainKnowledgeStore },
    obligationTrackerRef: { current: null },
    claimTrackerRef: { current: null },
    reviewGateRef: { current: config.agent.review.skipAuto ? 'off' : 'auto' },
    pluginHooks: [],
    pluginCommands: [],
    // TUI ???????? defaultStore???? setTodoSession/loadTodos ????
    // ????????????????????????? refs.todoStore?
    todoStore: defaultTodoStore,
  }

  // 10. Tool registry
  const { registry: toolRegistry } = createInteractiveToolRegistry(refs, config, cwd)

  // 11. Memory tool (unified recall + remember)
  toolRegistry.register(createMemoryTool(claimStore, {
    sessionId,
    getTurn: () => session.getTurnCount(),
    cwd,
  }))

  // 12. Agent runtime
  // ?? resume ???????? decideStartupResumeModel ????
  const startupResume = decideStartupResumeModel({
    resumed: wasSessionResumed(),
    explicitModel: opts.modelId,
    explicitProvider: opts.providerName,
    originalModel: wasSessionResumed() ? persist.loadMetadata()?.model : undefined,
    fallbackModelId: config.agent?.resumeFallbackModel,
    resolve: modelId => resolveProviderForModel({ config, provider, apiKey, auth }, modelId),
  })
  if (startupResume.degradedWarning) console.error(startupResume.degradedWarning)
  const { agent } = createAgentRuntime({
    provider: startupResume.target?.provider ?? provider,
    apiKey: startupResume.target?.apiKey ?? apiKey,
    auth: startupResume.target ? startupResume.target.auth : auth,
    config, sessionId, cwd,
    toolRegistry, persist, claimStore, fileHistory, refs,
    domainKnowledgeStore, modelId: startupResume.target?.modelId ?? opts.modelId,
    session,
    inheritFrozenFrom: resumedFrozen,
  })
  refs.promptEngine = agent.config.promptEngine
  wireFrozenSnapshotPersist(persist, agent.config.promptEngine)
  // ???????meta + JSONL ????? switchAgentSession/?? resume-fallback ???
  if (startupResume.fallbackUsed && startupResume.target) {
    try {
      persist.updateMetadata({ model: startupResume.target.modelId, provider: startupResume.target.providerName })
      persist.appendModelSwitch({ from: startupResume.originalModel, to: startupResume.target.modelId, provider: startupResume.target.providerName })
    } catch { /* best-effort */ }
  }
  refs.getTaskContract = () => agent.getTaskContract()
  refs.getImpactedTests = () => [...agent.getEvidenceState().impactedTests]
  refs.getSessionVitals = () => agent.getSessionVitals()
  refs.getProblemAttackStore = () => agent.problemAttack
  refs.getAttackEvidenceVerifier = () => makeAttackEvidenceVerifier(agent)

  // 12b. Restore goal tracker from persisted state (if session was resumed).
  // normalizeAfterResume: active ? paused (the process that wrote active is gone).
  if (wasSessionResumed()) {
    try {
      const { restoreGoalTracker } = await import('./agent/goal-persist.js')
      const restored = restoreGoalTracker(getSessionDir(cwd), sessionId, {
        maxJudgeRuns: config.agent.goal?.judge?.maxRuns,
      })
      if (restored) {
        agent.setGoalTracker(restored)
        refs.goalTrackerRef.current = restored
        console.error(`?? ???????????: ${restored.getGoal().slice(0, 60)}?  ?? /goal-resume ???`)
      }
    } catch { /* best-effort: goal restore failure is non-fatal */ }
  }

  // 13. MCP + Plugin + LSP initialization
  // asyncExtras (default true): fire-and-forget, non-blocking for faster startup
  // asyncExtras=false: synchronous await, completes before bootstrap returns
  if (opts.asyncExtras !== false) {
    initializeMcp(config, toolRegistry, refs).then(() => {
      agent.updateTools()
    }).catch(() => {})
    initializePlugins(config.plugins, toolRegistry, cwd).then((result) => {
      refs.pluginHooks = result.hooks
      refs.pluginCommands = result.commands
      for (const name of result.suppressTools) {
        toolRegistry.remove(name)
      }
      if (result.warnings.length > 0) {
        debugLog(`[plugins] ${result.loaded}/${result.scanned} loaded, ${result.totalTools} tools; warnings: ${result.warnings.join('; ')}`)
      }
      // Always refresh tools when plugins change the registry (tools added OR suppressed).
      // Suppress-only plugins (zero own tools) must still trigger an update to remove
      // the suppressed built-in tools from the model's tool list.
      if (result.totalTools > 0 || result.suppressTools.length > 0) {
        agent.updateTools()
      }
    }).catch((err) => {
      debugLog(`[plugins] Initialization failed: ${(err as Error).message}`)
    })
    initializeLsp(cwd, toolRegistry).then((lspManager) => {
      refs.lspManager = lspManager
      agent.updateTools()
    }).catch(() => {})
  } else {
    await initializeMcp(config, toolRegistry, refs)
    agent.updateTools()
    const pluginResult = await initializePlugins(config.plugins, toolRegistry, cwd)
    // Expose plugin hooks/commands via refs so the user-hooks bridge and the
    // slash-command resolver pick them up (lazy binding ? plugins load after
    // agent assembly, refs are read at fire/input time).
    refs.pluginHooks = pluginResult.hooks
    refs.pluginCommands = pluginResult.commands
    for (const name of pluginResult.suppressTools) {
      toolRegistry.remove(name)
    }
    if (pluginResult.warnings.length > 0) {
      debugLog(`[plugins] ${pluginResult.loaded}/${pluginResult.scanned} loaded, ${pluginResult.totalTools} tools; warnings: ${pluginResult.warnings.join('; ')}`)
    }
    if (pluginResult.totalTools > 0) agent.updateTools()
    const lsp = await initializeLsp(cwd, toolRegistry)
    refs.lspManager = lsp
    agent.updateTools()
  }

  // 14. Shutdown handler
  const shutdown = createShutdownHandler({
    config, provider, apiKey, auth, sessionId, session, persist,
    claimStore, fileHistory, toolRegistry, agent, refs,
    domainKnowledgeStore, meridianIndexer, cwd,
    shutdown: async () => {}, // placeholder, replaced below
    flushTuiPerfSummary: async () => {}, // placeholder; TUI bridge is attached on final context
    heartbeatInterval,
  })

  let ctx: BootstrapContext
  const flushTuiPerfSummary = async (summary: TuiPerfSummary): Promise<void> => {
    const writer = ctx.agent.telemetryWriter
    writer.write({
      kind: summary.kind,
      samples: summary.samples,
      cache: summary.cache,
      loopLag: summary.loopLag,
    })
    await writer.flush()
  }
  ctx = {
    config, provider, apiKey, auth, sessionId, session, persist,
    claimStore, fileHistory, toolRegistry, agent, refs,
    domainKnowledgeStore, meridianIndexer, cwd,
    shutdown,
    flushTuiPerfSummary,
    heartbeatInterval,
    templatesPendingAgents,
  }

  return ctx
}
