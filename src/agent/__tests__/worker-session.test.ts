import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ContentBlock } from '../../api/types.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { SessionContext } from '../context.js'
import { createReadOnlyWorkOrder, type WorkOrder } from '../work-order.js'
import {
  runWorkerSession,
  createSoftLandingDrain,
  detectApprovalDeadlock,
  buildMaxTurnsExhaustedResult,
  HEADLESS_DENY_MARKER,
  __setToolKeepaliveMs,
  type WorkerActivityKind,
  type WorkerSessionConfig,
  type WorkerTranscript,
} from '../worker-session.js'
import { HEADLESS_DENY_MARKER as PIPELINE_HEADLESS_DENY_MARKER } from '../tool-pipeline.js'

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function clientFromTexts(texts: string[]): StreamClient {
  let index = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      const text = texts[Math.min(index, texts.length - 1)]!
      index++
      cb.onTextDelta(text)
      cb.onContentBlock(textBlock(text))
      cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
    }),
  } as unknown as StreamClient
}

function makePromptEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/repo' },
  })
}

function validPacket(workOrderId: string) {
  return JSON.stringify({
    workOrderId,
    status: 'passed',
    summary: 'Worker found one seam.',
    findings: [{ claim: 'AgentLoop is injectable', evidence: 'src/agent/loop.ts constructor', confidence: 'high' }],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: ['Use an independent SessionContext'],
  })
}

describe('runWorkerSession', () => {
  it('runs a headless worker and returns a schema-valid result', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find AgentLoop constructor seams.',
      scope: { files: ['src/agent/loop.ts'] },
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts([validPacket('wo_1')]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.session.getTurnCount(), 1)
    assert.deepEqual(run.transcript.toolUses, [])
  })

  it('uses an independent SessionContext instead of mutating the primary session', async () => {
    const primary = new SessionContext()
    primary.addUserMessage('primary user message')
    const before = primary.getMessages().length

    const order = createReadOnlyWorkOrder({
      id: 'wo_2',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review isolation.',
      scope: {},
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts([validPacket('wo_2')]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(primary.getMessages().length, before)
    assert.ok(run.session.getMessages().length > 0)
  })

  it('recovers without repair when prose contains incidental JSON before the result packet', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_incidental',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find worker result parser seams across coordinator and worker session modules.',
      scope: {},
      budget: { maxRetries: 1 },
    })

    const text = `Observed tool input {"pattern":"WorkerResult"}. Final packet:\n${validPacket('wo_incidental')}`
    const run = await runWorkerSession({
      order,
      client: clientFromTexts([text]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.transcript.repairAttempts, 0)
  })

  it('runs one repair prompt after invalid worker JSON', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_3',
      parentTurnId: 'turn_1',
      kind: 'plan',
      profile: 'planner',
      objective: 'Plan coordinator tests.',
      scope: {},
      budget: { maxRetries: 1 },
    })

    const client = clientFromTexts(['not valid json', validPacket('wo_3')])
    const run = await runWorkerSession({
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      // ????????????????????????????????
      // repairAttempts ?? 0?????????????????? describe ???
      finalizeReport: false,
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.transcript.repairAttempts, 1)
  })

  it('returns blocked after retry budget is exhausted', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_4',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review invalid result handling.',
      scope: {},
      budget: { maxRetries: 0 },
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts(['not valid json']),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'blocked')
    assert.ok(run.result.risks.includes('Worker did not return schema-valid JSON'))
  })

  it('forceJsonRepair sends response_format on the repair request and recovers', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_json',
      parentTurnId: 'turn_1',
      kind: 'plan',
      profile: 'planner',
      objective: 'Plan json repair.',
      scope: {},
      budget: { maxRetries: 1 },
    })

    // Capture whether the repair request carried response_format.
    let sawResponseFormat = false
    let repairCallCount = 0
    const client = {
      stream: mock.fn(async (req: { response_format?: unknown }, cb: StreamCallbacks) => {
        // First call: invalid output (no response_format ? normal turn via AgentLoop).
        // Second call: json-mode repair (response_format set).
        if (req.response_format) {
          sawResponseFormat = true
          repairCallCount++
          cb.onTextDelta(validPacket('wo_json'))
          cb.onContentBlock(textBlock(validPacket('wo_json')))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
          return
        }
        // The AgentLoop also issues calls without response_format; only emit
        // invalid text the first time so repair triggers.
        cb.onTextDelta('definitely not json at all')
        cb.onContentBlock(textBlock('definitely not json at all'))
        cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
      }),
    } as unknown as StreamClient

    const run = await runWorkerSession({
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      forceJsonRepair: true,
      // ?????????????????? response_format???????
      // ? response_format ??????????????????????
      finalizeReport: false,
    })

    assert.equal(run.result.status, 'passed', 'json-mode repair should recover to passed')
    assert.ok(sawResponseFormat, 'repair request must carry response_format: json_object')
    assert.equal(repairCallCount, 1, 'exactly one json-mode repair call')
  })
})

