/**
 * RuntimeSessionManager ? desktop-facing multi-session layer (M0.5).
 *
 * Owns N independent agent runs and turns their AgentCallbacks into a single
 * monotonic, replayable event log per session. Deliberately separate from
 * src/agent/session-registry.ts (that is the cross-session claims/events
 * registry) ? these bridge, they do not merge.
 *
 * Invariants:
 *  - Every event carries a monotonic `seq`; `getEvents(since)` replays the tail,
 *    so a dropped viewer never loses history (B3).
 *  - A viewer unsubscribing NEVER aborts the run; only abort() does.
 *  - Approvals are requestId-keyed two-way interventions resolved out of
 *    band by answerIntervention() (B2). Intent direction notes are one-way,
 *    non-blocking timeline events (intent_note) ? no pending state.
 *  - Artifacts are surfaced from each session's own ArtifactStore, never shared
 *    across sessions (B4).
 */
import type { AgentCallbacks, ApprovalMode } from '../agent/loop-types.js'
import { debugLog } from '../utils/debug.js'
import { collectPostBoundaryEditIds } from '../agent/file-history.js'
import { loadConfig } from '../config/manager.js'
import type { DelegationActivity, Tool } from '../tools/types.js'
import type { ApprovalResult } from '../agent/approval-edit.js'
import type { HookEvent, HookResult } from '../hooks/user-hooks-runner.js'
import type { IntentPreview } from '../agent/intent-preview.js'
import { describeIntentNote } from '../agent/intent-preview.js'
import type { Artifact } from '../artifact/types.js'
import { ArtifactStore } from '../artifact/store.js'
import type { OaiMessage } from '../api/oai-types.js'
import { isAssistantWithTools, oaiMessageText, type OaiToolCall } from '../api/oai-types.js'
import { toolArgSummary } from '../tui/tool-label.js'
import { listPersistedResultRounds, loadPersistedResult, type PersistedResultRound } from '../agent/coordinator.js'
import { loadWorkerSession } from '../agent/worker-session-persist.js'
import type { SessionRegistry } from '../agent/session-registry.js'
import type { DecisionShift } from '../agent/loop-types.js'
import type { PlanModeState } from '../agent/plan-mode.js'
import type { AskModeState } from '../agent/ask-mode.js'
import {
  listPlans as storeListPlans,
  readPlan as storeReadPlan,
  rejectPlan as storeRejectPlan,
  writePlan as storeWritePlan,
  resolvePlanOptionLabel,
  parsePlanOptions,
  slugify,
  type PlanDocument,
} from '../plan/plan-store.js'
import { approvePlanWithGuards, type PlanApprovalResult } from '../plan/plan-approval.js'
import { SteerBuffer } from '../tui/steer-buffer.js'
import { TEAM_PANEL_UI_PREFIX } from '../tui/team-panel-model.js'
import { COUNCIL_PANEL_UI_PREFIX } from '../tui/council-panel-model.js'
import { containsRegisteredFrame } from '../tui/frame-codec.js'
import { buildHandoffPrompt } from '../tui/handoff.js'
import { handoffRecoveries } from '../agent/recovery-journal.js'
import { getSessionDir } from '../agent/session-persist.js'
import { WatchdogRecoveryPolicy } from '../agent/watchdog-recovery-policy.js'
import { buildDomainPickerEntries, type DomainPickerEntry } from '../agent/domain-picker-entries.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import type { ActiveStarDomain } from '../agent/star-domain.js'
import type { StarDomainId } from '../agent/star-domain.js'
import { skillRegistry, loadProjectSkills, listInstallableSkills, importSkillsIntoRivet, countInstalledSkills, readSkillContent, writeSkill, uninstallSkill, type InstallableSkill } from '../skills/skill-loader.js'
import type { MissionStore } from './mission-store.js'
import { join, resolve, dirname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync, copyFileSync, statSync, mkdirSync } from 'node:fs'
import { createWorktree, removeWorktree, listWorktrees, hasUnlandedWork, commitAll, revParseHead, squashMergeBranch, pushBranch, type WorktreeEntry } from '../agent/worktree.js'
import { createPr } from './gh-cli.js'
import { getGitGraph, getWorkingTreeFiles, getFileDiff, getFileAtBase } from '../tools/git.js'
import type { WorkingTreeFile } from '../tools/git.js'
import { SessionJobs, type JobEvent } from '../tools/job-store.js'
import { parseAskUserQuestions } from '../tools/ask-user-question.js'
import { grantApp as grantComputerUseApp } from '../tools/computer-use/app-grants.js'
import { outOfWorkspaceFilePaths } from '../agent/tool-pipeline.js'
import {
  DELEGATE_CAPABILITY_TTL_MS,
  DELEGATE_TIMEOUT_MS,
  isDelegateKind,
  type DelegateKind,
  type DelegateResult as ClientDelegateResult,
  type DelegatePayload,
} from './delegation-protocol.js'
import type {
  ApprovalMode as WireApprovalMode,
  PlanModeState as WirePlanModeState,
  AskModeState as WireAskModeState,
  SessionStatus,
  SessionEvent,
  SessionEventType,
  SessionRecord,
  PlanDraft,
} from './protocol.js'
import { redactValue, redactText, truncateUtf16Safe } from './redact.js'

// The session wire contract (event types, records, statuses) lives in
// protocol.ts so the desktop can share it type-only. Re-export so existing
// server-side importers keep working unchanged.
export type { SessionStatus, SessionEvent, SessionEventType, SessionRecord, PlanDraft } from './protocol.js'

// Compile-time drift guards: the wire copies of ApprovalMode / PlanModeState in
// protocol.ts must stay identical to the runtime definitions. If either side
// changes, these aliases stop typechecking.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
export type _ApprovalModeInSync = Assert<Equals<ApprovalMode, WireApprovalMode>>
export type _PlanModeStateInSync = Assert<Equals<PlanModeState, WirePlanModeState>>
export type _AskModeStateInSync = Assert<Equals<AskModeState, WireAskModeState>>

/** Structured approval outcome ? routes surface `reason` instead of a blind 409. */
export type PlanApprovalOutcome =
  | { ok: true }
  | {
      ok: false
      code: 'session-missing' | 'session-running' | 'plan-not-found' | 'invalid-content' | 'bad-approach'
      reason: string
    }

/** Structured plan-edit outcome (PUT /plans/:slug). */
export type PlanUpdateOutcome =
  | { ok: true }
  | {
      ok: false
      code: 'session-missing' | 'plan-not-found' | 'not-editable' | 'empty-content'
      reason: string
    }

/** ????????(worker ??):?? toolArgSummary ?????,
 *  ?????????? JSON ???????,??????? */
function summarizeToolCallArgs(call: OaiToolCall | undefined): string | undefined {
  if (!call) return undefined
  const raw = call.function.arguments ?? ''
  try {
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown>
    const summary = toolArgSummary(call.function.name, parsed)
    if (summary) return summary
  } catch {
    // ?? JSON?????????
  }
  return raw && raw !== '{}' ? raw.slice(0, 200) : undefined
}

/** PlusMenu ? a selectable model across all configured providers. */
export interface ModelOption {
  id: string
  alias: string
  provider: string
  contextWindow?: number
  /** ???? ? ??????????????????? */
  description?: string
}

/** PlusMenu ? a model option annotated with whether it's the session's current. */
export interface ModelEntry extends ModelOption {
  current: boolean
}

/** PlusMenu ? a skill's per-session enablement status. */
export interface SkillStatus {
  name: string
  description: string
  source: string
  enabled: boolean
  /** True when a backing file exists that the editor can open (not built-in/plugin). */
  editable?: boolean
}

/** Minimal agent surface the manager needs ? decoupled from AgentLoop for tests. */
/** User-dispatched background worker request (from POST /sessions/:id/delegate). */
export interface DelegateWorkerInput {
  objective: string
  /** Worker role profile (code_scout / reviewer / patcher ?). Defaults applied downstream. */
  profile?: string
  /** Optional star-domain authority injected into the worker. */
  authority?: string
  /** Optional files to scope the worker to. */
  files?: string[]
  /** Phase 2: resume a previous worker session by workOrderId. */
  resume?: string
}

/** Structured progress/terminal update emitted by a user-dispatched worker. */
export interface DelegateActivityUpdate {
  workOrderId: string
  parentToolId?: string
  profile?: string
  authority?: string
  /** Why this authority was chosen?worker ???????????? */
  authorityReason?: string
  objective?: string
  status: string
  progressLine?: string
  /** ? worker ?????????????????? */
  toolUseCount?: number
  /** ? worker ?? token ???turn ??????????? */
  tokenCount?: number
  /** ???????????? worker ??????terminal ?????? */
  eventKind?: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'turn' | 'retry' | 'lifecycle'
  /** ???????text/thinking ? delta?tool_use/tool_result ????? */
  eventDetail?: string
  /** Terminal failure classification (blocked/failed ??????)? */
  failureReason?: string
  model?: string
  provider?: string
  usage?: DelegationActivity['usage']
  artifactId?: string
  changedFiles?: string[]
  /** Terminal digest text for the desktop "?????" adopt button. */
  summary?: string
  /** ????????? running ?????? */
  contract?: DelegationActivity['contract']
  /** ?? findings ???????? getWorkerLog pull?? */
  findingsCount?: number
  /** ????? finding claim? */
  topFinding?: string
  /** ?? verification ??? */
  verificationBrief?: DelegationActivity['verificationBrief']
  /** ?? evidenceStatus? */
  evidenceStatus?: string
}

export interface ManagedAgent {
  run(prompt: string, callbacks: AgentCallbacks, images?: string[]): Promise<void>
  abort(): void
  listArtifacts(): Artifact[]
  readArtifact(id: string): Promise<string | null>
  /**
   * S ? live-switch the autonomy level. Mutates the agent's approval mode in
   * place (read per-tool by the pipeline), so a mid-session toggle takes effect
   * on the next tool without rebuilding the agent / losing conversation state.
   * Optional so lightweight test doubles need not implement it.
   */
  setApprovalMode?(mode: ApprovalMode): void
  /**
   * Plan mode ? restrict the agent to read-only tools (planning) or release it
   * (off). Mirrors AgentLoop.enterPlanMode/exitPlanMode. Optional so lightweight
   * test doubles need not implement it.
   */
  enterPlanMode?(opts?: { planFilePath?: string }): void
  exitPlanMode?(): void
  /**
   * Ask mode ? restrict the agent to pure read-only Q&A tools (asking) or
   * release it (off). Mutually exclusive with Plan Mode. Optional so lightweight
   * test doubles need not implement it.
   */
  enterAskMode?(): void
  exitAskMode?(): void
  /** ????????active/source/detail??UI ?????????????
   *  config ??? visionModel ??Optional ????????????? */
  getVisionBridge?(): { active: boolean; source: 'configured' | 'auto' | 'none'; detail?: string } | undefined
  /**
   * Plan mode change notification ? assigned by the session layer so agent-side
   * transitions (e.g. the model calling plan action=enter_mode) surface as
   * plan_mode SSE events. Mirrors AgentLoop.onPlanModeChange. Optional so
   * lightweight test doubles need not implement it.
   */
  onPlanModeChange?: (state: PlanModeState) => void
  /**
   * Ask mode change notification ? assigned by the session layer so agent-side
   * transitions surface as ask_mode SSE events.
   */
  onAskModeChange?: (state: AskModeState) => void
  /**
   * Relative path of the working draft the agent writes while in plan mode
   * (null when not planning). Mirrors AgentLoop.getActivePlanFilePath.
   * Optional so lightweight test doubles need not implement it.
   */
  getActivePlanFilePath?(): string | null
  /**
   * Set (or clear) the approved-plan pointer. Injects a tiny slug/title/path
   * reminder into the agent's dynamic appendix (NOT the plan body, which stays
   * on disk). Mirrors AgentLoop.setActivePlan. Optional for lightweight doubles.
   */
  setActivePlan?(plan: { slug: string; title: string; selectedApproach?: string } | null): void
  /** Inject the session-owned background job registry so bash(run_in_background)
   *  and the `job` tool operate on an instance the server subscribes to. Optional
   *  so lightweight test doubles need not implement it. */
  setJobs?(jobs: import('../tools/job-store.js').SessionJobs): void
  /**
   * Mount an EXTENDED-layer tool onto the main agent (mirrors AgentLoop.enableTool).
   * Used by workflow slash-command resolution to ensure prompt-declared tools are
   * visible before run. Optional so lightweight test doubles need not implement it.
   */
  enableTool?(name: string): {
    status: 'mounted' | 'already-active' | 'not-extended' | 'unknown' | 'gating-off'
    cacheImpact: 'prefix-invalidated' | 'none'
  }
  /**
   * Hot-register tools discovered after this agent was built (MCP connect mid-
   * session). Mirrors LSP attachLspTools: registry.register is Map.set-idempotent;
   * callers should then rely on updateTools() inside the impl. Optional so
   * lightweight test doubles need not implement it.
   */
  registerExternalTools?(tools: Tool[]): void
  /** Current reasoning effort level (off/low/medium/high/max). */
  getReasoningEffort?(): string | undefined
  /** Set the reasoning effort level (off/low/medium/high/max) or return to auto. */
  setReasoningEffort?(effort: import('../agent/auto-reasoning.js').ReasoningEffort | 'auto'): void
  /**
   * Goal mode ? attach/clear an autonomous-goal tracker. The tracker drives
   * cross-turn continuation via GoalContinuationController (assembled in
   * loop-factory). Mirrors AgentLoop.setGoalTracker. Optional for lightweight
   * doubles. Note: the caller MUST also update refs.goalTrackerRef.current so
   * the update_goal / deliver_task tool closures (which read refs, not the
   * agent field) stay in sync ? see RuntimeSessionManagerOptions.resolveGoalHandles.
   */
  setGoalTracker?(tracker: import('../agent/goal-tracker.js').GoalTracker | null): void
  /** Current goal tracker (null when no goal is active). Mirrors AgentLoop.getGoalTracker. */
  getGoalTracker?(): import('../agent/goal-tracker.js').GoalTracker | null
  /**
   * Cockpit snapshot ? aggregated runtime state (safety/verify/context/model/
   * advisory) for the desktop cockpit panel. Built by the pure function
   * buildCockpitSnapshot (tui/cockpit/state.ts) reading agent in-memory state.
   * Returns null when the agent isn't built yet (idle/rehydrated session) or
   * the snapshot assembly throws (transient agent rebuild window).
   */
  getCockpitSnapshot?(): import('../tui/cockpit/types.js').CockpitSnapshot | null
  /** Rewind: return the current message list (for listing rewind points). */
  getMessages(): OaiMessage[]
  /**
   * Outcome of the boot-time LLM history restore (sidecar restart recovery).
   * Lets the session layer warn when the event log shows a prior conversation
   * but the model context came back empty (corrupt/unreadable session file) ?
   * otherwise the user silently talks to a model that remembers nothing.
   * Optional so lightweight test doubles need not implement it.
   */
  getHistoryRestore?(): { restored: number; error?: string }
  /** Rewind: replace the message list (truncate to a prior point). */
  replaceMessages(msgs: OaiMessage[]): void
  /** Rewind: like replaceMessages but also resets turnCount/filesRead/filesModified etc. */
  rewindToMessages(msgs: OaiMessage[]): void
  /** Precise rewind: the session's per-edit FileHistory (write_file/edit_file
   *  backups keyed by tool_use id). Absent on lightweight doubles / when no
   *  history is wired. */
  getFileHistory?(): import('../agent/file-history.js').FileHistory | undefined
  /**
   * Reset the prompt engine's delta appendix baseline after any history rewrite
   * (compaction, rewind, /compact). Optional so lightweight test doubles need
   * not implement it; production agents (AgentLoop) delegate to promptEngine.
   */
  resetAppendixBaseline?(): void
  /**
   * PlusMenu (domain) ? pin a star domain (or null to disable). Mirrors
   * AgentLoop.setSessionDomain. Optional for lightweight test doubles.
   */
  setSessionDomain?(domain: ActiveStarDomain | null): void
  /** PlusMenu (domain) ? reset to Auto (next run auto-detects from input). */
  resetSessionDomain?(): void
  /** PlusMenu (domain) ? read the current selection (Auto when undefined). */
  getSessionDomain?(): ActiveStarDomain | null | undefined
  /**
   * PlusMenu (model) ? rebuild this session's agent on a new model, preserving
   * the conversation (same SessionContext) and shared stores. Returns the
   * resolved model id, or null when the model id is unknown / unauthorized.
   * Optional for lightweight test doubles.
   */
  switchModel?(modelId: string): string | null
  /**
   * PlusMenu (skills) ? set the per-session disabled skill set. Filters the
   * discovery block so disabled skills are hidden from the model. Optional for
   * lightweight test doubles.
   */
  setDisabledSkills?(names: Set<string>): void
  /** Estimated token count for the current conversation (including prefix overhead). */
  getEstimatedTokens?(): number
  /** Model context window size (max tokens). */
  getContextWindow?(): number
  /**
   * P0-2: ????? TodoStore ??????plan_task ???? todo_state SSE ??
   * ????????? session ??? TodoStore?Optional ??? lightweight test doubles?
   */
  getTodos?(): Array<{ id: string; content: string; status: string }>
  /**
   * Wave L: ??????? session ?????????sidecar runServe.close
   * ? shutdownAll????????? coordinator.shutdown ?? timer/in-flight
   * worker?? abort() ??????abort ???? turn ??? agent ??????
   * shutdown ???????Optional ??? lightweight test doubles?
   */
  shutdown?(): void | boolean | Promise<void | boolean>
  /**
   * I1: ??????????? artifact ?? council-plan-json ???
   * ??? CouncilSurface ????????? coordinator ? artifactStore?
   * Optional ??? lightweight test doubles?
   */
  conveneCouncil?(input: {
    artifactId: string
    objective?: string
    seats?: { authority: string; charter?: string }[]
    rounds?: number
  }): Promise<{ planMarkdown: string; artifactId: string }>
  /**
   * User-dispatched background subagent. Runs a worker in its own isolated
   * sub-session via the coordinator with an INDEPENDENT abort signal (so the
   * main turn's abort / model switch does not kill it), streaming progress via
   * the supplied onActivity callback. Does NOT touch the main SessionContext /
   * prefix cache. Optional so lightweight test doubles need not implement it.
   */
  delegateWorker?(
    input: DelegateWorkerInput,
    opts: { workerId: string; signal: AbortSignal; onActivity: (a: DelegateActivityUpdate) => void },
  ): Promise<void>
}

/**
 * Builds the agent for a session. Receives the manager's own session id so the
 * agent's stores (artifacts/session-persist) align with the session ? enabling
 * future artifact recovery across restarts. The optional approvalMode overrides
 * the global config autonomy level for this session (S).
 */
export type AgentFactory = (
  cwd?: string,
  sessionId?: string,
  approvalMode?: ApprovalMode,
  /**
   * Preferred model for the initial build (prefix-cache affinity). A session
   * rebuilt after rehydrate must come back on the model its history was
   * accumulated on ? building on the default model and cross-switching later
   * rebuilds the entire prefix cache. Factories may ignore it (test doubles)
   * or fall back to the default when the id no longer resolves.
   */
  modelId?: string,
) => ManagedAgent | Promise<ManagedAgent>

/**
 * Per-session goal handles, resolved lazily by serve-agent's SessionStores.
 * The manager needs both the RuntimeRefs.goalTrackerRef (read by tool closures)
 * and the sessionDir (for save/restore/delete of goal state) to wire goal mode.
 */
export interface GoalHandles {
  /** The RuntimeRefs.goalTrackerRef ? same object the update_goal and
   *  deliver_task tool closures close over. Mutating .current here keeps the
   *  tools in sync with the agent's own tracker field. */
  goalTrackerRef: { current: import('../agent/goal-tracker.js').GoalTracker | null }
  /** Directory where goal state is persisted (<sessionDir>/<sessionId>.goal.json). */
  sessionDir: string
  /** Configured cheap-worker profile for success-criteria extraction, if any. */
  cheapProfile?: { provider: string; model: string }
  /** All provider configs (for buildCheapClient). undefined when not resolvable. */
  allProviders?: Record<string, unknown>
}

/** Read-only view of a goal tracker's state. Returned by goal endpoints / SSE. */
export interface GoalSnapshot {
  goalId: string
  goal: string
  status: 'active' | 'paused' | 'blocked' | 'complete'
  iteration: number
  maxIterations: number
  wallClockElapsedMs: number
  wallClockBudgetMs?: number
  terminalReason?: string
  successCriteria: string[]
  /** Last completion-judge verdict (null until the first judge run). Shape
   *  mirrors StoredGoalJudgeVerdict from goal-tracker (kept as a structural
   *  type here to avoid a static import ? the field is pass-through only). */
  lastVerdict?: {
    overall: 'verified' | 'rejected' | 'inconclusive'
    criteriaMet: number
    criteriaUnmet: number
    criteriaTotal: number
    summary: string
  }
}

export interface CreateSessionInput {
  cwd?: string
  title?: string
  prompt?: string
  /** P1 ? ??????? Mission id????? title ?? getOrCreate? */
  missionId?: string
  approvalMode?: ApprovalMode
  /** Override the model for this session (takes priority over project/global defaults). */
  model?: string
  /** Override the star domain for this session (takes priority over project/global defaults). */
  domain?: string
  /** Create an isolated git worktree for this session (parallel work without conflict). */
  isolatedWorktree?: boolean
  /**
   * ?????????? v1 ? T2?auto-proceed ????????????????
   * ????? fail-closed ??????????????? + ??????
   */
  unattended?: boolean
  /**
   * P1b????????????????????? UI?
   * ? desktop/TUI ?? true?vscode-extension ?????? false?? sidecar
   * ??? goal ?????????fail-closed?????????????
   */
  planAutoApproveUi?: boolean
}

/** Persisted snapshot of a session: a record + its full event log. */
export interface PersistedSession {
  record: SessionRecord
  events: SessionEvent[]
}

/** One archived session's on-disk footprint, for the storage cleanup UI. */
export interface SessionStorageEntry {
  id: string
  title?: string
  status: SessionStatus
  updatedAt: number
  bytes: number
}

/** Aggregate disk-usage report for the desktop session store. */
export interface StorageReport {
  totalBytes: number
  sessionCount: number
  archivedCount: number
  /** Bytes reclaimable by purging all archived sessions. */
  archivedBytes: number
  /** Archived sessions, oldest first (the natural cleanup order). */
  archived: SessionStorageEntry[]
}

/**
 * ?????????`events` ?????????????????????
 * ???????????????????????
 */
export interface EventsTail {
  /** ?? maxEvents ???????????? */
  events: SessionEvent[]
  /** ?????? seq????? 0?? */
  diskFirstSeq: number
  /** ?????? seq????? 0?? */
  lastSeq: number
  /** ???????? artifact id??????????? artifact ?????? */
  artifactIds: string[]
  /** ?????????????????????????? */
  total: number
}

/**
 * Durable backing store for sessions (N1). Records are snapshotted; events are
 * append-only. Implementations must tolerate a corrupt trailing event line
 * (partial write) on load ? never throw, just drop it.
 */
export interface SessionPersistenceAdapter {
  saveRecord(record: SessionRecord): void
  appendEvent(sessionId: string, event: SessionEvent): void
  /** Flush buffered writes to disk (batched adapters). Optional ? no-op if absent. */
  flushSync?(): void
  loadAll(): PersistedSession[]
  /**
   * Lazy-boot support (optional). `loadRecords` reads ONLY the lightweight
   * index.json snapshot per session ? never the (potentially huge) event log ?
   * so rehydrate is O(sessions) instead of O(total events ever). `loadEvents`
   * reads a single session's full log on demand (first open). Adapters that omit
   * both fall back to the eager `loadAll()` path (fine for tiny in-memory test
   * stores). The file-backed store implements both.
   */
  loadRecords?(): SessionRecord[]
  loadEvents?(sessionId: string): SessionEvent[]
  /**
   * Async event-log read for the reconnect-replay path (optional). Adapters
   * that implement it should do a non-blocking file read and keep JSON parsing
   * off the main thread (worker / chunked) ? a large log parsed inline starves
   * SSE keepalives and turns one reconnect into a storm. Falls back to
   * `loadEvents` when absent.
   */
  loadEventsAsync?(sessionId: string): Promise<SessionEvent[]>
  /**
   * ?????????optional????? loadEventsAsync???????????
   * ? maxEvents ???parse ? worker ????????????????????
   * ?????????????????????????? loadEventsAsync?
   *
   * ?????????????`diskFirstSeq`?????????????
   * `artifactIds`???????????? artifact ??????????
   */
  loadEventsTailAsync?(sessionId: string, maxEvents: number): Promise<EventsTail>
  /**
   * ????????optional???????????? seq < before ???
   * ????? minCount ?????????????????????????
   * ??????????????? getHistoryPage ??? loadEventsAsync
   * ????`atLogStart` = ??????????`firstSeq` = ???? seq?
   */
  loadEventsBefore?(sessionId: string, before: number, minCount: number): Promise<{
    events: SessionEvent[]
    atLogStart: boolean
    firstSeq: number
  }>
  /**
   * Storage-management support (optional). `sizeReport`/`sizeOf` report on-disk
   * byte usage via stat() only (never reading contents); `deleteSession`
   * irreversibly removes a session's files. Used by the manual cleanup UI.
   */
  sizeReport?(): Map<string, number>
  sizeOf?(sessionId: string): number
  deleteSession?(sessionId: string): void
  /**
   * Persist a user-attached image as a standalone file so the event log only
   * carries a small reference id (not the base64). Optional ? adapters that
   * predate vision attachments may omit it. `base64` is the raw payload (no
   * data: prefix). Returns nothing; the caller already owns `imgId`.
   */
  saveImage?(sessionId: string, imgId: string, base64: string, mime: string): void
  /** Read back a persisted image by id. Returns undefined if missing. */
  readImage?(sessionId: string, imgId: string): { bytes: Buffer; mime: string } | undefined
}

