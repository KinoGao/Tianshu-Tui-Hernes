import type { StreamClient } from '../api/stream-client.js'
import type { Usage } from '../api/types.js'
import type { CompactionConfig } from '../compact/constants.js'
import { PromptEngine } from '../prompt/engine.js'
import { ToolRegistry } from '../tools/registry.js'
import { AgentLoop } from './loop.js'
import { SessionContext } from './context.js'
import { classifyFailure, isTransient } from './failure-classifier.js'
import {
  buildBlockedWorkerResult,
  clampWorkerMaxTurns,
  classifyWorkerParseError,
  deriveWorkerSessionId,
  parseWorkerResult,
  salvageWorkerResult,
  type WorkOrder,
  type WorkerResult,
} from './work-order.js'
import { toolArgSummary } from '../tui/tool-label.js'
import { buildWorkerPrompt, buildWorkerRepairPrompt, buildFinalizationInstruction, workerOrderHasWriteTools } from './worker-prompts.js'
import { reconcileCapturedWorkerFacts } from './worker-evidence.js'
import { buildWorkerKnowledgeBlock } from './worker-knowledge.js'
import { buildDomainKnowledgeBlock, formatBatchStigmergyBlock } from './domain-knowledge-block.js'
import type { DomainKnowledgeStore } from './domain-knowledge-store.js'
import type { WorkerMailbox } from './worker-mailbox.js'
import { createWorkerMailboxSender } from './worker-mailbox.js'

/** Max transient-retry attempts for network/API errors during worker execution.
 *  Independent of order.budget.maxRetries (which covers output parse failures). */
const MAX_TRANSIENT_RETRIES = 2
const TRANSIENT_BACKOFF_BASE_MS = 2_000

/** Worker read cap (2026-07-24 max-turns ??): workers run compact-disabled
 *  on 1M windows, where the window-derived cap is 120K chars ? one uncapped
 *  full-file read (50K chars observed) stays in history and is re-sent every
 *  turn until the turn budget dies. 16K (~?? cap ? 1/7.5) still fits any
 *  focused offset/limit slice; oversized full reads degrade to the fold
 *  skeleton + navigation hints instead (see read-file.ts), teaching the model
 *  where to re-read precisely. Head/tail split mirrors computeModelReadCap
 *  (60% / 30%, 10% marker buffer). */
const WORKER_READ_CAP: import('../tools/model-read-cap.js').ModelReadCap = {
  maxChars: 16_000,
  headChars: 9_600,
  tailChars: 4_800,
}

/** Checkpoint saved from a previous worker run ? allows Flash workers to resume
 *  from their last successful turn instead of redoing all work on retry. */
export interface WorkerCheckpoint {
  /** 0-based index of the last successfully completed turn. */
  turnIndex: number
  /** Accumulated partial output from completed turns. */
  partialResult: string
  /** Tool calls completed (for audit/dedup). */
  completedTools: string[]
}

export interface WorkerSessionConfig {
  order: WorkOrder
  client: StreamClient
  promptEngine: PromptEngine
  toolRegistry: ToolRegistry
  cwd: string
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
  /** Provider key used for this worker run (e.g. 'deepseek', 'openai'). */
  providerName?: string
  /** Whether to use response_format: json_object on the repair turn (when the
   *  provider supports it) to force valid JSON output. The repair turn is a
   *  tool-free single-shot request, so json_object does not conflict with
   *  function calling (unlike normal turns where tools + json_object cause
   *  duplicate/spurious output). Also gates json_object on the B ????
   *  finalization turn (finalizeWorkerReport) ? same tool-free shape, same
   *  provider-capability semantics. */
  forceJsonRepair?: boolean
  /** B??????????????????????????????????
   *  json_object?? forceJsonRepair ?????????????????????
   *  ?? 2026-07-24 ???????? summary ????? true?undefined ????
   *  coordinator ? RIVET_WORKER_FINALIZE=0 ?? false??????
   *  ??????? JSON??????? */
  finalizeReport?: boolean
  activeClaims?: import('../context/claims.js').ContextClaim[]
  /** Review-router re-entrancy depth propagated to worker tool calls. */
  reviewDepth?: number
  /** Parent abort signal ? propagated to worker AgentLoop for immediate abort. */
  abortSignal?: AbortSignal
  /** Approval mode of the dispatching (parent) session. Only `dangerously-skip-permissions`
   *  is honored here as a downward delegation of trust ? it lets the worker inherit the
   *  parent's opt-out of all prompts. Any other parent mode is ignored; the worker relies on
   *  headless approval semantics (in-workspace writes auto-approved, other asks fast-denied)
   *  rather than the parent's manual/auto-safe gating, since no human is attached to a worker. */
  parentApprovalMode?: import('./loop-types.js').ApprovalMode
  /** V3 Component B: optional per-domain lessons recalled into worker prompt. */
  domainKnowledgeStore?: DomainKnowledgeStore
  /** Liveness signal ? fired on every worker activity (text/thinking/tool)
   *  so the coordinator can feed a stall clock and the UI can show progress.
   *  Without this the worker's internal heartbeat fires into the void.
   *  `detail` carries the tool name for tool events and the delta for text. */
  onActivity?: (kind: WorkerActivityKind, detail?: string) => void
  /** WC: ?????? ? coordinator ??? per-order steer ?? drain?
   *  worker ? AgentLoop ???????????????????
   *  [User guidance] ???? tool_result????? steer ?????? */
  onSteerDrain?: () => string | null
  /** ????????? ? session ????????? getter?coordinator ??
   *  ??? per-order ????? getWorkerLog ??? saveWorkerSession ??
   *  ??????????????/????? session ???????? getter?? */
  onSessionReady?: (getMessages: () => readonly import('../api/oai-types.js').OaiMessage[]) => void
  /** ???????? ? ? worker ???? delegate_task/delegate_batch ??
   *  sub-worker ? DelegationActivity ? worker AgentLoop ?
   *  onDelegationActivity ?????????????????? worker ?
   *  UI ??????coordinator ????? parentWorkerId ??? order id?? */
  onNestedDelegation?: (activity: import('../tools/types.js').DelegationActivity) => void
  /** Resume from a previous checkpoint ? inject partial results as context so
   *  the worker doesn't redo completed work. Especially valuable for multi-turn
   *  Flash workers (test_scaffolder generating multiple files). */
  checkpoint?: WorkerCheckpoint
  /** Structured mailbox for inter-agent communication. Worker tools can send
   *  progress, findings, and escalations through this channel. The coordinator
   *  drains the mailbox after the wave completes. */
  mailbox?: WorkerMailbox
  /** Batch-scoped shared PrewarmCache (delegateBatch ??)???? worker ??
   *  ?????????????????? undefined ? worker ? AgentLoop
   *  ??????? cache???????? delegate ???? */
  prewarm?: import('./prewarm.js').PrewarmCache
  /** Batch-scoped shared StigmergyStore????? #3?delegateBatch ????
   *  ?? worker ????????????? worker ??????????
   *  worker ???prompt ????????? undefined ? worker ???
   *  sessionDir ???? store??????? */
  stigmergy?: import('../context/stigmergy.js').StigmergyStore
  /** Prior conversation history to resume from. When provided, the session is
   *  pre-seeded with these messages before the first agent.run(), so the worker
   *  sees its previous context. The current objective is appended as a new user
   *  message on top of the history. */
  priorMessages?: readonly import('../api/oai-types.js').OaiMessage[]
  /** Per-dispatch nonce mixed into the worker's session id (see
   *  deriveWorkerSessionId) ? batch order ids repeat across delegation runs,
   *  and without the nonce every run appends to the same conversation JSONL.
   *  Set by the coordinator; standalone callers may omit (legacy layout). */
  sessionNonce?: string
}

