import type { ToolHistoryEntry } from '../prompt/volatile.js'
import type { KnowledgeCandidate } from '../memory/essence-gate.js'
import { ControlPlaneController } from './control-plane-adapters.js'
import { SessionContext } from './context.js'
import { SessionPersist, getSessionDir, shouldAutoWriteHandoff } from './session-persist.js'
import { attachSessionPersistListener } from './session-persist-listener.js'
import { PrewarmCache } from './prewarm.js'
import { invalidateSessionReadDedup } from '../tools/read-file.js'
import { getTodos, getTodoRegressionStats } from '../tools/todo.js'
import { resolveDecisionsArm } from './decisions-experiment.js'
import { gateToolDefinitions, isExtendedTool } from './tool-tiers.js'
import { applyDescriptionMode } from '../tools/description-compact.js'
import { resolvePromptBlocks } from '../prompt/block-policy.js'
import { buildBudgetReport } from '../prompt/prefix-budget.js'
import type { CompactCircuitBreakerState, ContextAnchor } from '../context/types.js'
import type { ToolErrorClass } from '../tools/types.js'
import type { FailureClass } from './failure-classifier.js'
import { EvidenceTracker } from './evidence.js'
import { ObligationTracker } from './obligation-tracker.js'
import { decideAcceptanceOutcome } from './evidence-obligation.js'
import { computeVerifyFailStreak, createCvmVectorEvaluator, cvmVectorMode, type CvmVectorMode } from './hooks/cognitive-capsule-router.js'
import { ProblemAttackStore } from './problem-attack-loop.js'
import { TurnHarness } from './turn-harness.js'
import { TrajectoryRecorder } from './trajectory.js'
import { createTraceStore, type TraceStore } from './trace-store.js'
import { getDoomLoopLevel, getClassDoomLoopLevel, combineDoomLoopLevels, getDoomLoopThresholds } from './trace-store.js'
import { classifyActivityMode, computeFlowBeacon, evaluateConvergence, FLOW_MIN_SAMPLES, PRODUCTIVE_TOOLS } from './convergence-detector.js'
import { isInProductionFlow } from './production-flow.js'
import type { PhaseClass, ConvergenceResult } from './convergence-detector.js'
import { computeStructureFlowControl } from './structure-flow-controller.js'
import type { StructureFlowSnapshot } from './structure-flow-controller.js'
import { assembleCognitiveFrame, projectStructureFlowInputs } from './cognitive-frame.js'
import type { CognitiveFrame } from './cognitive-frame.js'
import { buildCognitiveFrameRecord, buildCognitiveFrameLiteRecord } from './cognitive-frame-replay.js'
import { createFrameRecorder } from './frame-telemetry.js'
import type { FrameRecorder } from './frame-telemetry.js'
import { emitStopReason, stopReasonAbortTag, type StopReason } from './stop-reason.js'
import type { PlanExecutionTrace, StepResult } from './plan-execution-trace.js'
import { buildGateConvergenceHint } from './delivery-gate-v2.js'
import { RoutingMetricsCollector } from '../model/routing-metrics.js'
import type { ImportGraph } from './import-graph.js'
import type { PlanModeState } from './plan-mode.js'
import { createActivePlanDraftPath } from './plan-mode.js'
import type { AskModeState } from './ask-mode.js'
import { WRITING_PLANS_SKILL } from './plan-delegation.js'
import { RepairPipeline } from './repair-pipeline.js'
import { fourHorsemenPass, semanticRepairPass } from './repair-passes.js'
import { ctclSanitizerPass } from './ctcl-sanitizer.js'
import { RepairHintTracker } from './repair-hint.js'
import { TurnCompletionController } from './turn-completion.js'
import { ToolExecutionController } from './tool-execution.js'
import { createPredictionAccumulator } from './prediction-error.js'
import type { PredictionAccumulator, EFEComponents } from './prediction-error.js'
import type { Sensorium } from './sensorium.js'
import type { StrategyProfile } from './sensorium.js'
import { createThetaState } from './star-event.js'
import type { ThetaState } from './star-event.js'
import { RuntimeHookPipeline, createRuntimeHookContext, type RuntimeHookSnapshot } from './runtime-hooks.js'
import { TurnPerceptionController } from './turn-perception.js'
import { TurnIntentController } from './turn-intent.js'
import { ContextInjectionController } from './context-injection.js'
import { CompactionController } from './compaction-controller.js'
import { buildActiveDomain, type ActiveStarDomain, type StarDomainId } from './star-domain.js'
import { starDomainRegistry } from './star-domain-registry.js'
import { buildDomainKnowledgeBlock } from './domain-knowledge-block.js'
import { mintNumericId, buildAgentMark, VOID_SYMBOL } from './void-identity.js'
import { buildDepartureMilestone } from '../constellation/milestone.js'
import { appendMilestone } from '../constellation/store.js'
import { ArtifactStore } from '../artifact/store.js'
import { SessionJobs } from '../tools/job-store.js'
import { MonitorRegistry } from './monitor-registry.js'
import { COMPACT_HISTORY_TOOL } from '../compact/recall-marker.js'
import { createWriteEvidenceProbe } from '../context/write-evidence-probe.js'
import { compactPolicyRatios } from '../compact/constants.js'
import { SessionStateManager } from './session-state.js'
import { isStarSoulEnabled } from './star-soul-gate.js'
import { debugLog } from '../utils/debug.js'
import { renderRouteAnnotation, STALL_ROUTE_TABLE } from './failure-taxonomy.js'
import { TurnStreamController } from './turn-stream.js'
import { type CognitiveSeason } from './cognitive-season.js'
import { createVigorState } from './vigor.js'
import type { VigorState } from './vigor.js'
import { createTelemetryWriter } from './telemetry-writer.js'
import type { TelemetryWriter } from './telemetry-writer.js'
import { PressureMonitor } from '../context/pressure-monitor.js'
import { createFsWatcher } from '../context/fs-watcher.js'
import type { FsWatcherState } from '../context/fs-watcher.js'
import { type CognitivePhaseSnapshot } from '../context/cognitive-ledger.js'
import { buildRuntimeSelfModel } from './runtime-self-model.js'
import { CacheAdvisor } from '../cache/advisor.js'
import type { RecallMetricsSummary } from '../cache/recall-metrics.js'
import { createSycophancyTrap, type SycophancyTrap } from './sycophancy-trap.js'
import { createP3Integration, P3Integration } from './p3-integration.js'
import { ImmuneHook } from './immune-hook.js'
import { AdvisoryBus, DISCIPLINE_REANCHOR_INTERVAL, HOLDOUT_MIN_DELIVERED, parseHoldoutRate, disciplineReanchorEntry } from './advisory-bus.js'
import { AdvisoryReadback, type EfficacyPriorCounts } from './advisory-readback.js'
import { applyDomainAdvisoryTone } from './domain-advisory-tone.js'
import { createDestructiveGateState } from '../tools/destructive-gate.js'
import { AdvisoryEfficacyStore, type EfficacyDelta } from '../context/advisory-efficacy-store.js'
import { PhysarumEngine } from '../repo/physarum-engine.js'
import { getPhysarumShadowStatsFromDb } from '../repo/physarum-shadow-stats.js'
import type { PhysarumShadowStats } from '../repo/physarum-shadow-stats.js'
import { createTurnBudget, type TurnBudget } from './turn-budget.js'
import { classifyRecoveryTrigger, type RecoveryTrigger } from './recovery-trigger.js'
import { modeForRecoveryTrigger, type ReliabilityDecision } from './reliability-mode.js'
import { ResourceSensor, type ResourceSensorSnapshot } from './resource-sensor.js'
import { type PlanMethodology, type TaskContract, type TaskDepthLayer } from '../context/task-contract.js'
import { StigmergyStore } from '../context/stigmergy.js'
import { describeImages, visionCacheKey } from './vision-service.js'
import { ImageRegistry } from './image-registry.js'
import { createStanceTally } from './stance-tally.js'
import { createVirtuePendingLedger, type VirtuePendingLedger, computeVirtueCredit } from './virtue-signals.js'
import { createFailureJournal, type FailureJournal } from './failure-journal.js'
import type { Pheromone } from '../context/stigmergy.js'
import type { PrefixFingerprint } from '../prompt/fingerprint.js'
import type { SensoriumEntry } from './retrospect.js'
import { join, dirname } from 'node:path'
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { extractRegressionInventory } from './regression-inventory.js'
import { extractPlanConstraints, renderPlanConstraints } from './plan-constraints.js'
import type { ApprovalMode, AgentConfig, AgentCallbacks } from './loop-types.js'
import type { PermissionAllowRule, PermissionOverlay } from './permissions.js'
import { createPermissionOverlay } from './permissions.js'
import { recordToolHistory } from "./tool-history-recorder.js";
import { requestThetaCheck } from "./theta-controller.js";
import { createTurnStreamController, createTurnCompletionController, createToolExecutionController, createPlanTraceCoordinator, createCompactBoundaryCoordinator, createTurnOrchestrator, createTurnStepProducer, createReasoningEffortController, createIntentRetrievalRouteController, createAntiAnchoringController, createModelRoutingShadowController, createPrewarmController, createRuntimeHooksPipeline, buildRuntimeSnapshot, createSidePathUsageRecorder, createReclaimDecisionRecorder } from "./loop-factory.js";
import type { TurnStepProducer } from './turn-step-producer.js'
import { ReasoningEffortController } from './reasoning-effort-controller.js'
import { IntentRetrievalRouteController } from './intent-retrieval-route-controller.js'
import { AntiAnchoringController } from './anti-anchoring-controller.js'
import { ModelRoutingShadowController } from './model-routing-shadow-controller.js'
import { PrewarmController } from './prewarm-controller.js'
import { loadSessionMemories } from './session-memory-warmup.js'
import type { PlanTraceCoordinator } from "./plan-trace-coordinator.js";
import type { CompactBoundaryCoordinator } from "./compact-boundary-coordinator.js";
import type { TurnOrchestrator } from "./turn-orchestrator.js";
import { type EffortShadowRecord } from './p3-reward.js'
import { TurnCacheObservability } from './cache-log-observability.js'

export type { ApprovalMode, AgentConfig, AgentCallbacks }

/**
 * Build the tiny approved-plan pointer block injected into the dynamic appendix.
 * Carries only slug/title/path ? NOT the plan body, which stays the single
 * source of truth on disk at `.rivet/plans/<slug>.md`. The agent reads it on
 * demand and tracks steps via the existing todo mechanism.
 */
export function formatActivePlanPointer(plan: { slug: string; title: string; selectedApproach?: string }): string {
  const esc = (s: string) =>
    s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const slug = esc(plan.slug)
  const title = esc(plan.title)
  const approach = plan.selectedApproach
    ? `????: ${esc(plan.selectedApproach)}?????????????????? `
    : ''
  return `<active-plan slug="${slug}" title="${title}" path=".rivet/plans/${slug}.md">${approach}???,????????????????,???? read_file ??;????? todo ??????????,??? plan_close?</active-plan>`
}



/** Debounce before an idle compaction pass fires after a turn settles.
 *  60s????????????????? 20?60s ????? debounce ????
 *  ???? abort ???? LLM ?????????? tokens?????????
 *  60s ????????????? RIVET_IDLE_COMPACTION_MS ??? */
const IDLE_COMPACTION_DELAY_MS = 60_000

export class AgentLoop {
    session!: SessionContext;
    config!: AgentConfig;
  /** Agent ??????shutdown ?? handoff ??????????????
   *  ?/handoff ???????? mtime ??? ? ?????????? */
  readonly createdAtMs = Date.now()
  abortController: AbortController | null = null
  /** Turn heartbeat watchdog reference (set in initializeRun, cleared on stop). */
  _turnHeartbeat: import('./turn-heartbeat.js').TurnHeartbeat | null = null
  /** True when the current abort was triggered by the hard-stall watchdog
   *  (not user Esc/Ctrl+C). Read by the UI to render a distinct message. */
  _watchdogAborted = false
  /** Count of user interrupts within the current turn (?#5). */
  _turnInterruptCount = 0
  /**
   * Pending-abort latch: set by abort() so an interrupt fired during the
   * init/warmup window (before the turn loop) is honored rather than lost.
   * Reset at the start of each run().
   */
  _pendingAbort = false
  cwd: string
  evidence: EvidenceTracker
  /** ????????evidence-driven reasoning loop???? evidence ???? */
  obligations: ObligationTracker
  /** ????? Phase 2?external-claim tracker getter?hook ??????
   *  hook ?????? undefined ? deliver ?? fail-open?? */
  externalClaimTracker?: () => import('./hooks/external-claim-tracking-hook.js').ClaimTracker
  /** Obligation final gate ???auto-continue ??/???/???????postSession ? meta?? */
  obligationGateStats = { continued: 0, misfires: 0, honestBlocked: 0, suppressed: 0 }
  compactFailures: CompactCircuitBreakerState = { consecutiveFailures: 0 }
  recentToolHistory: ToolHistoryEntry[] = []
  /** Component C (typecheck-reminder): a .ts/.tsx file was written this session. */
  touchedTsFiles = false
  /** Component C: a real typecheck (tsc/typecheck) has run since the last TS edit.
   *  A new TS edit resets this to false so the reminder re-arms. */
  sawTypecheckThisTask = false
  /** W5 (render-verify): a UI file was written this session. */
  touchedUiFiles = false
  /** W5 (render-verify): a visual verification tool was used this session. */
  sawVisualVerify = false
  prewarm = new PrewarmCache(60_000, 50)
  private _running = false
  /** Idle compaction: after a run settles, a debounced timer fires a turn-0
   *  compaction pass so the NEXT user turn doesn't eat a synchronous full
   *  compaction. Gated on real pressure / pending deferred work, cancelled the
   *  moment a new run() starts. */
  private _idleTimer: ReturnType<typeof setTimeout> | null = null
  private _idleCompacting = false
  private _idleAbort: AbortController | null = null
  private _idleSettled: Promise<void> | null = null
  /** P0-1 persist drain: awaits pending async writes so tool results survive abort. */
  private _persistDrain: (() => Promise<void>) | null = null
  private physarumForWarmup?: PhysarumEngine
  private meridianDbForWarmup?: import('../repo/meridian-db.js').MeridianDb
  private memoriesWarmed = false
  streamedText = ''
  thinkingOnlyRetries = 0
  lastThinkingContent = ''
  consecutiveNoToolTurns = 0
  wedgeToolFingerprint = ''
  wedgeRepeatCount = 0
  lastTurnTextFingerprint = ''
  lastTurnThinkingFingerprint = ''
  lastPrewarmAt = 0
  private lastCacheDiagnostic: string | null = null
  latestRisk: import('./approval-risk.js').RiskAssessment = { level: 'none', reasons: [], suggestedAction: 'No additional approval required.' }
  /** Latest per-turn free-energy signals ? consumed by coordinator EFE worker routing. */
  latestPolicySignals?: { efe: EFEComponents; sensorium: Sensorium }
  planModeState: PlanModeState = 'off'
  /** Relative path to the active plan file (draft or revision target). Writable in plan mode. */
  activePlanFilePath: string | null = null
  /** Ask Mode ? pure read-only Q&A; mutually exclusive with planModeState. */
  askModeState: AskModeState = 'off'
  /** ?? plan mode ??? one-shot ???????? contract id?????????????? */
  planModeSuggestedContracts = new Set<string>()
  /** ????????? one-shot ??????? contract id????????
   *  ?? `next=user_acceptance` ??????advisory ???????????? */
  readonly acceptanceAdvisedContracts = new Set<string>()
  /** W3?A ???? advisory ??????? key?collab:align:<contractId>???
   *  ?????????????????????? */
  collabAlignFiredContracts = new Set<string>()
  /** Plan mode ?????? ? server ?????? plan_mode SSE???? Plan tab??
   *  ?????? enter_mode ????session-manager ?????????????
   *  ?????????????????agent ????????? */
  onPlanModeChange?: (state: PlanModeState) => void
  /** Ask mode ?????? ? server ?????? ask_mode SSE? */
  onAskModeChange?: (state: AskModeState) => void
  /** TUI ???????????????????????? /plan-approve?? */
  onPlanApprovalRequested?: (info: import('../tools/types.js').PlanSubmittedInfo) => void
  /** TUI ???agent ???????????????????????????? */
  onAskUserQuestionRequested?: (info: import('../tools/types.js').AskUserQuestionInfo) => void
  decisions: string[] = []
  trajectory = new TrajectoryRecorder()
  failureJournal: FailureJournal = createFailureJournal()
  repairPipeline = new RepairPipeline([ctclSanitizerPass, fourHorsemenPass, semanticRepairPass])
  repairHintTracker = new RepairHintTracker()
  traceStore: TraceStore
  harness: TurnHarness
  routingMetrics = new RoutingMetricsCollector()
  importGraph: ImportGraph | null = null
  lastConflictCheckCount = 0
  predictionAccumulator: PredictionAccumulator = createPredictionAccumulator()
  sessionDomain: ActiveStarDomain | null | undefined
  /** Agent's self-chosen departure mark (leave_mark tool); sealed by the
   *  constellation post-session hook. Null until the agent leaves a mark. */
  pendingLeaveMark: import('../tools/types.js').LeaveMarkInput | null = null
  /** Ephemeral per-session numeric id, minted on first run. Used in welcome
   *  display and passed to buildAgentMark when the agent departs. */
  _sessionNumericId: number | null = null