export interface RuntimeSessionManagerOptions {
  createAgent: AgentFactory
  defaultCwd?: string
  now?: () => number
  idGenerator?: () => string
  /** Cap on retained events per session (ring buffer). Default 5000. */
  maxEvents?: number
  /**
   * Cap on how many sessions keep their event log resident at once. Lazy-loaded
   * sessions beyond this (LRU, and only ones with no live agent / not running /
   * unwatched) have their logs dropped back to disk, bounding memory regardless
   * of how much history accumulates. Default 16.
   */
  maxLoadedSessions?: number
  /** Auto-resolve a pending intervention after this many ms. 0 = never. Default 0. */
  approvalTimeoutMs?: number
  /** C2 ?? ? watchdog ???????????????ms??Default 5000. */
  watchdogContinueDelayMs?: number
  /** Goal ??????????????????ms???? goal ??????
   *  ?????????????0 = ??????????Default 150000?2.5min?
   *  serve.ts ? RIVET_GOAL_PLAN_AUTO_APPROVE_MS ???? */
  goalPlanAutoApproveMs?: number
  /** Optional durable store. When set, sessions survive sidecar restarts. */
  persistence?: SessionPersistenceAdapter
  /**
   * R1 ? late-bound accessor for the shared cross-session registry. A getter
   * (not a value) because the registry's SQLite backend resolves async after the
   * server starts. Returns undefined when concurrency features are disabled.
   */
  getSessionRegistry?: () => SessionRegistry | undefined
  /**
   * Goal mode ? late-bound accessor for the per-session goal handles (the
   * RuntimeRefs.goalTrackerRef that update_goal / deliver_task tool closures
   * read, plus the session dir for goal state persistence). A getter (not a
   * value) because the handles live in serve-agent's SessionStores, which are
   * built lazily per session and invisible to this generic manager. Returns
   * undefined for sessions without a sidecar-backed store (test doubles). When
   * absent, the goal methods on this manager degrade to "feature unavailable".
   */
  resolveGoalHandles?: (sessionId: string) => GoalHandles | undefined
  /** PlusMenu (review) ? ?????? refs ??????? resolveGoalHandles ?
   *  ???refs ?? serve-agent ? SessionStores ???? manager ?????
   *  ? agent ????? undefined??override ??? applySelections ???? */
  resolveReviewGateRef?: (sessionId: string) => { current: 'auto' | 'off' } | undefined
  /** PlusMenu (review) ? ??????review.skipAuto ????session ? override
   *  ? refs ???? GET ??? */
  defaultReviewGate?: 'auto' | 'off'
  /**
   * PlusMenu (model) ? enumerate selectable models across all configured
   * providers. Injected by serve.ts (which owns the provider config). Absent in
   * tests ? the model picker returns an empty list.
   */
  listModels?: () => ModelOption[]
  /**
   * PlusMenu (model) ? the default model id new sessions start on. Used for the
   * initial record.model and the picker's `current` flag.
   */
  defaultModelId?: string
  /** PlusMenu (domain) ? the default domain key new sessions start on. */
  defaultDomain?: string
  /**
   * Fallback model for one-click resume when the session's original model is
   * no longer available (user-configured, off by default). Resume is strictly
   * model-affine ? without this option an unavailable original model makes
   * resume fail closed (open-a-new-session guidance) instead of silently
   * running the history on the default model and rebuilding the prefix cache.
   */
  resumeFallbackModel?: string
  /**
   * Phase 3 #9 ? release a built agent after this long of session inactivity
   * (0 disables). The agent is the heavy half of a session (AgentLoop, tool
   * registry, prompt engine, coordinator); once released the session also
   * becomes eligible for the event-log LRU. The next prompt rebuilds the agent
   * with history restored from disk ? same recovery path as a sidecar restart.
   * Default 30 minutes.
   */
  idleAgentTtlMs?: number
  /**
   * P1 ????? ? Mission ???????????????????
   * ???? Mission ???????????? title ????????
   * `~/.rivet/missions/`?serve.ts ??????????? mission routes?
   */
  missionStore?: MissionStore
  /** Injectable timer surface for deterministic tool-result coalescing tests. */
  toolResultScheduler?: {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
  /** Injectable plan timer surface for deterministic lifecycle tests. */
  planEventScheduler?: {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
  /** Injectable async plan listing for deterministic lifecycle tests. */
  listPlans?: typeof storeListPlans
}

type InterventionKind = 'approval'

interface PendingIntervention {
  requestId: string
  kind: InterventionKind
  resolve: (value: ApprovalResult | boolean) => void
  timer?: ReturnType<typeof setTimeout>
  /** Tool identity of the gated call ? lets answerIntervention apply
   *  tool-specific "remember" semantics (e.g. computer_use per-app grants). */
  toolName?: string
  /** Original (unredacted) tool input for remember handling. */
  toolInput?: Record<string, unknown>
}

/** E4 ? pending client tool-landing delegation (mirrors PendingIntervention). */
interface PendingDelegation {
  requestId: string
  kind: DelegateKind
  resolve: (value: ClientDelegateResult | null) => void
  timer?: ReturnType<typeof setTimeout>
}

interface DelegateCapabilitySlot {
  clientId: string
  kinds: Set<DelegateKind>
  expiresAt: number
}

interface ActiveRunSettlement {
  settled: boolean
  claimsReleased: boolean
  promise: Promise<void>
  resolve: () => void
}

interface InternalSession {
  record: SessionRecord
  /** Lazily built on first run; null for rehydrated/idle sessions. */
  agent: ManagedAgent | null
  /** S ? per-session autonomy override threaded into the agent on build. */
  approvalMode?: ApprovalMode
  /** Per-session reasoning effort override. Applied to the agent on build and live-mutated mid-session. */
  reasoningEffort?: import('../agent/auto-reasoning.js').ReasoningEffort | 'auto'
  events: SessionEvent[]
  /**
   * Whether `events` holds the full on-disk log. False for a rehydrated session
   * whose log hasn't been read yet (lazy boot) or one whose log was evicted to
   * bound memory ? ensureEvents() (re)loads from disk on first access.
   */
  eventsLoaded: boolean
  /** In-flight async log load ? concurrent async opens share it (no double read). */
  eventsLoadPromise?: Promise<void>
  /**
   * ?????? seq?????????????? events[0].seq ????
   * ?????????replay_window ?????????"???????"?
   * ?????? 1?rehydrate/???? adoptLoadedEvents ????????
   */
  diskFirstSeq?: number
  seq: number
  running: boolean
  activeRunSettlement?: ActiveRunSettlement
  /** Increments when durability ownership is permanently revoked. */
  lifecycleGeneration: number
  /** Permanent-delete tombstone retained by queued callback closures. */
  tombstoned?: boolean
  pending: Map<string, PendingIntervention>
  /** E4 ? in-flight client landing delegations (keyed by requestId). */
  pendingDelegations: Map<string, PendingDelegation>
  /** E4 ? latest registered client capabilities (later registrant wins). */
  delegateCapabilities?: DelegateCapabilitySlot
  listeners: Set<(e: SessionEvent) => void>
  knownArtifacts: Set<string>
  /** T3 ? mid-run user guidance, drained into the agent at the next tool boundary. */
  steer: SteerBuffer
  /**
   * /handoff ??????????? POST /sessions/:id/handoff???? run ???
   * ???? .rivet/HANDOFF.md ????????? <id>.handoff.md??
   * loadPrevHandoff ?????????? TUI pendingHandoffCopy ?????
   */
  pendingHandoff?: { src: string; dest: string; sinceMs: number }
  /**
   * Background job registry (bash run_in_background + `job` tool). Server-owned so
   * it survives agent rebuilds (switchModel) and its lifecycle events can be
   * forwarded to SSE. Lazily created on first ensureAgent, injected into the agent
   * via setJobs, terminated on session close. */
  jobs?: import('../tools/job-store.js').SessionJobs
  /**
   * Lazily built read-only view over the on-disk artifact log for sessions
   * without a live agent (rehydrated/idle). Lets the desktop still read artifact
   * bodies after a sidecar restart, since the agent's ArtifactStore persists
   * both the index and raw files keyed by sessionId.
   */
  rehydratedArtifacts?: ArtifactStore
  /**
   * PlusMenu (domain) ? live star-domain selection. Tri-state mirrors
   * AgentLoop.getSessionDomain: undefined=Auto, null=no-persona (env kill switch
   * only), object=pinned. Applied
   * to the agent on ensureAgent (so lazy build is consistent) and after a model
   * rebuild (so the selection survives switchModel).
   */
  domainState: ActiveStarDomain | null | undefined
  /** PlusMenu (skills) ? per-session disabled skill names (in-memory). */
  disabledSkills: Set<string>
  /** PlusMenu (review) ? ?????????undefined = ??????
   *  ?refs.reviewGateRef ? review.skipAuto ????????
   *  POST /sessions/:id/review-gate ?????????agent ???
   *  ? applySelections ???? refs? */
  reviewGateOverride?: 'auto' | 'off'
  /**
   * Skills that failed to load from .rivet/skills at session create (e.g. a
   * malformed Claude SKILL.md with no/broken frontmatter). Surfaced to the UI so
   * an installed-but-unparseable skill is visible instead of silently dropped.
   */
  skillLoadErrors: string[]
  /**
   * User-dispatched background worker abort controllers, keyed by workerId.
   * Independent from the main turn's signal so a user-launched subagent is NOT
   * killed by aborting the main conversation. Lazily created on first dispatch.
   */
  backgroundAborts?: Map<string, AbortController>
  /**
   * First-seen timestamps per workOrderId, for delegation elapsed reporting.
   * Shared by the run-time callback path and the idle user-dispatch path so both
   * report consistent elapsed. Lazily created.
   */
  delegationStartedAt?: Map<string, number>
  /** Watchdog stall ??????? TUI ??????? session ????? */
  watchdogPolicy?: WatchdogRecoveryPolicy
  /** ???? onAbort ??? reason?watchdog ????????? run ????? */
  lastAbortReason?: string
  /** onAbort ??????????????????run().finally ? rejectAllPending ??? pending map? */
  abortWhileApprovalPending?: boolean
  /** ????????????this.now() ?????? grace ????? */
  lastApprovalDeniedAt?: number
  /** ????? run ? watchdog ??????? recordUserSubmit?? TUI ?
   *  onSubmitCallback ???????????????? consecutive?? */
  watchdogAutoResubmit?: boolean
  /** ??? watchdog stall?setImmediate ????? abort ? ? true ?????
   *  abort() ??????????status ? aborted????????????
   *  ?????????????????run() ????? */
  watchdogRecoveryCancelled?: boolean
  /** C2 ?? ? watchdog ?????????????? abort / ? prompt ??? */
  watchdogContinueTimer?: NodeJS.Timeout
  /** Goal ????????? ? ?????? slug??????????
   * ?approve/reject/edit/prompt/steer/abort/????????? */
  planAutoApproveTimer?: NodeJS.Timeout
  planAutoApproveSlug?: string
  /** plan_draft ?? ? ?????????this.now() ???? */
  planDraftLastEmit?: number
  /** plan_draft ?? ? ????????????????????????? */
  planDraftTimer?: unknown
  planDraftTimerGeneration?: number
  /** ??????????? fail-closed ?????? v1 ? T2?? */
  unattended?: boolean
  /** P1b???????? plan ??????? UI??? false = fail-closed? */
  planAutoApproveUi?: boolean
  /** ???????????????????? done/summary ??? */
  unattendedHaltReason?: string
  /** ??????????? app ????????????????????? */
  unattendedHaltApp?: string
  /** ?? delta ?????Wave 2???? bufferDelta()? */
  deltaBuf?: { type: 'text_delta' | 'thinking_delta'; text: string }
  /** delta ???????? */
  deltaTimer?: NodeJS.Timeout
  /** ?? delta run ??????????? token ??????????? */
  deltaRunActive?: boolean
  /** Contiguous streaming tool_result run; terminal results are never buffered. */
  toolResultStream?: { id: string; name: string; buffered: string; active: boolean }
  toolResultTimer?: unknown
  /** Reject streaming callbacks from an archived/deleted agent closure. */
  toolResultClosed?: boolean
}

/** Tools that spawn worker agents ? surfaced as delegation-tree nodes (N3). */
const DELEGATION_TOOLS = new Set(['delegate_task', 'delegate_batch', 'team_orchestrate', 'council_convene', 'galaxy'])

/** ?????? watchdog ????????? TuiApp.APPROVAL_STALL_GRACE_MS ???
 *  ????? stall ??? continue ????????????deny?continue?deny ??? */
const WATCHDOG_APPROVAL_GRACE_MS = 5_000

/** Cap on concurrent user-dispatched background workers per session (guards the
 *  shared coordinator from being swamped). */
const MAX_USER_BACKGROUND_WORKERS = 4

/** plan_draft ????????agent ??????????????250ms
 *  ???????????? burst ????????? metadata?SSE live ?????? */
const PLAN_DRAFT_THROTTLE_MS = 250

/** plan_draft SSE ????????????????????? GET /plans? */
const PLAN_DRAFT_LIVE_CONTENT_MAX = 200_000

/** Delta ?????Wave 2???provider ? token ????? token ??
 *  JSON.stringify + SSE write ???????????? delta ?????
 *  ?????? seq????/????????40ms ? ?? 10Hz ?????
 *  1/2.5?????? */
const DELTA_COALESCE_MS = 40

/** ???????????? flush???????????????? */
const DELTA_COALESCE_MAX_CHARS = 2_048
const TOOL_RESULT_COALESCE_MS = 40
const TOOL_RESULT_COALESCE_BYTES = 2_048

function takeUtf8Prefix(text: string, maxBytes: number): { head: string; tail: string } {
  let bytes = 0
  let end = 0
  for (const point of text) {
    const pointBytes = Buffer.byteLength(point)
    if (bytes + pointBytes > maxBytes) break
    bytes += pointBytes
    end += point.length
  }
  return { head: text.slice(0, end), tail: text.slice(end) }
}


/** Result of a user-dispatch request ? lets the route map a precise status code. */
export type DelegateResult =
  | { ok: true; workerId: string }
  | { ok: false; reason: 'not_found' | 'invalid' | 'unsupported' | 'limit' }

/** Result of a one-click resume ? `switched` means the fallback model took
 *  over (UI must disclose that the prefix cache will be rebuilt). */
export type ResumeRunResult =
  | { ok: true; model: string; switched: boolean }
  | { ok: false; code: 'not_found' | 'busy' | 'model_unavailable'; error: string }

/** Injected user prompt for a resumed run ? the model context was restored
 *  from disk, so a short continuation instruction rides the existing history
 *  (appended at the tail ? prefix-cache friendly). */
export const RESUME_PROMPT =
  '[??] ???????????????????????????????????????????????????????????'

/**
 * Parent-node objective for a delegation tool call. Prefer a top-level
 * objective/prompt; for delegate_batch fall back to summarizing tasks[].
 * Exported for unit tests.
 */
export function extractObjective(input: Record<string, unknown>): string {
  for (const key of ['objective', 'prompt', 'description', 'goal']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return v.slice(0, 200)
  }
  // delegate_batch: tasks: [{ objective, ... }, ...]
  const tasks = input.tasks
  if (Array.isArray(tasks) && tasks.length > 0) {
    const parts: string[] = []
    for (const t of tasks.slice(0, 3)) {
      if (t && typeof t === 'object' && typeof (t as { objective?: unknown }).objective === 'string') {
        const o = String((t as { objective: string }).objective).trim()
        if (o) parts.push(o.slice(0, 80))
      }
    }
    if (parts.length > 0) {
      const more = tasks.length > parts.length ? ` (+${tasks.length - parts.length} more)` : ''
      return `${parts.join(' ? ')}${more}`.slice(0, 200)
    }
  }
  return ''
}

/**
 * Scan an event log for approvals that were requested but never resolved ?
 * i.e. the run was interrupted (sidecar restart) while blocked on them.
 * Used by rehydrate() to close them out honestly instead of leaving a
 * dangling approval card in the replayed timeline.
 */
function findOrphanedApprovals(events: SessionEvent[]): Array<{ requestId: string; toolName: string }> {
  const open = new Map<string, string>()
  for (const e of events) {
    const id = typeof e.data.requestId === 'string' ? e.data.requestId : ''
    if (!id) continue
    if (e.type === 'approval_required') {
      open.set(id, typeof e.data.toolName === 'string' ? e.data.toolName : '')
    } else if (e.type === 'approval_resolved') {
      open.delete(id)
    }
  }
  return [...open.entries()].map(([requestId, toolName]) => ({ requestId, toolName }))
}

/** T2 ? todo item as surfaced to the desktop (subset of the tool's schema). */
interface TodoStateItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * T2 ? parse a `todo` write tool input into structured items.
 *
 * We read the per-call input rather than the global TodoStore singleton on
 * purpose: the store is shared across all sidecar sessions, so its snapshot is
 * not session-correct, whereas the tool input belongs to this session's call.
 * Returns null for non-write actions or malformed payloads.
 */
function extractTodoState(input: Record<string, unknown>): TodoStateItem[] | null {
  if (input.action !== 'write') return null
  const raw = input.todos
  if (!Array.isArray(raw)) return null
  const items: TodoStateItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id : ''
    const content = typeof e.content === 'string' ? e.content : ''
    const status = e.status === 'in_progress' || e.status === 'completed' ? e.status : 'pending'
    if (!id || !content) continue
    items.push({ id, content, status })
  }
  return items
}

export class RuntimeSessionManager {
  private readonly sessions = new Map<string, InternalSession>()
  private readonly createAgent: AgentFactory
  private readonly defaultCwd: string
  private readonly now: () => number
  private readonly idGenerator: () => string
  private readonly maxEvents: number
  private readonly maxLoadedSessions: number
  /** LRU of session ids whose event log is currently resident (oldest first). */
  private readonly loadedOrder: string[] = []
  private readonly approvalTimeoutMs: number
  private readonly watchdogContinueDelayMs: number
  private readonly goalPlanAutoApproveMs: number
  private readonly persistence?: SessionPersistenceAdapter
  private readonly getRegistry?: () => SessionRegistry | undefined
  private readonly listModelsFn?: () => ModelOption[]
  private readonly defaultModelId?: string
  private readonly defaultDomain?: string
  private readonly resumeFallbackModel?: string
  private readonly idleAgentTtlMs: number
  /** Goal mode ? late-bound per-session goal handles (refs + sessionDir). */
  private readonly resolveGoalHandles?: (sessionId: string) => GoalHandles | undefined
  /** PlusMenu (review) ? late-bound per-session review-gate ref accessor. */
  private readonly resolveReviewGateRef?: (sessionId: string) => { current: 'auto' | 'off' } | undefined
  /** PlusMenu (review) ? config-derived default when no override and no refs. */
  private readonly defaultReviewGate: 'auto' | 'off'
  private readonly toolResultScheduler: {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
  private readonly planEventScheduler: {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
  private readonly loadPlans: typeof storeListPlans
  /** P1 ????? ? ?? Mission ??????? Mission ???????? */
  private readonly missionStore?: MissionStore
  private idleSweepTimer?: ReturnType<typeof setInterval>
  /** Per-session coordinator refs for worker steer/kill (set by main.ts after agent build). */
  private readonly coordinatorBySession = new Map<string, () => import('../agent/coordinator.js').DelegationCoordinator | undefined>()

  constructor(opts: RuntimeSessionManagerOptions) {
    this.createAgent = opts.createAgent
    this.defaultCwd = opts.defaultCwd ?? process.cwd()
    this.now = opts.now ?? Date.now
    this.idGenerator = opts.idGenerator ?? (() => randomId())
    // RIVET_MAX_EVENTS?????????dev ??/??????????
    // ?????????????????? getHistoryPage ????????
    const envMaxEvents = Number(process.env.RIVET_MAX_EVENTS)
    this.maxEvents = opts.maxEvents
      ?? (Number.isFinite(envMaxEvents) && envMaxEvents >= 100 ? Math.floor(envMaxEvents) : 5000)
    this.maxLoadedSessions = opts.maxLoadedSessions ?? 16
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 0
    this.watchdogContinueDelayMs = opts.watchdogContinueDelayMs ?? 5_000
    this.goalPlanAutoApproveMs = opts.goalPlanAutoApproveMs ?? 150_000
    this.persistence = opts.persistence
    this.getRegistry = opts.getSessionRegistry
    this.listModelsFn = opts.listModels
    this.defaultModelId = opts.defaultModelId
    this.resumeFallbackModel = opts.resumeFallbackModel
    this.idleAgentTtlMs = opts.idleAgentTtlMs ?? 30 * 60_000
    this.resolveGoalHandles = opts.resolveGoalHandles
    this.resolveReviewGateRef = opts.resolveReviewGateRef
    this.defaultReviewGate = opts.defaultReviewGate ?? 'auto'
    this.toolResultScheduler = opts.toolResultScheduler ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    this.planEventScheduler = opts.planEventScheduler ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    this.loadPlans = opts.listPlans ?? storeListPlans
    this.missionStore = opts.missionStore
    if (this.idleAgentTtlMs > 0) {
      // Sweep once a minute; unref so the timer never keeps the process alive.
      this.idleSweepTimer = setInterval(() => this.sweepIdleAgents(), 60_000)
      this.idleSweepTimer.unref?.()
    }
    if (this.persistence) this.rehydrate()
  }

  /**
   * Phase 3 #9 ? release built agents of long-idle sessions so a day-long
   * sidecar doesn't accumulate one live AgentLoop per conversation ever opened.
   * Conservative gates: never touches a session that is running, holds pending
   * approvals, has user background workers or running jobs. Rebuild on the next
   * prompt goes through ensureAgent ? history restore, the same path a sidecar
   * restart uses (prefix cache is content-addressed, so byte-identical history
   * still hits).
   */
  sweepIdleAgents(): void {
    if (this.idleAgentTtlMs <= 0) return
    const now = this.now()
    for (const s of this.sessions.values()) {
      if (!s.agent || s.running) continue
      if (s.pending.size > 0) continue
      if (s.backgroundAborts && s.backgroundAborts.size > 0) continue
      if (s.jobs && s.jobs.list().some((j) => j.status === 'running')) continue
      if (now - s.record.updatedAt < this.idleAgentTtlMs) continue
      this.releaseAgent(s)
    }
    // Agent-free sessions are now eligible for the event-log LRU too.
    this.evictLoadedBeyondCap()
  }

  /** Shut down and drop a session's built agent (timers, coordinator, in-flight
   *  worker handles). The lightweight record/events stay; ensureAgent rebuilds
   *  on demand. Caller guarantees the session is not running. */
  private releaseAgent(s: InternalSession): void {
    let shutdownResult: void | boolean | Promise<void | boolean> | undefined
    try { shutdownResult = s.agent?.shutdown?.() } catch { /* best-effort */ }
    s.agent = null
    // A built agent may own claims even when the session has gone idle.  Wait
    // for async coordinator cleanup before releasing them; otherwise a worker
    // that ignored abort could race a new session during idle eviction.
    if (shutdownResult && typeof (shutdownResult as Promise<void>).then === 'function') {
      void Promise.resolve(shutdownResult).then(
        (settled) => { if (settled !== false) this.releaseClaimsIfIdle(s) },
        () => undefined,
      )
    } else if (shutdownResult !== false) {
      this.releaseClaimsIfIdle(s)
    }
  }

  /** Release claims only after the session has no active run settlement. */
  private releaseClaimsIfIdle(s: InternalSession): void {
    if (s.running || s.activeRunSettlement) return
    try { this.getRegistry?.()?.releaseAllClaims(s.record.id) } catch { /* best-effort */ }
  }

  /**
   * Phase 3 #9 ? drop a session's heavy in-memory state entirely (agent, event
   * ring, background jobs). Used by the archive path: an archived session is
   * closed, so its jobs are terminated (mirrors hardDelete) and its log is
   * evicted; everything reloads lazily from disk if the session is reopened.
   */
  private unloadSession(s: InternalSession): void {
    if (s.running) return
    this.releaseAgent(s)
    try { s.jobs?.killAll() } catch { /* best-effort */ }
    s.jobs = undefined
    // Never drop unflushed coalesced deltas ? they'd be lost from the replay.
    this.flushDeltaBuf(s)
    this.flushToolResultBuf(s)
    s.events = []
    s.knownArtifacts = new Set()
    s.eventsLoaded = false
    const i = this.loadedOrder.indexOf(s.record.id)
    if (i !== -1) this.loadedOrder.splice(i, 1)
  }

  /**
   * Restore sessions from the persistence store on boot. Honest semantics: the
   * old agent run is gone, so any session that was 'running' is restored as
   * 'aborted' (interrupted by restart) and is view-only until a fresh run is
   * started in the same cwd. events.jsonl is the source of truth for seq.
   */
  private rehydrate(): void {
    const p = this.persistence!
    // Lazy boot: read only the lightweight index.json records ? NOT the event
    // logs ? so a sidecar restart is O(sessions) instead of O(total events ever).
    // With dozens of long sessions the eager path read+parsed tens of MB of
    // events.jsonl synchronously on every launch (slow start + unbounded RAM);
    // here each session starts with an empty log that ensureEvents() fills on
    // first open. Falls back to eager loadAll() for adapters without lazy support.
    if (typeof p.loadRecords === 'function' && typeof p.loadEvents === 'function') {
      let records: SessionRecord[]
      try { records = p.loadRecords() } catch { return }
      for (const rec of records) {
        const wasRunning = rec.status === 'running'
        const session: InternalSession = {
          record: {
            ...rec,
            status: wasRunning ? 'aborted' : rec.status,
            lastSeq: rec.lastSeq,
            pendingApprovals: 0,
          },
          agent: null,
          events: [],
          eventsLoaded: false,
          seq: rec.lastSeq,
          running: false,
          lifecycleGeneration: 0,
          pending: new Map(),
          pendingDelegations: new Map(),
          listeners: new Set(),
          knownArtifacts: new Set(),
          steer: new SteerBuffer(),
          domainState: resolveDomainState(rec.domain ?? 'auto')?.state,
          disabledSkills: new Set(),
          skillLoadErrors: [],
          reasoningEffort: rec.reasoningEffort as import('../agent/auto-reasoning.js').ReasoningEffort | 'auto' | undefined,
          planAutoApproveUi: rec.planAutoApproveUi === true,
        }
        this.sessions.set(session.record.id, session)
        if (wasRunning) {
          // If the run died while blocked on approvals, close them out honestly:
          // read this ONE session's log (bounded: only crashed-with-pending
          // sessions pay it ? the pendingApprovals>0 gate keeps lazy boot lazy),
          // find approval_required events with no matching approval_resolved,
          // and append 'sidecar-restart' resolutions so the replayed timeline
          // shows WHAT was pending instead of a dangling, unanswerable card.
          let orphans: Array<{ requestId: string; toolName: string }> = []
          if (rec.pendingApprovals > 0) {
            try { orphans = findOrphanedApprovals(p.loadEvents!(rec.id)) } catch { /* best-effort */ }
          }
          // Persist the markers straight to disk WITHOUT keeping the log
          // resident. They re-appear when ensureEvents() reads it on first open.
          const appendMarker = (type: SessionEventType, data: Record<string, unknown>) => {
            const marker: SessionEvent = { seq: ++session.seq, ts: this.now(), type, data }
            session.record.lastSeq = session.seq
            session.record.updatedAt = marker.ts
            try { p.appendEvent(session.record.id, marker) } catch { /* best-effort */ }
          }
          for (const o of orphans) {
            appendMarker('approval_resolved', { requestId: o.requestId, decision: 'sidecar-restart', toolName: o.toolName })
          }
          appendMarker('status', {
            status: 'aborted',
            reason: 'sidecar-restart',
            ...(orphans.length ? { interruptedApprovals: orphans } : {}),
          })
          // One-click resume entry (Phase 3). Carries the model/domain the run
          // was on ? resume is strictly affine to both (prefix-cache), enforced
          // server-side by resumeRun().
          appendMarker('resume_offer', {
            model: rec.model ?? null,
            domain: rec.domain ?? 'auto',
          })
          this.persistRecord(session)
        }
      }
      return
    }

    // Eager fallback (in-memory / legacy adapters with only loadAll()).
    let restored: PersistedSession[]
    try {
      restored = p.loadAll()
    } catch {
      return
    }
    for (const ps of restored) {
      const events = ps.events.slice().sort((a, b) => a.seq - b.seq)
      const maxSeq = events.length ? events[events.length - 1]!.seq : ps.record.lastSeq
      const wasRunning = ps.record.status === 'running'
      const session: InternalSession = {
        record: {
          ...ps.record,
          status: wasRunning ? 'aborted' : ps.record.status,
          lastSeq: maxSeq,
          pendingApprovals: 0,
        },
        agent: null,
        // ??????????????????? maxEvents ????
        events: events.length > this.maxEvents ? events.slice(events.length - this.maxEvents) : events,
        diskFirstSeq: events[0]?.seq,
        eventsLoaded: true,
        seq: maxSeq,
        running: false,
        lifecycleGeneration: 0,
        pending: new Map(),
        pendingDelegations: new Map(),
        listeners: new Set(),
        knownArtifacts: new Set(
          events.filter((e) => e.type === 'artifact').map((e) => String(e.data.id)),
        ),
        steer: new SteerBuffer(),
        // Restore the live domain selection from the persisted key so a rebuilt
        // agent re-applies it. Skills are in-memory only ? start clean.
        domainState: resolveDomainState(ps.record.domain ?? 'auto')?.state,
        disabledSkills: new Set(),
        skillLoadErrors: [],
        reasoningEffort: ps.record.reasoningEffort as import('../agent/auto-reasoning.js').ReasoningEffort | 'auto' | undefined,
        planAutoApproveUi: ps.record.planAutoApproveUi === true,
      }
      this.sessions.set(session.record.id, session)
      if (wasRunning) {
        // Close out approvals the crash left dangling (see lazy path above) ?
        // here the full log is already in memory, so scan it directly.
        const orphans = findOrphanedApprovals(events)
        for (const o of orphans) {
          this.append(session, 'approval_resolved', { requestId: o.requestId, decision: 'sidecar-restart', toolName: o.toolName })
        }
        // Record an honest marker so the viewer sees the interruption.
        this.append(session, 'status', {
          status: 'aborted',
          reason: 'sidecar-restart',
          ...(orphans.length ? { interruptedApprovals: orphans } : {}),
        })
        // One-click resume entry (Phase 3) ? see the lazy path above.
        this.append(session, 'resume_offer', {
          model: ps.record.model ?? null,
          domain: ps.record.domain ?? 'auto',
        })
        this.persistRecord(session)
      }
    }
  }

  /**
   * Lazy-load a rehydrated/evicted session's event log on first access, then keep
   * at most `maxLoadedSessions` logs resident (LRU). Idempotent. All code paths
   * that read or append to `session.events` must funnel through here first so the
   * in-memory log is the complete on-disk log (not an empty lazy placeholder).
   */
  private ensureEvents(session: InternalSession): void {
    if (!session.eventsLoaded) {
      const loader = this.persistence?.loadEvents
      let loadError: string | undefined
      if (loader) {
        let evs: SessionEvent[]
        try {
          evs = loader.call(this.persistence, session.record.id)
        } catch (err) {
          // Do NOT silently replay an empty history ? record the failure so it
          // surfaces as a visible error event below (a viewer that reconnects
          // into a blank timeline otherwise has no clue the log read failed).
          evs = []
          loadError = redactText((err as Error)?.message ?? String(err))
        }
        this.adoptLoadedEvents(session, evs)
      }
      session.eventsLoaded = true
      if (loadError !== undefined) {
        this.append(session, 'error', {
          error: `event log could not be read ? history replay is incomplete (${loadError})`,
        })
      }
      // ???????sidecar ?? / abort ????????????????
      // ?????????????????????running ?? run ??????
      this.sweepStaleDelegationNodes(session, 'caller_aborted')
    }
    this.touchLoaded(session)
    this.evictLoadedBeyondCap()
  }

  /** Fold a freshly-read on-disk log into the session (shared by the sync and
   *  async load paths). Caller still owns the eventsLoaded flag. */
  private adoptLoadedEvents(session: InternalSession, evs: SessionEvent[]): void {
    evs.sort((a, b) => a.seq - b.seq)
    // knownArtifacts ????????????? artifact ????????
    // ????????????????????? artifact??
    session.knownArtifacts = new Set(
      evs.filter((e) => e.type === 'artifact').map((e) => String(e.data.id)),
    )
    // ????????? seq??replay_window ???????????????
    if (evs.length > 0) session.diskFirstSeq = evs[0]!.seq
    const maxSeq = evs.length ? evs[evs.length - 1]!.seq : session.record.lastSeq
    session.seq = Math.max(session.seq, maxSeq)
    // ????????????????????????? ? maxEvents??
    // ??????????????????????????append ?????
    // ??? since=0 ???????????????? events.jsonl ???
    // ??????? source of truth?
    session.events = evs.length > this.maxEvents ? evs.slice(evs.length - this.maxEvents) : evs
  }

  /** adoptLoadedEvents ???????????????????????
   *  diskFirstSeq / artifactIds ??????????????? */
  private adoptLoadedTail(session: InternalSession, tail: EventsTail): void {
    session.knownArtifacts = new Set(tail.artifactIds)
    if (tail.total > 0) session.diskFirstSeq = tail.diskFirstSeq
    const maxSeq = tail.total > 0 ? tail.lastSeq : session.record.lastSeq
    session.seq = Math.max(session.seq, maxSeq)
    session.events = tail.events
  }

  /**
   * Async twin of ensureEvents for the reconnect-replay entry points. Uses the
   * adapter's non-blocking `loadEventsAsync` when available (async file read +
   * off-thread parse) so a multi-MB log doesn't stall SSE keepalives.
   * Guards:
   *  - concurrent async opens share one in-flight load (no double read);
   *  - if a sync ensureEvents() wins the race while we awaited, the stale disk
   *    snapshot is discarded ? the sync path may already have appended fresh
   *    events that a blind overwrite would drop.
   */
  private async ensureEventsAsync(session: InternalSession): Promise<void> {
    if (!session.eventsLoaded) {
      // ?????????????????????????????
      const tailLoader = this.persistence?.loadEventsTailAsync
      const asyncLoader = this.persistence?.loadEventsAsync
      if (!tailLoader && !asyncLoader) {
        this.ensureEvents(session)
        return
      }
      if (!session.eventsLoadPromise) {
        session.eventsLoadPromise = (async () => {
          let tail: Awaited<ReturnType<NonNullable<typeof tailLoader>>> | undefined
          let evs: SessionEvent[] = []
          let loadError: string | undefined
          try {
            if (tailLoader) {
              tail = await tailLoader.call(this.persistence, session.record.id, this.maxEvents)
            } else {
              evs = await asyncLoader!.call(this.persistence, session.record.id)
            }
          } catch (err) {
            tail = undefined
            evs = []
            loadError = redactText((err as Error)?.message ?? String(err))
          }
          if (session.eventsLoaded) return // sync load won the race ? keep it
          if (tail) this.adoptLoadedTail(session, tail)
          else this.adoptLoadedEvents(session, evs)
          session.eventsLoaded = true
          if (loadError !== undefined) {
            this.append(session, 'error', {
              error: `event log could not be read ? history replay is incomplete (${loadError})`,
            })
          }
          // ? ensureEvents ??????????????
          this.sweepStaleDelegationNodes(session, 'caller_aborted')
        })().finally(() => {
          session.eventsLoadPromise = undefined
        })
      }
      await session.eventsLoadPromise
    }
    this.touchLoaded(session)
    this.evictLoadedBeyondCap()
  }

  /** Async twin of getEvents ? reconnect/replay entry point for HTTP routes. */
  async getEventsAsync(id: string, since = 0): Promise<{ events: SessionEvent[]; lastSeq: number } | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    await this.ensureEventsAsync(s)
    this.flushDeltaBuf(s)
    this.flushToolResultBuf(s)
    const events = s.events.filter((e) => e.seq > since)
    return { events, lastSeq: s.seq }
  }

  /**
   * ???????????????/stream ??????? replay_window
   * ?????diskFirstSeq < floorSeq ? ???????????????
   * ?????????????? getEventsAsync ?????events ?????
   */
  getReplayWindow(id: string): { floorSeq: number; diskFirstSeq: number; diskLastSeq: number } | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    const floorSeq = s.events[0]?.seq ?? s.seq + 1
    return { floorSeq, diskFirstSeq: s.diskFirstSeq ?? floorSeq, diskLastSeq: s.seq }
  }