/** `turn` ????? worker turn ??????detail ??? token ????????
 *  `retry` ??? API ?????????? attempt ????????????
 *  ????? liveness???? stall sweep ??????? ? ???
 *  `lifecycle` ??? coordinator / hands-session ???????????????
 *  ????detail ??????????worker-session ???????
 *  ?finalizeWorkerReport????????? 'finalizing report'???????
 *  AgentLoop???? stall clock ????????????? */
export type WorkerActivityKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'turn' | 'retry' | 'lifecycle'

/** tool_use ???:`name(????)`?toolArgSummary ??????;????
 *  ????????,???????????(?? feed/TUI mirror)??????? */
export function summarizeToolUseLine(name: string, input: unknown): string {
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  let arg = toolArgSummary(name, rec)
  if (!arg) {
    const cand = rec.file_path ?? rec.path ?? rec.pattern ?? rec.query ?? rec.url ?? rec.command ?? rec.objective
    if (typeof cand === 'string' && cand) arg = cand.length > 50 ? `${cand.slice(0, 49)}?` : cand
  }
  return arg ? `${name}(${arg})` : name
}

export interface WorkerTranscript {
  text: string
  thinking: string
  toolUses: string[]
  toolResults: string[]
  errors: string[]
  repairAttempts: number
  /** bash ??? command ??????worker-evidence ????"????"???
   *  ????????VERIFY_BASH_RE?????????/???????? */
  bashCommands?: string[]
  /** ?????isError?? bash ????worker-evidence ????"????"?
   *  "?????"?npm test ????? verified ????????????
   *  ????????????????? */
  failedBashCommands?: string[]
  /** ????edit_file/write_file/hash_edit/apply_patch??????????
   *  worker-evidence ??????????????? changedFiles????
   *  ???/?????????????changedFiles ???????? */
  mutatedFiles?: string[]
}

export interface WorkerSessionRun {
  result: WorkerResult
  transcript: WorkerTranscript
  session: SessionContext
  usage: Usage
  /** Extracted checkpoint when the worker was aborted mid-work ? can be passed
   *  back as config.checkpoint to resume on retry. */
  checkpoint?: WorkerCheckpoint
}

function emptyTranscript(): WorkerTranscript {
  return {
    text: '',
    thinking: '',
    toolUses: [],
    toolResults: [],
    errors: [],
    repairAttempts: 0,
    bashCommands: [],
    failedBashCommands: [],
    mutatedFiles: [],
  }
}

/**
 * Detect streaming-layer tool-call argument pollution from the worker transcript.
 *
 * Signature of the cross-tool pollution bug (openai-client.ts resolveToolCallIndex):
 * a read tool (grep/glob) repeatedly fails with a "required argument missing"
 * error that also names a FOREIGN field ? e.g. grep reporting
 * `Received input keys: file_path, path` (file_path belongs to read_section),
 * or the explicit "streaming tool_call argument pollution" marker grep emits.
 * When the model did the real work but got stuck retrying these poisoned calls,
 * it never reaches the final JSON ? the worker is reported as "Parse failed" /
 * "aborted", masking the upstream streaming root cause.
 *
 * Returns a diagnostic hint to surface in the blocked result so the operator
 * does not chase "model can't output JSON" when the real cause is streaming.
 */