  /** The session's ephemeral numeric identity (e.g. 7281). Minted lazily. */
  get sessionNumericId(): number {
    if (this._sessionNumericId === null) {
      this._sessionNumericId = mintNumericId()
    }
    return this._sessionNumericId
  }
  /** U6: most recent convergence-detector result ? consumed by the replan loop's
   *  detectDeviation (blocked/stalled signals). Null until first convergence check. */
  latestConvergenceResult: ConvergenceResult | null = null
  /** P2 ?????? turn ? structure-flow ?????EFE ?????
   *  runConvergenceCheck ???EFE ?? = null ? ???????????
   *  ?????? convergence ??? / plan advisory / tdd ????? */
  latestStructureFlow: StructureFlowSnapshot | null = null
  /** P3 ????? turn ??????????? runConvergenceCheck ????
   *  ?????EFE ???? quality ????? null??structure-flow ??
   *  ??????????????Wave 3 ?????????????? */
  latestCognitiveFrame: CognitiveFrame | null = null
  /** P2 plan advisory ????session ? one-shot??????? plan
   *  ?????enter/exit????????????????? */
  readonly structureFlowPlanAdvisoryKeys = new Set<string>()
  /** Most recent structured stop-reason (why the last turn loop ended). */
  latestStopReason: StopReason | null = null
  /** Fix 1 ? convergence emission cooldown with backoff. The L2 side-effects
   *  (?? card via onDecisionShift, convergence-warning phase change, and the
   *  advisory nudge) are throttled so a persistent stuck-state does NOT re-emit
   *  the same "??" card every single turn.
   *
   *  Backoff (incident 9266c3a7): the old fixed 3-turn cooldown re-emitted the
   *  same advisory ~50 times in a 154-turn session. Now the cooldown for the
   *  SAME message variant doubles each consecutive emission (3?6?12?24?),
   *  resetting to base when the variant changes, level escalates, or the agent
   *  produces a productive tool (edit/bash/test) since the last emit.
   *
   *  Re-emit only when the cooldown elapses, the level escalates, or the message
   *  type changes. Mirrors the cooldown discipline in kick-hook.ts. */
  private readonly convergenceEmitBaseCooldownTurns = 3
  private convergenceEmitCooldownTurns = 3
  /** Consecutive emit count for the current message variant ? drives both the
   *  backoff multiplier and the "? N ???" prefix in the injected message. */
  private convergenceEmitRepeatCount = 0
  private lastConvergenceEmitTurn = -Infinity
  private lastConvergenceEmitLevel = 0
  private lastConvergenceMsgKey = ''
  /** ???????????? ? ??????????? ? ????????? */
  private lastConvergenceEmitVerifyFailStreak = 0
  /** ???????? score ? ???? score ?????>0.15??????? */
  private lastConvergenceEmitScore = 1.0
  /** B1c/M4?2026-07-23 ????????L2+ ??????? N ? ? ?
   *  priorWarningAtL2Plus ???????????????????????
   *  ?? L2 ??,????????????????????? L3 ??? */
  private readonly convergenceWarningClearProductiveTurns = 5
  private turnHadProductiveTool = false
  private productiveTurnStreak = 0
  /** W1?20b9714e ?????????????phaseClass ??????????
   *  ? turn - phaseStartTurn ????????????"?? 90 ????"??
   *  ???????????? */
  private phaseStartTurn = 0
  private lastConvergencePhaseClass = ''
  /** ? 10 ??????? todo ??????????????10 = ???????? */
  private todoCompletedSamples: number[] = []
  /** Rolling score history from recent convergence checks (most recent last).
   *  Maintained as a sliding window of at most 20 entries. Passed to
   *  evaluateConvergence for L3 scoreAbort decline-trend detection. */
  convergenceScoreHistory: number[] = []
  /** ?????CCR/kick ????????? latestConvergenceResult.shouldKick
   *  ??????? true????? 3 ???????????? CCR ??????
   *  ?????????????????? convergence **????**? advisory ?
   *  ??????????????????? CCR ????? */
  wasConvergenceEmittedRecently(): boolean {
    return this.session.getTurnCount() - this.lastConvergenceEmitTurn <= 1
  }
  /** CVM-vector?v3.1 ???????? convergence ??? phaseClass?
   *  '' = ??????? convergence ????? perception ????? */
  getConvergencePhaseClass(): string {
    return this.lastConvergencePhaseClass
  }
  /** CVM-vector ?????mode ???RIVET_CVM_VECTOR??? shadow?+
   *  session ? evaluator?????????shadow ?? telemetry ?? submit??
   *  ???? turn-step-producer ????????? */
  readonly cvmVector: { mode: CvmVectorMode; evaluator: ReturnType<typeof createCvmVectorEvaluator> } = {
    mode: cvmVectorMode(),
    evaluator: createCvmVectorEvaluator(),
  }
  /** anchor-break-scout ??? session ????????CV2 ??????
   *  scout ? opt-in?antiAnchoring??????? false? */
  anchorScoutOwned = false
  /** PAL ?????? v2??????????attack_case ???
   *  problem-attack-hook ??????????????? reducer ???? */
  readonly problemAttack = new ProblemAttackStore()
  /** Phase 0 ?? ? guardian?CCR / ?? / kick????????????
   *  ???? session meta ????"???????"???????????? */
  readonly guardianActivity: {
    ccr: number
    shifts: Record<string, number>
    advisoriesRendered: number
    advisoriesDropped: number
    /** P1a ?????expect ???????/?????? */
    advisoriesAdopted: number
    advisoriesIgnored: number
    /** Holdout ???????????????cockpit advisory ????? */
    advisoriesHeldOut: number
    /** Wave 1?SR ????? + ? SessionContext cap ??? */
    advisoriesSrSubmitted: number
    advisoriesSrDropped: number
  } = { ccr: 0, shifts: {}, advisoriesRendered: 0, advisoriesDropped: 0, advisoriesAdopted: 0, advisoriesIgnored: 0, advisoriesHeldOut: 0, advisoriesSrSubmitted: 0, advisoriesSrDropped: 0 }
  private lastGuardianMetaFingerprint = ''
  /** ????????????source: 'kick' | 'convergence' | ??? */
  recordDecisionShift(source: string): void {
    this.guardianActivity.shifts[source] = (this.guardianActivity.shifts[source] ?? 0) + 1
  }
  /** ?? advisory ??????? AdvisoryBus.drainLedger?? */
  recordAdvisoryLedger(delta: { rendered: number; dropped: number; heldOut?: number; srSubmitted?: number; srDropped?: number }): void {
    this.guardianActivity.advisoriesRendered += delta.rendered
    this.guardianActivity.advisoriesDropped += delta.dropped
    this.guardianActivity.advisoriesHeldOut += delta.heldOut ?? 0
    this.guardianActivity.advisoriesSrSubmitted += delta.srSubmitted ?? 0
    this.guardianActivity.advisoriesSrDropped += delta.srDropped ?? 0
  }
  /** P1a??????????????/????? AdvisoryReadback.getTotals?? */
  recordAdvisoryOutcomes(totals: { adopted: number; ignored: number }): void {
    this.guardianActivity.advisoriesAdopted = totals.adopted
    this.guardianActivity.advisoriesIgnored = totals.ignored
    // P1?advisory ??? ? 2 ? ?? destructive-gate ??
    if (totals.ignored >= 2) {
      this.destructiveGate.noteAdvisoryPressure()
    }
  }

  /**
   * B??????????**??**?????????????
   * ????? lastEfficacyFlush??? 20 ? + postSession ????,
   * ??????(???????)??????(????????)?
   */
  flushAdvisoryEfficacy(): void {
    try {
      const deltas = new Map<string, EfficacyDelta>()
      for (const [key, s] of this.advisoryReadback.getStats()) {
        const base = this.lastEfficacyFlush.get(key)
        const delta: EfficacyDelta = {
          delivered: s.delivered - (base?.delivered ?? 0),
          adopted: s.adopted - (base?.adopted ?? 0),
          ignored: s.ignored - (base?.ignored ?? 0),
          shadowHeld: s.shadowHeld - (base?.shadowHeld ?? 0),
          shadowSatisfied: s.shadowSatisfied - (base?.shadowSatisfied ?? 0),
        }
        if (delta.delivered > 0 || delta.adopted > 0 || delta.ignored > 0 || delta.shadowHeld > 0 || delta.shadowSatisfied > 0) {
          deltas.set(key, delta)
        }
        this.lastEfficacyFlush.set(key, {
          delivered: s.delivered, adopted: s.adopted, ignored: s.ignored,
          shadowHeld: s.shadowHeld, shadowSatisfied: s.shadowSatisfied,
        })
      }
      if (deltas.size > 0) this.advisoryEfficacyStore.mergeAndSave(deltas)
    } catch { /* ??????????????? */ }
  }
  /**
   * ????????????????? StopReason ?? debugLog/????
   * ?? RIVET_DEBUG ???????"?? run ????"????? / ??
   * ?? / ??? / ???????????????? session meta?
   * ?? run ??????????????????????????
   */
  /** Obligation final gate ?????turn-orchestrator ???postSession ? meta?? */
  recordObligationGateEvent(event: 'continued' | 'misfire' | 'honest_blocked' | 'suppressed'): void {
    if (event === 'continued') this.obligationGateStats.continued += 1
    else if (event === 'misfire') this.obligationGateStats.misfires += 1
    else if (event === 'honest_blocked') this.obligationGateStats.honestBlocked += 1
    else this.obligationGateStats.suppressed += 1
  }