describe('buildMaxTurnsExhaustedResult (2026-07-24 ? summary ??)', () => {
  // classifyInfraFailure (review-coordinator-deps.ts) ? budget ??????
  // blocked summary ???????? review-router ????????????????
  const BUDGET_CLASSIFIER_RE = /max.?turns|exhausted without a final turn/i

  function makeOrder(id: string) {
    return createReadOnlyWorkOrder({
      id,
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review the wiring of the plan approval chain.',
      scope: {},
    })
  }

  function exploringTranscript(toolCalls: number): WorkerTranscript {
    return {
      text: '',
      thinking: '',
      toolUses: Array.from({ length: toolCalls }, (_, i) => (i % 2 === 0 ? 'read_file' : 'grep')),
      toolResults: [],
      errors: [],
      repairAttempts: 0,
    }
  }

  it('????????? ? ?? null?soft-landing ?????????', () => {
    const result = buildMaxTurnsExhaustedResult(makeOrder('wo_mt1'), exploringTranscript(8), validPacket('wo_mt1'), 12)
    assert.equal(result, null)
  })

  it('????? ? ??? budget blocked???????', () => {
    const prose = '????????????? session-manager.ts ? onToolResult??'
    const result = buildMaxTurnsExhaustedResult(makeOrder('wo_mt2'), exploringTranscript(21), prose, 12)
    assert.ok(result, 'expected a structured result')
    assert.equal(result!.status, 'blocked')
    assert.equal(result!.failureReason, 'max_turns')
    assert.match(result!.summary, /max-turns: exhausted without a final turn/)
    assert.match(result!.summary, /21 tool calls/)
    assert.match(result!.summary, BUDGET_CLASSIFIER_RE)
    // ???????? artifact ????? summary??"????"?????
    const note = result!.artifacts.find(a => a.title === 'Max-turns worker partial output')
    assert.ok(note, 'partial output preserved as artifact')
    assert.match(note!.content, /session-manager/)
  })

  it('??? ? blocked ??? partial artifact', () => {
    const result = buildMaxTurnsExhaustedResult(makeOrder('wo_mt3'), exploringTranscript(3), '   ', 12)
    assert.ok(result)
    assert.equal(result!.status, 'blocked')
    assert.equal(result!.failureReason, 'max_turns')
    assert.equal(result!.artifacts.some(a => a.title === 'Max-turns worker partial output'), false)
  })

  it('??????????? ? findings ?? + max_turns ??????????', () => {
    // ?? finding ? "claim": ???? ? ?? JSON.parse ?????? finding ?????
    const malformed = `{
      "workOrderId": "wo_mt4",
      "status": "passed",
      "summary": "wiring ??????",
      "findings": [
        { "claim": "plan_submitted ????", "evidence": "src/server/session-manager.ts:2101", "confidence": "high" },
        { ???????" }
      ],
      "artifacts": [],
      "changedFiles": [],
      "risks": [],
      "nextActions": []
    }`
    const result = buildMaxTurnsExhaustedResult(makeOrder('wo_mt4'), exploringTranscript(15), malformed, 12)
    assert.ok(result)
    assert.equal(result!.failureReason, 'max_turns')
    assert.ok(result!.findings.length >= 1, 'salvaged findings preserved')
    assert.ok(
      result!.risks.some(r => BUDGET_CLASSIFIER_RE.test(r)),
      'budget marker present in risks for classifyInfraFailure routing',
    )
  })
})