function detectPollutionFailure(transcript: WorkerTranscript): string | null {
  const errs = transcript.errors
  if (errs.length === 0) return null
  // Either the explicit pollution marker (grep.ts), or a "required" error that
  // also names a foreign key (file_path on a non-file tool, etc.).
  const hits = errs.filter(e =>
    e.includes('argument pollution')
    || (/\brequired\b/i.test(e) && /file_path|section|command\b/.test(e) && /pattern|path|glob\b/.test(e)),
  )
  if (hits.length < 2) return null  // a single transient blip is not a pattern
  return `Worker stalled on ${hits.length} streaming-polluted tool calls (foreign arguments grafted onto read tools). The review work above is likely real; the missing JSON is a symptom of the upstream OpenAIClient parallel-tool_call parsing bug, not a model failure. See .rivet/tool-stream-*.jsonl.`
}

/** Stable marker emitted by tool-pipeline's headless deny branch. Kept as a local
 *  const (not imported) to avoid a worker-session ? loop ? tool-pipeline import
 *  cycle; a drift-guard test asserts it matches tool-pipeline.HEADLESS_DENY_MARKER. */
export const HEADLESS_DENY_MARKER = 'not available in a headless worker'

/**
 * Detect approval-deadlock from the worker transcript.
 *
 * A headless worker cannot self-approve write operations that require it. When it
 * hits such a gate, the tool pipeline emits an error tool_result carrying
 * HEADLESS_DENY_MARKER. A small model often responds by emitting an approval
 * request in prose rather than result JSON, so the run ends as "Parse failed" ?
 * masking the real cause (a gated operation, not malformed output).
 *
 * Returns a diagnostic hint to surface in the blocked result so the operator does
 * not chase "model can't output JSON" when the real cause is an approval gate.
 */
export function detectApprovalDeadlock(transcript: WorkerTranscript): string | null {
  const hits = transcript.errors.filter(e => e.includes(HEADLESS_DENY_MARKER))
  if (hits.length === 0) return null
  return `Worker was gated on ${hits.length} approval-required tool call(s) it cannot self-approve as a headless worker. This blocked/parse result is a symptom of the gated operation (the worker likely emitted an approval request in prose), NOT malformed JSON. Fix by giving this profile a non-gated path to the change (e.g. it should already auto-approve in-workspace file writes), or run the task inline in the primary session.`
}

/** Minimal agent surface needed by the retry layer ? injectable so tests can
 *  exercise the real retry?blocked path without constructing a full AgentLoop. */
export interface RunnableAgent {
  run: AgentLoop['run']
}

/** ??? keepalive ?????????? stall ???90s??30s ??? */
let TOOL_KEEPALIVE_MS = 30_000
/** Test-only: shrink the long-tool keepalive cadence so tests don't wait 30s. */
export function __setToolKeepaliveMs(ms: number): void { TOOL_KEEPALIVE_MS = ms }

async function runOnce(
  agent: RunnableAgent,
  prompt: string,
  transcript: WorkerTranscript,
  onActivity?: (kind: WorkerActivityKind, detail?: string) => void,
  onSteerDrain?: () => string | null,
  onDelegationActivity?: (activity: import('../tools/types.js').DelegationActivity) => void,
): Promise<string> {
  let text = ''
  // AgentLoop.run never rethrows stream errors ? it reports them via onError
  // and resolves. Capture and rethrow here so the transient-retry layer above
  // actually sees ECONNRESET/429/timeout instead of an empty transcript.
  let streamError: Error | null = null
  let aborted = false
  // tool id ? bash command?? onToolResult ??????????????
  const bashCommandById = new Map<string, string>()
  // ??? keepalive?tool_use?tool_result ?????????????????
  // ????/??? liveness ??????? stall sweep ???? ? ???
  // finalize ?????????????? 30s ??? lifecycle ???
  // ??????????? stall ?????? budget ?????????????
  // ??????????????????????
  const toolsInFlight = new Map<string, { name: string; since: number }>()
  // ?????????????????? worker ???????????
  // ???? keepalive ??????????????????? TUI ?
  // coordinator ?????????????????????No response??
  let lastActivityAt = Date.now()
  const emitActivity = (kind: WorkerActivityKind, detail?: string): void => {
    lastActivityAt = Date.now()
    onActivity?.(kind, detail)
  }
  const keepalive = setInterval(() => {
    const now = Date.now()
    if (now - lastActivityAt < TOOL_KEEPALIVE_MS) return
    const oldest = toolsInFlight.values().next().value
    if (oldest) {
      const elapsedS = Math.round((now - oldest.since) / 1000)
      emitActivity('lifecycle', `tool still running: ${oldest.name} (${elapsedS}s, ${toolsInFlight.size} in flight)`)
      return
    }
    const elapsedS = Math.round((now - lastActivityAt) / 1000)
    emitActivity('lifecycle', `model request still running: waiting for first response (${elapsedS}s)`)
  }, TOOL_KEEPALIVE_MS)
  keepalive.unref?.()
  try {
  await agent.run(prompt, {
    onTextDelta: (delta) => {
      text += delta
      transcript.text += delta
      emitActivity('text', delta)
    },
    onThinkingDelta: (delta) => {
      transcript.thinking += delta
      emitActivity('thinking', delta)
    },
    onToolUse: (id, name, input) => {
      toolsInFlight.set(id, { name, since: Date.now() })
      transcript.toolUses.push(name)
      const inputRec = input as Record<string, unknown> | undefined
      if (name === 'bash' && typeof inputRec?.command === 'string') {
        const command = (input as { command: string }).command
        ;(transcript.bashCommands ??= []).push(command)
        bashCommandById.set(id, command)
      }
      // ????????????worker-evidence ???????? changedFiles
      // ????????????????worktree ???????????????
      // ????????
      if ((name === 'edit_file' || name === 'write_file' || name === 'hash_edit') && typeof inputRec?.file_path === 'string') {
        ;(transcript.mutatedFiles ??= []).push(inputRec.file_path)
      }
      if (name === 'apply_patch' && typeof inputRec?.diff === 'string') {
        for (const line of inputRec.diff.split('\n')) {
          // ?? diff ? +++ ????????????? +++ /dev/null ?????
          if (line.startsWith('+++ b/')) (transcript.mutatedFiles ??= []).push(line.slice(6).trim())
        }
      }
      // ????????(name(arg))?????? UI / TUI worker mirror ????,
      // ?????????"???????/?????"?
      emitActivity('tool_use', summarizeToolUseLine(name, input))
    },
    onToolResult: (id, name, result, isError) => {
      toolsInFlight.delete(id)
      transcript.toolResults.push(name)
      if (isError) {
        transcript.errors.push(result)
        const failedCommand = bashCommandById.get(id)
        if (failedCommand) (transcript.failedBashCommands ??= []).push(failedCommand)
      }
      emitActivity('tool_result', name)
    },
    // usage ??????getTotalUsage??????? token ???? fleet ???????
    onTurnComplete: (usage) => {
      const total = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
      if (total > 0) emitActivity('turn', String(total))
    },
    // WC: ???? ? drain coordinator ??? per-order steer ??
    onSteerDrain: onSteerDrain ? () => onSteerDrain() : undefined,
    // ?????worker ???? sub-worker ?????tool-pipeline ?????
    // ????? delegate ??? onWorkerActivity?????? worker ??????
    onDelegationActivity,
    onError: (error) => {
      transcript.errors.push(error.message)
      streamError = error
    },
    onAbort: () => {
      transcript.errors.push('Worker aborted')
      aborted = true
    },
    onApprovalRequired: async () => false,
  })
  } finally {
    clearInterval(keepalive)
  }
  // Aborts are a deliberate stop (budget timer / parent signal), not a fault ?
  // return the partial text and let the parse/blocked path handle it.
  if (streamError && !aborted) throw streamError
  return text
}

