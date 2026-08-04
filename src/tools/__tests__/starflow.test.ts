import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStarflowTool } from '../starflow.js'
import type { Tool, ToolCallParams, ToolResult } from '../types.js'

// ?? ??????????????? ?????????????????????????????????????????

function fakeTool(name: string, execute: (params: ToolCallParams) => Promise<ToolResult>, calls: ToolCallParams[]): Tool {
  return {
    definition: { name, description: `fake ${name}`, input_schema: { type: 'object', properties: {} } },
    async execute(params) { calls.push(params); return execute(params) },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

const COUNCIL_PASS = ['# ????', '', '```council-plan-json', '{"objective":"plan"}', '```'].join('\n')
const TEAM_PASS = 'team standard??? 2??? 1??? 0'
const GALAXY_PASS = '?? ???????? ? 2/2 ??\n\n????: ???????'

function makeTool(overrides?: { councilResult?: ToolResult }) {
  const cwd = mkdtempSync(join(tmpdir(), 'starflow-tool-'))
  const calls = { council: [] as ToolCallParams[], team: [] as ToolCallParams[], galaxy: [] as ToolCallParams[] }
  const tool = createStarflowTool({
    councilTool: fakeTool('council_convene', async () => overrides?.councilResult ?? { content: COUNCIL_PASS }, calls.council),
    teamTool: fakeTool('team_orchestrate', async () => ({ content: TEAM_PASS }), calls.team),
    galaxyTool: fakeTool('galaxy', async () => ({ content: GALAXY_PASS }), calls.galaxy),
    cwd,
  })
  return { tool, calls, cwd }
}

const DRAFTS = [
  { id: 'impl', title: '??', detail: '??????', files: ['src/auth.ts'] },
  { id: 'review', title: '??', detail: '??????' },
]

const MANY_DRAFTS = [
  ...DRAFTS,
  { id: 'backend', title: 'backend', detail: 'backend logic' },
  { id: 'docs', title: 'docs', detail: 'documentation' },
  { id: 'tests', title: 'tests', detail: 'additional tests' },
]

describe('STARFLOW_TOOL', () => {
  it('confirm ?? ? ????????????????', async () => {
    const { tool, calls } = makeTool()
    const result = await tool.execute({
      toolUseId: 'tu_1',
      cwd: '/repo',
      input: { objective: '?????', draftItems: DRAFTS },
    })

    assert.equal(result.isError, undefined)
    assert.equal(calls.council.length, 0, 'proposal ???? council')
    assert.equal(calls.team.length, 0, 'proposal ???? team')
    assert.equal(calls.galaxy.length, 0, 'proposal ???? galaxy')
    assert.match(result.content, /??????/)
    assert.match(result.content, /council ??/)
    assert.match(result.content, /team ??/)
    assert.match(result.content, /galaxy ?? ? 2 ???/)
    assert.match(result.content, /confirm: true/)
    assert.match(result.uiContent ?? '', /????/)
  })

  it('confirm:false ?? ? ?????', async () => {
    const { tool, calls } = makeTool()
    const result = await tool.execute({
      toolUseId: 'tu_2',
      cwd: '/repo',
      input: { objective: '?????', draftItems: DRAFTS, confirm: false },
    })
    assert.equal(result.isError, undefined)
    assert.equal(calls.council.length + calls.team.length + calls.galaxy.length, 0)
  })

  it('confirm:true ? ?????????????????', async () => {
    const { tool, calls } = makeTool()
    const result = await tool.execute({
      toolUseId: 'tu_3',
      cwd: '/repo',
      input: { objective: '?????', draftItems: DRAFTS, confirm: true },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.equal(calls.council.length, 1)
    assert.equal(calls.team.length, 1)
    assert.equal(calls.galaxy.length, 1)
    assert.equal(result.orchestration?.kind, 'starflow')
    assert.equal(result.orchestration?.phase, 'done')
    assert.equal(result.orchestration?.done, true)
    assert.ok(result.orchestration?.runId)
    assert.ok((result.orchestration?.revision ?? 0) > 0)
    assert.match(result.content, /??????/)
    assert.match(result.content, /??????/)
    assert.match(result.uiContent ?? '', /?????/)
  })

  it('confirm:true ? council ??? ? ?? blocked ??? isError', async () => {
    const { tool, calls } = makeTool({
      councilResult: { content: 'council_convene ????COUNCIL=0??????????', isError: false },
    })
    const result = await tool.execute({
      toolUseId: 'tu_4',
      cwd: '/repo',
      input: { objective: '?????', draftItems: DRAFTS, confirm: true },
    })

    assert.equal(result.isError, true, 'blocked ????????????')
    assert.equal(calls.team.length, 0)
    assert.equal(calls.galaxy.length, 0)
    assert.match(result.content, /????? council ??/)
    assert.match(result.uiContent ?? '', /??? council/)
  })

  it('???? ? format_error?objective ?? / galaxyDims ? 1 ??', async () => {
    const { tool } = makeTool()
    const missing = await tool.execute({ toolUseId: 'tu_5', cwd: '/repo', input: {} })
    assert.equal(missing.isError, true)
    assert.equal(missing.errorKind, 'format_error')
    const oneDim = await tool.execute({
      toolUseId: 'tu_6',
      cwd: '/repo',
      input: { objective: 'x', galaxyDims: [{ name: 'a', objective: 'b' }] },
    })
    assert.equal(oneDim.isError, true)
    assert.equal(oneDim.errorKind, 'format_error')
  })

  it('invalid Galaxy contract is rejected before council/team/galaxy dispatch', async () => {
    const { tool, calls } = makeTool()
    const invalid = await tool.execute({
      toolUseId: 'tu_contract_preflight',
      cwd: '/repo',
      input: {
        objective: 'validate starflow before dispatch',
        galaxyDims: [
          { name: 'review', objective: 'check', authority: 'yaoguang', authorities: ['yaoguang', 'tianji'] },
          { name: 'backend', objective: 'inspect', authority: 'tianji' },
        ],
        confirm: true,
      },
    })

    assert.equal(invalid.isError, true)
    assert.equal(invalid.errorKind, 'format_error')
    assert.match(invalid.content, /Starflow Galaxy contract validation failed|must set either/i)
    assert.equal(calls.council.length + calls.team.length + calls.galaxy.length, 0)
  })

  it('timeoutMs ?????????????????? 10 ???', () => {
    const { tool } = makeTool()
    const budget = tool.timeoutMs?.({ input: { objective: 'x' }, toolUseId: 'tu_7', cwd: '/repo' })
    assert.ok(typeof budget === 'number' && budget > 600_000, `???????? 600s ????? ${budget}`)
  })

  it('autoReview:false removes the extra Galaxy review timeout budget', () => {
    const { tool } = makeTool()
    const galaxyDims = [
      { name: 'impl', objective: 'write', authority: 'tianliang' },
      { name: 'backend', objective: 'inspect', authority: 'tianji' },
    ]
    const withReview = tool.timeoutMs?.({ input: { objective: 'x', galaxyDims, autoReview: true }, toolUseId: 'tu_review_budget', cwd: '/repo' })
    const withoutReview = tool.timeoutMs?.({ input: { objective: 'x', galaxyDims, autoReview: false }, toolUseId: 'tu_no_review_budget', cwd: '/repo' })
    assert.ok(typeof withReview === 'number' && typeof withoutReview === 'number')
    assert.ok(withReview! > withoutReview!)
  })

  it('timeoutMs follows draft-derived dimensions and does not double-count explicit review', () => {
    const { tool } = makeTool()
    const twoDims = tool.timeoutMs?.({
      input: { objective: 'x', draftItems: DRAFTS, autoReview: false },
      toolUseId: 'tu_derived_two',
      cwd: '/repo',
    })
    const fiveDims = tool.timeoutMs?.({
      input: { objective: 'x', draftItems: MANY_DRAFTS, autoReview: false },
      toolUseId: 'tu_derived_five',
      cwd: '/repo',
    })
    assert.ok(typeof twoDims === 'number' && typeof fiveDims === 'number')
    assert.ok(fiveDims! > twoDims!, `five derived dimensions must widen the budget (${fiveDims} vs ${twoDims})`)

    const explicitReview = tool.timeoutMs?.({
      input: { objective: 'x', draftItems: DRAFTS, autoReview: true },
      toolUseId: 'tu_explicit_review',
      cwd: '/repo',
    })
    assert.equal(explicitReview, twoDims, 'a derived review dimension already covers the review wave')
  })

  it('timeoutMs carries derived EP/DP profile, tier, and per-dimension budget inputs', () => {
    const { tool } = makeTool()
    const base = tool.timeoutMs?.({
      input: { objective: 'x', draftItems: DRAFTS, autoReview: false },
      toolUseId: 'tu_budget_base',
      cwd: '/repo',
    })
    const tuned = tool.timeoutMs?.({
      input: {
        objective: 'x',
        autoReview: false,
        galaxyDims: [
          { name: 'impl', objective: 'write', authority: 'tianliang', parallelism: 'data', replicas: 2, tierFloor: 'strong', timeoutMs: 900_000 },
          { name: 'review', objective: 'check', authority: 'yaoguang' },
        ],
      },
      toolUseId: 'tu_budget_tuned',
      cwd: '/repo',
    })
    assert.ok(typeof base === 'number' && typeof tuned === 'number')
    assert.ok(tuned! > base!, `explicit DP/tier/requested budget must widen the timeout (${tuned} vs ${base})`)
  })
})