describe('detectApprovalDeadlock', () => {
  function transcriptWithErrors(errors: string[]): WorkerTranscript {
    return { text: '', thinking: '', toolUses: [], toolResults: [], errors, repairAttempts: 0 }
  }

  it('drift guard: local marker matches the one tool-pipeline actually emits', () => {
    // worker-session keeps a local copy of the marker to avoid an import cycle;
    // if the two constants drift apart, deadlock detection silently goes blind.
    assert.equal(HEADLESS_DENY_MARKER, PIPELINE_HEADLESS_DENY_MARKER)
  })

  it('returns null when no headless denial appears in the transcript', () => {
    assert.equal(detectApprovalDeadlock(transcriptWithErrors([])), null)
    assert.equal(detectApprovalDeadlock(transcriptWithErrors(['some other tool error'])), null)
  })

  it('names the approval gate when headless denials are present', () => {
    const hint = detectApprovalDeadlock(transcriptWithErrors([
      `Tool "run_migration" is ${HEADLESS_DENY_MARKER}: it requires an approval that no human can grant in this context.`,
      'unrelated error',
      `Tool "run_migration" is ${HEADLESS_DENY_MARKER}: it requires an approval that no human can grant in this context.`,
    ]))
    assert.ok(hint, 'expected a diagnostic hint')
    assert.match(hint!, /2 approval-required tool call/)
    assert.match(hint!, /NOT malformed JSON/)
  })
})


describe('mutatedFiles capture (???? changedFiles)', () => {
  function toolUseBlock(id: string, name: string, input: Record<string, unknown>): ContentBlock {
    return { type: 'tool_use', id, name, input }
  }

  /** ????? tool_use???????loop ??????????? JSON? */
  function clientWithToolUses(uses: Array<{ id: string; name: string; input: Record<string, unknown> }>, finalText: string): StreamClient {
    let index = 0
    const turns = [...uses, null]
    return {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        const use = turns[Math.min(index, turns.length - 1)]
        index++
        if (use) {
          cb.onContentBlock(toolUseBlock(use.id, use.name, use.input))
          cb.onStopReason('tool_use', { input_tokens: 10, output_tokens: 5 })
        } else {
          cb.onTextDelta(finalText)
          cb.onContentBlock(textBlock(finalText))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        }
      }),
    } as unknown as StreamClient
  }

  it('captures edit_file/write_file/hash_edit file_path and apply_patch diff targets', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_mut',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Exercise mutatedFiles capture.',
      scope: {},
    })

    const run = await runWorkerSession({
      order,
      client: clientWithToolUses([
        { id: 'tu_1', name: 'edit_file', input: { file_path: 'src/edited.ts' } },
        { id: 'tu_2', name: 'write_file', input: { file_path: 'src/written.ts' } },
        { id: 'tu_3', name: 'hash_edit', input: { file_path: 'src/hashed.ts' } },
        {
          id: 'tu_4',
          name: 'apply_patch',
          input: {
            diff: [
              '--- a/src/patched.ts',
              '+++ b/src/patched.ts',
              '@@ -1 +1 @@',
              '--- a/src/deleted.ts',
              '+++ /dev/null',
            ].join('\n'),
          },
        },
      ], validPacket('wo_mut')),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 8,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    // /dev/null?????? +++ ???????
    assert.deepEqual(run.transcript.mutatedFiles, ['src/edited.ts', 'src/written.ts', 'src/hashed.ts', 'src/patched.ts'])
    // ?????? reconcile????????????? changedFiles?
    assert.deepEqual(run.result.changedFiles, ['src/edited.ts', 'src/written.ts', 'src/hashed.ts', 'src/patched.ts'])
  })

  it('ignores write tools without a string file_path', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_mut_empty',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Exercise mutatedFiles capture guards.',
      scope: {},
    })

    const run = await runWorkerSession({
      order,
      client: clientWithToolUses([
        { id: 'tu_1', name: 'edit_file', input: { old_text: 'a', new_text: 'b' } },
        { id: 'tu_2', name: 'read_file', input: { file_path: 'src/read-only.ts' } },
      ], validPacket('wo_mut_empty')),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 6,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.deepEqual(run.transcript.mutatedFiles, [])
  })
})


/** ?????B????????????????????????????
 *  ??????????????abort ????max-turns ???????
 *  ??????????parse ???????? */