/**
 * response_format ? provider ????????? provider????
 * supportsResponseFormat:false ? mimo/minimax/longcat ?????????
 * 400??????????? json ??/??????????????????
 * ?????????????????? json ?????
 */
function isResponseFormatRejection(err: Error | undefined): boolean {
  if (!err) return false
  return /response_format|json_object|json.mode|unknown\s+(parameter|field|argument)|unrecognized\s+(parameter|field|argument)|not[-_ ]supported/i.test(err.message)
}

/**
 * Single-shot repair request with response_format: json_object and NO tools.
 *
 * Normal worker turns carry tool definitions, and combining response_format:
 * json_object with tools is a known-broken combination (duplicate JSON, spurious
 * tool_calls, empty content ? see OpenAI community reports). The repair turn,
 * however, only needs the model to re-emit its result as valid JSON from the
 * repair prompt (which embeds the previous broken output). It carries no tools,
 * so json_object is safe here and forces the model to emit parseable JSON,
 * eliminating the most common parse-failure cause (free-text prose / truncation).
 *
 * Bypasses AgentLoop entirely (no tool-calling loop) ? just one client.stream
 * call. Returns the accumulated text ('' on stream error ? caller falls back to
 * the AgentLoop repair path) plus a `rejected` flag telling the caller the
 * provider refused response_format itself, so it can stop offering it.
 */