  recordStopReason(r: StopReason): void {
    this.latestStopReason = r
    if (!this.persist) return
    try {
      this.persist.updateMetadata({
        lastStopReason: {
          source: r.source,
          turn: r.turn,
          voluntary: r.voluntary,
          ...(r.detail !== undefined && { detail: r.detail }),
          ...(r.score !== undefined && { score: r.score }),
          ...(r.level !== undefined && { level: r.level }),
          t: Date.now(),
        },
      })
    } catch { /* meta ??????? ? ???? */ }
  }
  /** ? guardian ?????? session meta????????????????????? */
  flushGuardianMeta(): void {
    if (!this.persist) return
    const ga = this.guardianActivity
    const fingerprint = JSON.stringify([ga.ccr, ga.shifts, ga.advisoriesRendered, ga.advisoriesDropped, ga.advisoriesAdopted, ga.advisoriesIgnored])
    if (fingerprint === this.lastGuardianMetaFingerprint) return
    this.lastGuardianMetaFingerprint = fingerprint
    try {
      this.persist.updateMetadata({
        guardianActivity: {
          ccr: ga.ccr,
          shifts: { ...ga.shifts },
          advisoriesRendered: ga.advisoriesRendered,
          advisoriesDropped: ga.advisoriesDropped,
          advisoriesAdopted: ga.advisoriesAdopted,
          advisoriesIgnored: ga.advisoriesIgnored,
        },
      })
    } catch { /* meta ??????? ? ???? turn */ }
  }
  /** Goal tracker for autonomous long-running tasks. Owned by AgentLoop so that
   *  doom-loop threshold selection (getDoomLoopLevel) and goal-active checks
   *  (isGoalActive) read LOCAL state instead of reaching back into the
   *  orchestrator ? breaking the former orchestrator?loop?orchestrator cycle.
   *  The orchestrator reads it via the deps.getGoalTracker getter. */
  private goalTracker: import('./goal-tracker.js').GoalTracker | null = null
  /** U6: autonomous plan execution trace. Created per task (initializeRun), steps
   *  seeded from the first todo write (capturePlanSteps), advanced per tool-turn,
   *  and checked for deviation at each turn boundary. Null outside task context. */
  planTrace: PlanExecutionTrace | null = null
  /** U6: last replan correction injected as a system-reminder ? dedup guard so a
   *  persistent deviation doesn't spam an identical nudge every turn. */
  lastReplanInjection = ''
  /** Session-local affordance adaptations ? per-session, never mutates global registry */
  sessionAffordanceAdaptations: Record<string, import('./affordance.js').BaseAffordance> = {}
  /** Previous anchor graph hash for HEARTH INV-5 intra-session drift detection. */
  prevAnchorGraphHash: string | null = null
  /** Previous turn's streamed assistant text for dedup-guard P5. */
  prevStreamedText: string | null = null
  /** W2 ???????? turn ???????? kind ???pipeline onGateBlocked
   *  ???gate-block-guard hook postTurn drain ???? */
  gateBlockedKinds: string[] = []
  /** P1b: TDD gate ? target ???? ? session ?????3 ?? advisory */
  tddBlockedTargets = new Map<string, number>()
  pressureMonitor: PressureMonitor
  sycophancyTrap: SycophancyTrap = createSycophancyTrap()
  turnBudget: TurnBudget = createTurnBudget(0)
  sensorium: Sensorium | null = null
  strategy: StrategyProfile | null = null
  vigorState: VigorState = createVigorState()
  runtimeHooks: RuntimeHookPipeline
  perception: TurnPerceptionController
  intent: TurnIntentController
  contextInjection: ContextInjectionController
  compaction: CompactionController
  // P2-6 breadcrumb state ? lifted from createTurnStreamController closure
  // to instance scope so it survives TurnStreamController recreation at each
  // user-message boundary (turn-step-producer.ts:122). Without this, the diff
  // against cumulative engine counters resets every segment, causing false
  // positives (e.g. toolsUpdated=true on every turn=0) and false negatives
  // (real events masked by the reset).
  prevEngineStats = { volatileSwaps: 0, frozenClamps: 0, frozenFallbackRebuilds: 0, toolsUpdates: 0 }
  prevMsgCount = 0
  prevHitRate: number | null = null
  prevTokenEfficiency: number | undefined = undefined
  /** Request-aligned cache telemetry. Tool output is consumed by the next model call. */
  turnCacheObservability = new TurnCacheObservability()
  /** Estimated context tokens at the end of the previous turn ? baseline for
   *  compact attribution (compactPreRatio / compactReclaimed in the cache-log). */
  prevEstTokens = 0
  /** The compact-history artifact most recently produced by a compaction, set in
   *  the onArchive callback and consumed once when the rewrite turn's cache-log
   *  entry is built (loop-factory attaches it as entry.archiveId, then clears). */
  lastArchive: { id: string; turn: number } | null = null
  turnStream: TurnStreamController | null = null
  turnCompletion: TurnCompletionController
  toolExecution: ToolExecutionController
  planTraceCoordinator: PlanTraceCoordinator
  compactBoundaryCoordinator: CompactBoundaryCoordinator
  private turnOrchestrator: TurnOrchestrator
  turnStepProducer: TurnStepProducer
  private reasoningEffort: ReasoningEffortController
  /** ????????? reasoning effort?/effort max ???
   *  true ? autoReasoning ?????/effort auto ?? false ?? autoReasoning? */
  userReasoningOverride = false
  intentRoute: IntentRetrievalRouteController
  antiAnchoring: AntiAnchoringController
  private modelRoutingShadow: ModelRoutingShadowController
  prewarmController: PrewarmController
  thetaCheckInFlight = false
  thetaTelemetry: {
    lastReason: string | null
    lastDurationMs: number | null
    lastErrorCount: number
    lastTimedOut: boolean
    requestedCount: number
    /** Number of consecutive theta checks that timed out. Reset to 0 on success. */
    consecutiveTimeouts: number
    /** Turn number at which backoff expires. 0 = no backoff active. */
    cooldownUntilTurn: number
  } = {
    lastReason: null,
    lastDurationMs: null,
    lastErrorCount: 0,
    lastTimedOut: false,
    requestedCount: 0,
    consecutiveTimeouts: 0,
    cooldownUntilTurn: 0,
  }
  /** Max theta checks per session. Prevents runaway tsc spawning. */
  thetaRequestsThisTurn = 0
  thetaState: ThetaState = createThetaState(7)
  artifactStore: import('../artifact/store.js').ArtifactStore | undefined
  /** Session-scoped background job registry (bash run_in_background + `job` tool).
   *  Self-created for TUI; the server replaces it via setJobs() with an instance
   *  it subscribes to for SSE + REST. */
  private _jobs: import('../tools/job-store.js').SessionJobs | undefined
  /** Session-scoped monitor registry?monitor ?? + monitor-hook ???
   *  ? getter ??? _jobs??server setJobs ??????????? */
  private _monitors: import('./monitor-registry.js').MonitorRegistry | undefined
  sessionStateManager: SessionStateManager | undefined
  stigmergyStore: StigmergyStore
  loadedPheromones: Pheromone[] = []
  readonly stanceTally = createStanceTally()
  readonly virtuePendingLedger = createVirtuePendingLedger()
  lastSeenEventId = 0
  gitChangeRate = 0
  telemetryWriter: TelemetryWriter
  /** P3-D?frame ????????????frames.jsonl?????? */
  frameRecorder: FrameRecorder
  baselineFingerprint: PrefixFingerprint | null = null
  sensoriumSnapshots: SensoriumEntry[] = []
  taskContract?: TaskContract
  latestCognitiveSnapshot?: CognitivePhaseSnapshot
  persist: SessionPersist | null = null
  private resourceSensor: ResourceSensor
  latestResourceSnapshot: ResourceSensorSnapshot | null = null
  latestReliabilityDecision: ReliabilityDecision | null = null
  /** Triggers that have fired at error severity this session. Used by
   *  refreshReliabilityDecision to cap recurring firings at degraded,
   *  preventing permanent lock-in from non-self-resolving conditions. */
  firedRecoveryTriggers: Set<RecoveryTrigger> = new Set()
  fsWatcher: ReturnType<typeof createFsWatcher> | null = null
  latestFsWatcherState: FsWatcherState = { eventRate: 0, eventCount: 0, active: false }
  currentSeason: CognitiveSeason | null = null
  currentSeasonIntensity: number | null = null
  lastCompactTurn: number | null = null
  _lastRetrievalRoute: import('./intent-retrieval-route.js').RetrievalRoute | null = null
  _lastEligibility: import('./discipline-eligibility.js').DisciplineEligibility | null = null
  _taskDepthLayer: TaskDepthLayer | undefined = undefined
  _planMethodology: PlanMethodology | undefined = undefined
  _prevPhaseHint: string | undefined = undefined
  /**
   * P2-5: mid-round history rewrites break the prefix cache between two API
   * calls inside one user round (cache-log #30: input +319, cacheRead
   * 50,304?17,792). Pressure detected mid-round is deferred via these flags
   * and processed at the next user-message boundary (turn 0), keeping the
   * session append-only within a round.
   */
  pendingStaleCompact = false
  pendingHeapCompact = false
  cacheAdvisor: CacheAdvisor
  p3: P3Integration
  /** Tier 2 LLM speculation engine (null when disabled). Set by
   *  createTurnOrchestrator; read at postSession to persist fired/error
   *  counters into meta speculationStats. */
  llmSpeculationEngine: import('./llm-speculation.js').LlmSpeculationEngine | null = null
  immuneHook: ImmuneHook
  _lastImmuneHint?: import('./immune-context.js').ImmuneContextHint
  /** A1: unified advisory bus ? collects corrective signals, renders ?3 per turn */
  advisoryBus = new AdvisoryBus()
  /** P1a ?????advisory ???? expect ???? adopted/ignored */
  advisoryReadback = new AdvisoryReadback()
  /** ????????RIVET_CONTROL_PLANE: off|shadow|active??? shadow??
   *  shadow ???/???K0???? prompt?active ??? appendix ???Wave 4?? */
  controlPlane = new ControlPlaneController()
  /** ????? pre-execution ??(????? git ??????,?????)?
   *  tool-pipeline ????????,loop ???????? */
  destructiveGate = createDestructiveGateState({
    getVirtueCredit: () => {
      // ?? 4?reversal ?????????????????
      if (this.currentSeason === 'reversal') return 0.5
      const signals = this.stanceTally.getAllSignals?.()
      return signals ? computeVirtueCredit(signals) : 0.5
    },
  })
  /** B ???????? store????????? */
  advisoryEfficacyStore!: AdvisoryEfficacyStore
  /** ???? flush ?? per-key ???? ? mergeAndSave ????,???? */
  private lastEfficacyFlush = new Map<string, EfficacyDelta>()
  /** F-fix: tool calls since the last discipline re-anchor advisory. */
  private toolCallsSinceReanchor = 0
  /** Anti-habituation: turn count since last model-initiated objection/risk flag. */
  turnsSinceLastObjection = 0
  lastToolCompleteTime = 0
  initialUserMessage: string | null = null
  /** ?????Wave 1/2?????????????? + ?? remember ???
   *  ??????? postSession essence-gate ????????????? 60 ? FIFO? */
  knowledgeCandidates: KnowledgeCandidate[] = []
  /** ?? run ? orchestrator ????(? run ? 0 ??)???? C/D hook ?? */
  runLoopTurn = 0
  /** ????????(run ?? = 0,steer ?????)? run ?? */
  lastUserInputRunTurn = 0
  /** Sliding window of recent turn text fingerprints for cross-turn repetition detection. */
  recentTextFingerprints: string[] = []
  /** T2-02: Current effort shadow record (telemetry only in P0, influences effort in P3+) */
  _currentEffortShadow: EffortShadowRecord | null = null
  /** ????????? EXTENDED ????? /tools enable ????updateTools ???????? */
  private readonly mountedExtras = new Set<string>()
  /** ??????????????/????????? id ???? ask_image ?????
   *  ?????? prompt ???????? image-registry.ts ??????? */
  readonly imageRegistry = new ImageRegistry()

  constructor(
    config: AgentConfig,
    session: SessionContext,
    cwd?: string,
  ) {
      this.config = config; this.session = session;
    if (!this.config.permissionsOverlay) {
      this.config.permissionsOverlay = createPermissionOverlay()
    }
    this.cwd = cwd ?? process.cwd()
    // ??????? prewarm?????? createToolExecutionController???
    // L929 ????? deps ???? self.prewarm???????????????
    if (config.prewarm) this.prewarm = config.prewarm
    this.evidence = new EvidenceTracker()
    // ????????? EvidenceTracker ??????????????
    // blocked ?? attempted???????????? RED?Wave 1 ????
    this.obligations = new ObligationTracker()
    this.evidence.setVerificationListener(meta => this.obligations.applyVerification(meta))
    this.traceStore = createTraceStore()
    // P1b ??????????? ignoredStreak ??????/????
    this.advisoryBus.setHabituationPolicy(this.advisoryReadback)
    // Phase 2 ?????????expect ?????????????? ? ??
    this.advisoryBus.setSelfHealCheck((expect, since, now) =>
      this.advisoryReadback.wasSatisfiedBetween(expect, since, now))
    // Holdout ?????????????????? lift?RIVET_ADVISORY_HOLDOUT=0 ???
    this.advisoryBus.setHoldoutPolicy({
      rate: parseHoldoutRate(process.env.RIVET_ADVISORY_HOLDOUT),
      isEligible: key => this.advisoryReadback.getDeliveredCount(key) >= HOLDOUT_MIN_DELIVERED,
    })
    // B ??????????? EWMA ???????holdout ??/????/
    // Top-N ?????????;????????,guardian meta ???????
    this.advisoryEfficacyStore = new AdvisoryEfficacyStore(this.cwd)
    try {
      const priors = this.advisoryEfficacyStore.load()
      this.advisoryReadback.seedPriors(
        [...priors].map(([k, p]) => [k, {
          delivered: p.delivered, adopted: p.adopted, ignored: p.ignored,
          shadowHeld: p.shadowHeld, shadowSatisfied: p.shadowSatisfied,
        }] as [string, EfficacyPriorCounts]),
      )
    } catch { /* ???????????????? */ }
    this.advisoryBus.setAdoptionRateProvider(key => this.advisoryReadback.getAdoptionRate(key))
    // W2 efficacy ?????20b9714e?????????? delivered/adopted??
    // ? key ????? 3 ???????6 ????????constitutional ????
    this.advisoryBus.setEfficacyStatsProvider(key => {
      const s = this.advisoryReadback.getStats().get(key)
      return s ? { delivered: s.delivered, adopted: s.adopted } : null
    })
    // ???????2026-07-07??????? advisory ?????????
    // ??????????????????? sessionDomain?????/???????
    this.advisoryBus.setToneAdapter((content, meta) =>
      applyDomainAdvisoryTone(this.sessionDomain?.id, content, meta))
    // Lift ?????? lift??? + ??,????????? lift ???
    // Top-N ?????RIVET_ADVISORY_LIFT_CONSUMER=0 ????? = ????????
    if (process.env.RIVET_ADVISORY_LIFT_CONSUMER !== '0') {
      this.advisoryBus.setLiftProvider(key => this.advisoryReadback.getMatureLift(key))
    }
    // Phase 2 ???????? = ????+?????????navigator ??????
    // ??? encouragement/typecheck/informational ?????????????
    // ????? production-flow.ts?EFE/affordance ? wuwei ?????????
    this.advisoryBus.setFlowStateProvider(() => isInProductionFlow(this.recentToolHistory))
    this.harness = new TurnHarness(
      { maxRetries: 2, retryableClasses: ['timeout', 'flaky'] },
      this.trajectory,
      this.failureJournal,
    )
    this.pressureMonitor = new PressureMonitor(this.config.contextWindow)
    // ??????????????? CVM ?????????????????
    // ?? appendix baseline???????????????????? engine ??
    // ??????????????????
    this.config.promptEngine.setOnResetAppendixBaseline(() => {
      this.pressureMonitor.resetCvmOverhead()
    })
    this.resourceSensor = new ResourceSensor(this.config.resourceSensorOptions)
    this.fsWatcher = this.config.fsWatcherEnabled === false ? null : createFsWatcher({ cwd: this.cwd })
    this.telemetryWriter = createTelemetryWriter(this.cwd, this.config.sessionId)
    this.frameRecorder = createFrameRecorder(this.cwd, this.config.sessionId)
    const sessionDir = join(getSessionDir(this.cwd), this.config.sessionId ?? 'anon')
    const pheromonesPath = join(sessionDir, 'pheromones.json')
    // ???? store ??????? #3???? worker ?????????
    // ?????? sessionDir?
    this.stigmergyStore = this.config.stigmergyStore ?? new StigmergyStore(pheromonesPath)

    // Initialize ArtifactStore for append-only artifact log
    if (this.config.sessionId) {
      const artifactDir = join(this.cwd, '.rivet', 'artifacts')
      this.artifactStore = new ArtifactStore(artifactDir, this.config.sessionId)
      const stateManager = new SessionStateManager(this.config.sessionId)
      this.sessionStateManager = stateManager
      this._jobs = new SessionJobs(join(artifactDir, 'jobs'))
    }
    // MonitorRegistry ?????????? getJobs ?? undefined?subscribe ??????
    this._monitors = new MonitorRegistry(() => this._jobs, { telemetry: this.telemetryWriter })

    this.cacheAdvisor = new CacheAdvisor({
      providerProfile: this.config.providerProfile ?? { cacheType: 'none', persistent: false },
      contextWindow: this.config.contextWindow,
    })
    // W3-C3: observe-only delay-compact decision ledger ? cache-log.jsonl
    // (event:'compact_delay_decision'), same channel as per-request cache rows
    // so offline analysis joins decisions with the actual cache outcome.
    if (this.config.sessionId) {
      const sid = this.config.sessionId
      this.cacheAdvisor.setDelayDecisionListener(decision => {
        try {
          const line = JSON.stringify({ ts: Date.now(), ...decision })
          import('node:fs/promises').then(fs => {
            const dir = join(getSessionDir(this.cwd), sid)
            return fs.mkdir(dir, { recursive: true })
              .then(() => fs.appendFile(join(dir, 'cache-log.jsonl'), line + '\n'))
          }).catch(() => {})
        } catch { /* ledger is best-effort */ }
      })
    }
    // Speculative pre-execution chain SEALED (2026-07-07): no execute callback
    // and speculativeEnabled unset ? miner still records patterns, but nothing
    // is pre-executed or cached. Serving was cut 2026-07-06 (ShadowQueue had no
    // mtime validation and served pre-edit file content as a live read_file
    // result); without serving the background pre-reads were pure cost.
    // See P3Config.speculativeEnabled for the re-enable contract.
    this.p3 = createP3Integration()


    // Physarum + Immune system ? construction only, DB reads deferred to warmupMemories() (S9)
    const meridianDb = this.config.meridianIndexer?.getDb()
    const physarum = new PhysarumEngine(meridianDb)
    this.immuneHook = new ImmuneHook({ physarum, stigmergy: this.stigmergyStore, notebook: this.p3?.notebook })
    this.physarumForWarmup = physarum
    this.meridianDbForWarmup = meridianDb

    this.runtimeHooks = this.config.runtimeHooks ?? createRuntimeHooksPipeline(this)
    this.perception = new TurnPerceptionController({
      cwd: this.cwd,
      maxTurns: this.config.maxTurns,
      runtimeHooks: this.runtimeHooks,
      telemetryWriter: this.telemetryWriter,
      getRuntimeSnapshot: extra => this.buildRuntimeSnapshot(extra),
      getProviderDegradationRatio: () => this.config.providerHealth?.getDegradationRatio() ?? 0,
      // Hook injections are pseudo-user messages: append as SR to the last
      // user message (not a new message entry) to preserve prefix cache.
      // W2-B1: K1 append-only egress ? runtime hook payloads (MCTS seeds,
      // scout packets, fallback advisories) charge their bytes exactly once
      // at commit, under the 'runtime-payload' tag.
      addUserMessage: message => {
        this.session.appendSystemReminder(message)
        this.pressureMonitor.recordCvmInjection(Math.ceil(message.length / 4), 'runtime-payload')
      },
      requestThetaCheck: reason => { this.requestThetaCheck(reason) },
      setReasoningEffort: effort => { this.setReasoningEffort(effort, 'programmatic') },
      getFingerprint: () => this.config.promptEngine.getFingerprint(),
      submitControlSignal: signal => { this.controlPlane.submit(signal) },
    })
    this.intent = new TurnIntentController()
    this.contextInjection = new ContextInjectionController({
      session: this.session,
      promptEngine: this.config.promptEngine,
      contextWindow: this.config.contextWindow,
      getSessionId: () => this.config.sessionId,
      getTranscriptPath: () => this.config.transcriptPath,
      getSessionMemoryState: () => this.config.getSessionMemoryState?.(),
      getMessages: () => this.session.getMessages(),
      getRecentToolHistory: () => this.recentToolHistory,
      getRepairHintTracker: () => this.repairHintTracker,
      getContextClaimStore: () => this.config.contextClaimStore,
      getPlaybookStore: () => this.config.playbookStore,
      getCwd: () => this.cwd,
      advisoryBus: this.advisoryBus,
    })
    this.config.promptEngine.setOnLessonsRendered(ids => {
      try { this.config.playbookStore?.recordUsage(ids) } catch { /* non-critical */ }
    })
    this.compaction = new CompactionController({
      session: this.session,
      promptEngine: this.config.promptEngine,
      contextWindow: this.config.contextWindow,
      providerProfile: this.config.providerProfile,
      compactionProfile: this.config.compactionProfile,
      primaryClient: this.config.primaryClient,
      compactClient: this.config.compactClient,
      compactEnabled: this.config.compact.enabled,
      pressureMonitor: this.pressureMonitor,
      getTrajectoryEntries: () => this.trajectory.getEntries(),
      getStreamedText: () => this.streamedText,
      refreshLedger: () => { this.contextInjection.refreshLedger() },
      cacheAdvisor: this.cacheAdvisor,
      getStanceSummary: () => this.stanceTally.render(),
      persistMemories: memories => {
        const persist = this.persist
        if (!persist) return
        const createdAt = Date.now()
        for (const mem of memories) {
          persist.appendMemory({
            text: `[${mem.kind}] ${mem.text}`,
            source: 'compact',
            createdAt,
          })
        }
        // P3: hot-refresh the session-memory volatile block so memories extracted
        // during compaction are visible in THIS session's prompt ? not just the
        // next session. rebuildFrozenBase defers the actual volatileBlock swap to
        // the next user message boundary, and compaction runs at turn 0, so this
        // stays prefix-cache safe. Mirrors the /remember slash-command path.
        try {
          this.config.promptEngine.updateSessionMemory(persist.buildMemoryBlock())
        } catch { /* non-critical: memories are already persisted to disk */ }
      },
      getAbortSignal: () => this.abortController?.signal,
      getActiveContract: () => this.taskContract,
      // After any compaction rewrite the historical tool_results that read-ref
      // points at may be gone ? drop this session's read-dedup records so the
      // next read_file re-serves real content instead of a dangling reference.
      onHistoryRewritten: () => { invalidateSessionReadDedup(this.config.sessionId) },
      // Layered archival: persist discarded history as a recallable
      // compact-history artifact. Disk-only write, never touches the prefix.
      archiveHistory: async (input) => {
        const store = this.artifactStore
        if (!store) return null
        try {
          return await store.save({
            tool: COMPACT_HISTORY_TOOL,
            target: input.target,
            rawContent: input.rawContent,
            summary: input.summary,
            sections: input.sections,
          })
        } catch {
          return null
        }
      },
      // Recall observability: register the archive turn so recall turn-distance
      // can be computed when the model later read_sections this artifact.
      onArchive: (artifactId, turn) => {
        try { this.cacheAdvisor.registerArchive(artifactId, turn) } catch { /* non-critical */ }
        // Stash for the cache-log: the rewrite turn's entry attaches this id so
        // compaction necessity can be correlated with later recalls (consume-once).
        this.lastArchive = { id: artifactId, turn }
      },
      // Optional disaster-recovery snapshot of the full pre-compaction transcript.
      backupTranscript: (messages, turn) => {
        const persist = this.persist
        if (!persist) return
        try {
          const path = join(persist.getBackupDir(), `pre-compact-${turn}.jsonl`)
          const body = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
          writeFileSync(path, body, 'utf-8')
        } catch {
          // Snapshot is best-effort; never block compaction.
        }
      },
      // Side-path usage accounting: summary calls are billed but used to
      // discard their usage ? book them into session totals + cache-log.
      recordSummaryUsage: (usage, model) => {
        createSidePathUsageRecorder(this)('compact-summary', usage, model)
      },
      onReclaimDecision: createReclaimDecisionRecorder(this),
      writeProbe: createWriteEvidenceProbe(this.cwd),
    })
    // ? AgentLoop ??????? prefixOverhead??? UI ??? maybeCompact ??????
    // ??????? GlanceBar ?? ctx 0%?? 0/1.0M?????????? 0%??
    this.compaction.ensurePrefixOverhead()
    this.turnStream = this.createTurnStreamController()
    this.turnCompletion = this.createTurnCompletionController()
    this.toolExecution = this.createToolExecutionController()
    this.planTraceCoordinator = createPlanTraceCoordinator(this)
    this.compactBoundaryCoordinator = createCompactBoundaryCoordinator(this)
    this.turnOrchestrator = createTurnOrchestrator(this)
    this.turnStepProducer = createTurnStepProducer(this)
    this.reasoningEffort = createReasoningEffortController(this)
    this.intentRoute = createIntentRetrievalRouteController(this)
    this.antiAnchoring = createAntiAnchoringController(this)
    this.modelRoutingShadow = createModelRoutingShadowController(this)
    this.prewarmController = createPrewarmController(this)
    
    // ??? SessionPersist ?? fuzzy checkpoint
    if (this.config.sessionId) {
      this.persist = new SessionPersist(this.config.sessionId, this.cwd)

      // P1: Initialize session metadata with model info
      this.persist.initMetadata({
        model: this.config.promptEngine.getModel(),
        cwd: this.cwd,
      })
      // R1: record cwd (cross-cwd resume gate) and reset cleanExit ? the session
      // is now live, so a subsequent crash should be recoverable and a later
      // clean exit must re-mark it. Runs for both fresh and resumed sessions.
      this.persist.updateMetadata({ cwd: this.cwd, cleanExit: false })

      // P0-1: Mirror every in-memory message change to disk so non-/exit
      // shutdowns (Ctrl+C, crash, network drop) don't lose the session.
      const listener = attachSessionPersistListener({ session: this.session, persist: this.persist })
      this._persistDrain = listener.drain
    }
  }