  /**
   * ?????????????????????? loadEventsAsync ?
   * off-thread parse???? seq < before ??? ~limit ????????
   * ??? user ???? turn ???????? fold ?????????
   * ???????? history-page-fold.test.ts????????????
   * ?? events.jsonl ???????? source of truth?
   *
   * seq ???????????????????????????
   */
  async getHistoryPage(id: string, before: number, limit: number): Promise<{
    events: SessionEvent[]
    /** ?????? seq??events[0].seq ????????? */
    firstSeq: number
    lastSeq: number
  } | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    const p = this.persistence
    // ????Phase 2?????????????????????????
    // turn ??????? limit ?????????????? user ????
    // ???????? 4 ????????????? ? ???????
    if (p?.loadEventsBefore) {
      try {
        // +500???????????????? turn ???~100-200 ???
        // ????????? user ??????????
        let want = Math.max(1, limit) + 500
        for (let attempt = 0; attempt < 4; attempt++) {
          const win = await p.loadEventsBefore.call(p, id, before, want)
          const head = win.events
          let start = Math.max(0, head.length - Math.max(1, limit))
          while (start > 0 && head[start]!.type !== 'user') start--
          const aligned = start > 0 || win.atLogStart || head[0]?.type === 'user'
          if (aligned) {
            return { events: head.slice(start), firstSeq: win.firstSeq, lastSeq: s.seq }
          }
          want *= 4
        }
      } catch { /* ?????? ? ???? */ }
    }
    let all: SessionEvent[]
    if (p?.loadEventsAsync) {
      try { all = await p.loadEventsAsync.call(p, id) } catch { all = [] }
    } else if (p?.loadEvents) {
      try { all = p.loadEvents.call(p, id) } catch { all = [] }
    } else {
      // ephemeral ??????????????????
      all = s.events
    }
    const firstSeq = all[0]?.seq ?? 0
    const head = all.filter((e) => e.seq < before)
    let start = Math.max(0, head.length - Math.max(1, limit))
    // turn ?????????? user ??????????????????
    // ????????????????? before = ?? events[0].seq??
    while (start > 0 && head[start]!.type !== 'user') start--
    return { events: head.slice(start), firstSeq, lastSeq: s.seq }
  }