async function repairWithJsonMode(
  client: StreamClient,
  model: string,
  repairPrompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<{ text: string; rejected: boolean }> {
  let text = ''
  let error: Error | undefined
  await client.stream(
    {
      model,
      messages: [{ role: 'user' as const, content: repairPrompt }],
      max_tokens: maxTokens,
      stream: true,
      // Force JSON output. The repair prompt already mentions "json" (required
      // by DeepSeek/GLM when response_format is set).
      response_format: { type: 'json_object' as const },
    },
    {
      onTextDelta: (delta) => { text += delta },
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: (e) => { error = e },
    },
    signal,
  ).catch((e: unknown) => { error = e as Error })
  return { text: error ? '' : text, rejected: isResponseFormatRejection(error) }
}

/**
 * B?????????????????????????????????????
 *
 * ? repairWithJsonMode ?????? client.stream??? AgentLoop??? turn
 * ????????? messages????????????? 2026-07-24 ? summary
 * ???????????? "No work order context provided" ???????
 * ???? messages = worker ????????? + ?????????????
 * ??????????????????? worker ??? API ?????provider
 * ??????????????????? + ?????
 *
 * response_format: json_object ?? forceJsonRepair ? provider ???provider
 * ???????? json_object ???????? + ?????
 * ???/??? ? ?? ''????????parse ???? / max-turns ????
 *
 * ??????P0??coordinator ?????? provider ??? forceJsonRepair?
 * ? provider ???? response_format?isResponseFormatRejection??????
 * ???????????????????????? json ????? repair ?
 * ???????? provider ????????
 */
async function finalizeWorkerReport(
  config: WorkerSessionConfig,
  session: SessionContext,
  order: WorkOrder,
  hasWriteTools: boolean,
): Promise<string> {
  // ????? AgentLoop????????????????? lifecycle ? stall
  // clock??? delta ? 'text' ???????????????
  config.onActivity?.('lifecycle', 'finalizing report')
  const attempt = async (withJson: boolean): Promise<{ text: string; error?: Error }> => {
    let text = ''
    let error: Error | undefined
    await config.client.stream(
      {
        model: config.promptEngine.getModel(),
        messages: [
          ...session.getMessages(),
          { role: 'user' as const, content: buildFinalizationInstruction(order, hasWriteTools) },
        ],
        // ???????????16384???????????????????
        max_tokens: Math.min(16384, order.budget.maxTokens ?? config.contextWindow),
        stream: true,
        // ?????? "JSON"?DeepSeek/GLM ? response_format ????? json??
        ...(withJson ? { response_format: { type: 'json_object' as const } } : {}),
      },
      {
        onTextDelta: (delta) => { text += delta; config.onActivity?.('text', delta) },
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: () => {},
        onError: (e) => { error = e },
      },
      config.abortSignal,
    ).catch((e: unknown) => { error = e as Error })
    return { text, error }
  }
  let result = await attempt(Boolean(config.forceJsonRepair))
  if (result.error && config.forceJsonRepair && isResponseFormatRejection(result.error)) {
    config.forceJsonRepair = false
    config.onActivity?.('lifecycle', 'provider rejected response_format ? json channel disabled, retrying without')
    result = await attempt(false)
  }
  // ??????????????????parse ???? / max-turns ????
  return result.error || !result.text.trim() ? '' : result.text
}

/** Soft-landing wrap-up steer, delivered ONCE through the per-tool-round steer
 *  drain when the budget soft timer fires. After delivery (or before arming),
 *  the drain passes through to the inner (coordinator) steer queue.
 *  ??????????finalized?B ???????????????????
 *  ?????? worker ???????????????? JSON ???????? */
export function createSoftLandingDrain(
  inner?: () => string | null,
  reportContract: 'inline-json' | 'finalized' = 'inline-json',
): {
  drain: () => string | null
  requestWrapUp: () => void
} {
  let requested = false
  let delivered = false
  const wrapUpSteer = reportContract === 'finalized'
    ? '[budget warning] Less than 25% of your time budget remains. STOP exploring now. Wrap up your findings in prose based on the evidence you already have ? the structured report will be requested separately by the system. Do not start new tool-call chains.'
    : '[budget warning] Less than 25% of your time budget remains. STOP exploring now. Based on the evidence you already have, emit your final report as a single valid JSON object (WorkerResult contract) immediately. Do not start new tool-call chains.'
  return {
    requestWrapUp: () => { requested = true },
    drain: () => {
      if (requested && !delivered) {
        delivered = true
        return wrapUpSteer
      }
      return inner?.() ?? null
    },
  }
}

/** Abort-path salvage ladder: the abort (budget timer / parent signal) may have
 *  landed after the worker already emitted its final report ? or mid-stream
 *  with enough of the report on the wire to recover findings. Full contract
 *  parse first (degraded to unverified evidence), then field-level salvage.
 *  Returns null when nothing usable is present. */
export function salvageAbortedReport(
  latestText: string,
  orderId: string,
  abortSource: 'timeout' | 'caller_aborted',
): WorkerResult | null {
  if (!latestText.trim()) return null
  let parseError: unknown
  try {
    const parsed = parseWorkerResult(latestText, orderId)
    return {
      ...parsed,
      evidenceStatus: parsed.evidenceStatus === 'verified' ? 'unverified' : parsed.evidenceStatus,
      risks: [...parsed.risks, `salvaged after ${abortSource === 'timeout' ? 'budget timeout' : 'parent abort'} ? verification evidence downgraded`],
      failureReason: abortSource,
    }
  } catch (error) {
    parseError = error
    // Fall through to field-level salvage.
  }
  const salvaged = salvageWorkerResult(latestText, orderId, parseError)
  if (!salvaged) return null
  return { ...salvaged, failureReason: abortSource }
}

/** Deterministic handling for a run cut off by maxTurns (2026-07-24 ? summary ??).
 *
 *  When the initial run exhausts its turn budget without a final turn, the
 *  accumulated text is exploratory prose ? NOT a report. The repair ladder is
 *  actively harmful here: `repairWithJsonMode` is a context-free single-shot
 *  request (no conversation history), so the model fabricates a plausible
 *  report like "No work order context provided" ? which then parses cleanly
 *  and masks the real budget failure as a fake missing-context failure
 *  (observed on 5 review workers, 7-21~7-24; see
 *  docs/?????max-turns????read??.md).
 *
 *  Ladder: full contract parse (the report may have landed on the final turn
 *  via soft-landing) ? return null so the caller proceeds normally; else
 *  field-level salvage (honest "salvaged" summary, findings downgraded); else
 *  a structured blocked result whose summary carries the
 *  "max-turns: exhausted without a final turn" marker that
 *  classifyInfraFailure keys on for 'budget' retry-routing. Never repair. */
export function buildMaxTurnsExhaustedResult(
  order: WorkOrder,
  transcript: WorkerTranscript,
  latestText: string,
  maxTurns: number,
): WorkerResult | null {
  let parseError: unknown
  try {
    parseWorkerResult(latestText, order.id)
    return null // ?????????(soft-landing ??)???????
  } catch (error) {
    parseError = error
    // fall through ? the run genuinely ended without a report
  }
  const salvaged = salvageWorkerResult(latestText, order.id, parseError)
  if (salvaged) {
    return {
      ...salvaged,
      risks: [...salvaged.risks, `max-turns: exhausted without a final turn (budget ${maxTurns} turns, ${transcript.toolUses.length} tool calls) ? findings salvaged from a mid-work report, treat as unverified leads`],
      failureReason: 'max_turns',
    }
  }
  const blocked = buildBlockedWorkerResult(
    order,
    `max-turns: exhausted without a final turn. Worker used its full ${maxTurns}-turn budget while still exploring (${transcript.toolUses.length} tool calls issued, no verdict JSON produced). This is a deterministic budget failure ? do NOT trust any prose the model wrote about missing context; re-dispatch with a bigger budget or a narrower scope.`,
    'max_turns',
  )
  return latestText.trim()
    ? {
        ...blocked,
        artifacts: [
          ...blocked.artifacts,
          { kind: 'note' as const, title: 'Max-turns worker partial output', content: latestText.slice(0, 2000) },
        ],
      }
    : blocked
}

/** Run a single agent turn, retrying transient network/API errors with backoff.
 *  Exported for direct testing with an injected mock agent. */
export async function runOnceWithTransientRetry(
  agent: RunnableAgent,
  prompt: string,
  transcript: WorkerTranscript,
  onActivity?: (kind: WorkerActivityKind, detail?: string) => void,
  onSteerDrain?: () => string | null,
  onDelegationActivity?: (activity: import('../tools/types.js').DelegationActivity) => void,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      return await runOnce(agent, prompt, transcript, onActivity, onSteerDrain, onDelegationActivity)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const classified = classifyFailure(message)
      if (classified.retryable && isTransient(classified.class) && attempt < MAX_TRANSIENT_RETRIES) {
        const backoff = TRANSIENT_BACKOFF_BASE_MS * Math.pow(2, attempt)
        transcript.errors.push(`Transient error (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES + 1}): ${message} ? retrying in ${backoff}ms`)
        // ? liveness??????? backoff ??????????????
        // ????? stall sweep ???????? ? ???
        onActivity?.('retry', String(attempt + 1))
        await new Promise<void>(resolve => setTimeout(resolve, backoff))
        continue
      }
      throw err
    }
  }
  // Unreachable, but satisfy TypeScript
  throw new Error('runOnceWithTransientRetry: exhausted retries')
}