  createTurnStreamController(): TurnStreamController {
      return createTurnStreamController(this);
  }

  createTurnCompletionController(callbacks?: AgentCallbacks): TurnCompletionController {
      return createTurnCompletionController(this, callbacks);
  }

  private createToolExecutionController(): ToolExecutionController {
      return createToolExecutionController(this);
  }
  buildRuntimeSnapshot(extra?: Partial<RuntimeHookSnapshot>): RuntimeHookSnapshot {
      return buildRuntimeSnapshot(this, extra);
  }


  /** Capture an agent's departure mark ? sealed into the starmap at session close. */
  captureLeaveMark(mark: import('../tools/types.js').LeaveMarkInput): void {
    this.pendingLeaveMark = mark
  }

  /** The pending departure mark, if the agent left one this session. */
  getPendingLeaveMark(): import('../tools/types.js').LeaveMarkInput | null {
    return this.pendingLeaveMark
  }

  /** Write a constellation milestone when plan_close applies successfully. */
  handlePlanClosed(input: import('../tools/types.js').PlanClosedInput): void {
    try {
      const domain = this.sessionDomain?.id ?? ''
      const numericId = this._sessionNumericId ?? undefined
      const mark = buildAgentMark({ symbol: VOID_SYMBOL, domain, numericId })
      const summary = `plan closed: ${input.planFile} [${input.tasks}] ${input.deliveryState}`
      const milestone = buildDepartureMilestone({
        sessionId: this.config.sessionId ?? 'anon',
        agentMark: mark,
        domain,
        summary,
        type: 'milestone',
        tags: ['plan-close'],
      })
      appendMilestone(this.cwd, milestone)
    } catch {
      // Milestone write is best-effort; must not disrupt the tool flow.
    }
  }

  /** U6/C1: seed or sync the execution trace from todo/plan_task step inputs.
   *  withPlanSteps is idempotent for first population; once history exists,
   *  only status is synced (no step insertion/removal/description changes). */
  capturePlanSteps(steps: import('../tools/types.js').PlanStepInput[]): void {
    this.planTraceCoordinator.capturePlanSteps(steps)
  }

  /**
   * ?????????????todo ? acceptance ?????? acceptance ??
   * **??**???????????? `applyVerificationEvent` ?????????
   * ???????????? agent ????????????
   *
   * ??????? pending ? ???? open?? met ?? evidence ? ?? attempt
   * ?????????????????? ask_user??? blocked ?? pending ?
   * block?? honest_blocked???????????? met ??? ? satisfy?
   */
  captureAcceptance(items: import('../tools/types.js').AcceptanceItemInput[]): void {
    if (items.length === 0) return

    // ???????successCriteria ? tail ????????????????
    // ?????????????????pending?met???????????
    const criteria = items.map(i => i.criterion)
    if (this.taskContract) {
      const prev = this.taskContract.successCriteria
      const changed = prev.length !== criteria.length || criteria.some((c, i) => c !== prev[i])
      if (changed) this.taskContract = { ...this.taskContract, successCriteria: criteria }
    }

    const ob = this.obligations.getStore().obligations.find(
      o => o.family === 'acceptance' && o.state !== 'satisfied' && o.state !== 'superseded',
    )
    if (!ob) return

    const outcome = decideAcceptanceOutcome(items)
    if (!outcome) return
    switch (outcome.kind) {
      case 'declared':
        // ??????????????? advisory ??????????
        this.obligations.recordAttempt(ob.id, { evidenceRef: `acceptance-declared:${criteria.length}` })
        return
      case 'missing_evidence':
        this.obligations.recordAttempt(ob.id, { failureClass: 'acceptance_no_evidence' })
        return
      case 'blocked':
        this.obligations.block(ob.id, outcome.reason)
        return
      case 'met':
        this.obligations.satisfy(ob.id, outcome.evidenceRef)
    }
  }

  /** U6: build a StepResult from the tool events recorded for a given turn. */
  private buildStepResultFromTurn(turn: number): StepResult | null {
    return this.planTraceCoordinator.buildStepResultFromTurn(turn)
  }

  recordToolHistory(name: string, input: Record<string, unknown>, isError: boolean, result: string, errorClass?: ToolErrorClass, errorKind?: FailureClass): void {
      recordToolHistory(this, name, input, isError, result, errorClass, errorKind);
      // Reset convergence cooldown when the agent produces a productive tool
      // (edit/bash/test/commit/deliver). This means past convergence nudges
      // were either effective (prompted action) or irrelevant (direction was
      // fine all along) ? in either case, reset the repeat counter and cooldown
      // so the next nudge starts fresh rather than escalating from a stale count.
      if (PRODUCTIVE_TOOLS.has(name)) {
        this.convergenceEmitRepeatCount = 0
        this.convergenceEmitCooldownTurns = this.convergenceEmitBaseCooldownTurns
        // B1c?turn ?????,? runConvergenceCheck ??? turn ????
        this.turnHadProductiveTool = true
      }
      // F-fix (session 803d897d): field habituation moves discipline text out of
      // focus after ~4 turns while a heavy turn can run 20+ tool calls. Re-anchor
      // a one-line discipline summary through the advisory bus every N calls ?
      // appendix-rendered, cache-safe, no frozen-prefix changes.
      this.toolCallsSinceReanchor++
      if (this.toolCallsSinceReanchor >= DISCIPLINE_REANCHOR_INTERVAL) {
        this.toolCallsSinceReanchor = 0
        this.advisoryBus.submit(disciplineReanchorEntry())
      }
  }

  recordModelRoutingShadow(currentSensorium: Sensorium, efe: EFEComponents): void {
    this.modelRoutingShadow.record(currentSensorium, efe)
  }

  bindSessionDomain(taskDescription: string): void {
    if (this.sessionDomain !== undefined) return
    // ??????? defaultDomain ????? auto ?????????
    //?TUI/headless/server/??????????????????????
    if (isStarSoulEnabled()) {
      const key = this.config.defaultDomain ?? 'qiming'
      if (key !== 'auto') {
        const pinned = starDomainRegistry.get(key) ?? starDomainRegistry.get('qiming')
        if (pinned) {
          this.sessionDomain = {
            id: pinned.id as StarDomainId,
            name: pinned.name,
            volatileBlock: pinned.volatileBlock,
            motto: pinned.motto,
            courageThreshold: pinned.courageThreshold,
          }
          this.config.promptEngine.setActiveDomain(this.withDomainKnowledge(this.sessionDomain))
          this.persistSessionDomain()
          return
        }
      }
    }
    // domainKeywordRouting ?? true?Auto ???? DOMAIN_AUTO_POOL?????
    // ??? + ?????? matchDomain?????????DEFAULT_DOMAIN??
    // ?? false ????? DEFAULT_DOMAIN??????????????/??/
    // ?????? defaultDomain='auto' ???????????????
    this.sessionDomain = isStarSoulEnabled()
      ? buildActiveDomain(taskDescription, {
          keywordRouting: this.config.domainKeywordRouting !== false,
        })
      : null
    this.config.promptEngine.setActiveDomain(this.withDomainKnowledge(this.sessionDomain))
    this.persistSessionDomain()
  }

  /** ????? meta.domain??TUI /resume ????????bootstrap
   *  switchAgentSession ???shutdown ? buildSessionHandoff ?????????
   *  best-effort????????????? */
  private persistSessionDomain(): void {
    try { this.persist?.updateMetadata({ domain: this.sessionDomain?.id }) } catch { /* best-effort */ }
  }

  /**
   * ???????????????? top-3 lessons?worker ???
   * buildDomainKnowledgeBlock????????????????? ? ???
   * FROZEN ?????? per-turn ???
   */
  private withDomainKnowledge(domain: ActiveStarDomain | null): (ActiveStarDomain & { knowledgeBlock?: string }) | null {
    if (!domain || !this.config.domainKnowledgeStore) return domain
    try {
      const block = buildDomainKnowledgeBlock(this.config.domainKnowledgeStore, domain.id, { maxLessons: 3 })
      return block ? { ...domain, knowledgeBlock: block } : domain
    } catch {
      return domain
    }
  }

  abort(): void {
    this._turnInterruptCount++
    this._pendingAbort = true
    this.abortController?.abort()
    // NOTE: killAll() removed ? it was a global hammer that killed processes
    // from ALL AgentLoop instances, not just this one (??? #1).
    // ?????????????????????????abortController ?
    // ???????abort() ????? ? ? tool-pipeline ??????????
    // ???bash/run_tests ??? params.abortSignal??? killProcessTree ???????
    // ???????????????????????????????????
    // ??????????? main.tsx ????? killAllSync() ???
  }

  /**
   * Synchronously persist pending debounced memory stores. Called from the exit
   * path (main.tsx shutdownCallback) so deposits inside the 200ms debounce
   * window survive Ctrl+C / shutdown. Best-effort: never throw on the exit path.
   */
  flushStigmergySync(): void {
    try {
      this.stigmergyStore.flushSync()
    } catch {
      // exit-path persistence is best-effort; a failure must not block exit
    }
    try {
      this.config.domainKnowledgeStore?.flushSync()
    } catch {
      // exit-path persistence is best-effort; a failure must not block exit
    }
  }

  /**
   * System-initiated abort (hard-stall watchdog) ? breaks a wedged turn
   * WITHOUT incrementing `_turnInterruptCount`. That counter feeds the
   * recovery-trigger's "repeatedly interrupted" classification (see
   * refreshReliabilityDecision); a watchdog stall-recovery is not a user
   * interrupt and must not be mislabeled as one, especially when combined
   * with a genuine earlier interrupt in the same run.
   */
  abortStalledTurn(): void {
    this._watchdogAborted = true
    this.abortController?.abort()
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.config.approvalMode = mode
  }

  /** C3 ? current checkpoint interval for status displays. */
  getCheckpointInterval(): number {
    return this.config.checkpointEveryTurns ?? 0
  }

  /** Return the current session permission overlay, initializing if needed. */
  private getPermissionOverlay(): PermissionOverlay {
    if (!this.config.permissionsOverlay) {
      this.config.permissionsOverlay = createPermissionOverlay()
    }
    return this.config.permissionsOverlay
  }

  addAllowRule(rule: PermissionAllowRule): void {
    this.getPermissionOverlay().allow.push(rule)
  }

  addDenyRule(rule: PermissionAllowRule): void {
    this.getPermissionOverlay().deny.push(rule)
  }