  /**
   * ???????????????Phase 2???? insights / getWorkerLog /
   * listRewindPoints ?????????????????????????
   * ???????????????????? loadEventsAsync ? off-thread
   * parse?ephemeral??????????????????????????
   */
  async getAllEventsAsync(id: string): Promise<{ events: SessionEvent[]; lastSeq: number } | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    // ??? manager ??????delta/tool_result?????????? append?
    this.flushDeltaBuf(s)
    this.flushToolResultBuf(s)
    const p = this.persistence
    if (p?.loadEventsAsync) {
      try {
        return { events: await p.loadEventsAsync.call(p, id), lastSeq: s.seq }
      } catch { /* fall back to ring */ }
    } else if (p?.loadEvents) {
      try {
        return { events: p.loadEvents.call(p, id), lastSeq: s.seq }
      } catch { /* fall back to ring */ }
    }
    return this.getEventsAsync(id, 0)
  }

  /**
   * ????(W2):?? worker ??????????(?? delegation ??)
   * + ????(loadPersistedResult)+ ????(loadWorkerSession,
   * ? CLI worker-detail ?? ~/.rivet/subagents/<orderId>.session.jsonl)?
   * ?? undefined = ?????;??????????(worker ????)?
   * `full` ??(??????????):???? 50 ?,????????,
   * ??????????(toolInput)???????????
   * rounds:?? id ??????????(L1),result ????????
   */
  async getWorkerLog(id: string, workerId: string, opts?: { full?: boolean }): Promise<{
    activity: string[]
    result: ReturnType<typeof loadPersistedResult>
    rounds: PersistedResultRound[]
    transcript: { role: string; text: string; toolName?: string; toolInput?: string }[]
    savedAt: number | null
    /** true = ??????????????????(?? full=1 ???)? */
    truncated: boolean
  } | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    const full = opts?.full === true
    // ????:??????? worker ? progressLine / ???? / ?????
    // ?????(Phase 2):???????????,????? worker ?????
    const { events } = (await this.getAllEventsAsync(id)) ?? { events: [] as SessionEvent[] }
    const activity: string[] = []
    for (const e of events) {
      if (e.type !== 'delegation') continue
      if (String(e.data.workOrderId ?? '') !== workerId) continue
      const line = e.data.progressLine
        ?? (e.data.eventKind === 'text' ? e.data.eventDetail : undefined)
        ?? (e.data.status != null ? `status: ${String(e.data.status)}` : undefined)
      if (typeof line === 'string' && line) activity.push(line.slice(0, 300))
    }
    const result = loadPersistedResult(workerId)
    // ????????????coordinator per-order ?????saveWorkerSession
    // ???????????????????????/?????????
    const liveMessages = this.coordinatorBySession.get(id)?.()?.getLiveWorkerMessages(workerId)
    const record = liveMessages && liveMessages.length > 0 ? null : loadWorkerSession(workerId)
    const messages = liveMessages && liveMessages.length > 0 ? liveMessages : (record?.messages ?? [])
    const keep = full ? messages : messages.slice(-50)
    const textCap = full ? 4000 : 800
    const transcript = keep.map((m: OaiMessage) => ({
      role: m.role,
      // ??????? assistant.content ? null??oaiMessageText ?????? null,????
      text: (oaiMessageText(m) ?? '').slice(0, textCap),
      toolName: isAssistantWithTools(m) ? m.tool_calls[0]?.function.name : undefined,
      toolInput: isAssistantWithTools(m) ? summarizeToolCallArgs(m.tool_calls[0]) : undefined,
    }))
    return {
      activity: full ? activity : activity.slice(-50),
      result,
      rounds: listPersistedResultRounds(workerId),
      transcript,
      savedAt: record?.savedAt ?? null,
      truncated: !full && messages.length > 50,
    }
  }

  /** Mark a session's log as most-recently-used in the LRU. */
  private touchLoaded(session: InternalSession): void {
    if (!session.eventsLoaded) return
    const id = session.record.id
    const i = this.loadedOrder.indexOf(id)
    if (i !== -1) this.loadedOrder.splice(i, 1)
    this.loadedOrder.push(id)
  }

  /**
   * Drop event logs of idle LRU sessions to bound resident memory. Never unloads
   * a session that's live (agent built or running) or being watched (SSE
   * listeners) ? its in-memory log is the source of truth for in-flight appends
   * and replay; those reload cleanly from disk once idle.
   */
  private evictLoadedBeyondCap(): void {
    let i = 0
    while (i < this.loadedOrder.length && this.loadedOrder.length > this.maxLoadedSessions) {
      const id = this.loadedOrder[i]!
      const s = this.sessions.get(id)
      if (!s || s.agent || s.running || s.listeners.size > 0) { i++; continue }
      s.events = []
      s.knownArtifacts = new Set()
      s.eventsLoaded = false
      this.loadedOrder.splice(i, 1)
    }
  }

  /** Lightweight counts for GET /health. */
  stats(): { sessionCount: number; runningCount: number } {
    let runningCount = 0
    for (const s of this.sessions.values()) if (s.running) runningCount++
    return { sessionCount: this.sessions.size, runningCount }
  }

  /**
   * Disk-usage report for the storage cleanup UI. Sizes come from the
   * persistence adapter's stat()-only scan (no event-log reads), so this is
   * cheap to call even with a large history. Archived sessions are the
   * reclaimable set and are returned oldest-first.
   */
  storageReport(): StorageReport {
    const sizes = this.persistence?.sizeReport?.() ?? new Map<string, number>()
    let totalBytes = 0
    let archivedBytes = 0
    const archived: SessionStorageEntry[] = []
    for (const s of this.sessions.values()) {
      const bytes = sizes.get(s.record.id) ?? 0
      totalBytes += bytes
      if (s.record.archived === true) {
        archivedBytes += bytes
        archived.push({
          id: s.record.id,
          title: s.record.title,
          status: s.record.status,
          updatedAt: s.record.updatedAt,
          bytes,
        })
      }
    }
    archived.sort((a, b) => a.updatedAt - b.updatedAt)
    return {
      totalBytes,
      sessionCount: this.sessions.size,
      archivedCount: archived.length,
      archivedBytes,
      archived,
    }
  }

  /**
   * Irreversibly delete ONE archived session's files. Guarded: refuses unless
   * the session is archived. An archived run may still be settling after its
   * abort request; hard delete tombstones durability while finalization retains
   * only the in-memory busy/resource cleanup path.
   */
  deleteSession(id: string): { ok: boolean; freedBytes: number } {
    const s = this.sessions.get(id)
    if (!s || s.record.archived !== true) return { ok: false, freedBytes: 0 }
    const freedBytes = this.persistence?.sizeOf?.(id) ?? 0
    return { ok: this.hardDelete(id), freedBytes }
  }

  /**
   * Bulk-purge archived sessions. `ids` restricts to a specific set; otherwise
   * all archived qualify. `olderThanMs` further keeps only sessions untouched
   * for at least that long (relative to updatedAt). Never touches active or
   * running sessions. Returns the count and total bytes reclaimed.
   */
  purgeArchived(opts: { ids?: string[]; olderThanMs?: number } = {}): {
    deleted: number
    freedBytes: number
    ids: string[]
  } {
    const now = this.now()
    const idFilter = opts.ids ? new Set(opts.ids) : null
    const sizes = this.persistence?.sizeReport?.() ?? new Map<string, number>()
    const targets: string[] = []
    for (const s of this.sessions.values()) {
      if (s.record.archived !== true || s.running) continue
      if (idFilter && !idFilter.has(s.record.id)) continue
      if (opts.olderThanMs != null && now - s.record.updatedAt < opts.olderThanMs) continue
      targets.push(s.record.id)
    }
    let freedBytes = 0
    const deleted: string[] = []
    for (const id of targets) {
      if (this.hardDelete(id)) {
        freedBytes += sizes.get(id) ?? 0
        deleted.push(id)
      }
    }
    return { deleted: deleted.length, freedBytes, ids: deleted }
  }

  /**
   * Remove a session from memory + disk + registry. Internal: callers enforce
   * the archived/idle policy. Idempotent (missing id ? false).
   */
  private hardDelete(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    s.tombstoned = true
    s.lifecycleGeneration++
    s.toolResultClosed = true
    this.disposeDeletedSessionState(s)
    try { s.agent?.shutdown?.() } catch { /* best-effort */ }
    try { s.jobs?.killAll() } catch { /* best-effort */ }
    if (s.activeRunSettlement) {
      this.releaseRunClaims(id, s.activeRunSettlement)
    } else {
      try { this.getRegistry?.()?.releaseAllClaims(id) } catch { /* best-effort */ }
    }
    this.sessions.delete(id)
    const i = this.loadedOrder.indexOf(id)
    if (i !== -1) this.loadedOrder.splice(i, 1)
    try { this.persistence?.deleteSession?.(id) } catch { /* best-effort */ }
    return true
  }

  private disposeDeletedSessionState(session: InternalSession): void {
    if (session.deltaTimer) clearTimeout(session.deltaTimer)
    session.deltaTimer = undefined
    session.deltaBuf = undefined
    session.deltaRunActive = false
    this.cancelPlanDraftTimer(session)
    session.planDraftLastEmit = undefined
    if (session.watchdogContinueTimer) clearTimeout(session.watchdogContinueTimer)
    session.watchdogContinueTimer = undefined
    session.watchdogAutoResubmit = false
    session.watchdogRecoveryCancelled = true
    if (session.planAutoApproveTimer) clearTimeout(session.planAutoApproveTimer)
    session.planAutoApproveTimer = undefined
    session.planAutoApproveSlug = undefined
    this.cancelToolResultBuf(session)
    for (const pending of session.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve({ approved: false })
    }
    session.pending.clear()
    session.record.pendingApprovals = 0
  }

  private ownsSessionDurability(session: InternalSession): boolean {
    return !session.tombstoned && this.sessions.get(session.record.id) === session
  }

  private ownsSessionLifecycle(session: InternalSession, generation: number): boolean {
    return this.ownsSessionDurability(session) && session.lifecycleGeneration === generation
  }

  private releaseRunClaims(id: string, settlement: ActiveRunSettlement): void {
    if (settlement.claimsReleased) return
    settlement.claimsReleased = true
    try { this.getRegistry?.()?.releaseAllClaims(id) } catch { /* non-fatal */ }
  }

  private cancelPlanDraftTimer(session: InternalSession): void {
    if (session.planDraftTimer !== undefined) {
      this.planEventScheduler.clearTimeout(session.planDraftTimer)
      session.planDraftTimer = undefined
    }
    session.planDraftTimerGeneration = undefined
  }

  /**
   * Count running sessions sharing a working directory (VSW ?6 adaptive policy).
   * `runningCount` alone is global and would misjudge sessions in different
   * projects as concurrent (???). Paths are resolved before comparison so
   * relative/absolute forms of the same cwd match. `excludeSessionId` drops the
   * caller's own session, yielding "other concurrent sessions on this cwd".
   */
  sameCwdRunningCount(cwd: string, excludeSessionId?: string): number {
    const target = resolve(cwd)
    let count = 0
    for (const s of this.sessions.values()) {
      if (!s.running) continue
      if (excludeSessionId && s.record.id === excludeSessionId) continue
      if (resolve(s.record.cwd) === target) count++
    }
    return count
  }

  createSession(input: CreateSessionInput = {}): SessionRecord {
    const id = this.idGenerator()
    let cwd = input.cwd ?? this.defaultCwd
    let worktreeBranch: string | undefined
    let worktreePath: string | undefined
    let baselineHead: string | undefined

    if (input.isolatedWorktree) {
      try {
        const wt = createWorktree(cwd, id)
        worktreeBranch = wt.branch
        worktreePath = wt.path
        cwd = wt.path
        // Diff baseline for the Changes tab: task delta stays visible even
        // after the agent commits mid-task.
        baselineHead = revParseHead(wt.path)
      } catch {
        // Worktree creation failed ? fall back to shared cwd silently.
      }
    }

    const ts = this.now()

    // Per-project defaults: load .rivet-config.json from the session cwd so
    // agent.defaultDomain and provider.default override the global startup
    // values. Explicit input.model/domain take top priority (user chose in the
    // new-session dialog); then project config; then the global default.
    let sessionModel = this.defaultModelId
    let sessionDomain = this.defaultDomain ?? 'qiming'
    try {
      const projectConfig = loadConfig({ cwd })
      // loadConfig ????+?????????? 'auto'?????????
      // agent.defaultDomain ???????????? sidecar???????
      // config ?????????
      const projectDomain = projectConfig.agent?.defaultDomain
      if (projectDomain) sessionDomain = projectDomain
      const projectProvider = projectConfig.provider.providers[projectConfig.provider.default]
      if (projectProvider?.models[0]?.id) sessionModel = projectProvider.models[0].id
    } catch { /* project config load failure is non-fatal ? fall back to global defaults */ }
    if (input.model) sessionModel = input.model
    if (input.domain) sessionDomain = input.domain

    const session: InternalSession = {
      record: {
        id,
        status: 'idle',
        createdAt: ts,
        updatedAt: ts,
        cwd,
        title: input.title,
        lastSeq: 0,
        pendingApprovals: 0,
        approvalMode: input.approvalMode,
        model: sessionModel,
        domain: sessionDomain,
        worktreeBranch,
        worktreePath,
        baselineHead,
        // P1b?? record ????sidecar ??/rehydrate ??????????
        // ?????????????????fail-closed ????????
        ...(input.planAutoApproveUi === true ? { planAutoApproveUi: true } : {}),
      },
      agent: null,
      approvalMode: input.approvalMode,
      events: [],
      // ??????? seq=1?live ???append splice?? events[0] ????
      // ???? 1 ? replay_window ????"?????"?
      diskFirstSeq: 1,
      eventsLoaded: true,
      seq: 0,
      running: false,
      lifecycleGeneration: 0,
      pending: new Map(),
      pendingDelegations: new Map(),
      listeners: new Set(),
      knownArtifacts: new Set(),
      steer: new SteerBuffer(),
      domainState: sessionDomain && sessionDomain !== 'auto'
        ? resolveDomainState(sessionDomain)?.state
        : undefined,
      disabledSkills: new Set(),
      skillLoadErrors: [],
      unattended: input.unattended === true,
      planAutoApproveUi: input.planAutoApproveUi === true,
    }
    // P1 ? Mission ?????????projectId ??????input.cwd??
    // ?? worktree ???? cwd??worktree ???????projectId ????
    // Best-effort?Mission ????????????
    if (this.missionStore) {
      try {
        const projectCwd = input.cwd ?? this.defaultCwd
        if (input.missionId) {
          session.record.missionId = input.missionId
          this.missionStore.addSession(input.missionId, id)
        } else if (input.title && input.title.trim()) {
          const mission = this.missionStore.getOrCreate(projectCwd, input.title)
          session.record.missionId = mission.id
          this.missionStore.addSession(mission.id, id)
        }
      } catch { /* non-fatal ? ???????????? title/shortId */ }
    }
    this.sessions.set(id, session)
    this.touchLoaded(session)
    this.persistRecord(session)
    // ????????? registry????????/skills??????????????
    // ? agent ??????ensureAgent ? run() ???????? loadProjectSkills ??
    // ? agent ?????buildSessionStores???????????????0/0?????
    // ??????????????????registry ? Map.set ????
    // importFromClaude ???????? agent ???? buildSessionStores ???????
    // ?? loadErrors?? frontmatter ??????????UI ??????
    try { session.skillLoadErrors = loadProjectSkills(cwd).errors } catch { /* non-fatal: ??????????? */ }
    // R1 ? announce the session to the shared registry so its file claims are
    // attributed and reaped on crash. Best-effort: registry may be disabled.
    try { this.getRegistry?.()?.register(id, cwd, 'standalone') } catch { /* non-fatal */ }
    if (input.prompt && input.prompt.trim()) {
      this.run(id, input.prompt)
    }
    return { ...session.record }
  }

  /** Start an agent run on an idle session. Returns false if missing or busy. */
  run(id: string, prompt: string, images?: string[]): boolean {
    const session = this.sessions.get(id)
    if (!session || session.running) return false
    const wasAutoResubmit = session.watchdogAutoResubmit === true
    session.watchdogAutoResubmit = false
    session.watchdogRecoveryCancelled = false
    // C2 ? ??? run??? prompt ????????? continue??????????
    if (session.watchdogContinueTimer) {
      clearTimeout(session.watchdogContinueTimer)
      session.watchdogContinueTimer = undefined
    }
    // ???? prompt = ???????????????????
    this.cancelPlanAutoApprove(session, 'new-prompt')
    session.lastAbortReason = undefined
    session.abortWhileApprovalPending = false
    session.unattendedHaltReason = undefined
    session.unattendedHaltApp = undefined
    // ??? halt ???? run ???record ???? persist ????
    if (session.record.unattendedHalt) session.record.unattendedHalt = undefined
    session.watchdogPolicy ??= new WatchdogRecoveryPolicy()
    // ???????????????????? 'continue' ???? TUI ?
    // onSubmitCallback ????????? consecutive cap ??????
    if (!wasAutoResubmit) session.watchdogPolicy.recordUserSubmit()
    // Materialize the on-disk log before appending ? otherwise a reconnecting
    // viewer (since=0) would replay only this run's events, not the history.
    this.ensureEvents(session)
    // Mark running before ensureAgent (may await dynamic serve-agent import) so a
    // second run() cannot race in while the module is still loading. User/status
    // events are appended only after the agent exists ? warnIfHistoryLost must
    // see the pre-prompt event log, not this turn's user echo.
    session.running = true
    session.toolResultClosed = false
    // T3 ? drop any guidance left from a previous run so it can't leak forward.
    session.steer.clear()
    session.record.status = 'running'
    session.record.error = undefined
    // R1 ? keep the registry heartbeat fresh while this session is active.
    try { this.getRegistry?.()?.heartbeat(id) } catch { /* non-fatal */ }
    this.touch(session)

    const runGeneration = session.lifecycleGeneration
    let resolveRunSettlement!: () => void
    const runSettlementPromise = new Promise<void>((resolve) => {
      resolveRunSettlement = resolve
    })
    const runSettlement: ActiveRunSettlement = {
      settled: false,
      claimsReleased: false,
      promise: runSettlementPromise,
      resolve: resolveRunSettlement,
    }
    session.activeRunSettlement = runSettlement
    const ownsDurability = (): boolean => this.ownsSessionLifecycle(session, runGeneration)

    const startWithAgent = (agent: ManagedAgent) => {
      // Abort/archive raced a dynamic serve-agent import ? never start a turn.
      if (!ownsDurability() || session.record.status === 'aborted') {
        if (!runSettlement.settled) {
          runSettlement.settled = true
          if (session.activeRunSettlement === runSettlement) {
            session.activeRunSettlement = undefined
            session.running = false
          }
          this.releaseRunClaims(id, runSettlement)
          try { agent.abort() } catch { /* best-effort */ }
          runSettlement.resolve()
        }
        return
      }
      // Persist each attached image as a standalone file and echo only small
      // reference ids into the event log ? NOT the base64. This keeps events.jsonl
      // (and its full replay/restore) tiny while the model still receives the data
      // URLs inline via agent.run below.
      const imageIds = this.persistImages(id, images)
      // Snapshot "first user message" BEFORE appending ? the auto-title hook
      // below needs to know whether this run is the conversation opener.
      const wasFirstUser = !session.events.some((e) => e.type === 'user')
      this.append(session, 'user', {
        text: prompt,
        ...(images?.length
          ? { imageCount: images.length, ...(imageIds.length ? { imageIds } : {}) }
          : {}),
      })
      this.append(session, 'status', { status: 'running' })
      // P2-B: emit a goal_state baseline snapshot on the first user message so
      // MissionProjector + GoalBar can cold-start from the event stream instead
      // of relying on HTTP polling. No goalId/tracker yet ? just an active empty
      // goal that moves the projector phase from 'draft' to 'executing'.
      if (wasFirstUser) {
        this.append(session, 'goal_state', this.baselineGoalSnapshot() as unknown as Record<string, unknown>)
      }
      this.persistRecord(session)
      // Auto-generate a session title from the first user message when none is
      // set. Fire-and-forget ? extraction never blocks the main run, and the
      // hook double-checks `!record.title` after the await so a user who sets a
      // title manually during the ~1s extraction window is never overwritten.
      if (wasFirstUser && !session.record.title) {
        void this.maybeAutoTitle(id, prompt)
      }
      this.bindPlanModeChange(session, agent, runGeneration)
      const callbacks = this.buildCallbacks(session)
      void agent
        .run(prompt, callbacks, images)
        .then(() => {
          if (!ownsDurability()) return
          if (session.record.status === 'running') {
            session.record.status = 'completed'
          }
        })
        .catch((err: unknown) => {
          if (!ownsDurability()) return
          if (session.record.status === 'running') {
            session.record.status = 'failed'
            session.record.error = redactText((err as Error)?.message ?? String(err))
            this.append(session, 'error', { error: session.record.error })
          }
        })
        .finally(() => {
          if (runSettlement.settled) return
          runSettlement.settled = true
          try {
            if (session.activeRunSettlement === runSettlement) {
              session.activeRunSettlement = undefined
              session.running = false
            }
            this.releaseRunClaims(id, runSettlement)
            if (!ownsDurability()) {
              if (this.ownsSessionDurability(session) && session.record.archived) {
                this.unloadSession(session)
              }
              return
            }
            this.rejectAllPending(session, session.record.status === 'aborted' ? 'aborted' : 'stale')
            this.touch(session)
            this.scanArtifacts(session)
            this.settleHandoffArchive(session)
            this.append(session, 'done', { status: session.record.status })
            this.persistRecord(session)
            // ?????abort ??? worker ??? delegation ????????
            // ???? sweepStaleDelegationNodes????????coordinator ?
            // abort ????? promise?setImmediate ? orderControllers ??
            // ??????????? worker ??????
            const sweepReason = session.record.status === 'aborted' ? 'caller_aborted' : 'unknown'
            setImmediate(() => {
              if (this.sessions.get(id) !== session) return
              this.sweepStaleDelegationNodes(session, sweepReason)
            })
            this.maybeWatchdogAutoContinue(session)
            if (session.record.archived) this.unloadSession(session)
          } finally {
            runSettlement.resolve()
          }
        })
    }

    const failEnsure = (err: unknown) => {
      if (ownsDurability() && session.record.status === 'running') {
        session.record.status = 'failed'
        session.record.error = redactText((err as Error)?.message ?? String(err))
        this.append(session, 'error', { error: session.record.error })
      }
      if (!runSettlement.settled) {
        runSettlement.settled = true
        if (session.activeRunSettlement === runSettlement) {
          session.activeRunSettlement = undefined
          session.running = false
        }
        this.releaseRunClaims(id, runSettlement)
        if (ownsDurability()) {
          this.append(session, 'done', { status: session.record.status })
          this.persistRecord(session)
        }
        runSettlement.resolve()
      }
    }

    try {
      const agentOrPromise = this.ensureAgent(session)
      if (agentOrPromise && typeof (agentOrPromise as Promise<ManagedAgent>).then === 'function') {
        void (agentOrPromise as Promise<ManagedAgent>).then(startWithAgent, failEnsure)
      } else {
        startWithAgent(agentOrPromise as ManagedAgent)
      }
    } catch (err) {
      failEnsure(err)
    }
    return true
  }

  /**
   * /handoff??????????????????? run??agent ???????
   * ??? .rivet/HANDOFF.md??????????run ??? settleHandoffArchive
   * ????????? <id>.handoff.md?loadPrevHandoff ?????????
   * ? TUI pendingHandoffCopy ??????????/????? false??? 409??
   */
  requestHandoff(id: string, note?: string): { ok: boolean; error?: string } {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, error: 'Session not found' }
    if (session.running) return { ok: false, error: 'Session is already running' }
    const src = join(session.record.cwd, '.rivet', 'HANDOFF.md')
    const dest = join(getSessionDir(session.record.cwd), `${session.record.id}.handoff.md`)
    session.pendingHandoff = { src, dest, sinceMs: Date.now() }
    if (!this.run(id, buildHandoffPrompt(src, note))) {
      session.pendingHandoff = undefined
      return { ok: false, error: 'Session is already running' }
    }
    return { ok: true }
  }

  /**
   * run ???? handoff ????? run ???????????????
   * <id>.handoff.md ???? system ??????????????????
   * best-effort????????? done ???
   */
  private settleHandoffArchive(session: InternalSession): void {
    const pending = session.pendingHandoff
    if (!pending) return
    session.pendingHandoff = undefined
    try {
      if (existsSync(pending.src) && statSync(pending.src).mtimeMs > pending.sinceMs) {
        // dest ?????? agent ???? SessionPersist ?????? best-effort
        // ???????????/?????????????
        mkdirSync(dirname(pending.dest), { recursive: true })
        copyFileSync(pending.src, pending.dest)
        handoffRecoveries(session.record.cwd, session.record.id)
        this.append(session, 'handoff_archived', {
          text: `? ??????? ${pending.src} ??? ${pending.dest}???????????????`,
          src: pending.src,
          dest: pending.dest,
        })
      }
    } catch { /* best-effort???????????? */ }
  }

  /**
   * One-click resume for a run interrupted by a sidecar restart (resume_offer).
   *
   * Cache-affinity contract (hard requirement): the resumed run MUST stay on
   * the model and star domain the session was on before the restart ? the
   * conversation's prefix cache lives per model, and rebuilding it on a
   * different model costs more than the resume saves. Behavior ladder:
   *  - original model available ? resume on it (domain restored via
   *    ensureAgent ? applySelections from the persisted record.domain);
   *  - original model unavailable AND `resumeFallbackModel` is configured and
   *    available ? resume on the fallback with an explicit model_switched
   *    event (`switched: true` in the result lets the UI say "cache will be
   *    rebuilt");
   *  - otherwise fail closed (`model_unavailable`) ? the UI degrades to a
   *    "start a new session" entry. Never silently falls back to the default
   *    model.
   */
  async resumeRun(id: string): Promise<ResumeRunResult> {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, code: 'not_found', error: 'Session not found' }
    if (session.running) return { ok: false, code: 'busy', error: 'Session is already running' }
    const original = session.record.model
    const available = this.listModelsFn?.()
    // No injected model source (tests / minimal setups): trust the record ?
    // there is nothing to validate against, and the factory resolves it.
    const isAvailable = (m: string | undefined): m is string =>
      !!m && (!available || available.some((o) => o.id === m || o.alias === m))
    let target = original
    let switched = false
    if (!isAvailable(original)) {
      const fallback = this.resumeFallbackModel
      if (!isAvailable(fallback)) {
        return {
          ok: false,
          code: 'model_unavailable',
          error: original
            ? `??? ${original} ?????????????????agent.resumeFallbackModel??????????`
            : '??????????????????????????',
        }
      }
      target = fallback
      switched = true
    }
    if (switched) {
      if (session.agent) {
        // Live agent on the wrong model ? hot-swap it (emits model_switched).
        if (!(await this.switchModel(id, target!))) {
          return { ok: false, code: 'model_unavailable', error: `???? ${target} ?????????????` }
        }
      } else {
        // Agent not built yet: point the record at the fallback so ensureAgent
        // builds on it directly, and leave an audit event.
        this.ensureEvents(session)
        session.record.model = target
        this.append(session, 'model_switched', { modelId: target, reason: 'resume-fallback', from: original ?? null })
        this.persistRecord(session)
      }
    }
    const started = this.run(id, RESUME_PROMPT)
    if (!started) return { ok: false, code: 'busy', error: 'Session is already running' }
    return { ok: true, model: session.record.model ?? target ?? '', switched }
  }

  /**
   * User-dispatched background subagent. Unlike run(), this does NOT set
   * session.running ? the worker runs in its own isolated sub-session with an
   * independent abort signal, so it coexists with the main turn and is not
   * killed by aborting the main conversation. Progress streams through the same
   * 'delegation' SSE channel (origin:'user') the viewer panel already consumes.
   */
  async delegate(id: string, input: DelegateWorkerInput): Promise<DelegateResult> {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, reason: 'not_found' }
    const objective = input.objective?.trim()
    if (!objective) return { ok: false, reason: 'invalid' }
    const agent = await this.ensureAgentAsync(session)
    if (typeof agent.delegateWorker !== 'function') return { ok: false, reason: 'unsupported' }
    const aborts = session.backgroundAborts ?? (session.backgroundAborts = new Map())
    if (aborts.size >= MAX_USER_BACKGROUND_WORKERS) return { ok: false, reason: 'limit' }
    // Materialize the on-disk log so a reconnecting viewer replays this node.
    this.ensureEvents(session)
    const workerId = `user:${Math.random().toString(36).slice(2, 8)}`
    const controller = new AbortController()
    aborts.set(workerId, controller)
    this.touch(session)
    // Seed the panel with a running node immediately (before the worker spins up).
    this.emitDelegationActivity(session, {
      workOrderId: workerId,
      objective,
      profile: input.profile,
      authority: input.authority,
      status: 'running',
      origin: 'user',
    })
    void agent
      .delegateWorker(
        { ...input, objective },
        {
          workerId,
          signal: controller.signal,
          onActivity: (a) => this.emitDelegationActivity(session, { ...a, origin: 'user' }),
        },
      )
      .catch((err: unknown) => {
        this.emitDelegationActivity(session, {
          workOrderId: workerId,
          status: 'failed',
          summary: redactText((err as Error)?.message ?? String(err)),
          origin: 'user',
        })
      })
      .finally(() => {
        aborts.delete(workerId)
        this.touch(session)
      })
    return { ok: true, workerId }
  }

  /** Cancel a user-dispatched background worker. Returns false if unknown. */
  cancelDelegate(id: string, workerId: string): boolean {
    const controller = this.sessions.get(id)?.backgroundAborts?.get(workerId)
    if (!controller) return false
    controller.abort()
    return true
  }

  private ensureAgent(session: InternalSession): ManagedAgent | Promise<ManagedAgent> {
    if (session.agent) return session.agent
    this.ensureJobs(session)
    // Model affinity: a rehydrated session must come back on the model its
    // record carries (prefix-cache lives per model) ? not the default model.
    const created = this.createAgent(
      session.record.cwd,
      session.record.id,
      session.approvalMode,
      session.record.model,
    )
    const finish = (agent: ManagedAgent): ManagedAgent => {
      session.agent = agent
      this.applySelections(session)
      this.warnIfHistoryLost(session)
      return agent
    }
    // Production serve factory returns a Promise (dynamic serve-agent import).
    // Test doubles return a ManagedAgent synchronously ? keep that path sync so
    // existing tests don't need a microtask flush after every run().
    if (created && typeof (created as Promise<ManagedAgent>).then === 'function') {
      return (created as Promise<ManagedAgent>).then(finish)
    }
    return finish(created as ManagedAgent)
  }

  private async ensureAgentAsync(session: InternalSession): Promise<ManagedAgent> {
    return await this.ensureAgent(session)
  }

  /**
   * Surface the "UI has history, model has none" divergence. A rehydrated
   * session replays its full event log to the viewer, but the model context is
   * restored separately from the session .jsonl ? if that read failed or came
   * back empty while the event log clearly holds a prior conversation, warn in
   * the timeline instead of letting the user talk to an amnesiac model.
   * Best-effort: only fires when prior events are resident (run() calls
   * ensureEvents first, so the main prompt path always has them).
   */
  private warnIfHistoryLost(session: InternalSession): void {
    const info = session.agent?.getHistoryRestore?.()
    if (!info) return
    if (!info.error && info.restored > 0) return
    const hadConversation = session.events.some((e) => e.type === 'user')
    if (!hadConversation) return
    this.append(session, 'phase', {
      phase: info.error
        ? `?? ??????????${redactText(info.error)}??????????????????????`
        : '?? ?????????????????????????????????????????',
      historyRestore: { restored: info.restored, ...(info.error ? { error: redactText(info.error) } : {}) },
    })
  }

  /** Lazily create the server-owned background job registry for a session and
   *  wire its lifecycle events into the SSE stream. Idempotent. */
  private ensureJobs(session: InternalSession): SessionJobs {
    if (!session.jobs) {
      const jobs = new SessionJobs(join(session.record.cwd, '.rivet', 'artifacts', 'jobs'))
      jobs.on('event', (ev: JobEvent) => {
        this.append(session, 'job', {
          id: ev.job.id,
          command: ev.job.command,
          status: ev.job.status,
          exitCode: ev.job.exitCode,
          startedAt: ev.job.startedAt,
          endedAt: ev.job.endedAt,
          lastLine: ev.job.lastLine,
          pid: ev.job.pid,
          kind: ev.kind,
          ...(ev.chunk ? { chunk: ev.chunk } : {}),
        })
      })
      session.jobs = jobs
    }
    return session.jobs
  }

  /**
   * Re-apply the session's PlusMenu selections (star domain, disabled skills) to
   * its live agent. Idempotent ? called both after a lazy build (ensureAgent)
   * and after a model rebuild (switchModel) so the selections survive a fresh
   * AgentLoop. A domainState of undefined means Auto ? leave the agent's own
   * auto-detection untouched.
   */
  private applySelections(session: InternalSession): void {
    const agent = session.agent
    if (!agent) return
    // Bind the server-owned job registry so background jobs + their SSE events
    // survive agent rebuilds (switchModel builds a fresh AgentLoop).
    try {
      if (session.jobs) agent.setJobs?.(session.jobs)
    } catch { /* non-fatal */ }
    try {
      if (session.domainState === null) agent.setSessionDomain?.(null)
      else if (session.domainState !== undefined) agent.setSessionDomain?.(session.domainState)
    } catch { /* non-fatal */ }
    try {
      if (session.disabledSkills.size > 0) agent.setDisabledSkills?.(new Set(session.disabledSkills))
    } catch { /* non-fatal */ }
    try {
      if (session.reasoningEffort !== undefined) agent.setReasoningEffort?.(session.reasoningEffort)
    } catch { /* non-fatal */ }
    // ??? override ???switchModel ??? refs ???????????????
    // ??????? auto/off ????????? Off ?????
    try {
      if (session.reviewGateOverride !== undefined) {
        const ref = this.resolveReviewGateRef?.(session.record.id)
        if (ref) ref.current = session.reviewGateOverride
      }
    } catch { /* non-fatal */ }
    this.bindPlanModeChange(session, agent, session.lifecycleGeneration)
    this.bindAskModeChange(session, agent, session.lifecycleGeneration)
    // Plan mode ? AgentLoop ?????record.planMode ?????agent ??
    // ???????? / switchModel??????????????
    // getActivePlanFilePath ? null ? ??????????????record ?
    // planning ???? enterPlanMode????????????????
    // onPlanModeChange ???????????? plan_mode SSE?
    if (session.record.planMode === 'planning') {
      try { agent.enterPlanMode?.() } catch { /* non-fatal */ }
    } else if (session.record.askMode === 'asking') {
      try { agent.enterAskMode?.() } catch { /* non-fatal */ }
    }
  }

  private bindPlanModeChange(
    session: InternalSession,
    agent: ManagedAgent,
    lifecycleGeneration: number,
  ): void {
    // AgentLoop owns this callback property, so rebind it for every run. A
    // closure retained by an older run must not mutate a restored/new run.
    agent.onPlanModeChange = (state: PlanModeState) => {
      if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
      if (session.record.planMode === state) return
      session.record.planMode = state
      // Mutual exclusion: enter plan clears ask on the wire record.
      if (state === 'planning' && session.record.askMode === 'asking') {
        session.record.askMode = 'off'
        this.append(session, 'ask_mode', { state: 'off' })
      }
      this.touch(session)
      this.append(session, 'plan_mode', { state })
      this.persistRecord(session)
    }
  }

  private bindAskModeChange(
    session: InternalSession,
    agent: ManagedAgent,
    lifecycleGeneration: number,
  ): void {
    agent.onAskModeChange = (state: AskModeState) => {
      if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
      if (session.record.askMode === state) return
      session.record.askMode = state
      // Mutual exclusion: enter ask clears plan on the wire record.
      if (state === 'asking' && session.record.planMode === 'planning') {
        session.record.planMode = 'off'
        this.append(session, 'plan_mode', { state: 'off' })
      }
      this.touch(session)
      this.append(session, 'ask_mode', { state })
      this.persistRecord(session)
    }
  }

  // ?? PlusMenu: star domain ?????????????????????????????????????

  /**
   * PlusMenu ? list the domain picker entries for this session (Auto /
   * built-in + custom domains) with the session's current selection flagged.
   * Returns undefined when the session is missing.
   */
  listDomains(id: string): DomainPickerEntry[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return buildDomainPickerEntries(session.domainState)
  }

  /**
   * PlusMenu ? set the session's star domain by selection key (auto | off |
   * <domainId>). Updates the stored selection (applied on lazy build), live-
   * mutates an already-built agent, persists the key, and emits domain_changed.
   * Returns false when the session is missing or the key is unknown.
   */
  setDomain(id: string, key: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    const resolved = resolveDomainState(key)
    if (!resolved) return false
    session.domainState = resolved.state
    session.record.domain = resolved.key
    try {
      if (resolved.state === undefined) session.agent?.resetSessionDomain?.()
      else session.agent?.setSessionDomain?.(resolved.state)
    } catch { /* non-fatal */ }
    this.touch(session)
    this.append(session, 'domain_changed', { key: resolved.key, name: resolved.label })
    this.persistRecord(session)
    return true
  }

  // ?? PlusMenu: model ???????????????????????????????????????????

  /**
   * PlusMenu ? list selectable models for this session, flagging the current
   * one. Returns undefined when the session is missing. Empty when no provider
   * model source was injected (tests).
   */
  listModels(id: string): ModelEntry[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    const current = session.record.model
    const all = this.listModelsFn?.() ?? []
    return all.map((m) => ({ ...m, current: m.id === current || m.alias === current }))
  }

  /**
   * PlusMenu ? hot-switch the session's model, preserving conversation history.
   * Refuses while the session is running (caller must abort first), rebuilds the
   * agent on the new model (same SessionContext), re-applies domain/skill
   * selections, persists record.model, and emits model_switched. Returns false
   * when the session is missing/running or the model id is unknown.
   */
  async switchModel(id: string, modelId: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session || session.running) return false
    const agent = await this.ensureAgentAsync(session)
    let resolved: string | null
    try {
      resolved = agent.switchModel?.(modelId) ?? null
    } catch {
      return false
    }
    if (!resolved) return false
    // The rebuild produced a fresh AgentLoop ? re-bind per-session selections.
    this.applySelections(session)
    session.record.model = resolved
    this.touch(session)
    this.append(session, 'model_switched', { modelId: resolved })
    this.persistRecord(session)
    return true
  }

  // ?? PlusMenu: review gate ?????????????????????????????????????

  /**
   * PlusMenu (review) ? ?????????????? override > live refs
   * ?????? + ???????> ?????refs ???agent ?????
   * ? override / defaultReviewGate ?????????? undefined?
   */
  getReviewGate(id: string): 'auto' | 'off' | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return session.reviewGateOverride
      ?? this.resolveReviewGateRef?.(id)?.current
      ?? this.defaultReviewGate
  }

  /**
   * PlusMenu (review) ? ????????? override??????? live refs
   * ?refs ????? override?applySelections ? agent ???????
   * ??????? false?
   */
  setReviewGate(id: string, mode: 'auto' | 'off'): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.reviewGateOverride = mode
    try {
      const ref = this.resolveReviewGateRef?.(id)
      if (ref) ref.current = mode
    } catch { /* non-fatal ? override persists and replays on next build */ }
    return true
  }

  // ?? PlusMenu: skills ??????????????????????????????????????????

  /**
   * PlusMenu ? list every loaded skill with its per-session enablement status.
   * Returns undefined when the session is missing.
   */
  listSkills(id: string): SkillStatus[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return skillRegistry.list().map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source ?? (s.builtIn ? 'builtin' : 'rivet'),
      enabled: !session.disabledSkills.has(s.name),
      // Editable when there's a backing file on disk (built-ins have none;
      // plugin skills point at the plugin dir, which the editor could open
      // but we keep read-only for safety ? users edit via the plugin's own flow).
      editable: !!s.bodyPath && s.source !== 'builtin' && s.source !== 'plugin',
    }))
  }

  /**
   * Skills that failed to load from .rivet/skills for this session (malformed
   * frontmatter, etc.). Surfaced by GET /skills so an installed-but-unparseable
   * skill is visible rather than silently missing. Returns undefined when the
   * session is missing.
   */
  getSkillLoadErrors(id: string): string[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return [...session.skillLoadErrors]
  }

  /**
   * PlusMenu ? enable/disable a skill for this session. Updates the disabled
   * set, live-applies it to an already-built agent's discovery filter, and emits
   * skills_changed. Returns false when the session is missing.
   */
  setSkillEnabled(id: string, name: string, enabled: boolean): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    if (enabled) session.disabledSkills.delete(name)
    else session.disabledSkills.add(name)
    try { session.agent?.setDisabledSkills?.(new Set(session.disabledSkills)) } catch { /* non-fatal */ }
    this.touch(session)
    this.append(session, 'skills_changed', { name, enabled })
    return true
  }

  /**
   * Skills install ? list skills discoverable under .claude/skills that can be
   * copied into this session's project .rivet/skills. Read-only; returns
   * undefined when the session is missing.
   */
  listInstallableSkills(id: string): InstallableSkill[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return listInstallableSkills(session.record.cwd)
  }

  /**
   * Skills install ? count skills already installed under .rivet/skills. Drives
   * the soft install cap in UIs. Returns undefined when the session is missing.
   */
  installedSkillCount(id: string): number | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return countInstalledSkills(session.record.cwd)
  }

  /**
   * Skills install ? copy the named skills from .claude/skills into the project
   * .rivet/skills (idempotent; already-present ones are skipped). Intentionally
   * does NOT hot-load into the live registry or emit skills_changed: changing
   * the available-skill set mid-session shatters the prefix cache. The copied
   * skills take effect on the next session. Returns undefined when missing.
   */
  installSkills(id: string, names: string[]): { copied: string[]; skipped: string[]; errors: string[] } | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return importSkillsIntoRivet(session.record.cwd, names)
  }

  /**
   * Skills CRUD ? read the full SKILL.md text for the editor. Returns null for
   * built-in / plugin skills (no editable backing file) so the UI can show a
   * read-only notice. Returns undefined when the session is missing.
   */
  readSkillContent(id: string, name: string): string | null | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return readSkillContent(name, session.record.cwd)
  }

  /**
   * Skills CRUD ? write (create or overwrite) a skill. `scope: 'global'`
   * writes to ~/.rivet/skills (reusable across projects); 'project' writes to
   * <cwd>/.rivet/skills. Throws on malformed frontmatter (route layer ? 400).
   * Same no-hot-load contract as install: the change takes effect next session.
   * Returns undefined when the session is missing.
   */
  writeSkill(id: string, name: string, content: string, scope: 'project' | 'global'): { path: string } | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return writeSkill(name, content, session.record.cwd, scope)
  }

  /**
   * Skills CRUD ? uninstall a project-scoped skill (delete from .rivet/skills).
   * Returns { removed: false } for built-in / plugin / global skills so the UI
   * can show "cannot remove from here". Does NOT hot-load or emit
   * skills_changed ? same contract as install. Returns undefined when the
   * session is missing.
   */
  uninstallSkill(id: string, name: string): { removed: boolean; wasDir: boolean } | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return uninstallSkill(name, session.record.cwd)
  }

  /**
   * S ? set the per-session autonomy level. Updates the stored override (so it
   * applies when the agent is first built) AND live-mutates an already-built
   * agent (so a mid-session toggle takes effect on the next tool, no rebuild).
   * Returns false when the session is missing. Persists the new mode onto the
   * record so reconnecting viewers see the current level.
   */
  setApprovalMode(id: string, mode: ApprovalMode): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.approvalMode = mode
    session.record.approvalMode = mode
    try { session.agent?.setApprovalMode?.(mode) } catch { /* non-fatal */ }
    this.touch(session)
    this.persistRecord(session)
    return true
  }

  /**
   * Set the per-session reasoning effort level. Stores the override (so it
   * applies when the agent is first built) AND live-mutates an already-built
   * agent (so a mid-session change takes effect on the next turn). Returns false
   * when the session is missing. Persists the new level onto the record so
   * reconnecting viewers see the current level.
   */
  setReasoningEffort(id: string, effort: import('../agent/auto-reasoning.js').ReasoningEffort | 'auto'): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.reasoningEffort = effort
    session.record.reasoningEffort = effort
    try { session.agent?.setReasoningEffort?.(effort) } catch { /* non-fatal */ }
    this.touch(session)
    this.persistRecord(session)
    return true
  }

  // ?? Goal mode (autonomous cross-turn goal pursuit) ??????????????????
  // Mirrors the CLI/headless goal flow (main.ts:357-416). The tracker drives
  // cross-turn continuation via GoalContinuationController (assembled in
  // loop-factory); update_goal / deliver_task tools read refs.goalTrackerRef,
  // so both the agent field AND refs.current MUST stay in sync.
  /**
   * Create + attach a goal tracker. Resolves success criteria asynchronously
   * (fail-open ? defaults to a generic template). Returns the initial state, or
   * null when the session has no goal handles wired (test doubles / legacy
   * sidecar) or the session is missing.
   */
  async setGoal(id: string, opts: {
    goal: string
    maxIterations: number
    contextWindow: number
    wallClockMs?: number
    successCriteria?: string[]
    maxJudgeRuns?: number
  }): Promise<GoalSnapshot | null> {
    const session = this.sessions.get(id)
    if (!session) return null
    const handles = this.resolveGoalHandles?.(id)
    if (!handles) return null
    const { GoalTracker } = await import('../agent/goal-tracker.js')
    const { saveGoalState } = await import('../agent/goal-persist.js')
    const tracker = new GoalTracker({
      goal: opts.goal,
      maxIterations: opts.maxIterations,
      contextWindow: opts.contextWindow,
      ...(opts.wallClockMs !== undefined ? { wallClockMs: opts.wallClockMs } : {}),
      ...(opts.successCriteria ? { successCriteria: opts.successCriteria } : {}),
      ...(opts.maxJudgeRuns !== undefined ? { maxJudgeRuns: opts.maxJudgeRuns } : {}),
    })
    // Sync BOTH the agent field (drives GoalContinuationController) AND the refs
    // slot (read by update_goal / deliver_task tool closures). Out of sync ?
    // tools see null while continuation runs, or vice versa.
    try { session.agent?.setGoalTracker?.(tracker) } catch { /* non-fatal */ }
    handles.goalTrackerRef.current = tracker
    try { saveGoalState(handles.sessionDir, id, tracker) } catch { /* non-fatal */ }
    this.append(session, 'goal_state', this.snapshotGoal(tracker) as unknown as Record<string, unknown>)
    // Async criteria extraction (fail-open). Mirrors main.ts:392-414.
    void this.extractCriteria(id, opts.goal, tracker)
    return this.snapshotGoal(tracker)
  }

  /** Pause / resume ? mutate tracker state, persist, emit. */
  pauseGoal(id: string, reason?: string): GoalSnapshot | null {
    return this.mutateGoal(id, (t) => { t.pause(reason ?? 'user', 'user') })
  }
  resumeGoal(id: string): GoalSnapshot | null {
    return this.mutateGoal(id, (t) => { t.resume('user') })
  }
  /**
   * Cancel is terminal ? also clear the agent tracker + refs + persisted
   * state so a subsequent setGoal starts clean (aligns slash-commands.ts:1107).
   *
   * Returns a Promise ? the caller MUST await it before issuing setGoal on the
   * same session. The persisted-state deletion is awaited here (not fire-and-
   * forget) so a rapid cancel?setGoal sequence cannot race: without awaiting,
   * the dynamic-import delay + FS buffering could let the delete land AFTER a
   * new setGoal's saveGoalState, wiping the new goal's state file.
   */
  async cancelGoal(id: string): Promise<GoalSnapshot | null> {
    const session = this.sessions.get(id)
    if (!session) return null
    const handles = this.resolveGoalHandles?.(id)
    const tracker = handles?.goalTrackerRef.current ?? session.agent?.getGoalTracker?.() ?? null
    if (!tracker) return null
    tracker.cancel()
    try { session.agent?.setGoalTracker?.(null) } catch { /* non-fatal */ }
    if (handles) {
      handles.goalTrackerRef.current = null
      // Await the delete so a subsequent setGoal's save cannot be clobbered.
      try {
        const { deleteGoalState } = await import('../agent/goal-persist.js')
        deleteGoalState(handles.sessionDir, id)
      } catch { /* non-fatal ? file may not exist */ }
    }
    this.append(session, 'goal_state', this.snapshotGoal(tracker) as unknown as Record<string, unknown>)
    return this.snapshotGoal(tracker)
  }

  /** Read-only snapshot for the GET endpoint / SSE events. */
  getGoalState(id: string): GoalSnapshot | null {
    const session = this.sessions.get(id)
    if (!session) return null
    const handles = this.resolveGoalHandles?.(id)
    const tracker = handles?.goalTrackerRef.current ?? session.agent?.getGoalTracker?.() ?? null
    return tracker ? this.snapshotGoal(tracker) : null
  }

  private mutateGoal(id: string, fn: (t: import('../agent/goal-tracker.js').GoalTracker) => void): GoalSnapshot | null {
    const session = this.sessions.get(id)
    if (!session) return null
    const handles = this.resolveGoalHandles?.(id)
    const tracker = handles?.goalTrackerRef.current ?? session.agent?.getGoalTracker?.() ?? null
    if (!tracker) return null
    try { fn(tracker) } catch { return null }
    if (handles) {
      import('../agent/goal-persist.js').then(({ saveGoalState }) => {
        try { saveGoalState(handles.sessionDir, id, tracker) } catch { /* non-fatal */ }
      }).catch(() => {})
    }
    this.append(session, 'goal_state', this.snapshotGoal(tracker) as unknown as Record<string, unknown>)
    return this.snapshotGoal(tracker)
  }

  private snapshotGoal(t: import('../agent/goal-tracker.js').GoalTracker): GoalSnapshot {
    const terminalReason = t.getTerminalReason()
    return {
      goalId: t.getGoalId(),
      goal: t.getGoal(),
      status: t.getStatus(),
      iteration: t.getIteration(),
      maxIterations: t.getMaxIterations(),
      wallClockElapsedMs: t.getWallClockElapsedMs(),
      ...(t.getWallClockBudgetMs() !== undefined ? { wallClockBudgetMs: t.getWallClockBudgetMs() } : {}),
      ...(terminalReason ? { terminalReason } : {}),
      successCriteria: t.getSuccessCriteria(),
      ...(t.getLastVerdict() ? { lastVerdict: t.getLastVerdict()! } : {}),
    }
  }

  /**
   * P2-B: Baseline goal_state snapshot emitted on the first user message.
   * No GoalTracker exists yet ? this is a synthetic active-empty goal that
   * lets MissionProjector transition from 'draft' to 'executing' phase.
   * Subsequent setGoal/extractCriteria calls will emit richer goal_state events.
   */
  private baselineGoalSnapshot(): GoalSnapshot {
    return {
      goalId: '',
      goal: '',
      status: 'active',
      iteration: 0,
      maxIterations: 0,
      wallClockElapsedMs: 0,
      successCriteria: [],
    }
  }

  private async extractCriteria(id: string, goal: string, tracker: import('../agent/goal-tracker.js').GoalTracker): Promise<void> {
    const handles = this.resolveGoalHandles?.(id)
    if (!handles) return
    try {
      const { extractGoalCriteria, completionFromClient, buildCheapClient } = await import('../agent/goal-criteria.js')
      const session = this.sessions.get(id)
      // Prefer dedicated cheap client (mirrors main.ts:396-406); fall back to
      // the session's own client when no cheap profile is configured.
      let completion: Parameters<typeof extractGoalCriteria>[1] | null = null
      if (handles.cheapProfile && handles.allProviders) {
        const cheap = buildCheapClient(handles.cheapProfile, handles.allProviders as Parameters<typeof buildCheapClient>[1])
        if (cheap) completion = completionFromClient(cheap.client, cheap.model)
      }
      if (!completion) return // no cheap client ? leave generic criteria default
      const criteria = await extractGoalCriteria(goal, completion)
      tracker.setSuccessCriteria(criteria)
      const s = this.sessions.get(id)
      if (s) this.append(s, 'goal_state', this.snapshotGoal(tracker) as unknown as Record<string, unknown>)
    } catch {
      // non-fatal ? tracker keeps its generic default criteria
    }
  }

  /**
   * Auto-generate a session title from the first user message via the cheap
   * model profile (mirrors extractCriteria's side-path pattern). Fail-open:
   * any error or missing config leaves the title unset, the UI falls back to
   * sessionId.slice(0, 8). Double-checks `!record.title` after the await so a
   * user who set a title manually during extraction is never overwritten.
   */
  private async maybeAutoTitle(id: string, firstMessage: string): Promise<void> {
    const handles = this.resolveGoalHandles?.(id)
    if (!handles) return
    try {
      const { extractSessionTitle } = await import('../agent/title-extract.js')
      const { completionFromClient, buildCheapClient } = await import('../agent/goal-criteria.js')
      if (!handles.cheapProfile || !handles.allProviders) return
      const cheap = buildCheapClient(
        handles.cheapProfile,
        handles.allProviders as Parameters<typeof buildCheapClient>[1],
      )
      if (!cheap) return // provider not configured or no API key ? leave title unset
      const title = await extractSessionTitle(
        firstMessage,
        completionFromClient(cheap.client, cheap.model, 256),
      )
      const s = this.sessions.get(id)
      if (s && title && !s.record.title) {
        this.setTitle(id, title)
        this.attachImplicitMission(s, title)
      }
    } catch {
      // non-fatal ? title stays unset, UI keeps sessionId-slice fallback
    }
  }

  /**
   * rev2 ? ?? Mission??????sendPrompt ????? maybeAutoTitle
   * ???????? Mission?????????????? ? ??????
   * ?? !record.missionId???????????????
   * ??worktree ??? record.cwd ? worktree ???projectId ?????
   * ?????????? + isolatedWorktree?????P1 ???
   */
  private attachImplicitMission(s: InternalSession, title: string): void {
    if (!this.missionStore || s.record.missionId) return
    try {
      const mission = this.missionStore.create(s.record.cwd, title)
      this.missionStore.addSession(mission.id, s.record.id)
      s.record.missionId = mission.id
      this.persistRecord(s)
    } catch { /* non-fatal ? ??????? Mission ???? */ }
  }

  /**
   * Plan mode ? toggle the session between read-only planning and normal
   * execution. Building the agent eagerly here (ensureAgent) so the toggle binds
   * to the same instance a later run() reuses. Emits a `plan_mode` event so the
   * desktop can flip its mode chip / open the plan column. Returns false when the
   * session is missing.
   */
  async setPlanMode(id: string, state: PlanModeState): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false
    const agent = await this.ensureAgentAsync(session)
    session.record.planMode = state
    // Mutual exclusion with Ask on the wire record.
    if (state === 'planning' && session.record.askMode === 'asking') {
      session.record.askMode = 'off'
      this.append(session, 'ask_mode', { state: 'off' })
    }
    try {
      if (state === 'planning') agent.enterPlanMode?.()
      else agent.exitPlanMode?.()
    } catch { /* non-fatal */ }
    this.touch(session)
    this.append(session, 'plan_mode', { state })
    this.persistRecord(session)
    return true
  }

  /**
   * Ask mode ? toggle the session between pure read-only Q&A and normal
   * execution. Mutually exclusive with Plan Mode. Emits `ask_mode` (and clears
   * plan_mode when entering). Returns false when the session is missing.
   */
  async setAskMode(id: string, state: AskModeState): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false
    const agent = await this.ensureAgentAsync(session)
    session.record.askMode = state
    if (state === 'asking' && session.record.planMode === 'planning') {
      session.record.planMode = 'off'
      this.append(session, 'plan_mode', { state: 'off' })
    }
    try {
      if (state === 'asking') agent.enterAskMode?.()
      else agent.exitAskMode?.()
    } catch { /* non-fatal */ }
    this.touch(session)
    this.append(session, 'ask_mode', { state })
    this.persistRecord(session)
    return true
  }

  /** List this session's plans (newest first). null when the session is gone. */
  async listPlans(id: string): Promise<PlanDocument[] | null> {
    const session = this.sessions.get(id)
    if (!session) return null
    try {
      return await storeListPlans(session.record.cwd)
    } catch {
      return []
    }
  }

  /**
   * Active plan-mode draft ? the working document the agent writes while
   * planning. Drafts are NOT submitted plans (listPlans filters them); the
   * desktop renders this as a live "???" view instead. Returns `undefined`
   * when the session is missing, `null` when it exists but is not planning
   * or has no readable draft. Title is the draft's H1, null while empty.
   */
  async readPlanDraft(id: string): Promise<PlanDraft | null | undefined> {
    const session = this.sessions.get(id)
    if (!session) return undefined
    if (session.record.planMode !== 'planning') return null
    const path = session.agent?.getActivePlanFilePath?.() ?? null
    if (!path) return null
    try {
      const content = await readFile(join(session.record.cwd, path), 'utf-8')
      const h1 = content.match(/^#\s+(.+)$/m)
      return { path, title: h1 ? h1[1]!.trim() : null, content }
    } catch {
      return null
    }
  }

  /**
   * Read a single plan's full content. Returns `undefined` when the session is
   * missing and `null` when the session exists but the plan does not ? letting
   * the route distinguish 404 reasons.
   */
  async readPlan(id: string, slug: string): Promise<PlanDocument | null | undefined> {
    const session = this.sessions.get(id)
    if (!session) return undefined
    try {
      return await storeReadPlan(session.record.cwd, slug)
    } catch {
      return null
    }
  }

  /**
   * Edit a submitted plan's markdown before approval (desktop plan editing ?
   * Cursor 3.0 parity: review ? tweak the document ? Build). Only `submitted`
   * plans are editable; approved/executed are historical records and rejected
   * are archived. Emits `plan_submitted` so viewers re-fetch the body.
   */
  async updatePlan(id: string, slug: string, content: string): Promise<PlanUpdateOutcome> {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, code: 'session-missing', reason: 'Session not found' }
    // ???? = ???????????????
    this.cancelPlanAutoApprove(session, 'edited')
    const trimmed = content.trim()
    if (!trimmed) return { ok: false, code: 'empty-content', reason: 'Plan content must not be empty' }
    const existing = await storeReadPlan(session.record.cwd, slug)
    if (!existing) return { ok: false, code: 'plan-not-found', reason: `Plan not found: "${slug}"` }
    if (existing.status !== 'submitted') {
      return { ok: false, code: 'not-editable', reason: `Only submitted plans can be edited (status: ${existing.status})` }
    }
    // Options: honour a frontmatter block the editor kept/changed; fall back to
    // the recorded ones so a body-only edit never silently drops the choices.
    const options = parsePlanOptions(content) ?? existing.options
    try {
      await storeWritePlan(session.record.cwd, slug, content, options)
    } catch {
      return { ok: false, code: 'plan-not-found', reason: `Failed to write plan "${slug}"` }
    }
    const updated = await storeReadPlan(session.record.cwd, slug)
    this.touch(session)
    this.append(session, 'plan_submitted', {
      slug,
      title: updated?.title ?? existing.title,
      status: 'submitted',
    })
    this.persistRecord(session)
    return { ok: true }
  }

  /**
   * Build (approve) a plan: run the shared approval guards (content validation +
   * anchor-drift recheck), mark it approved on disk, release plan mode, then
   * inject the wave-execution kickoff as the next turn. Returns a structured
   * failure so the route can surface WHY approval was refused (the old boolean
   * collapsed "session running" / "empty plan" / "bad option" into one 409).
   */
  async approvePlan(id: string, slug: string, selectedApproach?: string): Promise<PlanApprovalOutcome> {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, code: 'session-missing', reason: 'Session not found' }
    // ?????? = ????????????????????????????
    // ???????? no-op??
    this.cancelPlanAutoApprove(session, 'approved')
    if (session.running) {
      return { ok: false, code: 'session-running', reason: 'Session is running ? wait for the current turn to finish before Build' }
    }
    // Validate the selected approach BEFORE mutating the plan file ? approving
    // first would leave the file marked APPROVED even when the option is bogus.
    let resolvedApproach: string | undefined
    if (selectedApproach?.trim()) {
      const pending = await storeReadPlan(session.record.cwd, slug)
      if (!pending) return { ok: false, code: 'plan-not-found', reason: `Plan not found: "${slug}"` }
      if (pending.options && pending.options.length > 0) {
        resolvedApproach = resolvePlanOptionLabel(pending.options, selectedApproach)
        if (!resolvedApproach) {
          return { ok: false, code: 'bad-approach', reason: `Unknown selectedApproach "${selectedApproach}"` }
        }
      } else {
        // No recorded options ? pass the user's text through as-is.
        resolvedApproach = selectedApproach.trim()
      }
    }
    // Shared approval kernel (same closed loop as TUI /plan-approve): empty/
    // placeholder plans hard-fail, anchor drift is rechecked and injected into
    // the kickoff, and the kickoff drives wave-by-wave execution through the
    // review gates (plan_task/team_orchestrate + plan_close).
    let result: PlanApprovalResult
    try {
      result = await approvePlanWithGuards(session.record.cwd, slug, resolvedApproach)
    } catch {
      return { ok: false, code: 'plan-not-found', reason: `Plan not found: "${slug}"` }
    }
    if (!result.ok) {
      return {
        ok: false,
        code: result.code === 'invalid-content' ? 'invalid-content' : 'plan-not-found',
        reason: result.reason,
      }
    }
    const { approved, kickoff } = result
    const agent = await this.ensureAgentAsync(session)
    try {
      agent.setActivePlan?.({
        slug,
        title: approved.title,
        selectedApproach: resolvedApproach,
      })
    } catch { /* non-fatal */ }
    try { agent.exitPlanMode?.() } catch (err) {
      debugLog('approvePlan: agent.exitPlanMode() failed ? plan mode may not have exited', err instanceof Error ? err.message : String(err))
    }
    // agent.onPlanModeChange ????? record ??? plan_mode ?? ????????
    // ???????????? double?
    if (session.record.planMode !== 'off') {
      session.record.planMode = 'off'
      this.append(session, 'plan_mode', { state: 'off' })
    }
    // ??????? plan_submitted??mission-projector ? approved ?????
    // ???????????????? reject/edit ????approved ?????
    this.append(session, 'plan_submitted', { slug, title: approved.title, status: 'approved' })
    this.touch(session)
    this.persistRecord(session)
    this.run(id, kickoff)
    return { ok: true }
  }

  /**
   * Reject a plan with optional feedback. Keeps the plan on disk (marked
   * rejected) and re-enters plan mode. Revision feedback routing depends on
   * session state: idle ? kick a revision turn immediately; running ? queue
   * through the steer buffer (injected at the next tool boundary), so mid-run
   * feedback is never silently dropped. Emits `plan_submitted` to refresh
   * viewers.
   */
  async rejectPlan(id: string, slug: string, comment?: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false
    // ?? = ???????????????
    this.cancelPlanAutoApprove(session, 'rejected')
    let rejected: PlanDocument | null
    try {
      rejected = await storeRejectPlan(session.record.cwd, slug)
    } catch {
      return false
    }
    if (!rejected) return false
    const agent = await this.ensureAgentAsync(session)
    try {
      agent.enterPlanMode?.({ planFilePath: `.rivet/plans/${slug}.md` })
    } catch { /* non-fatal */ }
    // ? approvePlan?enterPlanMode ? onPlanModeChange ??????? plan_mode?
    if (session.record.planMode !== 'planning') {
      session.record.planMode = 'planning'
      this.append(session, 'plan_mode', { state: 'planning' })
    }
    this.append(session, 'plan_submitted', { slug, title: rejected.title, status: 'rejected' })
    this.touch(session)
    this.persistRecord(session)
    const note = comment?.trim()
    if (note) {
      const revisionPrompt = `User rejected the plan. Feedback:\n\n${note}\n\nRevise the plan in \`.rivet/plans/${slug}.md\`, then call plan action=submit again.`
      if (session.running) {
        // Mid-run rejection: the feedback rides the steer buffer (next tool
        // boundary) instead of being dropped ? the old code only handled idle.
        session.steer.push(revisionPrompt)
        this.append(session, 'steer_queued', { text: redactText(revisionPrompt) })
      } else {
        this.run(id, revisionPrompt)
      }
    }
    return true
  }

  /**
   * T3 ? queue mid-run user guidance. Unlike run(), this does NOT start a turn:
   * the text is buffered and injected at the next tool boundary (onSteerDrain).
   * Only meaningful while running ? an idle session has no turn to steer.
   *
   * Returns:
   *  - 'queued'    guidance accepted into the running session's buffer
   *  - 'idle'      session exists but is not running (caller should use /prompt)
   *  - 'not_found' no such session
   */
  steer(id: string, text: string): 'queued' | 'idle' | 'not_found' {
    const session = this.sessions.get(id)
    if (!session) return 'not_found'
    if (!session.running) return 'idle'
    // ?? = ???????????????
    this.cancelPlanAutoApprove(session, 'steer')
    session.steer.push(text)
    // Echo into the event log so the thread reflects the queued guidance and
    // reconnecting viewers see it (append-only, like the user turn echo).
    this.append(session, 'steer_queued', { text: redactText(text) })
    this.touch(session)
    return 'queued'
  }

  /** ?? session ? coordinator ???main.ts ? agent ??????? */
  setCoordinatorRef(sessionId: string, ref: () => import('../agent/coordinator.js').DelegationCoordinator | undefined): void {
    this.coordinatorBySession.set(sessionId, ref)
  }

  /** ?? session ? coordinator ???session ??????? */
  clearCoordinatorRef(sessionId: string): void {
    this.coordinatorBySession.delete(sessionId)
  }

  /**
   * ??? session ????? worker ?? steer ???
   * ?? null = session/coordinator ????false = worker ????true = ????
   */
  steerWorker(sessionId: string, workerId: string, text: string): true | false | null {
    const getCoordinator = this.coordinatorBySession.get(sessionId)
    if (!getCoordinator) return null
    const coordinator = getCoordinator()
    if (!coordinator) return null
    return coordinator.steerWorker(workerId, text)
  }

  /**
   * ???? session ????? worker????? backgroundAborts?? orderControllers??
   * ?? null = session ????false = worker ???/????true = ????
   */
  killWorker(sessionId: string, workerId: string): true | false | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    // ? 1???????? worker?backgroundAborts?
    const bgAbort = session.backgroundAborts?.get(workerId)
    if (bgAbort) {
      try { bgAbort.abort() } catch { /* already aborted */ }
      session.backgroundAborts?.delete(workerId)
      return true
    }
    // ? 2?agent ??? worker?orderControllers??? coordinator?
    const getCoordinator = this.coordinatorBySession.get(sessionId)
    if (!getCoordinator) return false
    const coordinator = getCoordinator()
    if (!coordinator) return false
    return coordinator.killWorker(workerId)
  }

  /** ???? session ??? worker ????? */
  isWorkerRunning(sessionId: string, workerId: string): boolean {
    const getCoordinator = this.coordinatorBySession.get(sessionId)
    if (!getCoordinator) return false
    const coordinator = getCoordinator()
    if (!coordinator) return false
    return coordinator.isWorkerRunning(workerId)
  }

  /**
   * ???????????? running ? delegation ????????
   * ?backgroundAborts / coordinator.orderControllers?????????
   * ?????????worker ???????????????????
   * abort ??????????? onDelegationActivity ? lifecycleGeneration
   * ?????sidecar ??? rehydrate ??? delegation ??????????
   * ??????????????????kill ???? 409?
   * ??????????running ????? run ????????
   */
  private sweepStaleDelegationNodes(session: InternalSession, failureReason: string): void {
    if (session.running) return
    const latest = new Map<string, string>()
    const firstTs = new Map<string, number>()
    for (const ev of session.events) {
      if (ev.type !== 'delegation') continue
      const workerId = typeof ev.data.workerId === 'string' ? ev.data.workerId : undefined
      const status = typeof ev.data.status === 'string' ? ev.data.status : undefined
      if (!workerId || !status) continue
      if (!firstTs.has(workerId)) firstTs.set(workerId, ev.ts)
      latest.set(workerId, status)
    }
    for (const [workerId, status] of latest) {
      if (status !== 'running') continue
      if (session.backgroundAborts?.has(workerId)) continue
      if (this.isWorkerRunning(session.record.id, workerId)) continue
      // ???????????????????? elapsedMs ?? 0 ????
      const startedMap = session.delegationStartedAt ?? (session.delegationStartedAt = new Map())
      const ts = firstTs.get(workerId)
      if (ts !== undefined && !startedMap.has(workerId)) startedMap.set(workerId, ts)
      this.emitDelegationActivity(session, { workOrderId: workerId, status: 'failed', failureReason })
    }
  }

  /**
   * N2 ? artifact feedback re-injection. Turns a human comment on an artifact
   * into a structured next-turn prompt so the agent revises in-context. Only
   * valid on an idle session (a finished turn); returns false while running.
   *
   * `lines` carries diff line-level review comments (file + old/new line +
   * comment), surfaced as a `[LINE-LEVEL REVIEW]` block so the agent can locate
   * each remark at an exact file:line anchor. Artifacts-level `comment` and
   * `lines` are both optional but at least one must be non-empty.
   */
  feedback(
    id: string,
    artifactId: string,
    comment: string,
    lines?: ReadonlyArray<{ file: string; oldLine?: number; newLine?: number; comment: string }>,
  ): boolean {
    const s = this.sessions.get(id)
    if (!s || s.running) return false
    this.ensureEvents(s)
    const meta = [...s.events].reverse().find(
      (e) => e.type === 'artifact' && e.data.id === artifactId,
    )
    const target = meta ? String(meta.data.target ?? '') : ''
    const parts: string[] = [`[ARTIFACT FEEDBACK]`]
    parts.push(`Artifact: ${artifactId}${target ? ` (${target})` : ''}`)
    if (comment.trim()) {
      parts.push(`Comment: ${comment}`)
    }
    // ???????? <file>:<line> ???? agent ????
    const lineRemarks = lines?.filter((l) => l.comment.trim()) ?? []
    if (lineRemarks.length > 0) {
      const rendered = lineRemarks
        .map((l) => {
          const lineRef = l.newLine ?? l.oldLine
          const loc = lineRef != null ? `${l.file}:${lineRef}` : l.file
          return `${loc} ? ${l.comment.trim()}`
        })
        .join('\n')
      parts.push(`[LINE-LEVEL REVIEW]\n${rendered}`)
    }
    const prompt = `${parts.join('\n')}\n\nPlease revise your work to address this feedback.`
    return this.run(id, prompt)
  }

  /**
   * Start a run and resolve when it reaches a terminal state (N3 ? used by the
   * runtime pool so scheduled tasks can report a summary). Returns immediately
   * with a failed result if the session is missing or already busy.
   */
  runAndWait(
    id: string,
    prompt: string,
  ): Promise<{ status: SessionStatus; summary: string; changedFiles: string[]; haltedApp?: string }> {
    const s = this.sessions.get(id)
    if (!s || s.running) {
      return Promise.resolve({ status: 'failed', summary: 'session missing or busy', changedFiles: [] })
    }
    if (!this.run(id, prompt)) {
      return Promise.resolve({ status: 'failed', summary: 'failed to start', changedFiles: [] })
    }
    // run() installs this token synchronously before invoking AgentLoop.run().
    // Capture it now so a later run can never satisfy this waiter.
    const settlement = s.activeRunSettlement
    if (!settlement) {
      return Promise.resolve({ status: 'failed', summary: 'run settlement unavailable', changedFiles: [] })
    }
    return settlement.promise.then(() => ({
      status: s.record.status,
      summary: this.buildRunSummary(s),
      changedFiles: this.collectChangedFiles(s),
      // ??????????? app??????? TaskRecord ??????
      ...(s.unattendedHaltApp ? { haltedApp: s.unattendedHaltApp } : {}),
    }))
  }

  private buildRunSummary(session: InternalSession): string {
    // ???? fail-closed ?????????? assistant ???????????
    if (session.unattendedHaltReason) {
      return `[unattended halt] ${session.unattendedHaltReason}`
    }
    // Last assistant text run is the closest thing to a result summary.
    for (let i = session.events.length - 1; i >= 0; i--) {
      const e = session.events[i]!
      if (e.type === 'text_delta') {
        const text = String(e.data.text ?? '').trim()
        if (text) return text.slice(0, 500)
      }
    }
    return `status=${session.record.status}`
  }

  private collectChangedFiles(session: InternalSession): string[] {
    const files = new Set<string>()
    for (const e of session.events) {
      if (e.type !== 'tool_use') continue
      const name = String(e.data.name ?? '')
      if (name !== 'edit_file' && name !== 'write_file' && name !== 'apply_patch') continue
      const input = e.data.input as Record<string, unknown> | undefined
      const path = input && typeof input.path === 'string' ? input.path : null
      if (path) files.add(path)
    }
    return [...files]
  }

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()]
      .filter((s) => !s.record.archived)
      .map((s) => this.enrichRecord(s))
  }

  listAllSessions(): SessionRecord[] {
    return [...this.sessions.values()].map((s) => this.enrichRecord(s))
  }

  /** Enrich a session record with live context usage when the agent is awake. */
  private enrichRecord(s: InternalSession): SessionRecord {
    const record = { ...s.record }
    if (s.agent) {
      try { record.contextTokens = s.agent.getEstimatedTokens?.() } catch { /* non-fatal */ }
      try { record.contextWindow = s.agent.getContextWindow?.() } catch { /* non-fatal */ }
      // Prefer the user's explicit effort selection (including 'auto') over the
      // agent's current concrete level, so the desktop chip reflects the mode
      // the user actually set.
      try { record.reasoningEffort = s.reasoningEffort ?? s.agent.getReasoningEffort?.() } catch { /* non-fatal */ }
    }
    const persona = resolveDomainPersona(record.domain)
    record.domainGlyph = persona.glyph
    record.domainAccent = persona.accent
    return record
  }

  getSession(id: string): SessionRecord | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return this.enrichRecord(s)
  }

  /**
   * I1: expose the live ManagedAgent for a session so surfaces like
   * CouncilSurface can call agent-specific methods (conveneCouncil). Returns
   * undefined when the session is missing or has no built agent yet.
   */
  getAgentForSession(id: string): ManagedAgent | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return s.agent ?? undefined
  }

  /**
   * I4: append a `hook_result` event for user-defined .rivet/hooks.json scripts.
   * Retains only the latest 50 hook_result events so diagnostic noise does not
   * evict user messages from the main ring buffer.
   */
  emitHookResult(
    id: string,
    results: HookResult[],
    meta: { event: HookEvent; turn?: number; toolName?: string; error?: string },
  ): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.append(s, 'hook_result', {
      event: meta.event,
      turn: meta.turn,
      toolName: meta.toolName,
      error: meta.error,
      results,
    })
    this.trimHookResults(s)
  }

  private trimHookResults(session: InternalSession): void {
    const hookEvents = session.events.filter((e) => e.type === 'hook_result')
    if (hookEvents.length <= 50) return
    const toDrop = hookEvents.length - 50
    const dropped = new Set(hookEvents.slice(0, toDrop))
    session.events = session.events.filter((e) => !dropped.has(e))
  }

  getEvents(id: string, since = 0): { events: SessionEvent[]; lastSeq: number } | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    // Reconnect/replay entry point ? lazy-load the log from disk on first open.
    this.ensureEvents(s)
    // Poll/replay must see the freshest text ? drain the delta window first.
    this.flushDeltaBuf(s)
    this.flushToolResultBuf(s)
    const events = s.events.filter((e) => e.seq > since)
    return { events, lastSeq: s.seq }
  }

  /** Live event subscription for SSE. Unsubscribing never aborts the run. */
  /**
   * Subscribe to live events. Optional `clientId` ties this SSE connection to
   * E4 delegate capabilities: on teardown, capabilities registered under the
   * same clientId are cleared and in-flight delegations fail-back (null).
   */
  subscribe(
    id: string,
    listener: (e: SessionEvent) => void,
    opts?: { clientId?: string },
  ): (() => void) | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    s.listeners.add(listener)
    const clientId = opts?.clientId?.trim() || undefined
    return () => {
      s.listeners.delete(listener)
      if (clientId) this.clearDelegateCapabilities(id, clientId)
    }
  }

  abort(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const wasRunning = s.running
    // Is there actually anything to stop? Must be sampled before the timers
    // below are cleared. rehydrate() loads EVERY persisted session into memory,
    // so abortAll() (sidecar shutdown + the global POST /abort) walks all of
    // them ? without this gate each pass appended a `status: aborted` marker to
    // and re-touched updatedAt on hundreds of long-finished sessions, flattening
    // the recency order every list in the UI sorts by.
    const abortable =
      wasRunning ||
      s.record.status === 'running' ||
      s.pending.size > 0 ||
      s.pendingDelegations.size > 0 ||
      s.watchdogContinueTimer !== undefined ||
      s.planAutoApproveTimer !== undefined
    if (s.record.status === 'running') {
      s.record.status = 'aborted'
    }
    if (wasRunning) {
      s.lifecycleGeneration++
      this.cancelPlanDraftTimer(s)
      s.planDraftLastEmit = undefined
    }
    // ????????watchdog stall ? finally ? setImmediate ???????
    // abort ??????????????? setImmediate ???????
    s.watchdogRecoveryCancelled = true
    // C2 ? ????????????????????? Esc??
    if (s.watchdogContinueTimer) {
      clearTimeout(s.watchdogContinueTimer)
      s.watchdogContinueTimer = undefined
      this.append(s, 'watchdog_recovery', { cancelled: true })
    }
    // abort = ???????????????
    this.cancelPlanAutoApprove(s, 'aborted')
    s.agent?.abort()
    this.rejectAllPending(s, 'aborted')
    // ?????abort ??? run finally ?? durability ???worker ??
    // ????????????? sweepStaleDelegationNodes????????
    // ?????run finally?microtask??? session.running ?? false?
    // coordinator ?????? promise????? orderControllers?
    setImmediate(() => {
      if (this.sessions.get(id) !== s) return
      this.sweepStaleDelegationNodes(s, 'caller_aborted')
    })
    // Idle sessions keep their timestamps and their log stays clean. The
    // in-memory suppression flag above still applies ? a stall recovery waiting
    // on setImmediate is cancelled either way, it just no longer re-stamps a
    // session whose status is already 'aborted'. Returns true regardless: the
    // route reads false as "no such session" (404).
    if (abortable) {
      this.touch(s)
      this.append(s, 'status', { status: 'aborted' })
      this.persistRecord(s)
    }
    return true
  }

  abortAll(): void {
    for (const id of this.sessions.keys()) this.abort(id)
  }

  /**
   * Wave L: ???????runServe.close???????? session ?
   * agent.shutdown() ?? coordinator/timer/in-flight worker ????
   * abortAll() ???abortAll ????? turn?shutdownAll ???????
   * best-effort??? session shutdown ????????
   */
  shutdownAll(): Promise<void> {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer)
      this.idleSweepTimer = undefined
    }
    const pending: Promise<void>[] = []
    for (const s of this.sessions.values()) {
      let shutdownResult: void | boolean | Promise<void | boolean> | undefined
      try {
        shutdownResult = s.agent?.shutdown?.()
      } catch { /* best-effort */ }
      const releaseIdleClaims = (settled?: void | boolean) => {
        if (settled !== false) this.releaseClaimsIfIdle(s)
      }
      if (shutdownResult && typeof (shutdownResult as Promise<void>).then === 'function') {
        pending.push(Promise.resolve(shutdownResult).then(releaseIdleClaims, () => undefined))
      } else if (shutdownResult !== false) {
        releaseIdleClaims()
      }
      try { s.jobs?.killAll() } catch { /* best-effort */ }
      // Drain any coalescing delta window so the tail is never lost on exit.
      try { this.flushDeltaBuf(s) } catch { /* best-effort */ }
      try { this.flushToolResultBuf(s) } catch { /* best-effort */ }
    }
    // Flush any buffered events to disk before exit.
    this.persistence?.flushSync?.()
    return pending.length > 0 ? Promise.all(pending).then(() => undefined) : Promise.resolve()
  }

  /**
   * Archive (soft-close) a session: abort if running, mark `archived=true`, and
   * persist. The session is excluded from listSessions() but its data survives on
   * disk (events.jsonl / artifacts) ? rehydrate still restores it as archived.
   * Returns false when the session is missing or already archived.
   */
  archiveSession(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s || s.record.archived) return false
    const wasRunning = s.running
    // Stop any in-flight run first (mirrors abort's cleanup).
    if (s.running) {
      s.record.status = 'aborted'
      s.lifecycleGeneration++
      this.cancelPlanDraftTimer(s)
      s.planDraftLastEmit = undefined
      s.agent?.abort()
      this.rejectAllPending(s, 'aborted')
    }
    s.record.archived = true
    // Clean up isolated worktree on archive. Guard against data loss: if the
    // worktree has uncommitted changes, checkpoint-commit them first; if the
    // branch carries commits not merged into the main workspace, keep the
    // branch (only the worktree directory is removed) so work stays landable.
    let branchKept = false
    if (s.record.worktreePath) {
      try {
        const work = hasUnlandedWork(this.defaultCwd, s.record.worktreePath, s.record.worktreeBranch)
        if (work.dirty) {
          // worktree remove --force discards uncommitted changes ? snapshot them.
          commitAll(s.record.worktreePath, 'rivet: archive checkpoint', { noVerify: true })
        }
        const after = work.dirty || work.unmergedCommits > 0
          ? hasUnlandedWork(this.defaultCwd, s.record.worktreePath, s.record.worktreeBranch)
          : work
        // Squash merge-back leaves branch commits unreachable from main ?
        // the landedHead marker proves they were landed. A branch head that
        // hasn't moved past the last merge-back is safe to delete.
        const landed = Boolean(s.record.landedHead)
          && revParseHead(s.record.worktreePath) === s.record.landedHead
        branchKept = Boolean(s.record.worktreeBranch) && after.unmergedCommits > 0 && !landed
        removeWorktree(this.defaultCwd, s.record.worktreePath, s.record.worktreeBranch, { keepBranch: branchKept })
      } catch { /* non-fatal */ }
    }
    this.touch(s)
    this.append(s, 'status', branchKept
      ? { status: 'archived', branchKept: true, worktreeBranch: s.record.worktreeBranch }
      : { status: 'archived' })
    s.toolResultClosed = true
    this.cancelToolResultBuf(s)
    this.persistRecord(s)
    // Phase 3 #9 ? an archived session must not keep its heavy state resident.
    // If a run was just aborted above, its promise is still settling; run()'s
    // finally does the unload once the agent has actually let go.
    if (!wasRunning) this.unloadSession(s)
    return true
  }

  /**
   * Unarchive (restore) a previously archived session. Returns it to the active
   * list and resets status to idle. Returns false when missing or not archived.
   */
  unarchiveSession(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s || !s.record.archived) return false
    s.record.archived = false
    s.toolResultClosed = false
    s.record.status = 'idle'
    this.touch(s)
    this.persistRecord(s)
    return true
  }

  /**
   * Rename a session. Updates the record title and persists it.
   * Returns false when the session is missing.
   */
  setTitle(id: string, title: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    s.record.title = title.trim()
    this.touch(s)
    this.persistRecord(s)
    return true
  }

  /** List git worktrees for a given cwd (defaults to the manager's default cwd). */
  getWorktrees(cwd?: string): WorktreeEntry[] {
    return listWorktrees(cwd ?? this.defaultCwd)
  }

  /** ASCII branch/merge graph for a given cwd (defaults to the manager's default cwd). */
  async getGitGraph(cwd?: string, maxCount?: number): Promise<string> {
    return getGitGraph(cwd ?? this.defaultCwd, maxCount)
  }

  /** Working-tree changes relative to HEAD for the desktop "changes" tab. */
  async getWorkingTreeFiles(cwd?: string, includeIgnored = false): Promise<{ files: WorkingTreeFile[]; isRepo: boolean }> {
    return getWorkingTreeFiles(cwd ?? this.defaultCwd, 'HEAD', includeIgnored)
  }

  /** Unified diff of a single file relative to HEAD (on-demand). */
  async getFileDiff(path: string, cwd?: string): Promise<string> {
    return getFileDiff(cwd ?? this.defaultCwd, path)
  }

  /**
   * Resolve the git context of a session: worktree cwd for isolated worktree
   * sessions, otherwise the session's own cwd (the project directory), falling
   * back to the shared default cwd only as a last resort. The diff baseline is
   * the recorded creation HEAD for worktree sessions, plain HEAD otherwise.
   */
  private sessionGitContext(id: string): { cwd: string; baseRef: string } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const cwd = s.record.worktreePath ?? s.record.cwd ?? this.defaultCwd
    const baseRef = s.record.baselineHead ?? 'HEAD'
    return { cwd, baseRef }
  }

  /** Session-scoped working-tree changes (worktree cwd + task baseline). */
  async getSessionWorkingTree(id: string, includeIgnored = false): Promise<{ files: WorkingTreeFile[]; isRepo: boolean } | null> {
    const ctx = this.sessionGitContext(id)
    if (!ctx) return null
    const result = await getWorkingTreeFiles(ctx.cwd, ctx.baseRef, includeIgnored)
    // The worktree owner marker is infrastructure, not user work ? hide it.
    return { ...result, files: result.files.filter(f => f.path !== '.vsw-owner.json') }
  }

  /** Session-scoped single-file diff (worktree cwd + task baseline). */
  async getSessionFileDiff(id: string, path: string): Promise<string | null> {
    const ctx = this.sessionGitContext(id)
    if (!ctx) return null
    return getFileDiff(ctx.cwd, path, ctx.baseRef)
  }

  /**
   * Full file content at the session's task baseline ? the left pane of an
   * editor client's native two-pane diff (VS Code extension changes view).
   */
  async getSessionFileAtBase(id: string, path: string): Promise<{ exists: boolean; content: string } | null> {
    const ctx = this.sessionGitContext(id)
    if (!ctx) return null
    return getFileAtBase(ctx.cwd, path, ctx.baseRef)
  }

  // ?? Change landing (desktop Changes tab: Commit / Merge back / Create PR) ??

  /**
   * Stage and commit everything in the session's cwd (worktree for isolated
   * sessions, shared cwd otherwise). Server-direct path of the dual-channel
   * design ? the "let the agent commit" path goes through a normal prompt.
   */
  commitSessionChanges(id: string, message?: string): { ok: boolean; sha?: string; nothingToCommit?: boolean; error?: string } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const cwd = s.record.worktreePath ?? this.defaultCwd
    const fallback = `rivet: ${s.record.title?.trim() || `session ${id.slice(0, 8)}`} changes`
    const result = commitAll(cwd, message?.trim() || fallback)
    if (result.ok && result.sha) {
      this.append(s, 'landing', { action: 'commit', sha: result.sha })
      this.touch(s)
    }
    return result
  }

  /**
   * Squash-merge the session's worktree branch into the main workspace's
   * current branch. Uncommitted worktree changes are committed first so the
   * squash captures the full task delta. Fail-closed on dirty main workspace
   * or conflicts (rolled back, conflict files reported).
   */
  mergeSessionBack(id: string): { ok: boolean; sha?: string; nothingToMerge?: boolean; conflictFiles?: string[]; error?: string } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    if (!s.record.worktreeBranch || !s.record.worktreePath) {
      return { ok: false, error: 'not a worktree session ? nothing to merge back' }
    }
    // Sweep uncommitted work into the branch first (squash flattens it anyway).
    const checkpoint = commitAll(s.record.worktreePath, 'rivet: pre-merge checkpoint', { noVerify: true })
    if (!checkpoint.ok) return { ok: false, error: `failed to checkpoint worktree: ${checkpoint.error}` }
    const title = s.record.title?.trim() || 'session changes'
    const result = squashMergeBranch(this.defaultCwd, s.record.worktreeBranch, `${title} (rivet session ${id.slice(0, 8)})`)
    if (result.ok) {
      // Squash merges leave the branch commits unreachable from main, so
      // rev-list alone can't prove "landed". Record the branch head at merge
      // time ? archive deletes the branch when it hasn't moved past this.
      s.record.landedHead = revParseHead(s.record.worktreePath)
      if (result.sha) this.append(s, 'landing', { action: 'merge_back', sha: result.sha, branch: s.record.worktreeBranch })
      this.touch(s)
      this.persistRecord(s)
    }
    return result
  }

  /**
   * Push the session's worktree branch and open a PR via `gh pr create`.
   * Uncommitted changes are checkpoint-committed first.
   */
  async createSessionPr(id: string, title?: string, body?: string): Promise<{ ok: boolean; url?: string; error?: string } | null> {
    const s = this.sessions.get(id)
    if (!s) return null
    if (!s.record.worktreeBranch || !s.record.worktreePath) {
      return { ok: false, error: 'not a worktree session ? create PRs from an isolated worktree session' }
    }
    const checkpoint = commitAll(s.record.worktreePath, 'rivet: pre-PR checkpoint', { noVerify: true })
    if (!checkpoint.ok) return { ok: false, error: `failed to checkpoint worktree: ${checkpoint.error}` }
    const pushed = pushBranch(s.record.worktreePath, s.record.worktreeBranch)
    if (!pushed.ok) return { ok: false, error: `git push failed: ${pushed.error}` }
    const result = await createPr(s.record.worktreePath, {
      title: title?.trim() || s.record.title?.trim(),
      body: body?.trim() || `Created from Rivet session ${id.slice(0, 8)}.`,
    })
    if (result.ok && result.url) {
      this.append(s, 'landing', { action: 'pr_created', url: result.url, branch: s.record.worktreeBranch })
      this.touch(s)
    }
    return result
  }

  /** Expose defaultCwd for routes that need the repo root (e.g. gh CLI). */
  getDefaultCwd(): string {
    return this.defaultCwd
  }

  /**
   * Mount an EXTENDED-layer tool onto the session's agent (workflow auto-mount).
   * Returns the mount status, or undefined if the session/agent lacks enableTool
   * (lightweight doubles). No-op if gating is off (tool already visible).
   */
  async enableTool(id: string, name: string): Promise<{ status: string; cacheImpact: string } | undefined> {
    const session = this.sessions.get(id)
    if (!session) return undefined
    const agent = await this.ensureAgentAsync(session)
    return agent.enableTool?.(name)
  }

  /**
   * Hot-inject MCP (or other late-discovered) tools into every session that
   * already has a live ManagedAgent. Sessions without an agent yet will pick
   * tools up at ensureAgent ? buildSessionStores via getAllTools(). Idempotent:
   * ToolRegistry.register is Map.set overwrite.
   */
  injectMcpTools(tools: Tool[]): void {
    if (!tools.length) return
    for (const s of this.sessions.values()) {
      if (!s.agent || s.record.archived) continue
      try {
        s.agent.registerExternalTools?.(tools)
      } catch {
        /* best-effort per session ? one failure must not block others */
      }
    }
  }

  // ?? E4 client tool delegation ??????????????????????????????????????????

  /**
   * Register (or heartbeat) client landing capabilities. Later registrant
   * replaces the prior slot. Returns false when the session is missing.
   */
  registerDelegateCapabilities(
    id: string,
    clientId: string,
    kinds: DelegateKind[],
  ): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const cid = clientId.trim()
    if (!cid) return false
    const valid = kinds.filter(isDelegateKind)
    s.delegateCapabilities = {
      clientId: cid,
      kinds: new Set(valid),
      expiresAt: this.now() + DELEGATE_CAPABILITY_TTL_MS,
    }
    return true
  }

  /**
   * Clear capabilities for a clientId (SSE teardown). Also fail-backs any
   * in-flight PendingDelegation with null so tool-pipeline resumes locally.
   * If clientId is omitted, clears whatever slot is present.
   */
  clearDelegateCapabilities(id: string, clientId?: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const slot = s.delegateCapabilities
    if (!slot) return false
    if (clientId && slot.clientId !== clientId) return false
    s.delegateCapabilities = undefined
    // Fail-back in-flight landings ? client is gone.
    for (const [rid, pend] of [...s.pendingDelegations]) {
      s.pendingDelegations.delete(rid)
      if (pend.timer) clearTimeout(pend.timer)
      pend.resolve(null)
    }
    return true
  }

  /** Whether the session currently has a live capability for `kind`. */
  hasDelegateCapability(id: string, kind: DelegateKind): boolean {
    const s = this.sessions.get(id)
    if (!s?.delegateCapabilities) return false
    const slot = s.delegateCapabilities
    if (slot.expiresAt <= this.now()) {
      s.delegateCapabilities = undefined
      return false
    }
    return slot.kinds.has(kind)
  }

  /**
   * Resolve a pending delegation with a client result. Returns false if the
   * request is gone (already timed out / fail-backed).
   */
  answerDelegation(id: string, requestId: string, result: ClientDelegateResult): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const pend = s.pendingDelegations.get(requestId)
    if (!pend) return false
    s.pendingDelegations.delete(requestId)
    if (pend.timer) clearTimeout(pend.timer)
    pend.resolve({
      content: typeof result.content === 'string' ? result.content : '',
      isError: result.isError === true,
      uiContent: typeof result.uiContent === 'string' ? result.uiContent : undefined,
      status: result.status === 'rejected' ? 'rejected' : result.status === 'ok' ? 'ok' : undefined,
    })
    return true
  }

  /**
   * Hang a landing step for the client. Returns null immediately when no live
   * capability matches (tool-pipeline fails back to local). Otherwise emits
   * `tool_delegate` and waits for answerDelegation / timeout?null.
   */
  private requestToolDelegate(
    session: InternalSession,
    lifecycleGeneration: number,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<ClientDelegateResult | null> {
    if (!isDelegateKind(kind)) return Promise.resolve(null)
    if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) {
      return Promise.resolve(null)
    }
    const slot = session.delegateCapabilities
    if (!slot || slot.expiresAt <= this.now() || !slot.kinds.has(kind)) {
      if (slot && slot.expiresAt <= this.now()) session.delegateCapabilities = undefined
      return Promise.resolve(null)
    }
    const timeoutMs = DELEGATE_TIMEOUT_MS[kind]
    const requestId = randomId()
    const deadlineMs = this.now() + timeoutMs
    return new Promise<ClientDelegateResult | null>((resolve) => {
      const pend: PendingDelegation = {
        requestId,
        kind,
        resolve,
        timer: setTimeout(() => {
          if (!session.pendingDelegations.delete(requestId)) return
          // Timeout ? null (fail-back). NOT an error ? agent never sees it.
          resolve(null)
        }, timeoutMs),
      }
      if (typeof pend.timer?.unref === 'function') pend.timer.unref()
      session.pendingDelegations.set(requestId, pend)
      this.append(session, 'tool_delegate', {
        requestId,
        kind,
        payload: payload as unknown as DelegatePayload,
        deadlineMs,
      })
    })
  }

  /**
   * Resolve a pending approval. Returns false if the request is gone.
   * An optional `editedInput` lets the human tweak the tool input
   * (e.g. per-hunk edit picks) before it runs ? flows through ApprovalResult.
   * (Intent is now a non-blocking timeline note and has no pending state.)
   */
  /**
   * Label an approval that would widen the write/read boundary to a directory
   * outside the workspace, so the UI can offer "remember this directory". Absent
   * for every other approval ? the checkbox must not appear where remembering
   * has no meaning.
   */
  private pathGrantHint(
    cwd: string,
    name: string,
    input: Record<string, unknown>,
  ): { dir: string; mode: 'read' | 'write' } | undefined {
    if (name === 'request_path_access') {
      const p = typeof input.path === 'string' ? input.path.trim() : ''
      return p ? { dir: p, mode: input.mode === 'write' ? 'write' : 'read' } : undefined
    }
    const need = outOfWorkspaceFilePaths(cwd, name, input)
    const first = need?.paths[0]
    return need && first ? { dir: dirname(first), mode: need.mode } : undefined
  }

  answerIntervention(
    id: string,
    requestId: string,
    decision: string,
    editedInput?: Record<string, unknown>,
    remember?: boolean,
  ): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const pend = s.pending.get(requestId)
    if (!pend) return false
    s.pending.delete(requestId)
    if (pend.timer) clearTimeout(pend.timer)

    const approved = decision === 'approve' || decision === 'approved'
    const result: ApprovalResult = { approved }
    if (approved && editedInput && typeof editedInput === 'object') {
      result.editedInput = editedInput
    }
    // Out-of-workspace path approvals read this to persist the directory grant
    // per-workspace. Computer Use keeps its own grant store (below) ? the two
    // remember semantics are independent, so both consume the same flag.
    if (approved && remember === true) result.remember = true
    pend.resolve(result)
    if (!approved) s.lastApprovalDeniedAt = this.now()
    // Computer Use "always allow": approve + remember records a machine-level
    // per-app grant so future actions on this app skip the prompt entirely
    // (the tool's requiresApproval consults the same grant store).
    let rememberedApp: string | undefined
    if (approved && remember === true && pend.toolName === 'computer_use') {
      const app = pend.toolInput?.app
      if (typeof app === 'string' && app.trim()) {
        try {
          grantComputerUseApp(app.trim())
          rememberedApp = app.trim()
        } catch { /* grant persistence is best-effort ? approval still resolves */ }
      }
    }
    this.recountApprovals(s)
    this.append(s, 'approval_resolved', {
      requestId,
      decision: approved ? 'approve' : 'reject',
      edited: !!result.editedInput,
      ...(rememberedApp ? { rememberedApp } : {}),
    })
    this.touch(s)
    this.persistRecord(s)
    return true
  }

  /** List background jobs for a session. undefined = session missing. */
  listJobs(id: string): import('../tools/job-store.js').JobSnapshot[] | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return s.jobs?.list() ?? []
  }

  /** Full captured output of a background job. undefined = session/job missing. */
  getJobLogs(id: string, jobId: string): string | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return s.jobs?.logs(jobId) ?? undefined
  }

  /** Terminate a background job. Returns false when session/job is missing. */
  killJob(id: string, jobId: string): boolean {
    const s = this.sessions.get(id)
    if (!s || !s.jobs) return false
    return s.jobs.kill(jobId)
  }

  listArtifacts(id: string): Artifact[] | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    // Rehydrated/idle sessions have no live agent ? read the artifact log
    // straight off disk (index + raw files survive a sidecar restart).
    if (!s.agent) return this.rehydratedArtifactStore(s).list()
    return s.agent.listArtifacts()
  }

  readArtifact(id: string, artifactId: string): Promise<string | null> | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (!s.agent) return this.rehydratedArtifactStore(s).readRaw(artifactId)
    return s.agent.readArtifact(artifactId)
  }

  /**
   * Build (once) a read-only ArtifactStore over the session's persisted
   * artifact directory. Mirrors the layout the live AgentLoop writes:
   * `<cwd>/.rivet/artifacts/<sessionId>`. Construction is cheap and never
   * throws on a missing directory (loadIndex no-ops), so an idle session with
   * no artifacts simply yields an empty list.
   */
  private rehydratedArtifactStore(s: InternalSession): ArtifactStore {
    if (!s.rehydratedArtifacts) {
      const artifactDir = join(s.record.cwd, '.rivet', 'artifacts')
      s.rehydratedArtifacts = new ArtifactStore(artifactDir, s.record.id)
    }
    return s.rehydratedArtifacts
  }

  /**
   * List user messages that can be rewound to. Each entry has the message
   * index (for use with rewind()), the text content, and the event timestamp
   * (derived from the session event log, since OaiMessage has no ts field).
   * Returns empty for sessions without a live agent (rehydrated/idle).
   */
  async listRewindPoints(id: string): Promise<{ index: number; content: string; timestamp: number; seq?: number }[] | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (!s.agent) return []
    const msgs = s.agent.getMessages()
    // Collect user events (seq + ts + text) so we can map each user message to
    // both its submission time AND the seq of its originating `user` event. The
    // seq lets the UI anchor previews/forks on the exact `u-${seq}` block the
    // rewind reducer will cut at ? same anchor rewind() emits as anchorSeq.
    // ?????(Phase 2):?????????????????? user ????
    // ?? seq/ts ??,????? timestamp=0 + ????????
    const { events } = (await this.getAllEventsAsync(id)) ?? { events: [] as SessionEvent[] }
    const userEvents: { seq: number; ts: number; text: string }[] = []
    for (const e of events) {
      if (e.type === 'user') {
        userEvents.push({ seq: e.seq, ts: e.ts, text: String((e.data as { text?: unknown }).text ?? '') })
      }
    }
    const entries: { index: number; content: string; timestamp: number; seq?: number }[] = []
    // seq ????????:???????????? user ????????
    // ????????????????(????????)????;???
    // (??????/??)???????? seq,????,????????
    // ???timestamp ??????:???????????????? ts?
    let cursor = 0
    let ordinal = 0
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!
      if (m.role === 'user' && typeof m.content === 'string') {
        let hit = -1
        for (let k = cursor; k < userEvents.length; k++) {
          if (userEvents[k]!.text === m.content) { hit = k; break }
        }
        const ue = hit >= 0 ? userEvents[hit]! : undefined
        if (hit >= 0) cursor = hit + 1
        entries.push({
          index: i,
          content: m.content,
          timestamp: ue?.ts ?? userEvents[ordinal]?.ts ?? 0,
          ...(ue !== undefined ? { seq: ue.seq } : {}),
        })
        ordinal++
      }
    }
    return entries
  }

  /**
   * Rewind a session to a prior message index. Truncates the agent's message
   * list, appends a `rewind` event to the event log (append-only ? old events
   * are NOT deleted, so reconnecting clients can see the rewind marker), and
   * optionally rolls back files via the existing checkpoint system.
   *
   * Safety: rejects if session is `running` (caller must abort first).
   */
  rewind(id: string, messageIndex: number, options?: { rollbackFiles?: boolean }): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    if (s.running) return false
    if (!s.agent) return false
    this.ensureEvents(s)

    const msgs = s.agent.getMessages()
    if (messageIndex < 0 || messageIndex >= msgs.length) return false

    const target = msgs[messageIndex]!
    const prompt = typeof target.content === 'string' ? target.content : ''

    // Resolve a duplicate-proof UI anchor: the seq of the `user` event that
    // produced this rewound message. The rewound message is the N-th user-role
    // string message; the N-th `user` event in the log carries the same text.
    // Emit anchorSeq only when the ordinal lines up AND the text matches, so a
    // trimmed/diverged log silently falls back to the client's text heuristic.
    let userOrdinal = 0
    for (let i = 0; i < messageIndex; i++) {
      const m = msgs[i]!
      if (m.role === 'user' && typeof m.content === 'string') userOrdinal++
    }
    const userEvents = s.events.filter(e => e.type === 'user')
    const anchorEvent = userEvents[userOrdinal]
    const anchorSeq = anchorEvent && anchorEvent.data.text === prompt ? anchorEvent.seq : undefined

    // Truncate messages to the selected point (full derived-state reset).
    s.agent.rewindToMessages(msgs.slice(0, messageIndex))
    s.agent.resetAppendixBaseline?.()

    // Update session status: rewind returns the session to idle so the user
    // can send a new prompt. Previous status (completed/failed) is stale.
    s.record.status = 'idle'
    s.record.error = undefined

    // Append rewind event (append-only ? viewers see the marker).
    this.append(s, 'rewind', {
      messageIndex,
      prompt,
      ...(anchorSeq !== undefined ? { anchorSeq } : {}),
      timestamp: this.now(),
    })

    // Optional file rollback via existing checkpoint system.
    if (options?.rollbackFiles) {
      void this.rollbackFiles(s)
    }

    return true
  }

  /** Best-effort file rollback for rewind. Surfaces result via event log. */
  private async rollbackFiles(session: InternalSession): Promise<void> {
    try {
      const { getRollbackPreview, rollbackToCheckpoint, makeOwnershipGuard } = await import('../agent/checkpoint.js')
      const registry = this.getRegistry?.()
      const guard = registry
        ? makeOwnershipGuard(registry, session.record.id, session.record.cwd)
        : undefined
      const preview = await getRollbackPreview(session.record.cwd, session.record.id, guard)
      if (preview) {
        await rollbackToCheckpoint(session.record.cwd, preview.confirmationToken, session.record.id, guard)
      }
    } catch {
      // checkpoint rollback is best-effort; rewind still succeeds on messages
    }
  }

  /**
   * Preview the files a precise (per-message) code rewind would touch. Returns
   * `available: false` when the session has no live agent / FileHistory or no
   * tracked edits after the boundary ? the caller can then fall back to the
   * coarse checkpoint rollback (which also covers bash-driven changes).
   */
  previewFilesPrecise(
    id: string,
    messageIndex: number,
  ): { available: boolean; files: { path: string; action: 'restore' | 'delete' }[] } | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    const fh = s.agent?.getFileHistory?.()
    if (!s.agent || !fh) return { available: false, files: [] }
    const msgs = s.agent.getMessages()
    if (messageIndex < 0 || messageIndex >= msgs.length) return { available: false, files: [] }
    const ids = collectPostBoundaryEditIds(msgs, messageIndex)
    const files = fh.getBoundaryFiles(ids)
    return { available: files.length > 0, files }
  }

  /**
   * Precise (per-message) code rewind: restore every agent-edited file to its
   * content as of the selected message; delete files created after it. Does NOT
   * truncate the conversation (that's the separate rewind() path). Rejects while
   * running (unsafe to restore files under an active writer).
   */
  async rewindFilesPrecise(
    id: string,
    messageIndex: number,
  ): Promise<{ success: boolean; filesChanged: string[] } | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (s.running) return { success: false, filesChanged: [] }
    const fh = s.agent?.getFileHistory?.()
    if (!s.agent || !fh) return { success: false, filesChanged: [] }
    const msgs = s.agent.getMessages()
    if (messageIndex < 0 || messageIndex >= msgs.length) return { success: false, filesChanged: [] }
    const ids = collectPostBoundaryEditIds(msgs, messageIndex)
    const filesChanged = await fh.rewindToBoundary(ids)
    return { success: true, filesChanged }
  }

  // ?? internals ?????????????????????????????????????????????????

  /**
   * T4 ? emit a structured per-worker delegation update to the subagent panel.
   * Extracted from buildCallbacks so the idle user-dispatch path (delegate())
   * can reuse the exact same mapping/elapsed logic. Extra fields beyond the
   * core status: `summary` (terminal digest for the "?????" adopt button),
   * `origin` ('user' marks a user-dispatched worker), plus the live-activity
   * passthrough (toolUseCount/tokenCount/eventKind/eventDetail) and terminal
   * `failureReason` so the desktop panel can render counters + failure labels.
   */
  private emitDelegationActivity(
    session: InternalSession,
    a: {
      workOrderId: string
      parentToolId?: string
      /** ?????? worker order id????????? */
      parentWorkerId?: string
      profile?: string
      authority?: string
      /** Why this authority was chosen (from DelegationActivity.authorityReason). */
      authorityReason?: string
      objective?: string
      status: string
      progressLine?: string
      toolUseCount?: number
      tokenCount?: number
      eventKind?: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'turn' | 'retry' | 'lifecycle'
      eventDetail?: string
      failureReason?: string
      model?: string
      provider?: string
      usage?: DelegationActivity['usage']
      artifactId?: string
      changedFiles?: string[]
      summary?: string
      origin?: 'user' | 'agent'
      contract?: DelegationActivity['contract']
      findingsCount?: number
      topFinding?: string
      verificationBrief?: DelegationActivity['verificationBrief']
      evidenceStatus?: string
    },
  ): void {
    const startedMap = session.delegationStartedAt ?? (session.delegationStartedAt = new Map())
    let started = startedMap.get(a.workOrderId)
    if (started === undefined) {
      started = this.now()
      startedMap.set(a.workOrderId, started)
    }
    this.append(session, 'delegation', {
      workerId: a.workOrderId,
      parentId: a.parentToolId,
      // ???????? worker?parentId ????? id??????????
      // ?????????????
      parentWorkerId: a.parentWorkerId,
      profile: a.profile,
      // authority ???????????? authority ???????????????
      // ???????? worker ??/????????
      authority: a.authority,
      authorityReason: a.authorityReason,
      objective: a.objective,
      status: a.status,
      phase: a.status === 'running' ? 'running' : a.status,
      progressLine: a.progressLine ? redactText(a.progressLine) : undefined,
      elapsedMs: this.now() - started,
      toolUseCount: a.toolUseCount,
      tokenCount: a.tokenCount,
      eventKind: a.eventKind,
      eventDetail: a.eventDetail ? redactText(a.eventDetail) : undefined,
      failureReason: a.failureReason,
      model: a.model,
      provider: a.provider,
      usage: a.usage,
      artifactId: a.artifactId,
      changedFiles: a.changedFiles,
      summary: a.summary ? redactText(a.summary) : undefined,
      origin: a.origin,
      // ???? + ???????Phase 1 ????? findings ? getWorkerLog pull??
      contract: a.contract,
      findingsCount: a.findingsCount,
      topFinding: a.topFinding ? redactText(a.topFinding) : undefined,
      verificationBrief: a.verificationBrief,
      evidenceStatus: a.evidenceStatus,
    })
  }

  private buildCallbacks(session: InternalSession): AgentCallbacks {
    const lifecycleGeneration = session.lifecycleGeneration
    const isActive = (): boolean => this.ownsSessionLifecycle(session, lifecycleGeneration)
    // plan ?? action=submit ? toolId ???onToolUse ?? / onToolResult ????
    // ?? slug+title?onPlanSubmitted ?? slugify ????emitPlanSubmitted ??
    // ??? slug ???????? plans[0] ????????? cwd ? plans[0]
    // ???????????????????/???2026-07-25 ????
    const planSubmitToolIds = new Map<string, { slug: string; title: string }>()
    return {
      onTextDelta: (text) => {
        if (!isActive()) return
        this.flushToolResultBuf(session)
        session.toolResultStream = undefined
        this.bufferDelta(session, 'text_delta', text)
      },
      onThinkingDelta: (thinking) => {
        if (!isActive()) return
        this.flushToolResultBuf(session)
        session.toolResultStream = undefined
        this.bufferDelta(session, 'thinking_delta', thinking)
      },
      onToolUse: (toolId, name, input) => {
        if (!isActive()) return
        this.append(session, 'tool_use', { id: toolId, name, input: redactValue(input) })
        // plan ?? action=submit ???????onToolResult ?? input?????
        // toolId ????????????"????"??? plan ?? action
        //?enter_mode/close/list??? plan_submitted?title ?????submit ?
        // slug = slugify(title)?src/tools/plan.ts ??????? emitPlanSubmitted
        // ??? slug ????? plan ???????? title ??????????
        if (name === 'plan' && (input as { action?: string } | null)?.action === 'submit') {
          const title = (input as { title?: unknown } | null)?.title
          if (typeof title === 'string' && title.trim()) {
            planSubmitToolIds.set(toolId, { slug: slugify(title), title: title.trim() })
          } else {
            planSubmitToolIds.set(toolId, { slug: '', title: '' })
          }
        }
        // N3: surface delegation as a tree node, derived from the tool stream
        // (no core-loop rewrite ? stays inside the server layer).
        if (DELEGATION_TOOLS.has(name)) {
          this.append(session, 'delegation', {
            workerId: toolId,
            objective: extractObjective(input),
            profile: typeof input.profile === 'string' ? input.profile : undefined,
            status: 'running',
          })
        }
        // T2: surface the active task list as structured state for the desktop
        // checklist (Codex-style active todo / Antigravity Task Plan).
        if (name === 'todo') {
          const items = extractTodoState(input)
          if (items) this.append(session, 'todo_state', { items })
        }
        // ????????ask_user_question ? input ????????/???
        // ? tool_use ??? user_question SSE?????????? + endTurn??
        // ????? API ?? ???????????????????
        if (name === 'ask_user_question') {
          const questions = parseAskUserQuestions(input)
          if (questions.length > 0) {
            this.append(session, 'user_question', {
              toolUseId: toolId,
              questions: questions.map(q => ({
                id: q.id,
                prompt: redactText(q.prompt),
                options: q.options.map(o => redactText(o)),
                allowMultiple: q.allowMultiple,
              })),
            })
          }
        }
      },
      onToolResult: (toolId, name, result, isError, _rawPath, uiContent) => {
        // Agent callbacks can already be queued when archive/delete closes the
        // session. Reject both stream and terminal callbacks before watchdog,
        // persistence, delegation, plan, or artifact side effects.
        if (!isActive() || session.toolResultClosed) return
        // ?????????isError === undefined ??? chunk?TUI ??????
        // ??????????????? stall??
        if (isError !== undefined) session.watchdogPolicy?.recordToolResult()
        const eventData = {
          id: toolId,
          name,
          isError: !!isError,
          result: isError === undefined
            ? redactText(result)
            : truncateUtf16Safe(redactText(result), 2000),
          // uiContent is the display override (e.g. ask_user_question renders the
          // question + numbered options here, not the model-facing placeholder).
          // Team panel frames encode rich structured data ? raise the cap to 8K
          // so multi-task wave DAGs aren't truncated before the desktop decodes them.
          ...(uiContent
            ? { uiContent: truncateUtf16Safe(redactText(uiContent), containsRegisteredFrame(uiContent) ? 8000 : 2000) }
            : {}),
        }
        if (isError === undefined) {
          this.bufferToolResult(session, toolId, name, eventData.result)
          return
        }
        this.flushToolResultBuf(session)
        session.toolResultStream = undefined
        this.append(session, 'tool_result', eventData)
        if (DELEGATION_TOOLS.has(name)) {
          this.append(session, 'delegation', {
            workerId: toolId,
            status: isError ? 'failed' : 'completed',
          })
        }
        // Plan mode ? a successful `plan action=submit` wrote a new .rivet/plans/*.md.
        // Surface it as an event so the desktop's plan column refreshes live.
        // ?2026-07-24 ????????????????? plan_submit?????
        // ???? plan?? onToolUse ??? toolId ???? submit action??
        const submittedPlan = planSubmitToolIds.get(toolId)
        planSubmitToolIds.delete(toolId)
        if (!isError && submittedPlan) {
          void this.emitPlanSubmitted(session, lifecycleGeneration, submittedPlan)
        }
        // Plan mode ? while planning, write_file/edit_file can only touch the
        // active draft (checkPlanMode gates every other path), so a successful
        // final write means the draft grew. Emit a throttled invalidation
        // signal ? this replaces the desktop's 2s draft polling as the primary
        // liveness channel (polling stays as a degraded fallback).
        if (
          isError === false
          && session.record.planMode === 'planning'
          && (name === 'write_file' || name === 'edit_file')
        ) {
          this.schedulePlanDraftEvent(session, lifecycleGeneration)
        }
        // P0-2: plan_task ????? todos ? ? todo_state ??? TodoDock ??
        if (name === 'plan_task' && isError === false) {
          const items = session.agent?.getTodos?.()
          if (items && items.length > 0) this.append(session, 'todo_state', { items })
        }
        this.scanArtifacts(session)
      },
      onTurnComplete: (usage, turnNumber, isFinal, evidenceSummary) => {
        if (!isActive()) return
        session.watchdogPolicy?.recordTurnComplete()
        this.append(session, 'turn_complete', { usage, turnNumber, isFinal: !!isFinal, ...(isFinal && evidenceSummary ? { evidence: evidenceSummary } : {}) })
      },
      onError: (err) => {
        if (!isActive()) return
        this.append(session, 'error', { error: redactText(err.message) })
      },
      onAbort: (reason) => {
        if (!isActive()) return
        session.lastAbortReason = reason
        // ? finally ? rejectAllPending ????????????
        session.abortWhileApprovalPending =
          [...session.pending.values()].some((p) => p.kind === 'approval')
        if (session.record.status === 'running') session.record.status = 'aborted'
      },
      onCheckpoint: (hash) => {
        if (!isActive()) return
        this.append(session, 'checkpoint', { hash })
      },
      onPhaseChange: (phase, detail) => {
        if (!isActive()) return
        session.record.currentPhase = phase
        this.append(session, 'phase', { phase, ...(detail ?? {}) })
      },
      // R5 ? structured course-correction ? its own event so the desktop can
      // render a "??" card inline (selective externalization of star-domain).
      onDecisionShift: (shift: DecisionShift) => {
        if (!isActive()) return
        this.append(session, 'decision_shift', {
          source: shift.source,
          domain: shift.domain,
          reason: redactText(shift.reason),
          methods: (shift.methods ?? []).map((m) => redactText(m)),
          severity: shift.severity ?? 'info',
        })
      },
      onApprovalRequired: (toolId, name, input) =>
        this.requestApproval(session, lifecycleGeneration, toolId, name, input),
      // E4 ? client landing delegation (mirrors onApprovalRequired injection).
      onToolDelegate: (kind, payload) =>
        this.requestToolDelegate(session, lifecycleGeneration, kind, payload),
      onIntentNote: (intent) => {
        if (!isActive()) return
        this.emitIntentNote(session, intent)
      },
      // T3 ? drain mid-run user guidance at the tool boundary (the agent appends
      // it to the last tool_result; see tool-execution.ts). The buffer is fed by
      // POST /sessions/:id/steer while the session is running.
      onSteerDrain: () => isActive() ? session.steer.drain() : null,
      // C3 ? ???????cruise ???paused=true???????????
      // unleashed ?????????????digest ??????
      onAutonomyCheckpoint: (info) => {
        if (!isActive()) return
        this.append(session, 'autonomy_checkpoint', {
          turns: info.turns,
          digest: info.digest,
          paused: info.paused,
        })
      },
      // T4 ? structured per-worker delegation status/progress ? subagent panel.
      // Keyed by workOrderId (distinct from the spawning tool id, which is the
      // delegation-tree parent). Emitted alongside the existing text stream.
      onDelegationActivity: (a) => {
        if (!isActive()) return
        this.emitDelegationActivity(session, a)
      },
    }
  }

  private requestApproval(
    session: InternalSession,
    lifecycleGeneration: number,
    toolId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<ApprovalResult> {
    if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) {
      return Promise.resolve({ approved: false })
    }
    // ?????auto-proceed ??????????????? ? fail-closed?
    // ?????????????????????????????????
    // ????????????????? agent ? postTool ???????
    if (session.unattended) {
      const requestId = toolId || randomId()
      const appName = typeof input.app === 'string' && input.app ? input.app : undefined
      const app = appName ? ` (app: ${appName})` : ''
      const reason = `unattended run blocked on approval: ${name}${app}`
      session.unattendedHaltReason ??= reason
      // ????????? app ?????????? ? ????????????
      if (session.unattendedHaltApp === undefined && appName) session.unattendedHaltApp = appName
      // record.error ?????/???????????????????
      session.record.error ??= reason
      // ?????????/Inbox ??? error ??????"??????"
      // ?????????Wave 4 halt ?????????
      session.record.unattendedHalt ??= { reason, ...(appName ? { app: appName } : {}) }
      this.append(session, 'approval_required', { requestId, toolName: name, input: redactValue(input) })
      this.append(session, 'approval_resolved', { requestId, decision: 'unattended_blocked' })
      this.append(session, 'unattended_halt', { requestId, toolName: name, reason })
      session.lastApprovalDeniedAt = this.now()
      this.persistRecord(session)
      // ??????? agent ?? deny ? tool_result ????????????????
      setImmediate(() => {
        if (this.ownsSessionLifecycle(session, lifecycleGeneration)) {
          this.abort(session.record.id)
        }
      })
      return Promise.resolve({ approved: false })
    }
    return new Promise<ApprovalResult>((resolve) => {
      const requestId = toolId || randomId()
      const pend: PendingIntervention = {
        requestId,
        kind: 'approval',
        resolve: resolve as (v: ApprovalResult | boolean) => void,
        toolName: name,
        toolInput: input,
      }
      if (this.approvalTimeoutMs > 0) {
        pend.timer = setTimeout(() => {
          if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) {
            session.pending.delete(requestId)
            resolve({ approved: false })
            return
          }
          if (session.pending.delete(requestId)) {
            resolve({ approved: false })
            session.lastApprovalDeniedAt = this.now()
            this.recountApprovals(session)
            this.append(session, 'approval_resolved', { requestId, decision: 'timeout' })
            this.persistRecord(session)
          }
        }, this.approvalTimeoutMs)
      }
      session.pending.set(requestId, pend)
      this.recountApprovals(session)
      const pathGrant = this.pathGrantHint(session.record.cwd, name, input)
      this.append(session, 'approval_required', {
        requestId,
        toolName: name,
        input: redactValue(input),
        ...(pathGrant ? { pathGrant } : {}),
      })
      // Persist the pendingApprovals count NOW ? if the sidecar dies while
      // blocked on this approval, rehydrate() uses the on-disk count as the
      // gate for scanning the log and closing the approval out honestly.
      this.persistRecord(session)
    })
  }

  /**
   * Goal ????????????2026-07-24?C2 watchdog ??????
   * ???????? goal ???? plan_auto_approve_pending?? deadlineMs??
   * ?????????goal ????????????????????????
   * ???????? goal ??????approval ??????????????
   * ??????????approve/reject/edit/prompt/steer/abort/?????????
   */
  private maybeArmPlanAutoApprove(session: InternalSession, slug: string): void {
    const delayMs = this.goalPlanAutoApproveMs
    if (delayMs <= 0) return
    if (!this.isGoalActive(session)) return
    // P1b fail-closed???????????? UI ???????
    if (!session.planAutoApproveUi) return
    this.cancelPlanAutoApprove(session, 'superseded')
    const deadlineMs = this.now() + delayMs
    session.planAutoApproveSlug = slug
    this.append(session, 'plan_auto_approve_pending', { slug, deadlineMs, delayMs })
    const timer = setTimeout(() => {
      session.planAutoApproveTimer = undefined
      session.planAutoApproveSlug = undefined
      if (!this.ownsSessionDurability(session)) return
      // ?????????????????? run / ?? / ?? goal?
      if (session.running || session.record.archived) return
      if (!this.isGoalActive(session)) return
      void this.approvePlan(session.record.id, slug).then((outcome) => {
        if (!outcome.ok) {
          this.append(session, 'plan_auto_approve_cancelled', { slug, reason: outcome.reason })
        }
      })
    }, delayMs)
    timer.unref?.()
    session.planAutoApproveTimer = timer
  }

  /** ??????????? slug ???????????????? cancel?? */
  private cancelPlanAutoApprove(session: InternalSession, reason: string): void {
    const slug = session.planAutoApproveSlug
    if (session.planAutoApproveTimer) clearTimeout(session.planAutoApproveTimer)
    session.planAutoApproveTimer = undefined
    session.planAutoApproveSlug = undefined
    if (slug) this.append(session, 'plan_auto_approve_cancelled', { slug, reason })
  }

  /** ????????????????????????????????????? */
  cancelPlanAutoApproveForUser(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    this.cancelPlanAutoApprove(session, 'user')
    return true
  }

  private isGoalActive(session: InternalSession): boolean {
    const tracker = this.resolveGoalHandles?.(session.record.id)?.goalTrackerRef.current
      ?? session.agent?.getGoalTracker?.()
      ?? null
    return tracker?.isActive() === true
  }

  /**
   * Watchdog stall ?????????? TUI v3??run settle ???????
   * 'continue'???? setImmediate ??????????? HTTP ???run/archive?
   * ???????????? aborted ??????TUI??????????????
   *
   * C2 ???????????????????? pendingAutoContinue+delayMs ?
   * watchdog_recovery ???????????????????????????
   * ????? abort?? watchdogRecoveryCancelled???? prompt?run() ?
   * ???????????Loop ???????????
   */
  private maybeWatchdogAutoContinue(session: InternalSession): void {
    const reason = session.lastAbortReason
    if (!reason?.startsWith('watchdog')) return
    const policy = session.watchdogPolicy
    if (!policy) return
    const suppressed = session.abortWhileApprovalPending === true
      || (session.lastApprovalDeniedAt != null
          && this.now() - session.lastApprovalDeniedAt < WATCHDOG_APPROVAL_GRACE_MS)
    setImmediate(() => {
      if (!this.ownsSessionDurability(session)) return
      // ?????????????running???????? aborted??????
      // ???????? abort ? ? ?????
      if (session.running || session.record.status !== 'aborted' || session.record.archived) return
      if (session.watchdogRecoveryCancelled) return
      const decision = policy.onStall({ suppressed })
      const delayMs = this.watchdogContinueDelayMs
      this.append(session, 'watchdog_recovery', {
        reason,
        autoContinue: decision.autoContinue,
        ...(decision.stopReason ? { stopReason: decision.stopReason } : {}),
        ...(decision.autoContinue ? { dense: decision.dense === true, pendingAutoContinue: true, delayMs } : {}),
        ...policy.snapshot(),
      })
      if (!decision.autoContinue) return
      const timer = setTimeout(() => {
        session.watchdogContinueTimer = undefined
        if (!this.ownsSessionDurability(session)) return
        // ???????????????????? abort / ??? prompt / ???
        if (session.running || session.record.status !== 'aborted' || session.record.archived) return
        if (session.watchdogRecoveryCancelled) return
        session.watchdogAutoResubmit = true
        if (!this.run(session.record.id, 'continue')) session.watchdogAutoResubmit = false
      }, delayMs)
      timer.unref?.()
      session.watchdogContinueTimer = timer
    })
  }

  /**
   * Non-blocking direction note: append a passive timeline event and return.
   * The agent never waits ? there is no pending Promise/timer. The user steers
   * by typing (POST /sessions/:id/steer) if they want to change direction.
   */
  private emitIntentNote(session: InternalSession, intent: IntentPreview): void {
    const copy = describeIntentNote(intent)
    this.append(session, 'intent_note', {
      summary: intent.summary,
      confidence: intent.confidence,
      warnings: intent.warnings ?? [],
      title: copy.title,
      reasons: copy.reasons,
      action: copy.action,
      steerHint: copy.steerHint,
    })
  }

  private rejectAllPending(session: InternalSession, reason: string): void {
    if (session.pending.size > 0) session.lastApprovalDeniedAt = this.now()
    for (const [requestId, pend] of session.pending) {
      if (pend.timer) clearTimeout(pend.timer)
      pend.resolve({ approved: false })
      this.append(session, 'approval_resolved', { requestId, decision: reason })
    }
    session.pending.clear()
    this.recountApprovals(session)
  }

  private recountApprovals(session: InternalSession): void {
    let count = 0
    for (const p of session.pending.values()) if (p.kind === 'approval') count++
    session.record.pendingApprovals = count
  }

  /**
   * After a plan_submit tool result, emit a `plan_submitted` event for the plan
   * that was JUST submitted. The slug comes from the onToolUse registration
   * (slugify(title), same derivation as the submit tool) ? never `plans[0]`:
   * with several sessions sharing one cwd, the newest plan on disk may belong
   * to another session (or be an older APPROVED one), which used to send the
   * wrong card or no card at all (desktop clears non-submitted cards), leaving
   * the model waiting on an approval the user never sees. The known slug is
   * verified against disk (status/title authoritative); plans[0] stays only as
   * a fallback when registration had no usable title. Async/best-effort: the
   * tool already persisted the file, so a read failure here only delays the
   * live refresh, not the data.
   */
  private async emitPlanSubmitted(
    session: InternalSession,
    lifecycleGeneration: number,
    known?: { slug: string; title: string },
  ): Promise<void> {
    if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
    try {
      const plans = await this.loadPlans(session.record.cwd)
      if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
      const knownHit = known?.slug ? plans.find((p) => p.slug === known.slug) : undefined
      if (known?.slug && !knownHit) {
        // ??? slug ????????????????????????????
        // ?????????? submitted??????????
        this.append(session, 'plan_submitted', { slug: known.slug, title: known.title, status: 'submitted' })
        this.maybeArmPlanAutoApprove(session, known.slug)
        return
      }
      const target = knownHit ?? plans[0]
      if (target) {
        this.append(session, 'plan_submitted', {
          slug: target.slug,
          title: target.title,
          status: target.status,
        })
        // goal ?????????????? goal ????????
        if (target.status === 'submitted') this.maybeArmPlanAutoApprove(session, target.slug)
      }
    } catch {
      // non-fatal ? the desktop can still poll GET /plans
    }
  }

  /**
   * Throttled `plan_draft` scheduler. Leading edge fires immediately; writes
   * inside the window arm ONE trailing timer so the final write of a burst
   * always lands an event (a plain leading-edge throttle would leave the
   * desktop stale until its fallback poll).
   */
  private schedulePlanDraftEvent(session: InternalSession, lifecycleGeneration: number): void {
    if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
    if (
      session.planDraftTimer !== undefined
      && session.planDraftTimerGeneration !== lifecycleGeneration
    ) {
      this.cancelPlanDraftTimer(session)
    }
    const now = this.now()
    const elapsed = now - (session.planDraftLastEmit ?? 0)
    if (elapsed >= PLAN_DRAFT_THROTTLE_MS) {
      session.planDraftLastEmit = now
      void this.emitPlanDraft(session, lifecycleGeneration)
      return
    }
    if (session.planDraftTimer !== undefined) return
    const timer = this.planEventScheduler.setTimeout(() => {
      if (session.planDraftTimer !== timer) return
      if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
      session.planDraftTimer = undefined
      session.planDraftTimerGeneration = undefined
      session.planDraftLastEmit = this.now()
      void this.emitPlanDraft(session, lifecycleGeneration)
    }, PLAN_DRAFT_THROTTLE_MS - elapsed)
    session.planDraftTimer = timer
    session.planDraftTimerGeneration = lifecycleGeneration
    const unrefTimer = timer as { unref?: () => void }
    unrefTimer?.unref?.()
  }

  /**
   * Emit the `plan_draft` signal. Persistence / in-memory ring store metadata
   * only (path/title/size) so events.jsonl stays small. Connected SSE listeners
   * receive the same seq with `content` attached when the draft is under
   * PLAN_DRAFT_LIVE_CONTENT_MAX ? desktop PlanPanel can paint without GET.
   */
  private async emitPlanDraft(session: InternalSession, lifecycleGeneration: number): Promise<void> {
    if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
    if (session.record.planMode !== 'planning') return
    try {
      const draft = await this.readPlanDraft(session.record.id)
      if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
      if (!draft) return
      const meta: Record<string, unknown> = {
        path: draft.path,
        title: draft.title,
        size: draft.content.length,
      }
      const live: Record<string, unknown> =
        draft.content.length <= PLAN_DRAFT_LIVE_CONTENT_MAX
          ? { ...meta, content: draft.content }
          : meta
      this.append(session, 'plan_draft', live, { persistData: meta })
    } catch {
      // non-fatal ? the desktop's fallback poll still refreshes the draft
    }
  }

  private scanArtifacts(session: InternalSession): void {
    if (!session.agent) return
    let list: Artifact[]
    try {
      list = session.agent.listArtifacts()
    } catch {
      return
    }
    for (const art of list) {
      if (session.knownArtifacts.has(art.id)) continue
      session.knownArtifacts.add(art.id)
      this.append(session, 'artifact', {
        id: art.id,
        tool: art.tool,
        target: art.target,
        summary: art.summary,
        charCount: art.charCount,
        lineCount: art.lineCount,
      })
    }
  }

  /**
   * Delta ???Wave 2??provider ? token ?? ? ?????????????
   * ?? delta??? run ?? / ? delta ??????????? token ???
   * ???? 40ms / 2KB ????????text?thinking?? flush ???
   * ?????????????? seq??????? + fan-out ??????????
   */
  private bufferDelta(session: InternalSession, type: 'text_delta' | 'thinking_delta', text: string): void {
    if (!text || !this.ownsSessionDurability(session)) return
    if (session.deltaBuf && session.deltaBuf.type !== type) {
      this.flushDeltaBuf(session)
      session.deltaRunActive = false
    }
    if (!session.deltaRunActive) {
      session.deltaRunActive = true
      this.appendRaw(session, type, { text })
      return
    }
    if (session.deltaBuf) session.deltaBuf.text += text
    else session.deltaBuf = { type, text }
    if (session.deltaBuf.text.length >= DELTA_COALESCE_MAX_CHARS) {
      this.flushDeltaBuf(session)
      return
    }
    if (!session.deltaTimer) {
      session.deltaTimer = setTimeout(() => {
        session.deltaTimer = undefined
        this.flushDeltaBuf(session)
      }, DELTA_COALESCE_MS)
      session.deltaTimer.unref?.()
    }
  }

  /** ???? delta ?????????????? no-op? */
  private flushDeltaBuf(session: InternalSession): void {
    if (session.deltaTimer) {
      clearTimeout(session.deltaTimer)
      session.deltaTimer = undefined
    }
    const buf = session.deltaBuf
    if (!buf) return
    session.deltaBuf = undefined
    this.appendRaw(session, buf.type, { text: buf.text })
  }

  /**
   * Coalesce contiguous streaming tool_result callbacks. A tool-id switch is an
   * ordering boundary: flush the prior tool before exposing the new one.
   */
  private bufferToolResult(session: InternalSession, id: string, name: string, result: string): void {
    if (!result || session.toolResultClosed) return
    this.flushDeltaBuf(session)
    session.deltaRunActive = false
    const current = session.toolResultStream
    if (current && (current.id !== id || current.name !== name)) {
      this.flushToolResultBuf(session)
      session.toolResultStream = undefined
    }
    const stream = session.toolResultStream ?? (session.toolResultStream = {
      id,
      name,
      buffered: '',
      active: false,
    })
    if (!stream.active) {
      stream.active = true
      const first = takeUtf8Prefix(result, TOOL_RESULT_COALESCE_BYTES)
      // partial: true ?????? chunk?????? result??SSE ? isError
      // ?????????????????????? chunk ???????
      //?delegate_batch ??????????????? append ??????
      this.appendRaw(session, 'tool_result', { id, name, isError: false, partial: true, result: first.head })
      stream.buffered = first.tail
    } else {
      stream.buffered += result
    }
    while (Buffer.byteLength(stream.buffered) >= TOOL_RESULT_COALESCE_BYTES) {
      const chunk = takeUtf8Prefix(stream.buffered, TOOL_RESULT_COALESCE_BYTES)
      stream.buffered = chunk.tail
      this.appendRaw(session, 'tool_result', {
        id: stream.id,
        name: stream.name,
        isError: false,
        partial: true,
        result: chunk.head,
      })
    }
    if (stream.buffered && session.toolResultTimer === undefined) {
      const sessionId = session.record.id
      session.toolResultTimer = this.toolResultScheduler.setTimeout(() => {
        session.toolResultTimer = undefined
        if (session.toolResultClosed || this.sessions.get(sessionId) !== session) {
          session.toolResultStream = undefined
          return
        }
        this.flushToolResultBuf(session)
      }, TOOL_RESULT_COALESCE_MS)
      const timer = session.toolResultTimer as { unref?: () => void }
      timer?.unref?.()
    }
  }

  private flushToolResultBuf(session: InternalSession): void {
    if (session.toolResultTimer !== undefined) {
      this.toolResultScheduler.clearTimeout(session.toolResultTimer)
      session.toolResultTimer = undefined
    }
    const stream = session.toolResultStream
    if (!stream?.buffered) return
    const result = stream.buffered
    stream.buffered = ''
    this.appendRaw(session, 'tool_result', {
      id: stream.id,
      name: stream.name,
      isError: false,
      partial: true,
      result,
    })
  }

  private cancelToolResultBuf(session: InternalSession): void {
    if (session.toolResultTimer !== undefined) {
      this.toolResultScheduler.clearTimeout(session.toolResultTimer)
      session.toolResultTimer = undefined
    }
    session.toolResultStream = undefined
  }

  /**
   * ???????? delta ????? delta ???????????????
   * abort??? append status?L abort()??turn ??????????????
   * ???????????????
   *
   * `opts.persistData` ? when set, the in-memory ring + events.jsonl store this
   * payload while SSE listeners receive `data` (e.g. plan_draft live content).
   */
  private append(
    session: InternalSession,
    type: SessionEventType,
    data: Record<string, unknown>,
    opts?: { persistData?: Record<string, unknown> },
  ): void {
    if (!this.ownsSessionDurability(session)) return
    if (type !== 'tool_result') {
      this.flushToolResultBuf(session)
      session.toolResultStream = undefined
    }
    if (type !== 'text_delta' && type !== 'thinking_delta') {
      this.flushDeltaBuf(session)
      session.deltaRunActive = false
    }
    this.appendRaw(session, type, data, opts)
  }

  private appendRaw(
    session: InternalSession,
    type: SessionEventType,
    liveData: Record<string, unknown>,
    opts?: { persistData?: Record<string, unknown> },
  ): void {
    if (!this.ownsSessionDurability(session)) return
    const persistData = opts?.persistData ?? liveData
    const stored: SessionEvent = { seq: ++session.seq, ts: this.now(), type, data: persistData }
    session.events.push(stored)
    if (session.events.length > this.maxEvents) {
      session.events.splice(0, session.events.length - this.maxEvents)
    }
    session.record.lastSeq = session.seq
    session.record.updatedAt = stored.ts
    if (this.persistence) {
      try {
        this.persistence.appendEvent(session.record.id, stored)
      } catch {
        // persistence failure must not break the live event log
      }
    }
    const forListeners: SessionEvent =
      persistData === liveData ? stored : { ...stored, data: liveData }
    for (const listener of session.listeners) {
      try {
        listener(forListeners)
      } catch {
        // a misbehaving viewer must not break the event log
      }
    }
  }

  private persistRecord(session: InternalSession): void {
    if (!this.persistence || !this.ownsSessionDurability(session)) return
    try {
      this.persistence.saveRecord({ ...session.record })
    } catch {
      // non-fatal ? events.jsonl is the source of truth for replay
    }
  }

  /**
   * Decode user-attached image data URLs and persist each as a file, returning
   * the generated ids. Best-effort: a malformed URL or persistence gap is
   * skipped (the model still gets the inline image; only its thumbnail is lost).
   */
  private persistImages(sessionId: string, images?: string[]): string[] {
    if (!images?.length || !this.persistence?.saveImage) return []
    const ids: string[] = []
    for (const url of images) {
      const parsed = parseImageDataUrl(url)
      if (!parsed) continue
      const imgId = randomId()
      try {
        this.persistence.saveImage(sessionId, imgId, parsed.base64, parsed.mime)
        ids.push(imgId)
      } catch {
        // non-fatal ? skip this thumbnail, keep the rest
      }
    }
    return ids
  }

  /** Read a persisted user image (for the GET image route). */
  readImage(sessionId: string, imgId: string): { bytes: Buffer; mime: string } | undefined {
    return this.persistence?.readImage?.(sessionId, imgId)
  }

  private touch(session: InternalSession): void {
    session.record.updatedAt = this.now()
  }
}