describe('worker finalization turn (B?????)', () => {
  interface CapturedRequest {
    messages: Array<{ role: string; content: unknown }>
    tools?: unknown
    response_format?: unknown
  }

  type ScriptEntry = string | { toolUse: { id: string; name: string; input: Record<string, unknown> } }

  /** ?????????? client????????? messages/tools/response_format?
   *  ?????????????????????? clientFromTexts ????? */
  function capturingClient(script: ScriptEntry[]) {
    const requests: CapturedRequest[] = []
    let index = 0
    const client = {
      stream: mock.fn(async (req: CapturedRequest, cb: StreamCallbacks) => {
        requests.push(req)
        const entry = script[Math.min(index, script.length - 1)]!
        index++
        if (typeof entry === 'string') {
          if (entry) {
            cb.onTextDelta(entry)
            cb.onContentBlock(textBlock(entry))
          }
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        } else {
          cb.onContentBlock({ type: 'tool_use', id: entry.toolUse.id, name: entry.toolUse.name, input: entry.toolUse.input } as ContentBlock)
          cb.onStopReason('tool_use', { input_tokens: 10, output_tokens: 5 })
        }
      }),
    } as unknown as StreamClient
    return { client, requests }
  }

  function finalizeConfig(order: WorkOrder, client: StreamClient, over: Partial<WorkerSessionConfig> = {}): WorkerSessionConfig {
    return {
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      ...over,
    }
  }

  function scoutOrder(id: string, budget?: { maxTurns?: number; maxRetries?: number }): WorkOrder {
    return createReadOnlyWorkOrder({
      id,
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find the finalization seam.',
      scope: {},
      budget,
    })
  }

  function messageTexts(req: CapturedRequest): string {
    return req.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
  }

  it('?????????????????? tools?json_object ? forceJsonRepair', async () => {
    const order = scoutOrder('wo_fin')
    const { client, requests } = capturingClient([
      'I read src/agent/loop.ts and found the constructor seam.', // ???? JSON ??
      validPacket('wo_fin'), // ???????
    ])
    const activities: Array<[WorkerActivityKind, string | undefined]> = []
    const run = await runWorkerSession(finalizeConfig(order, client, {
      forceJsonRepair: true,
      onActivity: (kind, detail) => activities.push([kind, detail]),
    }))

    assert.equal(run.result.status, 'passed', '????? JSON ????????????')
    assert.equal(requests.length, 2, '????????? + ??')
    const finalizeReq = requests[1]!
    // ???????
    const last = finalizeReq.messages.at(-1)!
    assert.equal(last.role, 'user')
    assert.ok(String(last.content).includes('?? ID???????wo_fin'), '????????')
    assert.ok(String(last.content).includes('?????????????????????'))
    // ??????????????????? worker ???????
    assert.deepEqual(
      finalizeReq.messages.slice(0, -1),
      run.session.getMessages(),
      '??? messages ?????? worker ??????????? + ???????',
    )
    // ? tools?json_object ? forceJsonRepair ?
    assert.equal(finalizeReq.tools, undefined, '????? tools')
    assert.deepEqual(finalizeReq.response_format, { type: 'json_object' })
    // ?????? finalized ???????????? JSON?
    assert.ok(messageTexts(requests[0]!).includes('???????? JSON'), '???????? finalized ??')
    // ???????? lifecycle?delta ?? text?stall clock ????
    assert.ok(activities.some(([k, d]) => k === 'lifecycle' && d === 'finalizing report'))
    assert.ok(activities.some(([k]) => k === 'text'))
  })

  it('forceJsonRepair ?????????? json_object ????????+????', async () => {
    const order = scoutOrder('wo_fin_gate')
    const { client, requests } = capturingClient(['exploration prose', validPacket('wo_fin_gate')])
    const run = await runWorkerSession(finalizeConfig(order, client))

    assert.equal(run.result.status, 'passed')
    assert.equal(requests.length, 2)
    assert.equal(requests[1]!.response_format, undefined, 'provider ?????? response_format')
    assert.equal(requests[1]!.tools, undefined, '???????')
    assert.ok(String(requests[1]!.messages.at(-1)!.content).includes('?? ID'), '??????')
  })

  it('provider ?? response_format?????????????????? json ??', async () => {
    const order = scoutOrder('wo_probe')
    const requests: CapturedRequest[] = []
    let call = 0
    const client = {
      stream: mock.fn(async (req: CapturedRequest, cb: StreamCallbacks) => {
        requests.push(req)
        call++
        if (call === 1) {
          // ??????? JSON
          cb.onTextDelta('exploration prose')
          cb.onContentBlock(textBlock('exploration prose'))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        } else if (call === 2) {
          // ???? response_format???? provider ?? 400 ??????
          cb.onError(new Error('HTTP 400: Unknown parameter: `response_format` is not supported'))
        } else {
          // ??????? response_format?????????
          cb.onTextDelta(validPacket('wo_probe'))
          cb.onContentBlock(textBlock(validPacket('wo_probe')))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        }
      }),
    } as unknown as StreamClient
    const activities: Array<[WorkerActivityKind, string | undefined]> = []
    const config = finalizeConfig(order, client, {
      forceJsonRepair: true,
      onActivity: (kind, detail) => activities.push([kind, detail]),
    })
    const run = await runWorkerSession(config)

    assert.equal(run.result.status, 'passed', '???????????????????')
    assert.equal(requests.length, 3, '?? + ???? + ? response_format ??')
    assert.deepEqual(requests[1]!.response_format, { type: 'json_object' }, '??????? json_object')
    assert.equal(requests[2]!.response_format, undefined, '??????? response_format ??')
    assert.equal(config.forceJsonRepair, false, '????? json ?????? repair ?????')
    assert.ok(activities.some(([k, d]) => k === 'lifecycle' && String(d).includes('rejected response_format')))
  })

  it('?????? response_format ???json ??????', async () => {
    const order = scoutOrder('wo_probe_net')
    // ????????? response_format ???? ???????????
    const requests: CapturedRequest[] = []
    let call = 0
    const client = {
      stream: mock.fn(async (req: CapturedRequest, cb: StreamCallbacks) => {
        requests.push(req)
        call++
        if (call === 1) {
          const natural = JSON.stringify({
            workOrderId: 'wo_probe_net',
            status: 'passed',
            summary: 'report from exploration text after finalize network failure',
            findings: [],
            artifacts: [],
            changedFiles: [],
            risks: [],
            nextActions: [],
          })
          cb.onTextDelta(natural)
          cb.onContentBlock(textBlock(natural))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        } else {
          cb.onError(new Error('socket hang up'))
        }
      }),
    } as unknown as StreamClient
    const config = finalizeConfig(order, client, { forceJsonRepair: true })
    const run = await runWorkerSession(config)

    assert.equal(requests.length, 2, '??????????? parse ?????')
    assert.equal(config.forceJsonRepair, true, '??????? json ??')
    assert.equal(run.result.status, 'passed')
  })

  it('???? parse ?? ? ???????', async () => {
    const order = scoutOrder('wo_fin_repair', { maxRetries: 1 })
    const { client, requests } = capturingClient([
      'exploration prose, no JSON',
      'finalized but still not json', // ???????
      validPacket('wo_fin_repair'), // ?????
    ])
    const run = await runWorkerSession(finalizeConfig(order, client))

    assert.equal(run.result.status, 'passed')
    assert.equal(run.transcript.repairAttempts, 1, '???????????')
    assert.equal(requests.length, 3, '?? + ?? + ??')
  })

  it('????? ? ??????parse ?????', async () => {
    const order = scoutOrder('wo_fin_empty')
    const natural = JSON.stringify({
      workOrderId: 'wo_fin_empty',
      status: 'passed',
      summary: 'report recovered from exploration text',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
    })
    const { client, requests } = capturingClient([natural, '   ']) // ?????
    const run = await runWorkerSession(finalizeConfig(order, client))

    assert.equal(run.result.status, 'passed')
    assert.equal(run.result.summary, 'report recovered from exploration text', '????????????')
    assert.equal(requests.length, 2, '??????????')
    assert.equal(run.transcript.repairAttempts, 0, '??????????????')
  })

  it('max-turns ????? ? ?????????????? blocked?', async () => {
    const order = scoutOrder('wo_fin_mt', { maxTurns: 1, maxRetries: 0 })
    const { client, requests } = capturingClient([
      { toolUse: { id: 'tu_1', name: 'grep', input: { pattern: 'seam' } } }, // ?????????
      validPacket('wo_fin_mt'), // ???????
    ])
    const run = await runWorkerSession(finalizeConfig(order, client, { maxTurns: 1 }))

    assert.equal(run.result.status, 'passed', '?????????')
    assert.equal(run.result.failureReason, undefined, '???? max_turns')
    assert.equal(requests.length, 2, '?? 1 ? + ?? 1 ????????? blocked?')
  })

  it('max-turns ????? + ???? ? ????? max-turns ??', async () => {
    const order = scoutOrder('wo_fin_mt_fail', { maxTurns: 1, maxRetries: 0 })
    const { client, requests } = capturingClient([
      { toolUse: { id: 'tu_1', name: 'grep', input: { pattern: 'seam' } } },
      '', // ?????/?
    ])
    const run = await runWorkerSession(finalizeConfig(order, client, { maxTurns: 1 }))

    assert.equal(run.result.status, 'blocked')
    assert.equal(run.result.failureReason, 'max_turns')
    assert.match(run.result.summary, /max-turns: exhausted without a final turn/)
    assert.equal(requests.length, 2, '??????????????')
  })

  it('abort ? ????????abort ?????', async () => {
    const order = scoutOrder('wo_fin_abort', { maxRetries: 1 })
    const controller = new AbortController()
    let streamCalls = 0
    // ???? abort ??????? fault-client ? idle_stall?
    const client = {
      stream: mock.fn(async (_req: unknown, _cb: StreamCallbacks, signal?: AbortSignal) => {
        streamCalls++
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) return reject(new Error('aborted'))
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }),
    } as unknown as StreamClient
    const p = runWorkerSession(finalizeConfig(order, client, { abortSignal: controller.signal }))
    setTimeout(() => controller.abort(), 50)
    const run = await p

    assert.equal(run.result.status, 'blocked')
    assert.equal(run.result.failureReason, 'caller_aborted')
    assert.equal(streamCalls, 1, 'abort ???? API????????')
  })

  it('finalizeReport: false ? ??????inline ??????????????', async () => {
    const order = scoutOrder('wo_fin_off', { maxRetries: 1 })
    const { client, requests } = capturingClient(['prose, no json', validPacket('wo_fin_off')])
    const run = await runWorkerSession(finalizeConfig(order, client, { finalizeReport: false }))

    assert.equal(run.result.status, 'passed')
    assert.equal(run.transcript.repairAttempts, 1, '????parse ??????')
    assert.equal(requests.length, 2, '??????? + ??')
    for (const req of requests) {
      assert.ok(!String(req.messages.at(-1)!.content).includes('?????????????????????'), '???????????')
    }
    assert.ok(messageTexts(requests[0]!).includes('????? JSON ??'), '?????? inline ??')
  })

  it('soft-landing steer ?????', () => {
    const finalized = createSoftLandingDrain(undefined, 'finalized')
    finalized.requestWrapUp()
    const steer = finalized.drain()
    assert.ok(steer?.includes('requested separately'), 'finalized??????????')
    assert.ok(!steer!.includes('emit your final report as a single valid JSON object'), 'finalized ????? JSON')

    const inline = createSoftLandingDrain()
    inline.requestWrapUp()
    assert.ok(inline.drain()?.includes('emit your final report as a single valid JSON object'), 'inline ??????')
  })
})