  addBashAllowPrefix(prefix: string): void {
    const overlay = this.getPermissionOverlay()
    if (!overlay.bashAllow.includes(prefix)) overlay.bashAllow.push(prefix)
  }

  addBashDenyPrefix(prefix: string): void {
    const overlay = this.getPermissionOverlay()
    if (!overlay.bashDeny.includes(prefix)) overlay.bashDeny.push(prefix)
  }

  removePermissionRule(
    kind: 'allow' | 'deny' | 'bashAllow' | 'bashDeny',
    indexOrPattern: number | string,
  ): boolean {
    const overlay = this.getPermissionOverlay()
    if (kind === 'allow' || kind === 'deny') {
      const list = overlay[kind]
      if (typeof indexOrPattern === 'number') {
        if (indexOrPattern < 0 || indexOrPattern >= list.length) return false
        list.splice(indexOrPattern, 1)
        return true
      }
      const idx = list.findIndex(r => r.tool === indexOrPattern)
      if (idx === -1) return false
      list.splice(idx, 1)
      return true
    }
    const list = overlay[kind]
    if (typeof indexOrPattern === 'number') {
      if (indexOrPattern < 0 || indexOrPattern >= list.length) return false
      list.splice(indexOrPattern, 1)
      return true
    }
    const idx = list.indexOf(indexOrPattern)
    if (idx === -1) return false
    list.splice(idx, 1)
    return true
  }

  resetPermissionOverlay(): void {
    this.config.permissionsOverlay = createPermissionOverlay()
  }

  /** Attach a GoalTracker to the current run. Owned by AgentLoop; the
   *  orchestrator reads it via deps.getGoalTracker (no longer a field on
   *  TurnOrchestrator), severing the loop?orchestrator back-edge that
   *  getDoomLoopLevel/isGoalActive used to traverse. */
  setGoalTracker(tracker: import('./goal-tracker.js').GoalTracker | null): void {
    this.goalTracker = tracker
  }

  /** Expose the goal tracker for deps wiring (orchestrator reads via getter). */
  getGoalTracker(): import('./goal-tracker.js').GoalTracker | null {
    return this.goalTracker
  }

  /** Check if goal tracker is active (for doom-loop threshold selection). */
  isGoalActive(): boolean {
    return this.goalTracker?.isActive() ?? false
  }

  /**
   * Single source of truth for the abort reason passed to onAbort(). Encodes
   * whether the current abort was a watchdog hard-stall (vs. a user Ctrl+C) and,
   * for watchdog stalls during a goal run, tags `watchdog:goal` so the UI can
   * auto-recover/continue instead of treating it as a user interrupt. Used by
   * every onAbort emission site (turn-orchestrator deps + turn-step-producer)
   * so the encoding stays consistent across abort paths.
   */
  abortReason(): string | undefined {
    if (!this._watchdogAborted) return undefined
    return this.isGoalActive() ? 'watchdog:goal' : 'watchdog'
  }

  /** Sync plan-mode state into config so tool-pipeline reads it */
  syncPlanModeToConfig(): void {
    this.config.planModeState = this.planModeState
    this.config.activePlanFilePath = this.activePlanFilePath
    this.config.askModeState = this.askModeState
    this.config.promptEngine.setPlanModeState(this.planModeState)
    this.config.promptEngine.setActivePlanFilePath(this.activePlanFilePath)
    this.config.promptEngine.setAskModeState(this.askModeState)
    // ??? session meta??resume ?????????????????????
    // ??????(enter/exit/setActivePlan)?????,??????
    try {
      this.persist?.updateMetadata({
        planModeState: this.planModeState,
        activePlanFilePath: this.activePlanFilePath,
        askModeState: this.askModeState,
      })
    } catch { /* best-effort */ }
  }

  /**
   * source ???2026-07-25 advisory-ecology-repair W1??
   * ???????/effort ?????CLI????????? userReasoningOverride?
   * ??????perception strategy effort?autoReasoning ????????
   * reasoningEffort.set()??????????? override ???
   * ???? 2 ????????? autoReasoning????? /effort ???????????
   */
  setReasoningEffort(
    effort: import('./auto-reasoning.js').ReasoningEffort | 'auto',
    source: 'user' | 'programmatic' = 'user',
  ): void {
    if (effort === 'auto') {
      // ????? auto ? autoReasoning ?????? effort??? override ???
      if (source === 'user') this.userReasoningOverride = false
      return
    }
    if (source === 'user') this.userReasoningOverride = true
    // ????????/effort max ??? ??????perception strategy?
    // autoReasoning ?????????????????
    if (source === 'programmatic' && this.userReasoningOverride) return
    this.reasoningEffort.set(effort)
  }

  shadowEffortTelemetry(
    ruleBaseline: string,
    overrides?: { errorRate?: number; isRepeat?: boolean },
  ): void {
    this.reasoningEffort.shadowTelemetry(ruleBaseline, overrides)
  }

  getEffortDelta(): number | null {
    return this.reasoningEffort.getDelta()
  }

  getReasoningEffort(): import('./auto-reasoning.js').ReasoningEffort | undefined {
    return this.reasoningEffort.get()
  }

  updateSessionMemory(block: string): void {
    this.config.promptEngine.updateSessionMemory(block)
  }

  /**
   * ??????????? ? ??????MCP/LSP ???????????????????
   * ?? createAgentConfig ?? gateToolDefinitions??? updateTools ??? EXTENDED ??
   * ??????? bug?MCP/LSP ???? updateTools ??? ? ??????????
   */
  private gatedToolDefinitions(): import('../api/types.js').ToolDefinition[] {
    const all = this.config.toolRegistry.getDefinitions()
    const gating = this.config.toolGating
    // ???????????????????config.blockPolicy????????
    // ??? memo ???????? invalidate?live ?????? compact ??
    // ? full?system ?????? ? ?????? miss??????????
    // config ????????? live ???
    const toolDescriptions = (this.config.blockPolicy
      ?? resolvePromptBlocks(this.config.cwd ?? process.cwd())).toolDescriptions
    if (!gating) return applyDescriptionMode(all, toolDescriptions)
    return gateToolDefinitions(all, {
      enabled: gating.enabled,
      coreOverride: gating.coreOverride,
      extraCore: gating.extraCore,
      domainTier: gating.domainTier,
      mountedExtras: [...this.mountedExtras],
      disabledTools: gating.disabledTools,
      toolDescriptions,
    })
  }

  updateTools(): void {
    this.config.promptEngine.updateTools(this.gatedToolDefinitions())
  }

  /** ?????????????????? + ??????? */
  getActiveToolNames(): string[] {
    return this.gatedToolDefinitions().map(d => d.name)
  }

  /**
   * ??????? EXTENDED ?????????? turn ??? slash ??????
   *
   * ???????? staticCtx.tools ? fingerprint?? exact-prefix ??? provider
   * ?deepseek-native / anthropic-cache-control??????????????'none' provider ????
   *
   * @returns ??????? UI ???status + ?????
   */
  enableTool(name: string): {
    status: 'mounted' | 'already-active' | 'not-extended' | 'unknown' | 'gating-off'
    cacheImpact: 'prefix-invalidated' | 'none'
    prefixCacheStrategy: 'deepseek-native' | 'anthropic-cache-control' | 'none'
  } {
    const strategy = this.config.prefixCacheStrategy ?? 'none'
    const cacheImpact: 'prefix-invalidated' | 'none' =
      strategy === 'none' ? 'none' : 'prefix-invalidated'

    // ???? ? ???????????
    if (!this.config.toolGating || !this.config.toolGating.enabled) {
      return { status: 'gating-off', cacheImpact: 'none', prefixCacheStrategy: strategy }
    }
    // ????????
    if (!this.config.toolRegistry.getDefinitions().some(d => d.name === name)) {
      return { status: 'unknown', cacheImpact: 'none', prefixCacheStrategy: strategy }
    }
    // ? EXTENDED ????????? EXTENDED?CORE/MCP/LSP??????
    if (!isExtendedTool(name)) {
      return { status: 'not-extended', cacheImpact: 'none', prefixCacheStrategy: strategy }
    }
    // ??? ? ??
    if (this.mountedExtras.has(name)) {
      return { status: 'already-active', cacheImpact: 'none', prefixCacheStrategy: strategy }
    }
    this.mountedExtras.add(name)
    this.updateTools()
    return { status: 'mounted', cacheImpact, prefixCacheStrategy: strategy }
  }

  getTrajectoryStats(): { totalTools: number; failures: number; retries: number; avgDurationMs: number } {
    return this.trajectory.summarize()
  }

  getTrajectoryEntries(): import('./trajectory.js').TrajectoryEntry[] {
    return this.trajectory.getEntries()
  }

  resetTrajectory(): void {
    this.trajectory.reset()
  }

  getTraceStore(): TraceStore { return this.traceStore }

  getEvidenceState() { return this.evidence.getState() }

  getVerificationSummary() { return this.evidence.getVerificationSummary() }

  /** @deprecated Mode is now auto-detected from message content via isActionableTurn. */
  setPromptMode(_mode: string): void {
    // No-op: mode detection is automatic. Kept for backward compat with slash commands.
  }

  /** @deprecated Always returns 'task' ? chat/task binary no longer exists. */
  getPromptMode(): string {
    return 'task'
  }

  /** Get the currently active star domain (null = no domain, undefined = not yet resolved). */
  getSessionDomain(): ActiveStarDomain | null | undefined {
    return this.sessionDomain
  }

  /** Manually set the active star domain. Pass null to disable, or a valid ActiveStarDomain. */
  setSessionDomain(domain: ActiveStarDomain | null): void {
    this.sessionDomain = domain
    this.config.promptEngine.setActiveDomain(this.withDomainKnowledge(domain))
    this.persistSessionDomain()
  }

  /** Reset domain to undefined so the next run() will auto-detect from user input. */
  resetSessionDomain(): void {
    this.sessionDomain = undefined
    this.config.promptEngine.setActiveDomain(undefined)
    this.persistSessionDomain()
  }

  /**
   * Completed-turn count for this session. Used to detect a mid-session
   * star-domain switch (>0 ? switching now invalidates the prefix cache and
   * forces a full context rebuild at the next request, ~10x cost).
   */
  getSessionTurnCount(): number {
    return this.session.getTurnCount()
  }

  /**
   * PlusMenu ? per-session disabled skill names. Filters the skill discovery
   * block (turn-step-producer) so disabled skills are hidden from the model.
   * Empty set = all skills available (default).
   */
  private _disabledSkills: Set<string> = new Set()

  /** Replace the per-session disabled skill set (desktop skill toggle). */
  setDisabledSkills(names: Set<string>): void {
    this._disabledSkills = new Set(names)
  }

  /** Read the per-session disabled skill set (consumed by turn-step-producer). */
  getDisabledSkills(): Set<string> {
    return this._disabledSkills
  }

  /** Mark a skill as explicitly invoked so its instructions survive compaction. */
  markSkillInvoked(name: string): void {
    this.config.promptEngine.markSkillInvoked(name)
  }

  /** Release an invoked skill so its instructions are no longer re-injected. */
  markSkillCompleted(name: string): void {
    this.config.promptEngine.markSkillCompleted(name)
  }

  getLatestPheromones() { return this.loadedPheromones }

  /** Expose MeridianIndexer for /index command */
  getIndexer() { return this.config.meridianIndexer ?? null }

  getDecisions(): string[] { return this.decisions }

  getContextLayerReport() { return this.config.promptEngine.getContextLayerReport() }

  getDoomLoopLevel(): 'none' | 'warn' | 'blocked' {
    // Goal-active mode uses relaxed thresholds to avoid false doom-loop triggers
    // during long autonomous tasks where repeated tool types are legitimate.
    const thresholds = getDoomLoopThresholds(this.goalTracker?.isActive() ?? false)
    return combineDoomLoopLevels(
      getDoomLoopLevel(this.traceStore.toolFingerprints, thresholds.exact),
      getClassDoomLoopLevel(this.traceStore.bashClassFingerprints ?? [], thresholds.class),
    )
  }

  getReliabilityDecision(): ReliabilityDecision | null { return this.latestReliabilityDecision }

  private sessionPersistPath(): string | undefined {
    return this.persist?.getFilePath()
  }

  refreshReliabilityDecision(): void {
    // User override: RIVET_RELIABILITY_OVERRIDE=full disables all reliability
    // locks. Use when the agent is permanently locked by a non-self-resolving
    // condition (e.g. orphan tool_use blocks) and you accept the risk.
    if (process.env.RIVET_RELIABILITY_OVERRIDE === 'full') {
      this.latestReliabilityDecision = null
      return
    }

    this.latestResourceSnapshot = this.resourceSensor.sample(this.sessionPersistPath())
    const disk = this.latestResourceSnapshot.disk
    const trigger = classifyRecoveryTrigger({
      interrupt: {
        interruptCountThisTurn: this._turnInterruptCount,
        hasPendingTools: this.detectPendingTools(),
        turn: this.session.getTurnCount(),
      },
      doomLoop: {
        doomLoopLevel: this.getDoomLoopLevel(),
        recentFingerprints: this.traceStore.toolFingerprints.slice(-20),
        uniqueFingerprintCount: new Set(this.traceStore.toolFingerprints.slice(-20)).size,
      },
      thrashing: {
        compactionTurns: this.pressureMonitor.getCompactionTurns(),
        currentTurn: this.session.getTurnCount(),
        consecutiveCompactFailures: this.compactFailures.consecutiveFailures,
        estimatedTokens: this.session.getEstimatedTokens(),
        contextWindow: this.config.contextWindow,
        lastCompactFailed: this.compactFailures.consecutiveFailures > 0,
      },
      integrity: this.computeSessionIntegrity(),
      resourcePressure: {
        rssBytes: this.latestResourceSnapshot.memory.rssBytes,
        heapUsedBytes: this.latestResourceSnapshot.memory.heapUsedBytes,
        memoryLimitBytes: this.latestResourceSnapshot.memory.memoryLimitBytes,
        sessionBytes: disk?.sessionBytes ?? 0,
        sessionByteLimit: disk?.sessionByteLimit ?? Number.POSITIVE_INFINITY,
        memoryTrendBytesPerSample: this.latestResourceSnapshot.memoryTrendBytesPerSample,
      },
    })

    this.latestReliabilityDecision = modeForRecoveryTrigger(
      trigger,
      this.isGoalActive(),
      this.firedRecoveryTriggers,
    )

    // Track triggers that fire at error severity for one-shot suppression.
    // Add AFTER modeForRecoveryTrigger so the first occurrence reaches full
    // severity (e.g. minimal). Subsequent occurrences are then capped at
    // degraded by modeForRecoveryTrigger's suppressedTriggers check.
    if (trigger && trigger.severity === 'error' && trigger.trigger) {
      this.firedRecoveryTriggers.add(trigger.trigger)
    }
  }