function randomId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  )
}

/** Parse a `data:image/<mime>;base64,<payload>` URL. Returns null if malformed. */
function parseImageDataUrl(url: string): { mime: string; base64: string } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url)
  if (!m) return null
  return { mime: m[1]!.toLowerCase(), base64: m[2]! }
}

/**
 * Resolve a star-domain selection KEY into the live tri-state + canonical key +
 * display label. Mirrors AgentLoop.getSessionDomain semantics:
 *  - 'auto' ? state undefined (per-message auto-detect)
 *  - 'off'  ? legacy alias, resolves to auto (state undefined)
 *  - <id>   ? the ActiveStarDomain, when the id is a known domain
 * Returns null for an unknown key so callers can 400/return false.
 */
function resolveDomainState(
  key: string,
): { state: ActiveStarDomain | null | undefined; key: string; label: string } | null {
  if (key === 'auto') return { state: undefined, key: 'auto', label: 'Auto' }
  // Legacy: the 'off' selection was removed. Old persisted sessions with
  // domain:'off' resolve to Auto instead of breaking (state undefined, not null).
  if (key === 'off') return { state: undefined, key: 'auto', label: 'Auto' }
  const d = starDomainRegistry.get(key)
  if (!d) return null
  return {
    state: { id: d.id as StarDomainId, name: d.name, volatileBlock: d.volatileBlock, motto: d.motto, courageThreshold: d.courageThreshold },
    key: d.id,
    label: d.name,
  }
}

function resolveDomainPersona(key: string | undefined): { glyph: string; accent: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'dim' } {
  // 'off' removed; treat legacy value as Auto for persona rendering.
  if (key === 'auto' || key === 'off' || key === undefined) return { glyph: '?', accent: 'primary' }
  const d = starDomainRegistry.get(key)
  if (!d) return { glyph: '?', accent: 'primary' }
  return { glyph: d.uiPersona.glyph, accent: d.uiPersona.accent }
}