describe('worker doom-loop gate??????worker ????????????', () => {
  it('worker ?????????? doom ??????????', async () => {
    let executeCount = 0
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'grep', description: 'fake grep', input_schema: { type: 'object', properties: {} } },
      execute: async () => { executeCount++; return { content: 'boom: pattern exploded', isError: true } },
      requiresApproval: () => false,
      isConcurrencySafe: () => true,
      isEnabled: () => true,
    } as never)
    let toolCallSeq = 0
    const client = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        // ??????????????????doom-loop ???????
        // doom ??? ? ???????????executeCount ?? ~7?
        // ??? ? ???????executeCount ?? maxTurns?
        toolCallSeq++
        cb.onContentBlock({ type: 'tool_use', id: `tu_${toolCallSeq}`, name: 'grep', input: { pattern: 'same-pattern' } } as ContentBlock)
        cb.onStopReason('tool_use', { input_tokens: 10, output_tokens: 5 })
      }),
    } as unknown as StreamClient
    const order = createReadOnlyWorkOrder({
      id: 'wo_doom', parentTurnId: 'turn_1', kind: 'code_search', profile: 'code_scout',
      objective: 'Probe doom gate wiring in worker.', scope: {},
      budget: { maxTurns: 15, maxRetries: 0 },
    })
    await runWorkerSession({
      order, client, promptEngine: makePromptEngine(), toolRegistry: registry,
      cwd: '/repo', maxTurns: 15, contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })
    assert.ok(
      executeCount <= 8,
      `doom ??? ~7 ?????????????? ${executeCount} ??maxTurns=15???worker ??????`,
    )
  })
})