  /** ?#5: Check for tool_calls that have no matching tool_result. */
  private detectPendingTools(): boolean {
    const msgs = this.session.getMessages()
    const pendingIds = new Set<string>()
    for (const msg of msgs) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) pendingIds.add(tc.id)
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        pendingIds.delete(msg.tool_call_id)
      }
    }
    return pendingIds.size > 0
  }

  /** ?#5: Compute session integrity snapshot for recovery trigger. */
  private computeSessionIntegrity() {
    const msgs = this.session.getMessages()
    const toolCallIds = new Set<string>()
    const toolResultIds = new Set<string>()
    for (const msg of msgs) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) toolCallIds.add(tc.id)
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        toolResultIds.add(msg.tool_call_id)
      }
    }
    return {
      orphanToolUseCount: [...toolCallIds].filter(id => !toolResultIds.has(id)).length,
      orphanToolResultCount: [...toolResultIds].filter(id => !toolCallIds.has(id)).length,
      wasRepaired: false,
      syntheticResultsInserted: 0,
      messageCount: msgs.length,
    }
  }

  requestThetaCheck(reason: string): void {
      if (this.config.thetaCheckDisabled) return
      requestThetaCheck(this, reason);
  }

  /** Physarum provider health: feed stream outcomes into the tracker.
   *  Success slowly warms the provider; failure rapidly cools it (4x asymmetry).
   *  Degradation ratio is consumed by sensorium stability; cold tiers are
   *  skipped by coordinator worker routing. */
  recordProviderOutcome(ok: boolean): void {
    const health = this.config.providerHealth
    const providerId = this.config.providerName
    if (!health || !providerId) return
    health.registerProvider(providerId)
    if (ok) health.recordSuccess(providerId)
    else health.recordFailure(providerId)
  }

  getLatestRisk(): import('./approval-risk.js').RiskAssessment { return this.latestRisk }

  /** Latest free-energy policy signals (EFE + sensorium) for downstream routing. */
  getPolicySignals(): { efe: EFEComponents; sensorium: Sensorium } | undefined {
    return this.latestPolicySignals
  }

  /** Enter plan mode ? only read-only tools allowed. Clears any stale approved-plan pointer. */
  enterPlanMode(opts?: { planFilePath?: string }): void {
    // Idempotent re-entry: already planning with a live draft and no explicit
    // target ? keep the current draft. Creating a fresh one would orphan the
    // file the agent is incrementally writing to.
    if (this.planModeState === 'planning' && this.activePlanFilePath && !opts?.planFilePath) {
      return
    }
    // Mutual exclusion with Ask Mode ? enter plan exits ask silently.
    if (this.askModeState === 'asking') {
      this.askModeState = 'off'
      try { this.onAskModeChange?.('off') } catch { /* non-fatal */ }
    }
    this.planModeState = 'planning'
    // P2 plan advisory ?????????????? planning ????????
    this.structureFlowPlanAdvisoryKeys.clear()
    // Re-entering cancels any pending exit reminder from a prior exit.
    this.config.promptEngine.setPlanExitReminderPending(false)
    this.config.promptEngine.setActivePlan(null)

    const cwd = this.cwd
    if (opts?.planFilePath) {
      this.activePlanFilePath = opts.planFilePath.replace(/\\/g, '/')
    } else {
      this.activePlanFilePath = createActivePlanDraftPath()
      const abs = join(cwd, this.activePlanFilePath)
      mkdirSync(dirname(abs), { recursive: true })
      if (!existsSync(abs)) writeFileSync(abs, '', 'utf-8')
    }
    this.syncPlanModeToConfig()
    this.markSkillInvoked(WRITING_PLANS_SKILL)
    // ?? plan mode ??????????????????????? advisory?
    // ???????????????advisory ????????scope ????????
    // ???? DisciplineEligibility.requiresEngineeringDiscipline???? isActionable?
    const isEngineeringTask = this.latestCognitiveSnapshot?.requiresEngineeringDiscipline ?? this.taskContract?.isActionable
    if (isEngineeringTask) {
      const files = this.taskContract?.scope.mentionedFiles ?? []
      const fileHint = files.length > 0
        ? `?? scope ???????????????${files.slice(0, 12).join(', ')}${files.length > 12 ? ` ??? ${files.length} ??` : ''}?`
        : ''
      this.advisoryBus.submit({
        key: 'plan-scout-parallel',
        priority: 0.7,
        category: 'delegation',
        content: `???????????????????????????????? \`delegate_batch\` ????? 2-4 ??? \`code_scout\`????/???????? scout ????????????????????${fileHint}????????????????`,
        ttl: 2,
        expect: { kind: 'tool_appears', tools: ['delegate_batch'], withinTurns: 2 },
        channel: 'system-reminder',
      })
    }
    try { this.onPlanModeChange?.('planning') } catch { /* non-fatal */ }
  }

  /** Exit plan mode ? user approved, all tools allowed */
  exitPlanMode(): void {
    this.planModeState = 'off'
    // P2 plan advisory ???????????
    this.structureFlowPlanAdvisoryKeys.clear()
    this.config.promptEngine.setPlanExitReminderPending(true)
    this.releasePlanModeArtifacts()
    this.syncPlanModeToConfig()
    try { this.onPlanModeChange?.('off') } catch { /* non-fatal */ }
  }

  /**
   * Shared plan-mode teardown: drop the draft pointer (removing the draft file
   * when it is still empty, so toggling in and out doesn't litter .rivet/plans/)
   * and release the writing-plans skill pin ? leaving it invoked would re-inject
   * the full planning skill into every post-approval execution turn.
   */
  private releasePlanModeArtifacts(): void {
    const draft = this.activePlanFilePath
    this.activePlanFilePath = null
    if (draft && /\/draft-\d+\.md$/.test(draft.replace(/\\/g, '/'))) {
      try {
        const abs = join(this.cwd, draft)
        if (existsSync(abs) && readFileSync(abs, 'utf-8').trim() === '') rmSync(abs)
      } catch { /* best-effort cleanup */ }
      // Drop the draft from the task ledger so it is never treated as an owned
      // file at delivery/commit time. The draft is a transient planning artifact;
      // the canonical plan lives in .rivet/plans/<slug>.md once submitted.
      this.config.taskLedger?.removeEventsByPath(draft)
    }
    this.markSkillCompleted(WRITING_PLANS_SKILL)
  }

  /**
   * Set (or clear) the approved-plan pointer. Injects a tiny slug/title/path
   * reminder into the dynamic appendix ? NOT the plan body (which stays on disk).
   * Approving releases plan mode (state?off) so execution tools are unblocked.
   * Cache-safe: the pointer never enters the frozen base.
   */
  setActivePlan(plan: { slug: string; title: string; selectedApproach?: string } | null): void {
    if (!plan) {
      this.config.promptEngine.setActivePlan(null)
      return
    }
    this.config.promptEngine.setActivePlan(formatActivePlanPointer(plan))
    // ?3 ????????????????????? task contract?
    // deliver_task ???????? grep ???????? 3??best-effort?
    // ?4 ?????D8 L2?????/???????????????????????
    try {
      const planContent = readFileSync(join(this.cwd, '.rivet', 'plans', `${plan.slug}.md`), 'utf-8')
      const inventory = extractRegressionInventory(planContent)
      if (inventory.length > 0 && this.taskContract) {
        this.taskContract = { ...this.taskContract, regressionInventory: inventory }
      }
      const planConstraints = renderPlanConstraints(extractPlanConstraints(planContent), `${plan.slug}.md`)
      if (planConstraints.length > 0 && this.taskContract) {
        this.taskContract = { ...this.taskContract, planConstraints }
      }
    } catch { /* best-effort: ??/????????????? */ }
    const wasPlanning = this.planModeState === 'planning'
    this.planModeState = 'off'
    if (wasPlanning) this.config.promptEngine.setPlanExitReminderPending(true)
    this.releasePlanModeArtifacts()
    this.syncPlanModeToConfig()
    if (wasPlanning) { try { this.onPlanModeChange?.('off') } catch { /* non-fatal */ } }
  }

  /** Get current plan mode state */
  getPlanModeState(): PlanModeState { return this.planModeState }

  /** Enter Ask Mode ? pure read-only Q&A. Mutually exclusive with Plan Mode. */
  enterAskMode(): void {
    if (this.askModeState === 'asking') return
    // Mutual exclusion with Plan Mode ? enter ask exits plan (with exit reminder).
    if (this.planModeState === 'planning') {
      this.planModeState = 'off'
      this.config.promptEngine.setPlanExitReminderPending(true)
      this.releasePlanModeArtifacts()
      try { this.onPlanModeChange?.('off') } catch { /* non-fatal */ }
    }
    this.askModeState = 'asking'
    this.syncPlanModeToConfig()
    try { this.onAskModeChange?.('asking') } catch { /* non-fatal */ }
  }

  /** Exit Ask Mode ? restore normal tool access. */
  exitAskMode(): void {
    if (this.askModeState === 'off') return
    this.askModeState = 'off'
    this.syncPlanModeToConfig()
    try { this.onAskModeChange?.('off') } catch { /* non-fatal */ }
  }

  getAskModeState(): AskModeState { return this.askModeState }

  /** Relative path to the active plan file while in plan mode. */
  getActivePlanFilePath(): string | null { return this.activePlanFilePath }

  getPrewarmStats(): { hits: number; misses: number; hitRate: number } { return this.prewarm.stats() }

  getPhysarumShadowStats(): PhysarumShadowStats {
    return getPhysarumShadowStatsFromDb(this.meridianDbForWarmup)
  }

  getCacheDiagnostic(): string | null { return this.lastCacheDiagnostic }

  refreshCacheDiagnostic(turn: number): void {
    this.lastCacheDiagnostic = this.compaction.refreshCacheDiagnostic(turn)
  }

  /** Estimated token count for the current conversation (live, for desktop ctx-bar). */
  getEstimatedTokens(): number {
    return this.session.getEstimatedTokens()
  }

  /** Session-scoped background job registry (undefined in anon/no-session mode). */
  get jobs(): import('../tools/job-store.js').SessionJobs | undefined {
    return this._jobs
  }

  /** Session-scoped monitor registry (always present; degrades without jobs). */
  get monitors(): import('./monitor-registry.js').MonitorRegistry | undefined {
    return this._monitors
  }

  /** Replace the background job registry. The server injects an instance it owns
   *  (subscribed for SSE + REST). Any prior self-created jobs are terminated. */
  setJobs(jobs: import('../tools/job-store.js').SessionJobs): void {
    if (this._jobs && this._jobs !== jobs) {
      try { this._jobs.killAll() } catch { /* best-effort */ }
    }
    this._jobs = jobs
  }

  /** Real context-window occupancy (anchor on last API prompt_tokens + tail
   *  estimate) ? for display only. See SessionContext.getRealOccupancy. */
  getRealOccupancy(): number {
    return this.session.getRealOccupancy()
  }

  /** Observe-only recall stats for compacted-history artifacts (for /context).
   *  Cheap delegate ? avoids the heavier getDebugInfo() build. */
  getRecallSummary(): RecallMetricsSummary {
    return this.cacheAdvisor.getRecallSummary()
  }

  /** Model context window size in tokens. */
  getContextWindow(): number {
    return this.config.contextWindow
  }

  getLedger() { return this.session.getContextLedger() }

  getCognitiveSnapshot(): CognitivePhaseSnapshot | undefined { return this.latestCognitiveSnapshot }

  getTaskContract(): TaskContract | undefined { return this.taskContract }

  /** W5?incident 20b9714e??session_vitals ?????????????
   *  ????????? IO????????? null????????"???"? */
  getSessionVitals(): import('../tools/session-vitals.js').SessionVitalsData {
    const estimatedTokens = this.session.getEstimatedTokens()
    const contextWindow = this.config.contextWindow
    const statsMap = this.advisoryReadback.getStats()
    const top = [...statsMap.entries()]
      .map(([key, s]) => ({
        key,
        delivered: s.delivered,
        adopted: s.adopted,
        ignored: s.ignored,
        silenced: this.advisoryBus.isEfficacySilenced(key),
      }))
      .sort((a, b) => b.delivered - a.delivered)
      .slice(0, 5)
    const s = this.sensorium
    let runtime: import('./runtime-self-model.js').RuntimeSelfModel | null = null
    try {
      const coordinator = this.config.coordinatorRef?.()
      if (coordinator) {
        const verification = this.evidence.getVerificationSummary()
        runtime = buildRuntimeSelfModel({
          phase: this.planModeState,
          turn: this.session.getTurnCount(),
          contextRatio: contextWindow > 0 ? estimatedTokens / contextWindow : 1,
          sensorium: s ? {
            pressure: s.pressure,
            confidence: s.confidence,
            stability: s.stability,
          } : null,
          verificationDebt: verification.total > 0
            ? verification.pending / verification.total
            : (this.evidence.hasVerificationDebt() ? 1 : 0),
          coordinator: coordinator.getRuntimeSnapshot(),
        })
      }
    } catch {
      // session_vitals is diagnostic; a missing coordinator must never break it.
      runtime = null
    }
    return {
      ctx: {
        estimatedTokens,
        contextWindow,
        ratio: contextWindow > 0 ? estimatedTokens / contextWindow : 1,
      },
      cache: this.session.getCacheHistory().slice(-5),
      sensorium: s ? {
        momentum: s.momentum, pressure: s.pressure, confidence: s.confidence,
        complexity: s.complexity, freshness: s.freshness, stability: s.stability,
      } : null,
      cvm: {
        overheadRatio: this.pressureMonitor.getCvmOverheadRatio(),
        throttled: this.pressureMonitor.isCvmThrottling(),
        ceiling: this.pressureMonitor.isCvmThrottlingCeiling(),
      },
      advisories: {
        rendered: this.guardianActivity.advisoriesRendered,
        dropped: this.guardianActivity.advisoriesDropped,
        adopted: this.guardianActivity.advisoriesAdopted,
        ignored: this.guardianActivity.advisoriesIgnored,
        top,
      },
      runtime,
      turn: this.session.getTurnCount(),
    }
  }

  /** ???????????? Assistant ????????? TUI ????????? */
  getTaskList() { return this.sessionStateManager?.getTaskList() ?? [] }

  addAnchor(kind: ContextAnchor['kind'], text: string): void {
    this.contextInjection.addAnchor(kind, text)
  }

  getFileHistory() { return this.config.fileHistory }

  /** Book a side-path request's usage into session totals + the cache-log.
   *  Side paths are billed like any other call, and silently discarding their
   *  usage was a real cost blind spot (2026-07-06). `kind` keeps the sources
   *  distinguishable in `cache-log.jsonl`. */
  recordSidePathUsage(kind: string, usage: Partial<import('../api/types.js').Usage>, model?: string): void {
    createSidePathUsageRecorder(this)(kind, usage, model)
  }

  /** ??? frozen ????????`/prefix-budget`???????????
   *  ????????????????????????????????? */
  getPrefixBudget(): { profile: string; toolDescriptions: string; report: import('../prompt/prefix-budget.js').PrefixBudgetReport } {
    const policy = this.config.blockPolicy ?? resolvePromptBlocks(this.config.cwd ?? process.cwd())
    return {
      profile: policy.profile,
      toolDescriptions: policy.toolDescriptions,
      report: buildBudgetReport(this.config.promptEngine.getPrefixBudgetInputs()),
    }
  }

  getDebugInfo() {
    const fp = this.config.promptEngine.getFingerprint()
    const sysPrompt = this.config.promptEngine.getSystemPrompt()
    return { fingerprint: fp, drift: this.config.promptEngine.checkDrift(),
      systemPromptLength: sysPrompt.length,
      systemPromptPreview: sysPrompt.slice(0, 200) + (sysPrompt.length > 200 ? '...' : ''),
      toolCount: this.config.toolRegistry.getDefinitions().length,
      toolNames: this.config.toolRegistry.getDefinitions().map(t => t.name),
      volatilePayloadReport: this.config.promptEngine.getVolatilePayloadReport(this.recentToolHistory),
      cacheAdvisor: this.cacheAdvisor.getDiagnostic() }
  }

  /** Drain pending async persist writes ? public for /cd pre-migration
   *  (moving session files while a queued append is in flight would recreate
   *  a dangling jsonl at the old path). */
  async drainPersistWrites(): Promise<void> {
    await this._persistDrain?.()
  }

  async runPostSession(callbacks: AgentCallbacks): Promise<void> {
    // P0-1: drain pending async persist writes so tool results survive abort/Ctrl+C.
    await this._persistDrain?.()
    await this.runtimeHooks.runPostSession(createRuntimeHookContext(this.buildRuntimeSnapshot(),
      { emitPhaseChange: (phase, detail) => { callbacks.onPhaseChange?.(phase, detail) } }))
    if (this.config.sessionRegistry) {
      try { this.config.sessionRegistry.cleanupOldEvents(2 * 60 * 60 * 1000) } catch { /* ignore */ }
    }
    this.flushAdvisoryEfficacy()
    try { this.immuneHook.getPhysarum().save() } catch { /* non-critical */ }
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) db.saveImmuneMemories(this.immuneHook.exportMemories())
    } catch { /* non-critical */ }
    try {
      const db = this.config.meridianIndexer?.getDb()
      // notebook ?????? p3-integration.ts????????????????
      //????? memory-epoch reset???"?????"????????
      if (db && this.p3.notebook) db.saveMistakeEntries(this.p3.notebook.getAllEntries())
    } catch { /* non-critical */ }
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) db.saveToolPatternMinerSnapshot(this.p3.miner.exportSnapshot())
    } catch { /* non-critical */ }
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) {
        db.saveBanditState('bandit:reasoning_effort', this.p3.serializeEffortBandit())
        // model_style bandit sealed (zero production callers). Its state was
        // saved/restored every session but never consulted for a decision.
        db.saveBanditState('p3:plan_cache', this.p3.serializePlanCache())
      }
    } catch { /* non-critical */ }
    try {
      // ??? /handoff?????????????????????????????
      // ?? handoff ?????????????????shouldAutoWriteHandoff??
      const sp = this.persist
      const handoffMtime = sp && existsSync(sp.getHandoffPath()) ? statSync(sp.getHandoffPath()).mtimeMs : null
      if (sp && shouldAutoWriteHandoff(handoffMtime, this.createdAtMs)) {
        const handoffText = this.compaction.buildSessionHandoff()
        sp.writeHandoff(handoffText)
      }
      if (sp) {
        const domainId = this.sessionDomain?.id
        if (domainId) sp.updateMetadata({ domain: domainId })
      }
    } catch { /* ignore */ }
    // Sink compact-history recall stats into the (gated) sensorium channel.
    // Observe-only: collects turn-distance data for a future adaptive-window
    // decision; it does NOT influence compaction thresholds today.
    try {
      this.telemetryWriter.write({ kind: 'recall-summary', ...this.cacheAdvisor.getRecallSummary() })
    } catch { /* telemetry is best-effort */ }
    // Speculation source stats ? session meta. Written unconditionally of the
    // RIVET_DEBUG_TELEMETRY gate so the "should llmSpeculation default on"
    // decision has cross-session hit-rate evidence. Only written when at least
    // one source saw activity ? idle sessions don't grow their meta files.
    try {
      const stats = this.p3.queue.statsBySource()
      const hasActivity = Object.values(stats).some(s => s.enqueued > 0 || s.hits > 0)
      if (hasActivity) this.persist?.updateMetadata({ speculationStats: stats })
    } catch { /* meta ??????? ? ???? */ }
    // LLM speculation engine call counters ? meta. speculationStats.llm only
    // counts shadow-queue enqueued/hits; without fired/errors there is no
    // on-disk evidence of how many speculative API calls actually happened
    // (2026-07-06 cost blind spot fix).
    try {
      const engineStats = this.llmSpeculationEngine?.stats()
      if (engineStats && engineStats.fired > 0) {
        this.persist?.updateMetadata({ llmSpeculationEngine: engineStats })
      }
    } catch { /* meta ??????? ? ???? */ }
    // Obligation final gate ???Wave 3 ??????auto-continue ????
    // ?????????????? >20% ????? task kind ??????
    // ??????????????????????? meta?
    try {
      const og = this.obligationGateStats
      if (og.continued > 0 || og.misfires > 0 || og.honestBlocked > 0 || og.suppressed > 0) {
        this.persist?.updateMetadata({ obligationGate: og })
      }
    } catch { /* meta ??????? ? ???? */ }
    // todo ???? ? meta?detectRegressions ?????????????????
    // ??????????????????????????????????????
    // ??????????? debug ?????????????? meta?
    try {
      const todoStats = (this.config.getTodoRegressionStats ?? getTodoRegressionStats)()
      if (todoStats.writes > 0) {
        // ???????????????????????????????????
        // ?????????????????decisions ????????
        this.persist?.updateMetadata({
          todoRegressions: todoStats,
          decisionsArm: resolveDecisionsArm(this.config.sessionId),
        })
      }
    } catch { /* meta ??????? ? ???? */ }
  }

  async startFsWatcher(): Promise<void> {
    try {
      await this.fsWatcher?.start()
    } catch {
      // fs.watch is an opportunistic external signal; unavailable watchers must not block turns.
    }
  }

  stopFsWatcher(): void {
    this.fsWatcher?.stop()
    this.latestFsWatcherState = { eventRate: 0, eventCount: 0, active: false }
  }

  isRunning(): boolean {
    return this._running
  }

  async run(userInput: string, callbacks: AgentCallbacks, images?: string[]): Promise<void> {
    // Re-entry guard: prevent concurrent agent.run() calls.
    // React strict mode or rapid re-submits could trigger handleSubmit
    // while a previous run is still in-flight, corrupting SessionContext.
    // Claim the guard synchronously before any await (including the
    // cancelIdleCompaction drain) so a duplicate run() that arrives during the
    // drain sees _running=true and no-ops instead of racing _runInner.
    if (this._running) {
      debugLog('[agent] run() called while already running ? skipping duplicate')
      return
    }
    this._running = true
    // Eager abort controller: created synchronously before any await (incl. the
    // cancelIdleCompaction() drain below) so an Esc/Ctrl+C during the init/warmup
    // window aborts a live signal instead of a no-op. Pending latch is cleared
    // for this fresh run. cancelIdleCompaction only aborts the idle controller
    // and its finally nulls abortController only when it === idleAbort, so this
    // fresh user-turn controller survives the drain untouched.
    this._pendingAbort = false
    this._watchdogAborted = false
    this.abortController = new AbortController()
    // W3???????????? system-reminder ???????? 1 ???
    this.session.resetSrCount()
    // Cancel + drain any pending/in-flight idle compaction before mutating the
    // session, so the user turn never races idle history rewrites. Awaiting the
    // settle is correct (not a stall): the idle abort makes the in-flight pass
    // bail at its next checkpoint; replaceMessages itself is synchronous so the
    // session is always in a consistent state at the await boundary.
    try {
      await this.cancelIdleCompaction()

      // ?????????????? registry????????????? ask_image
      // ?????id ??? images ??????????? prompt/???
      const registeredIds = images && images.length > 0 ? this.imageRegistry.register(images) : []

      // Vision bridge: when the primary model is text-only but a dedicated
      // multimodal model is configured, describe the images and prepend the
      // description to the user prompt so the primary model still receives
      // the visual information. ????????????images ??? oaiMessages ?????
      // ?????? registry ? ask_image ???v4 ?????????????
      if (images && images.length > 0 && !this.config.supportsVision && this.config.visionClient) {
        // ????????????????/??/???????????????
        // ?????"??????"????????? failed???? debugLog?
        // ??????**??** userInput ???? describeImages ????????????
        // userInput ???? prepend ????????????
        const firstDescKey = visionCacheKey(undefined, this.config.visionModelPrompt, userInput)
        try {
          const description = await describeImages(this.config.visionClient, images, {
            prompt: this.config.visionModelPrompt,
            // ???????????/????????????? prompt ???
            // "????????[?]" ? ?? OCR ???????????????
            accompanyingText: userInput,
            maxTokens: this.config.visionModelMaxTokens,
            signal: this.abortController.signal,
          })
          if (description) {
            userInput = `[????]\n${description}\n\n${userInput}`
            // ??????????? ask_image ???????????
            const firstId = registeredIds[0]
            if (firstId) {
              this.imageRegistry.cacheDescription(firstId, firstDescKey, description)
            }
          } else {
            userInput = `[??????] ????? ${images.length} ????????????????`
              + `?????????????????\n\n${userInput}`
            debugLog('[vision] bridge returned empty description')
          }
        } catch (err) {
          const reason = (err as Error)?.message ?? String(err)
          userInput = `[??????] ????? ${images.length} ????????????${reason}???`
            + `??????????????? agent.visionModel ????????\n\n${userInput}`
          debugLog(`[vision] bridge error: ${reason}`)
        }
        // text-only ?????????? prompt parts ??????? registry ??????
        images = undefined
      }

      await this._runInner(userInput, callbacks, images)
    } finally {
      this._running = false
      this.scheduleIdleCompaction()
    }
  }

  /**
   * Schedule a debounced idle compaction pass. Called from run()'s finally so
   * it only ever arms after at least one turn. The timer is unref'd so it never
   * keeps the TUI/sidecar process alive. Disabled when discretionary compaction
   * is off (worker sessions) or via RIVET_IDLE_COMPACTION=0.
   */
  scheduleIdleCompaction(): void {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null }
    if (!this.config.compact?.enabled) return
    if (process.env['RIVET_IDLE_COMPACTION'] === '0') return
    const delayMs = Number(process.env['RIVET_IDLE_COMPACTION_MS']) || IDLE_COMPACTION_DELAY_MS
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null
      if (this._running) return
      void this.runIdleCompaction()
    }, delayMs)
    this._idleTimer.unref?.()
  }

  /**
   * Cancel a scheduled idle timer and abort + await any in-flight idle
   * compaction. Resolves only once the session is safe to mutate again.
   */
  async cancelIdleCompaction(): Promise<void> {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null }
    if (this._idleCompacting && this._idleAbort) this._idleAbort.abort()
    if (this._idleSettled) { try { await this._idleSettled } catch { /* settled */ } }
  }

  /**
   * ???????? = provider ??? compact ??cache-preserving 0.86 /
   * balanced 0.78 / aggressive 0.70???? RIVET_IDLE_COMPACTION_RATIO ???
   *
   * ?????**?????????????????**????????????
   * ??????? 0.5 ???????????????????????????
   * ????????????????????????????50?compact ???
   * ?????????????????????????????
   */
  private idleCompactionMinRatio(): number {
    const override = Number(process.env['RIVET_IDLE_COMPACTION_RATIO'])
    if (Number.isFinite(override) && override > 0 && override <= 1) return override
    return compactPolicyRatios(this.config.providerProfile).compact
  }

  /**
   * Run a single turn-0-equivalent compaction pass while idle. Reuses the full
   * boundary ladder (session split ? maybeCompact ? T9 ? stale ? heap, plus
   * pending-flag drain) at turn=0 semantics ? prefix-cache safe, identical to
   * what the next user turn would run, just paid during idle time.
   *
   * ???? = ???????? + ???????ratio ?? compact ?????
   * ?????????????mid-turn ??? pendingStale/pendingHeap ???
   * ratio ????????? 50% ??????????
   */
  async runIdleCompaction(): Promise<void> {
    if (this._running || this._idleCompacting) return
    if (!this.config.compact?.enabled) return
    const ctxWindow = this.config.contextWindow ?? 1_000_000
    const ratio = this.session.getEstimatedTokens() / ctxWindow
    const minRatio = this.idleCompactionMinRatio()
    if (!this.pendingStaleCompact && !this.pendingHeapCompact && ratio < minRatio) return

    this._idleCompacting = true
    const idleAbort = new AbortController()
    this._idleAbort = idleAbort
    // Point the shared abort accessor at the idle controller so the compaction
    // ladder (and its LLM stream) is cancellable via cancelIdleCompaction().
    this.abortController = idleAbort
    this._idleSettled = (async () => {
      try {
        debugLog(`[idle-compact] starting (ratio=${ratio.toFixed(2)} gate=${minRatio.toFixed(2)} pendingStale=${this.pendingStaleCompact} pendingHeap=${this.pendingHeapCompact})`)
        await this.compactBoundaryCoordinator.runCompaction(0, null)
      } catch (e) {
        debugLog(`[idle-compact] error: ${(e as Error)?.message}`)
      }
    })()
    try {
      await this._idleSettled
    } finally {
      this._idleCompacting = false
      this._idleSettled = null
      this._idleAbort = null
      if (this.abortController === idleAbort) this.abortController = null
    }
  }

  /** Load cross-session history off the construction path (S9). Idempotent. */
  async warmupMemories(): Promise<void> {
    if (this.memoriesWarmed) return
    this.memoriesWarmed = true
    // Cross-session learning load: config.crossSessionEnabled (default true) activates it.
    // Env RIVET_NO_CROSS_SESSION=1 overrides as force-off.
    if (!this.config.crossSessionEnabled) return
    if (process.env.RIVET_NO_CROSS_SESSION === '1' || process.env.RIVET_NO_CROSS_SESSION === 'true') return
    const db = this.meridianDbForWarmup
    if (!db) return
    loadSessionMemories({
      db,
      physarum: this.physarumForWarmup,
      immuneHook: this.immuneHook,
      p3: this.p3,
    })
  }

  /**
   * T2-02 Track A2: Apply bandit delta to a base reasoning effort.
   *
   * Wired into the live effort selection path. Protected by three gates:
   *   1. effortBanditEnabled flag (default false) ? checked in getEffortDelta()
   *   2. Consistency-promotion gate (totalPulls ? 30, agreement ? 0.8)
   *   3. reasoningFloor still enforced (resolveEffortDelta clamp)
   *
   * When any gate is closed, returns baseEffort unchanged ? zero behavior delta.
   */
  applyEffortDelta(baseEffort: string): string {
    return this.reasoningEffort.applyDelta(baseEffort)
  }

  /**
   * P3 ????turn ???**?????**??loop ?????????
   * sensorium / latestPolicySignals / PAL / evidence ?????????
   * ?????? frame?????????????? frame ?????
   * frame ????EFE ??? quality.efe='missing'??????? IO?
   */
  private assembleBoundaryFrame(
    turn: number,
    phaseClass: string,
    todoCompletedDelta: number,
    userMessageConsumed: boolean,
  ): CognitiveFrame {
    // flow ???? P1 ? computeFlowBeacon????????????? 5?
    // ? ? tier signalWindow??? detector ?? slice(-signalWindow) ?
    // 5 ?????????????????????
    const momentumHasData = this.sensorium
      ? (this.sensorium.quality?.momentum ?? 'measured') !== 'no-data'
      : false
    const beacon = this.sensorium && momentumHasData
      ? computeFlowBeacon({
        momentum: this.sensorium.momentum,
        momentumHasData,
        stability: this.sensorium.stability,
        recentToolHistory: this.recentToolHistory,
        todoCompletedDelta,
        signalWindow: Math.max(1, this.recentToolHistory.length),
      })
      : null

    // ????????????? failed?running ??????????
    // ? P1 flow beacon ? settled-only ??????
    let consecutiveFailures = 0
    for (let i = this.recentToolHistory.length - 1; i >= 0; i--) {
      const status = this.recentToolHistory[i]!.status
      if (status === 'failed') consecutiveFailures++
      else if (status === 'success') break
    }

    // ????????? EvidenceTracker.hasVerificationDebt()?W3 ?????
    // self-verify ???????????????????????? ?3?
    // ??????????????????????????????????
    // ?? hardTighten ???? P1 ??????????
    const gateState = this.evidence.getGateState()
    const hasVerificationDebt = this.evidence.hasVerificationDebt()

    return assembleCognitiveFrame({
      turn,
      phaseClass,
      efe: this.latestPolicySignals?.efe ?? null,
      sensorium: this.sensorium
        ? { momentum: this.sensorium.momentum, momentumHasData, stability: this.sensorium.stability }
        : null,
      flow: {
        score: beacon?.score ?? null,
        sampleCount: beacon?.sampleCount ?? 0,
        requiredSamples: FLOW_MIN_SAMPLES,
      },
      pal: this.problemAttack.snapshotForCvm(),
      evidence: {
        hasVerificationDebt,
        deliveryStatus: this.evidence.getState().deliveryStatus,
        consecutiveFailures,
      },
      user: { intervened: userMessageConsumed },
      // ?????????????????????? activePlanFile ||
      // planning?projectStructureFlowInputs??detector ?
      // progressBeacons.activePlan ???????????????????
      plan: { activePlanFile: this.activePlanFilePath !== null, planModeState: this.planModeState },
      progress: { todoCompletedDelta },
    })
  }

  async runConvergenceCheck(
    turn: number,
    phaseClass: string,
    assistantResponded: boolean,
    userMessageConsumed: boolean,
    callbacks: AgentCallbacks,
  ): Promise<{
    action: 'proceed' | 'abort'
  }> {
    // Fix 3 ? the user just intervened this turn, so any pre-intervention
    // "hesitation" (no-tool) streak is broken: zero it before evaluation so a
    // stale streak can't drive a spurious stagnation/abort right after the user
    // speaks. (Turn-start and tool-use paths reset this elsewhere; this covers
    // mid-run steer injection.)
    if (userMessageConsumed) {
      this.consecutiveNoToolTurns = 0
      // ?? C ????:steer ?? = ????????,stale ????
      this.lastUserInputRunTurn = turn
      // P2 plan advisory?????? = ??????????????????
      this.structureFlowPlanAdvisoryKeys.clear()
    }

    // W1 ? ???????phase ?????????????????"???"
    // ????????????
    if (phaseClass !== this.lastConvergencePhaseClass) {
      this.lastConvergencePhaseClass = phaseClass
      this.phaseStartTurn = turn
    }
    const phaseRelativeTurn = Math.max(1, turn - this.phaseStartTurn + 1)

    // W1 ? ?????todo ????????????todo ??????
    // "???"????? detector ? L2+ ???
    let todoCompletedNow = 0
    try {
      todoCompletedNow = (this.config.getTodos ?? getTodos)().filter(t => t.status === 'completed').length
    } catch { /* beacon is advisory-only ? never break the convergence check */ }
    this.todoCompletedSamples.push(todoCompletedNow)
    if (this.todoCompletedSamples.length > 10) this.todoCompletedSamples.shift()
    const todoCompletedDelta = todoCompletedNow - (this.todoCompletedSamples[0] ?? todoCompletedNow)

    // W3 ? ?????????? + ????????????????
    // "????????"??"????"? 20b9714e ???????????
    const activityMode = classifyActivityMode(
      this.recentToolHistory,
      this.evidence.getState().filesModified.size,
    )

    // B1c/M4?turn ????????? ? ????????;? N ?????
    // ??????????? userMessageConsumed ?????????????
    // L3,?"????????"? grace-turn,?????????? abort?
    this.productiveTurnStreak = this.turnHadProductiveTool ? this.productiveTurnStreak + 1 : 0
    this.turnHadProductiveTool = false
    if (this.lastConvergenceEmitLevel >= 2 && this.productiveTurnStreak >= this.convergenceWarningClearProductiveTurns) {
      debugLog(`[convergence] turn=${turn} prior-warning cleared (${this.productiveTurnStreak} productive turns since emit)`)
      this.lastConvergenceEmitTurn = -Infinity
      this.lastConvergenceEmitLevel = 0
      this.lastConvergenceMsgKey = ''
      this.lastConvergenceEmitVerifyFailStreak = 0
    }

    // Grace-turn precondition for the score abort: a convergence warning at L2+
    // must have been delivered in a strictly earlier turn, so the model had at
    // least one turn to act on the guidance. Captured before this turn's kick
    // emission updates the fields and passed into evaluateConvergence so the
    // detector's scoreAbort decision uses the same signal as loop.ts.
    const warnedInEarlierTurn = this.lastConvergenceEmitLevel >= 2
      && this.lastConvergenceEmitTurn < turn

    // P3 ??????? turn ????????????????? P2 ???
    // ???EFE ??? measured ? ?? null ? latestStructureFlow=null?
    // ? P2?EFE ?? ? ????????????
    // P2 ????????????????? missing-data????
    // structureRelaxation??? flowInputs??? flow ?????????
    this.latestCognitiveFrame = this.assembleBoundaryFrame(turn, phaseClass, todoCompletedDelta, userMessageConsumed)
    const structureFlowInputs = projectStructureFlowInputs(this.latestCognitiveFrame)
    this.latestStructureFlow = structureFlowInputs
      ? computeStructureFlowControl(structureFlowInputs)
      : null
    const structureRelaxation = this.latestStructureFlow !== null
      && !this.latestStructureFlow.reasons.includes('missing-data')
      ? this.latestStructureFlow.relaxation
      : null

    // W4 ???????????????? status='failed' ????
    // ??????????????agent ???? bug ?? doom-loop?
    // transient ???pointer-guard ???????????????????
    const toolErrorWindow = this.recentToolHistory.slice(-10)
    const recentToolErrorRatio = toolErrorWindow.length > 0
      ? toolErrorWindow.filter(h => h.status === 'failed' && !h.transient).length / toolErrorWindow.length
      : 0

    // Sanitize history for convergence detector: transient guard failures
    // (pointer-guard rejections, etc.) are format-level mistakes the model fixes
    // next turn ? not competence failures. Reclassify them as 'success' so they
    // don't drag down computeErrorPenalty and trigger false stagnation signals.
    const sanitizedHistory = this.recentToolHistory.map(h =>
      h.status === 'failed' && h.transient ? { ...h, status: 'success' as const } : h)

    const convergenceCheck = evaluateConvergence({
      turn,
      phaseClass: phaseClass as PhaseClass,
      phaseRelativeTurn,
      scoreHistory: this.convergenceScoreHistory,
      contextWindow: this.config.contextWindow,
      recentToolHistory: sanitizedHistory,
      evidenceState: this.evidence.getState(),
      toolFingerprints: this.traceStore.toolFingerprints,
      noToolTurnCount: this.consecutiveNoToolTurns,
      textFingerprints: this.recentTextFingerprints,
      providerName: this.config.providerName,
      outputTokens: this.session.getTotalUsage().output_tokens,
      repeatCount: this.convergenceEmitRepeatCount,
      priorWarningAtL2Plus: warnedInEarlierTurn,
      progressBeacons: {
        todoCompletedDelta,
        activePlan: this.activePlanFilePath !== null,
        // P2 ???? ? ??????????? P1 ?????Sensorium ??
        // ???????????????????? detector ???
        // tier.signalWindow ??????????????Sensorium ?? ?
        // ?? ? ?????????????P3 ????????????
        // ????????????????
        ...(structureRelaxation !== null ? { structureRelaxation } : (this.latestCognitiveFrame?.facts.sensorium ? {
          flowInputs: { ...this.latestCognitiveFrame.facts.sensorium },
        } : {})),
      },
      activityMode,
      recentToolErrorRatio,
    })
    this.latestConvergenceResult = convergenceCheck
    // P3 Wave 3 / P3-D?????????full ???facts ?????????
    // ??????? frames.jsonl??????RIVET_FRAME_TELEMETRY=0 ????
    // lite ???<200B???? sensorium.jsonl?recorder ????????
    // ??????????? loop?
    try {
      if (this.frameRecorder.enabled) {
        this.frameRecorder.write(buildCognitiveFrameRecord(this.latestCognitiveFrame, this.latestStructureFlow, convergenceCheck))
      }
      this.telemetryWriter.write(buildCognitiveFrameLiteRecord(this.latestCognitiveFrame, this.latestStructureFlow, convergenceCheck))
    } catch { /* telemetry is diagnostics-only */ }
    // Maintain rolling score history for L3 decline-trend detection (sliding window ? 20)
    this.convergenceScoreHistory.push(convergenceCheck.score)
    if (this.convergenceScoreHistory.length > 20) this.convergenceScoreHistory.shift()
    debugLog(`[convergence] turn=${turn} score=${convergenceCheck.score.toFixed(2)} level=${convergenceCheck.level} phase=${phaseClass}`)

    if (convergenceCheck.shouldKick && convergenceCheck.injectedMessage) {
      // Fix 3 ? user-interaction reset. When the user just spoke/intervened this
      // turn, the agent has already handed control back (the "right" convergence
      // outcome). Reset the cooldown and skip emitting a nudge this turn so we
      // don't nag right after the user starts acting. (An agent that ends a turn
      // by asking the user a question also lands here on the next turn, since the
      // user's answer arrives as a consumed message.)
      if (userMessageConsumed) {
        this.lastConvergenceEmitTurn = -Infinity
        this.lastConvergenceEmitLevel = 0
        this.lastConvergenceMsgKey = ''
        this.lastConvergenceEmitVerifyFailStreak = 0
      } else {
        // Fix 1 ? cooldown + dedup gate on the visible side-effects. The message
        // type is keyed by its header line, so same-type nudges with only changed
        // diagnostic numbers do not count as a new "direction". Skip the
        // "?? N ???????" progressive prefix: it varies per emission and
        // must not make a repeat look like a direction change (that would reset
        // the cooldown and re-emit every turn ? the exact spam this gate exists
        // to stop).
        const msgKey = convergenceCheck.injectedMessage.split('\n')
          .find(l => l.length > 0 && !l.startsWith('??')) ?? ''
        const cooldownElapsed = turn - this.lastConvergenceEmitTurn >= this.convergenceEmitCooldownTurns
        const scoreDropped = this.lastConvergenceEmitScore - convergenceCheck.score > 0.15
        const cooledDown = cooldownElapsed || scoreDropped
        const escalated = convergenceCheck.level > this.lastConvergenceEmitLevel
        const changedDirection = msgKey !== this.lastConvergenceMsgKey
        // ???????2026-07-04 ??????????????? = ????
        // ??????????"????"????????????????
        // ? CCR P7 ?????computeVerifyFailStreak??????????
        const verifyFailStreak = computeVerifyFailStreak(this.recentToolHistory)
        const verifyFailEscalated = verifyFailStreak >= 2 && verifyFailStreak > this.lastConvergenceEmitVerifyFailStreak
        if (cooledDown || escalated || changedDirection || verifyFailEscalated) {
          // Backoff: if the same message variant fires again, double the cooldown
          // (3?6?12?24?). Reset to base when direction changes or level escalates.
          if (changedDirection || escalated) {
            this.convergenceEmitRepeatCount = 0
            this.convergenceEmitCooldownTurns = this.convergenceEmitBaseCooldownTurns
          } else {
            this.convergenceEmitRepeatCount += 1
            this.convergenceEmitCooldownTurns = this.convergenceEmitBaseCooldownTurns * (1 << Math.min(this.convergenceEmitRepeatCount, 5))
          }
          this.lastConvergenceEmitTurn = turn
          this.lastConvergenceEmitLevel = convergenceCheck.level
          this.lastConvergenceMsgKey = msgKey
          this.lastConvergenceEmitVerifyFailStreak = verifyFailStreak
          this.lastConvergenceEmitScore = convergenceCheck.score
          // B1c?????? N ??????????????????
          this.productiveTurnStreak = 0
          this.turnHadProductiveTool = false

          // Level 2: inject user guidance as a system-visible nudge
          callbacks.onPhaseChange?.('convergence-warning', {
            reason: `???? L${convergenceCheck.level}: ${phaseClass} ??? ${phaseRelativeTurn} ?????? (score=${convergenceCheck.score.toFixed(2)})`,
            suggestion: convergenceCheck.injectedMessage.slice(0, 200),
          })
          // R4 ? externalize the convergence nudge as a structured course-correction
          // so the desktop renders a "??" card; the injected guidance below is what
          // the agent acts on next, making the cause?effect visible to the user.
          // W2 ? efficacy ???? key ????????advisory ???????
          // ???????? UI ???20b9714e?32 ??????
          if (!this.advisoryBus.isEfficacySilenced('convergence')) {
            this.recordDecisionShift('convergence')
            callbacks.onDecisionShift?.({
              source: 'convergence',
              reason: `${phaseClass} ??? ${phaseRelativeTurn} ?????????????????`,
              methods: [convergenceCheck.injectedMessage.slice(0, 200)],
              severity: convergenceCheck.level >= 2 ? 'warn' : 'info',
            })
          }
          // W4 advisory ?????2026-07-28 session 0087edf0????????
          // ?? advisory??? >15 ?/?????? detection ??? advisory
          // bus ????agent ??????????? advisory ??????????
          // ??? onPhaseChange ??? TUI ???????? advisory ???
          const avgAdvisoriesPerTurn = (turn + 1) > 0 ? this.guardianActivity.advisoriesRendered / (turn + 1) : 0
          const advisoryFlood = avgAdvisoriesPerTurn > 15
          if (!advisoryFlood) {
            this.advisoryBus.submit({
            key: 'convergence',
            priority: 0.65,
            tier: 'operational',
            category: 'discipline',
            content: convergenceCheck.injectedMessage +
              ` ${renderRouteAnnotation(STALL_ROUTE_TABLE[this.consecutiveNoToolTurns >= 2 ? 'no-tool-stall' : 'strategy-stall'])}`,
            // ??????P1a + W3 + B1b??
            // - ????????????????????
            // - ??????W3??"?????"????? = ????????
            //   ?????read/grep/glob ?????? ? adopted ?????
            //   ??????? ? ????? ignored?? efficacy ??????
            // - build ???B1b/M4?2026-07-23 ?????????? = ????
            //   /??????course_changed ???????????????????
            expect: this.consecutiveNoToolTurns >= 2
              ? { kind: 'tool_appears', tools: [], withinTurns: 1 }
              : activityMode === 'diagnostic'
                ? { kind: 'tool_appears', tools: ['read_file', 'grep', 'glob', 'list_dir', 'bash'], withinTurns: 2 }
                : { kind: 'course_changed', withinTurns: 2 },
          })
          }

          // When convergence is detected, append the delivery gate hint so the
          // agent sees the gate state alongside the convergence message.
          // Previously only fired for doomLoopLevel==='blocked', but YELLOW
          // gates (no_test_infra, external_blocked) also need context ?
          // otherwise the generic "???????" can contradict "??????".
          if (convergenceCheck.level >= 2) {
            let gateHint = '???????????? deliver_task ???'
            try {
              const gate = this.config.deliveryGateV2?.([...this.evidence.getState().filesModified])
              if (gate) gateHint = `?????${buildGateConvergenceHint(gate, this._taskDepthLayer)}`
            } catch { /* gate evaluation must never break convergence handling */ }
            this.advisoryBus.submit({
              key: 'convergence-gate',
              priority: 0.6,
              tier: 'operational',
              category: 'discipline',
              content: gateHint,
            })
          }
        }
      }
    }

    if (convergenceCheck.shouldForceSplit) {
      // Level 3: force session split to reset context and break the loop
      debugLog(`[convergence] turn=${turn} force-split score=${convergenceCheck.score.toFixed(2)}`)
      if (await this.compaction.trySessionSplit()) {
        // split succeeded ? reset turn counter and continue
        debugLog(`[convergence] turn=${turn} split-succeeded`)
      }
    }

    if (convergenceCheck.shouldAbort) {
      // Grace turn for all aborts: if no L2+ warning was delivered in an earlier
      // turn (first escalation straight to L3, or the ladder was reset by a
      // user message), demote this abort to the kick that was just emitted
      // above and let the model act on it for one turn. This applies to both
      // score-based and no-tool aborts ? a model that went silent without prior
      // warning deserves one more chance after being nudged.
      if (!warnedInEarlierTurn) {
        debugLog(`[convergence] turn=${turn} score-abort demoted to kick (no prior-turn warning) score=${convergenceCheck.score.toFixed(2)}`)
        return { action: 'proceed' }
      }
      // Structured stop-reason: distinguish the no-tool hard cap from a
      // score-based abort, and tag whether the model was still reasoning (a
      // near-miss that would previously have been a silent false??). This is
      // the "?????????" observability ? emitted via debugLog +
      // onPhaseChange, and the onAbort tag lets the TUI render a labeled stop
      // instead of a bare "? Interrupted" (which looked like a user interrupt).
      const stopReason: StopReason = {
        source: convergenceCheck.abortCause === 'no-tool' ? 'no-tool-abort' : 'convergence-abort',
        turn,
        voluntary: false,
        score: convergenceCheck.score,
        level: convergenceCheck.level,
        noToolTurnCount: this.consecutiveNoToolTurns,
        reasoningActive: convergenceCheck.reasoningActive,
      }
      emitStopReason(stopReason, {
        record: r => { this.recordStopReason(r) },
        debug: debugLog,
        onPhaseChange: callbacks.onPhaseChange,
      })
      if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage()
      callbacks.onAbort(stopReasonAbortTag(stopReason))
      return { action: 'abort' }
    }

    return { action: 'proceed' }
  }

  private async _runInner(userInput: string, callbacks: AgentCallbacks, images?: string[]): Promise<void> {
    await this.turnOrchestrator.execute(userInput, callbacks, images)
  }

}