export async function runWorkerSession(config: WorkerSessionConfig): Promise<WorkerSessionRun> {
  if (config.activeClaims && config.activeClaims.length > 0) {
    config.promptEngine.updateActiveClaims(config.activeClaims)
  }
  // Build knowledge blocks for prompt injection. Domain lessons are scoped to
  // the worker authority and stay in the worker prompt only; they never mutate
  // the primary session prompt/prefix.
  const knowledgeBlocks = [
    config.activeClaims ? buildWorkerKnowledgeBlock(config.activeClaims) : '',
    config.domainKnowledgeStore && config.order.authority
      ? buildDomainKnowledgeBlock(config.domainKnowledgeStore, config.order.authority)
      : '',
    // ???????????? #3???????? worker ????
    // ??????????????????coordinator ???? opt-in ?
    // ?????? store?
    config.stigmergy ? await formatBatchStigmergyBlock(config.stigmergy) : '',
  ].filter(Boolean)
  // B?????????????????????????????????
  // finalized ?????? shape/?????finalizeReport === false
  // ?RIVET_WORKER_FINALIZE=0?????????inline JSON??????
  const finalizeReport = config.finalizeReport !== false
  const reportContract = finalizeReport ? 'finalized' as const : 'inline-json' as const
  const hasWriteTools = workerOrderHasWriteTools(config.order)
  const baseParts = [...knowledgeBlocks, buildWorkerPrompt(config.order, undefined, { ledgerCwd: config.cwd, reportContract })]
  // Checkpoint resume: inject partial results so the worker doesn't redo completed work
  if (config.checkpoint && config.checkpoint.partialResult) {
    baseParts.push(
      `<checkpoint turn="${config.checkpoint.turnIndex}" tools="${config.checkpoint.completedTools.length}">`,
      'The following work was already completed in a previous run. Do NOT redo it ? continue from where it stopped:',
      config.checkpoint.partialResult,
      '</checkpoint>',
    )
  }
  const prompt = baseParts.join('\n\n')

  const session = new SessionContext()
  // Session resume: pre-seed the conversation history so the worker continues
  // from its previous context. The new objective is then appended as a fresh
  // user message by agent.run() below.
  if (config.priorMessages && config.priorMessages.length > 0) {
    session.replaceMessages([...config.priorMessages])
  }
  config.onSessionReady?.(() => session.getMessages())
  const agent = new AgentLoop({
    client: config.client,
    promptEngine: config.promptEngine,
    toolRegistry: config.toolRegistry,
    // R3.1: honor the per-profile turn budget even for direct callers ? the
    // coordinator already clamps, this guards runWorkerSession used standalone.
    maxTurns: clampWorkerMaxTurns(config.maxTurns, config.order.budget.maxTurns),
    contextWindow: config.contextWindow,
    compact: config.compact,
    // ? read cap:worker ??? + 1M ?????????,????? read
    // ????????? prompt???????????,??? offset/limit?
    readCapOverride: WORKER_READ_CAP,
    sessionId: deriveWorkerSessionId(config.order.id, config.sessionNonce),
    // Headless: no human answers approval prompts for a worker. The tool pipeline
    // auto-approves in-workspace writes (worktree/claim isolation) and fast-denies
    // anything else that would ask, instead of stalling on onApprovalRequired.
    headless: true,
    // Trust downward-delegation: a parent running dangerously-skip-permissions
    // opted out of all prompts, so the worker inherits that. Other parent modes
    // are left unset ? headless semantics govern instead.
    approvalMode: config.parentApprovalMode === 'dangerously-skip-permissions'
      ? 'dangerously-skip-permissions'
      : undefined,
    reviewDepth: config.reviewDepth,
    // B3: the worker knows its own nesting depth, so any delegate_task it
    // issues carries it and the coordinator can cap recursion.
    delegationDepth: config.order.delegationDepth,
    thetaCheckDisabled: true,
    // V3: pin the worker's frozen <star-domain> to order.authority so the
    // structural constant position carries the correct domain identity.
    // authority ??? bindSessionDomain ? `?? 'qiming'` ?????????
    // ?????????????????????? 'auto' ??????
    defaultDomain: config.order.authority,
    // ????????? prewarm?loop.ts ???? createToolExecutionController
    // ????????????????? tool-pipeline ?????????
    prewarm: config.prewarm,
    // ??????? store????? #3???? worker ??????
    // ????? sessionDir?
    stigmergyStore: config.stigmergy,
  }, session, config.cwd)

  // Record the selected model into the worker session JSONL so the actual
  // model used is auditable without opening the .meta.json sidecar.
  const workerModel = config.promptEngine.getModel()
  agent.persist?.appendModelSwitch({ to: workerModel })

  // Create mailbox sender for structured inter-agent communication.
  // Workers report progress, findings, and escalations through this channel;
  // the coordinator drains the mailbox after the wave completes.
  const mbox = config.mailbox
    ? createWorkerMailboxSender(config.mailbox, config.order.id)
    : null

  // Abort latch ? once the budget timer or the parent signal fires, the
  // session must STOP. Each agent.run() creates a fresh AbortController, so
  // without this latch the parse-repair loop below would happily re-run an
  // "aborted" worker with a live signal and keep issuing API calls.
  // `abortSource` records WHICH fired first so the blocked result can carry a
  // machine-readable failureReason (timeout vs caller_aborted ? different
  // recovery strategies for the primary).
  let abortLatched = false
  let abortSource: 'timeout' | 'caller_aborted' | null = null
  const timeoutMs = config.order.budget.timeoutMs
  const timer = setTimeout(() => {
    abortLatched = true
    abortSource ??= 'timeout'
    agent.abort()
  }, timeoutMs)

  // Soft landing ? at ~75% of the budget (or 60s before the hard timer for
  // long budgets), inject ONE wrap-up steer through the per-tool-round drain
  // channel so the worker stops exploring and emits its final report while
  // there is still time. Session 2c1186f5: a scout was hard-killed 37s INTO
  // streaming its final report ? the report was seconds from landing.
  // Cache-safe: the steer is an append-only tail message in the worker's own
  // session (same mechanism as coordinator steerWorker).
  const softLanding = createSoftLandingDrain(config.onSteerDrain, reportContract)
  const steerDrain = softLanding.drain
  const softMs = Math.max(timeoutMs * 0.75, timeoutMs - 60_000)
  const softTimer = softMs > 0 && softMs < timeoutMs
    ? setTimeout(() => { softLanding.requestWrapUp() }, softMs)
    : null

  // Propagate parent abort signal ? when parent aborts, worker must stop
  // immediately instead of waiting for the internal budget timeout.
  const onParentAbort = config.abortSignal
    ? () => { abortLatched = true; abortSource ??= 'caller_aborted'; agent.abort(); clearTimeout(timer) }
    : null
  if (onParentAbort && !config.abortSignal!.aborted) {
    config.abortSignal!.addEventListener('abort', onParentAbort, { once: true })
  }
  const wasAborted = (): boolean => abortLatched || (config.abortSignal?.aborted ?? false)

  try {
    const transcript = emptyTranscript()
    let latestText = await runOnceWithTransientRetry(agent, prompt, transcript, config.onActivity, steerDrain, config.onNestedDelegation)
    mbox?.progress(1, config.order.budget.maxRetries + 1, 'initial run')

    // Max-turns ??????? run ? maxTurns ??????????????
    // ???????2026-07-24 ? summary ?????? buildMaxTurnsExhaustedResult??
    const initialStop = agent.latestStopReason
    const maxTurnsExhausted = initialStop?.source === 'max-turns' && !initialStop.voluntary
    // ??? max-turns ????????????????????? null ??
    // ??????????soft-landing ?????????? parse ???
    const maxTurnsFallback = (): WorkerSessionRun | null => {
      const exhausted = buildMaxTurnsExhaustedResult(
        config.order,
        transcript,
        latestText,
        clampWorkerMaxTurns(config.maxTurns, config.order.budget.maxTurns),
      )
      if (!exhausted) return null
      mbox?.escalate(`Worker exhausted max-turns budget (${transcript.toolUses.length} tool calls, no verdict)`)
      return {
        result: exhausted,
        transcript,
        session,
        usage: session.getTotalUsage(),
        checkpoint: {
          turnIndex: 0,
          partialResult: latestText.slice(0, 8000),
          completedTools: [...transcript.toolUses],
        },
      }
    }

    // Abort ???????/??????????? API????????????
    // ???? worker ????? max-turns ?????????? attempt 0 ?
    // abort ??? salvage ???
    if (!wasAborted()) {
      if (finalizeReport) {
        // B????????????????????????????????
        // ?????????????????max-turns ?????????????
        // ???????????????????????????? max-turns ???
        const reportText = await finalizeWorkerReport(config, session, config.order, hasWriteTools)
        if (reportText) {
          latestText = reportText
        } else if (maxTurnsExhausted) {
          const run = maxTurnsFallback()
          if (run) return run
        }
        // ?????? max-turns?? ???????? parse ???? ? ???
      } else if (maxTurnsExhausted) {
        // ????RIVET_WORKER_FINALIZE=0??max-turns ????????
        // ?? run ? maxTurns ??????????
        const run = maxTurnsFallback()
        if (run) return run
      }
    }

    for (let attempt = 0; attempt <= config.order.budget.maxRetries; attempt++) {
      // Abort wins over repair: never re-run an aborted worker.
      if (wasAborted()) {
        const partialSummary = latestText.slice(0, 500)
        mbox?.escalate(`Worker aborted: ${partialSummary.slice(0, 100)}`)
        // Extract checkpoint for potential resume
        const abortCheckpoint: WorkerCheckpoint = {
          turnIndex: attempt,
          partialResult: latestText.slice(0, 8000),
          completedTools: [...transcript.toolUses],
        }
        // Abort salvage ? the abort may have landed AFTER the worker finished
        // (or nearly finished) its final report. Try the full contract first
        // (degraded to unverified evidence), then field-level salvage, before
        // discarding everything into an empty blocked result.
        const abortSalvaged = salvageAbortedReport(latestText, config.order.id, abortSource ?? 'timeout')
        if (abortSalvaged) {
          return {
            result: abortSalvaged,
            transcript,
            session,
            usage: session.getTotalUsage(),
            checkpoint: abortCheckpoint,
          }
        }
        const pollutionHint = detectPollutionFailure(transcript)
        const approvalHint = detectApprovalDeadlock(transcript)
        return {
          result: {
            ...buildBlockedWorkerResult(
              config.order,
              `Worker aborted (${abortSource === 'caller_aborted' ? 'parent signal' : 'budget timeout'}). Partial output: ${partialSummary}${pollutionHint ? ` ${pollutionHint}` : ''}${approvalHint ? ` ${approvalHint}` : ''}`,
              abortSource ?? 'timeout',
            ),
            artifacts: [
              { kind: 'note' as const, title: 'Aborted worker partial output', content: latestText.slice(0, 2000) },
            ],
          },
          transcript,
          session,
          usage: session.getTotalUsage(),
          checkpoint: abortCheckpoint,
        }
      }
      try {
        // ?????????? transcript ??????????????
        // changedFiles/verification?????????????????????
        const result = reconcileCapturedWorkerFacts(parseWorkerResult(latestText, config.order.id), transcript)
        // Report structured findings back to coordinator
        if (result.findings?.length) {
          for (const f of result.findings.slice(0, 3)) {
            mbox?.reportFinding(f.claim ?? 'finding', 'info', result.changedFiles)
          }
        }
        if (mbox) {
          mbox.progress(config.order.budget.maxRetries + 1, config.order.budget.maxRetries + 1, 'completed')
        }
        return {
          result,
          transcript,
          session,
          usage: session.getTotalUsage(),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        transcript.errors.push(message)
        mbox?.escalate(`Parse failed (attempt ${attempt + 1}): ${message.slice(0, 100)}`)
        if (attempt === config.order.budget.maxRetries) {
          // Terminal tier ladder: repair retries exhausted ? field-level salvage
          // (recover independently parseable findings from the malformed report)
          // ? empty blocked only when nothing is salvageable.
          const salvaged = salvageWorkerResult(latestText, config.order.id, error)
          if (salvaged) {
            mbox?.progress(config.order.budget.maxRetries + 1, config.order.budget.maxRetries + 1, 'parse-salvaged')
            return {
              result: salvaged,
              transcript,
              session,
              usage: session.getTotalUsage(),
            }
          }
          const partialSummary = latestText.slice(0, 300)
          const pollutionHint = detectPollutionFailure(transcript)
          const approvalHint = detectApprovalDeadlock(transcript)
          return {
            result: {
              ...buildBlockedWorkerResult(config.order, `Parse failed after ${attempt + 1} attempts: ${message}. Partial: ${partialSummary}${pollutionHint ? ` ${pollutionHint}` : ''}${approvalHint ? ` ${approvalHint}` : ''}`, 'json_parse'),
              parseErrorKind: classifyWorkerParseError(error) ?? 'json_syntax',
              artifacts: [
                { kind: 'note' as const, title: 'Unparseable worker output', content: latestText.slice(0, 2000) },
              ],
            },
            transcript,
            session,
            usage: session.getTotalUsage(),
          }
        }
        transcript.repairAttempts++
        // JSON-mode repair: provider supports response_format: json_object and
        // the combination is safe here (no tools on this turn). Prefer it over
        // the AgentLoop repair loop ? it directly forces valid JSON output,
        // short-circuiting the most common parse-failure cause.
        if (config.forceJsonRepair && !abortLatched) {
          const repair = await repairWithJsonMode(
            config.client,
            config.promptEngine.getModel(),
            buildWorkerRepairPrompt(config.order, latestText, message),
            // ??????????16384???????????????????????
            Math.min(16384, config.order.budget.maxTokens ?? config.contextWindow),
            config.abortSignal,
          )
          // provider ???? response_format??????? json ?????
          // finalize/repair ??????? finalizeWorkerReport ???????
          if (repair.rejected) config.forceJsonRepair = false
          if (repair.text) {
            latestText = repair.text
            // Skip the AgentLoop repair ? go straight to re-parse at loop top.
            continue
          }
          // json-mode repair produced nothing (stream error) ? fall through to AgentLoop repair
        }
        latestText = await runOnceWithTransientRetry(agent, buildWorkerRepairPrompt(config.order, latestText, message), transcript, config.onActivity, steerDrain, config.onNestedDelegation)
      }
    }

    return {
      result: buildBlockedWorkerResult(config.order, 'Worker result parser exited unexpectedly'),
      transcript,
      session,
      usage: session.getTotalUsage(),
    }
  } finally {
    clearTimeout(timer)
    if (softTimer) clearTimeout(softTimer)
    if (onParentAbort && config.abortSignal) {
      config.abortSignal.removeEventListener('abort', onParentAbort)
    }
  }
}