describe('worker long-tool keepalive?P0-3?tool_use?tool_result ????????', () => {
  it('?????????? lifecycle ??? liveness', async () => {
    __setToolKeepaliveMs(15)
    try {
      const registry = new ToolRegistry()
      registry.register({
        definition: { name: 'slow_probe', description: 'fake slow tool', input_schema: { type: 'object', properties: {} } },
        execute: async () => { await new Promise((r) => setTimeout(r, 120)); return { content: 'done' } },
        requiresApproval: () => false,
        isConcurrencySafe: () => true,
        isEnabled: () => true,
      } as never)
      let call = 0
      const client = {
        stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
          call++
          if (call === 1) {
            cb.onContentBlock({ type: 'tool_use', id: 'tu_slow', name: 'slow_probe', input: {} } as ContentBlock)
            cb.onStopReason('tool_use', { input_tokens: 10, output_tokens: 5 })
          } else {
            cb.onTextDelta(validPacket('wo_keep'))
            cb.onContentBlock(textBlock(validPacket('wo_keep')))
            cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
          }
        }),
      } as unknown as StreamClient
      const order = createReadOnlyWorkOrder({
        id: 'wo_keep', parentTurnId: 'turn_1', kind: 'code_search', profile: 'code_scout',
        objective: 'Probe keepalive during a slow tool.', scope: {},
        budget: { maxTurns: 4, maxRetries: 0 },
      })
      const activities: Array<[WorkerActivityKind, string | undefined]> = []
      const run = await runWorkerSession({
        order, client, promptEngine: makePromptEngine(), toolRegistry: registry,
        cwd: '/repo', maxTurns: 4, contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        onActivity: (kind, detail) => activities.push([kind, detail]),
      })
      assert.equal(run.result.status, 'passed')
      const beats = activities.filter(([k, d]) => k === 'lifecycle' && String(d).startsWith('tool still running: slow_probe'))
      assert.ok(beats.length >= 2, `120ms ???? + 15ms ???????????? ${beats.length} ?`)
    } finally {
      __setToolKeepaliveMs(30_000)
    }
  })

  it('??????????? lifecycle ??', async () => {
    __setToolKeepaliveMs(15)
    try {
      let calls = 0
      const client = {
        stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
          calls++
          await new Promise(resolve => setTimeout(resolve, 70))
          cb.onTextDelta(validPacket('wo_first_byte'))
          cb.onContentBlock(textBlock(validPacket('wo_first_byte')))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        }),
      } as unknown as StreamClient
      const order = createReadOnlyWorkOrder({
        id: 'wo_first_byte', parentTurnId: 'turn_1', kind: 'code_search', profile: 'code_scout',
        objective: 'Probe first-byte keepalive.', scope: {}, budget: { maxTurns: 1, maxRetries: 0 },
      })
      const activities: Array<[WorkerActivityKind, string | undefined]> = []
      const run = await runWorkerSession({
        order, client, promptEngine: makePromptEngine(), toolRegistry: new ToolRegistry(),
        cwd: '/repo', maxTurns: 1, contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        finalizeReport: false,
        onActivity: (kind, detail) => activities.push([kind, detail]),
      })
      assert.equal(calls, 1)
      assert.equal(run.result.status, 'passed')
      assert.ok(
        activities.some(([kind, detail]) => kind === 'lifecycle' && String(detail).includes('waiting for first response')),
        'provider first-byte wait must be visible as a lifecycle heartbeat',
      )
    } finally {
      __setToolKeepaliveMs(30_000)
    }
  })
})
