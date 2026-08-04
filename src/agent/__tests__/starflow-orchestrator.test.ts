import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveGalaxyDims,
  nextWaveOf,
  runStarflow,
  starflowStatePath,
  __setStarflowHeartbeatMs,
  type StarflowDeps,
  type StarflowInput,
  type StarflowSeat,
} from '../starflow-orchestrator.js'
import { formatTeamSummary } from '../../tools/team-orchestrate.js'
import type { Tool, ToolCallParams, ToolResult } from '../../tools/types.js'
import type { TeamOrchestrationOutcome } from '../orchestration-outcome.js'

// ?? ???????? ??????????????????????????????????????????????????????

type ExecuteFn = (params: ToolCallParams) => Promise<ToolResult>

function fakeTool(name: string, execute: ExecuteFn, calls: ToolCallParams[]): Tool {
  return {
    definition: { name, description: `fake ${name}`, input_schema: { type: 'object', properties: {} } },
    async execute(params) { calls.push(params); return execute(params) },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

/** council ????????? planJson????? council-convene.ts ?????? */
function councilPassContent(planJson = '{"objective":"plan"}'): string {
  return ['# ????', '', '???????', '', '```council-plan-json', planJson, '```', '', '? ???????'].join('\n')
}

function teamPassContent(nextWave?: number): string {
  const lines = ['team standard??? 2??? 1??? 0', '???', '  wave-0 [low] T1 ? ????', '', '<packet/>']
  if (nextWave !== undefined) {
    lines.push('', `????? diff ??????????? team_orchestrate ?? fromWave: ${nextWave}?`)
  }
  return lines.join('\n')
}

function galaxyPassContent(): string {
  return ['?? ???????? ? 3/3 ??', '', '  impl ??: ? ??', '', '????: ???????'].join('\n')
}

function galaxyFailContent(): string {
  return [
    '?? ???????? ? 2/4 ??', '',
    '  frontend ??: ? ??????', '',
    '  review ??: ? ??????', '',
    '  docs ??: ? ??', '',
    '????: 2/4 ???????????????????????????',
  ].join('\n')
}

/** ??????content ???????????????? orchestration ???
 *  ??????????? Phase 1 ???????????????????? */
function structuredTeam(over: Partial<TeamOrchestrationOutcome> = {}): ToolResult {
  return {
    content: '??????????????',
    orchestration: {
      kind: 'team', dispatched: 2, wave: 0, totalWaves: 1,
      workers: { total: 2, passed: 2 }, ...over,
    },
  }
}

function makeDeps(overrides: {
  council?: ExecuteFn
  team?: ExecuteFn
  galaxy?: ExecuteFn
  cwd?: string
}): { deps: StarflowDeps; calls: { council: ToolCallParams[]; team: ToolCallParams[]; galaxy: ToolCallParams[] }; cwd: string } {
  const cwd = overrides.cwd ?? mkdtempSync(join(tmpdir(), 'starflow-orch-'))
  const calls = { council: [] as ToolCallParams[], team: [] as ToolCallParams[], galaxy: [] as ToolCallParams[] }
  const deps: StarflowDeps = {
    councilTool: fakeTool('council_convene', overrides.council ?? (async () => ({ content: councilPassContent() })), calls.council),
    teamTool: fakeTool('team_orchestrate', overrides.team ?? (async () => ({ content: teamPassContent() })), calls.team),
    galaxyTool: fakeTool('galaxy', overrides.galaxy ?? (async () => ({ content: galaxyPassContent() })), calls.galaxy),
    cwd,
    params: { input: {}, toolUseId: 'tu_starflow', cwd },
  }
  return { deps, calls, cwd }
}

const TWO_DRAFTS = [
  { id: 'impl', title: '??????', detail: '??????????', files: ['src/core.ts'] },
  { id: 'review', title: '????', detail: '??????????', files: ['src/core.ts'] },
]

function baseInput(overrides?: Partial<StarflowInput>): StarflowInput {
  return { objective: '????????', draftItems: TWO_DRAFTS, ...overrides }
}

// ?? ?? ?????????????????????????????????????????????????????????????????

describe('STARFLOW_ORCHESTRATOR', () => {
  it('long phase emits a concrete phase heartbeat to the parent tool stream', async () => {
    __setStarflowHeartbeatMs(10)
    try {
      const outputs: string[] = []
      const { deps } = makeDeps({
        team: async () => {
          await new Promise(resolve => setTimeout(resolve, 35))
          return { content: teamPassContent() }
        },
      })
      deps.params.onOutput = chunk => outputs.push(chunk)
      await runStarflow(deps, baseInput())
      assert.ok(outputs.some(line => /?? ? team ?????/.test(line)), 'team phase heartbeat should be streamed')
    } finally {
      __setStarflowHeartbeatMs(10_000)
    }
  })

  it('??????council?team?galaxy?deliver?????????????', async () => {
    const { deps, calls, cwd } = makeDeps({})
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'done')
    assert.equal(calls.council.length, 1)
    assert.equal(calls.team.length, 1)
    assert.equal(calls.galaxy.length, 1)
    // council ????? confirm:true?team ?? council ??? planJson
    assert.equal(calls.council[0]!.input.confirm, true)
    assert.deepEqual(calls.council[0]!.input.draftItems, TWO_DRAFTS)
    assert.equal(calls.team[0]!.input.planJson, '{"objective":"plan"}')
    // galaxy ??? draftItems ??
    const dims = calls.galaxy[0]!.input.dimensions as Array<{ name: string; authority: string }>
    assert.deepEqual(dims.map(d => d.name), ['impl', 'review'])
    assert.deepEqual(dims.map(d => d.authority), ['tianliang', 'yaoguang'])
    // ?????objective ?????phase=done
    const statePath = starflowStatePath(cwd, '????????')
    assert.ok(existsSync(statePath), '???????')
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(saved.phase, 'done')
    assert.equal(saved.phases.council.status, 'passed')
    assert.equal(saved.phases.team.status, 'passed')
    assert.equal(saved.phases.galaxy.status, 'passed')
    assert.equal(typeof saved.phases.council.elapsedMs, 'number')
    assert.equal(typeof saved.phases.team.elapsedMs, 'number')
    assert.ok(saved.phases.team.rawPath, 'phase output should have a durable fallback report')
    assert.match(readFileSync(saved.phases.team.rawPath, 'utf8'), /team standard/)
    assert.ok(saved.updatedAt > 0)
    assert.equal(typeof saved.runId, 'string')
    // M1??? checkpoint?? 0 ??? saveState ???+ ?????? = 5 ????
    // revision ????????????????? + ?????????????
    // ??? blocked/resume ?????????? M1 ??????
    assert.equal(saved.revision, 5, 'checkpoint ?? = 4 ?? + 1 ????')
    // ????????? + deliver_task ??
    assert.match(run.report, /??????/)
    assert.match(run.report, /deliver_task/)
    assert.match(run.report, /?? 1 council ????/)
  })

  it('???????????? lease ????????????? checkpoint', async () => {
    const first = makeDeps({})
    let releaseTeam!: () => void
    let teamStarted!: () => void
    const started = new Promise<void>(resolve => { teamStarted = resolve })
    const hold = new Promise<void>(resolve => { releaseTeam = resolve })
    first.deps.teamTool = fakeTool('team_orchestrate', async () => {
      teamStarted()
      await hold
      return { content: teamPassContent() }
    }, first.calls.team)

    const firstPromise = runStarflow(first.deps, baseInput())
    await started

    const second = makeDeps({ cwd: first.cwd })
    const secondRun = await runStarflow(second.deps, baseInput())
    assert.equal(secondRun.state.phase, 'council')
    assert.match(secondRun.state.blockedReason ?? '', /another Starflow run/i)
    assert.equal(second.calls.council.length + second.calls.team.length + second.calls.galaxy.length, 0)

    releaseTeam()
    const firstRun = await firstPromise
    assert.equal(firstRun.state.phase, 'done')
  })

  it('???????????????????????????', async () => {
    const { deps, cwd } = makeDeps({
      council: async () => { throw new Error('provider first-byte timeout') },
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'council')
    assert.equal(run.state.phases.council?.status, 'blocked')
    const rawPath = run.state.phases.council?.rawPath
    assert.ok(rawPath, 'phase error should have a durable raw report path')
    assert.match(readFileSync(rawPath!, 'utf8'), /provider first-byte timeout/)
    assert.ok(existsSync(starflowStatePath(cwd, '????????')))
  })

  it('??? resume ?????????????? checkpoint ???????', async () => {
    const first = makeDeps({})
    first.deps.params.sessionId = 'session-old'
    const firstRun = await runStarflow(first.deps, baseInput())
    assert.equal(firstRun.state.phase, 'done')
    assert.ok(existsSync(starflowStatePath(first.cwd, '????????', 'session-old')))

    const second = makeDeps({ cwd: first.cwd })
    second.deps.params.sessionId = 'session-new'
    const secondRun = await runStarflow(second.deps, baseInput({ resume: true }))
    assert.equal(secondRun.state.phase, 'done')
    assert.equal(second.calls.council.length, 0)
    assert.equal(second.calls.team.length, 0)
    assert.equal(second.calls.galaxy.length, 0)
    assert.ok(existsSync(starflowStatePath(first.cwd, '????????', 'session-new')))
  })

  it('council ???blocking challenge ????? blocked???????team/galaxy ???', async () => {
    const veto = ['# ????', '', '## ? ??????blocking challenge ????', '- ????: ????????', '- ????: ??????', '', '????????'].join('\n')
    const { deps, calls } = makeDeps({ council: async () => ({ content: veto }) })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'council')
    assert.equal(run.state.phases.council?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /????: ????????/)
    assert.equal(calls.team.length, 0)
    assert.equal(calls.galaxy.length, 0)
    assert.match(run.report, /????? council ??/)
    assert.match(run.report, /?????/)
  })

  it('council ???COUNCIL=0?isError:false?? blocked ???????', async () => {
    const { deps, calls } = makeDeps({
      council: async () => ({ content: 'council_convene ????COUNCIL=0??????????', isError: false }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'council')
    assert.match(run.state.blockedReason ?? '', /?????/)
    assert.match(run.report, /COUNCIL=0/)
    assert.equal(calls.team.length, 0)
    assert.equal(calls.galaxy.length, 0)
  })

  it('team ?? ? ? council ?????rounds:2??????', async () => {
    let teamCalls = 0
    const { deps, calls } = makeDeps({
      team: async () => {
        teamCalls++
        return teamCalls === 1
          ? { content: 'team_orchestrate ?????????', isError: true }
          : { content: teamPassContent() }
      },
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'done')
    assert.equal(calls.council.length, 2, '?? + ?????')
    assert.equal(calls.council[1]!.input.rounds, 2, '???????')
    assert.equal(calls.team.length, 2)
    assert.equal(run.state.teamRetries, 1)
    assert.ok(run.state.phases.team?.rawPath)
    const teamRaw = readFileSync(run.state.phases.team!.rawPath!, 'utf8')
    assert.match(teamRaw, /?????/)
    assert.match(teamRaw, /team standard/)
    assert.match(run.report, /?? 1 ????/)
  })

  it('team ????? ? blocked ?? team ??', async () => {
    const { deps, calls } = makeDeps({
      team: async () => ({ content: 'team standard??? 2??? 1??? 0\n\n? ?? 0??? 2 ? worker ???????/????????????? fromWave 1?' }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'team')
    assert.equal(run.state.phases.team?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /????/)
    assert.equal(calls.council.length, 2)
    assert.equal(calls.team.length, 2, '???? 1?team ?????')
    assert.equal(calls.galaxy.length, 0)
    assert.match(run.report, /????? team ??/)
    assert.match(run.report, /resume: true/)
  })

  // ?????? team-orchestrate.ts ??????????????????
  // formatTeamSummary ???????????????????????????
  it('team ??? ? blocked ?? team ??', async () => {
    const zeroDispatched = formatTeamSummary({
      mode: 'standard', planned: [], tasks: [], waves: [], dispatched: 0, blocked: [], packet: '<packet/>',
    }, 0)
    const { deps, calls } = makeDeps({ team: async () => ({ content: zeroDispatched }) })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'team')
    assert.equal(run.state.phases.team?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /????? worker/)
    assert.equal(calls.team.length, 2, '???? 1?team ?????')
    assert.equal(calls.galaxy.length, 0)
  })

  it('galaxy ??????? ? blocked??????', async () => {
    const { deps, calls } = makeDeps({ galaxy: async () => ({ content: galaxyFailContent() }) })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'galaxy')
    assert.equal(run.state.phases.galaxy?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /2\/4 ??????/)
    assert.match(run.state.blockedReason ?? '', /frontend ??/)
    assert.match(run.state.blockedReason ?? '', /review ??/)
    assert.equal(calls.galaxy.length, 1)
    assert.match(run.report, /????? galaxy ??/)
  })

  it('resume:true ??????????????????', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'starflow-resume-'))
    let galaxyCalls = 0
    const galaxyScript: ExecuteFn = async () => {
      galaxyCalls++
      return galaxyCalls === 1 ? { content: galaxyFailContent() } : { content: galaxyPassContent() }
    }
    // ????galaxy ??? ? blocked
    const first = makeDeps({ cwd, galaxy: galaxyScript })
    const run1 = await runStarflow(first.deps, baseInput())
    assert.equal(run1.state.phase, 'galaxy')
    assert.equal(first.calls.council.length, 1)
    assert.equal(first.calls.team.length, 1)

    // ????resume ?? council/team ???????? galaxy
    const second = makeDeps({ cwd, galaxy: galaxyScript })
    const run2 = await runStarflow(second.deps, baseInput({ resume: true }))
    assert.equal(run2.state.phase, 'done')
    assert.equal(second.calls.council.length, 0, 'council ???????')
    assert.equal(second.calls.team.length, 0, 'team ???????')
    assert.equal(second.calls.galaxy.length, 1)
    assert.equal(run2.state.phases.council?.status, 'passed', '????????')
    assert.equal(run2.state.phases.team?.status, 'passed')
  })

  it('? galaxyDims ?? draftItems ? ?? galaxy ?????????????', async () => {
    const { deps, calls } = makeDeps({})
    const run = await runStarflow(deps, baseInput({ draftItems: undefined }))

    assert.equal(run.state.phase, 'done')
    assert.equal(calls.galaxy.length, 0, '???? 2 ??? galaxy?schema min 2?')
    assert.equal(run.state.phases.galaxy?.status, 'skipped')
    assert.match(run.report, /??/)
    assert.match(run.report, /? draftItems ?????/)
  })

  it('??????????????????', async () => {
    const teamWaves: number[] = []
    const { deps, calls } = makeDeps({
      team: async (params) => {
        const fromWave = Number(params.input.fromWave ?? 0)
        teamWaves.push(fromWave)
        return { content: teamPassContent(fromWave < 2 ? fromWave + 1 : undefined) }
      },
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'done')
    assert.deepEqual(teamWaves, [0, 1, 2], 'fromWave 0?1?2 ????')
    assert.equal(calls.team.length, 3)
  })
})

// ?? ????????Phase 1????????????? orchestration ?? ?????

describe('STARFLOW_TEAM_WAVE_RESUME', () => {
  const teamWaveFail = (teamWaves: number[]): ExecuteFn =>
    async (params: ToolCallParams) => {
      const fromWave = Number(params.input.fromWave ?? 0)
      teamWaves.push(fromWave)
      if (fromWave === 0) return { content: teamPassContent(1) }
      return { content: 'team standard??? 2??? 1??? 0\n\n? ?? 1??? 2 ? worker ??????????? fromWave 2?' }
    }

  it('M1: ? 0 ???? 1 ?? ? ????? 1 ??????? 0', async () => {
    const teamWaves: number[] = []
    const { deps } = makeDeps({ team: teamWaveFail(teamWaves) })
    const run = await runStarflow(deps, baseInput())
    assert.equal(run.state.phase, 'team')
    assert.ok(run.state.blockedReason?.includes('????'), run.state.blockedReason)
    assert.deepEqual(teamWaves, [0, 1, 1], '???? completedTeamWaves=1 ??????? 0')
  })

  it('M1: blocked ? resume:true ?????????council/? 0 ????', async () => {
    const teamWaves: number[] = []
    const { deps } = makeDeps({ team: teamWaveFail(teamWaves) })
    await runStarflow(deps, baseInput())
    teamWaves.length = 0
    const resumed = await runStarflow(deps, baseInput({ resume: true }))
    assert.equal(resumed.state.phase, 'team')
    assert.deepEqual(teamWaves, [1], 'resume ????? 1?council ?? 0 ????')
  })

  it('M1: ????? completedTeamWaves ??????resume ??????', async () => {
    const teamWaves: number[] = []
    const { deps } = makeDeps({
      team: async (params: ToolCallParams) => {
        const fromWave = Number(params.input.fromWave ?? 0)
        teamWaves.push(fromWave)
        return { content: teamPassContent(fromWave < 2 ? fromWave + 1 : undefined) }
      },
    })
    const run = await runStarflow(deps, baseInput())
    assert.equal(run.state.phase, 'done')
    assert.equal(run.state.completedTeamWaves, 2, '?? 2 ???')
    assert.deepEqual(teamWaves, [0, 1, 2], '??????')
  })
})

describe('STARFLOW_PREWARM_FACTS', () => {
  const draftWithFile = (cwd: string): StarflowInput =>
    baseInput({
      draftItems: [
        { id: 'impl', title: '??????', detail: '??????????', files: ['src/core.ts'] },
        { id: 'review', title: '????', detail: '??????????', files: ['src/core.ts'] },
      ],
    })

  it('M3: council ?????????????? objective ????', async () => {
    const { deps, calls } = makeDeps({})
    mkdirSync(join(deps.cwd, 'src'), { recursive: true })
    writeFileSync(join(deps.cwd, 'src/core.ts'), 'export function core() { return 42 }\n', 'utf8')

    const run = await runStarflow(deps, draftWithFile(deps.cwd))

    assert.equal(run.state.phase, 'done')
    const dims = calls.galaxy[0]!.input.dimensions as Array<{ objective: string }>
    assert.match(dims[0]!.objective, /????????/, '???? objective ??????')
    assert.match(dims[0]!.objective, /src[/\\]core\.ts/, '????????')
    assert.match(dims[0]!.objective, /export function core/, '??????????')
  })

  it('M3: ?? galaxyDims ???????????????', async () => {
    const { deps, calls } = makeDeps({})
    mkdirSync(join(deps.cwd, 'src'), { recursive: true })
    writeFileSync(join(deps.cwd, 'src/core.ts'), 'export function core() { return 42 }\n', 'utf8')

    await runStarflow(deps, {
      objective: '????????',
      draftItems: draftWithFile(deps.cwd).draftItems,
      galaxyDims: [
        { name: 'impl', objective: '?????????', authority: 'tianliang' },
        { name: 'review', objective: '?????????', authority: 'yaoguang' },
      ],
    })

    const dims = calls.galaxy[0]!.input.dimensions as Array<{ objective: string }>
    assert.equal(dims[0]!.objective, '?????????', '???? objective ????')
    assert.equal(dims[1]!.objective, '?????????')
  })

  it('M3: ??????????????????????', async () => {
    const { deps, calls } = makeDeps({})
    // ??? src/core.ts??buildPrewarmValue ?? undefined????
    const run = await runStarflow(deps, draftWithFile(deps.cwd))
    assert.equal(run.state.phase, 'done')
    const dims = calls.galaxy[0]!.input.dimensions as Array<{ objective: string }>
    assert.doesNotMatch(dims[0]!.objective, /????????/, '?????????')
  })
})

describe('STARFLOW_TEAM_STRUCTURED_GATE', () => {
  it('???????dispatched:0?? blocked?reason ???????? worker?', async () => {
    const { deps, calls } = makeDeps({ team: async () => structuredTeam({ dispatched: 0 }) })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'team')
    assert.equal(run.state.phases.team?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /????? worker/)
    assert.equal(calls.galaxy.length, 0)
  })

  it('????????workers 2/0?? blocked?reason ????????', async () => {
    const { deps, calls } = makeDeps({ team: async () => structuredTeam({ workers: { total: 2, passed: 0 } }) })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'team')
    assert.equal(run.state.phases.team?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /????/)
    assert.equal(calls.galaxy.length, 0)
  })

  it('?????????waveGate.passed:false?? blocked?reason ?????', async () => {
    const { deps, calls } = makeDeps({
      team: async () => structuredTeam({ waveGate: { passed: false, failures: ['npx tsc --noEmit ? 3 errors'] } }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'team')
    assert.equal(run.state.phases.team?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /tsc/)
    assert.equal(calls.galaxy.length, 0)
  })

  it('??? review ???reviewVerdict:rejected?? blocked?reason ???review gate ???', async () => {
    const { deps, calls } = makeDeps({ team: async () => structuredTeam({ reviewVerdict: 'rejected' }) })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'team')
    assert.equal(run.state.phases.team?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /review gate ??/)
    assert.equal(calls.galaxy.length, 0)
  })

  it('??????wave/totalWaves ?? fromWave ???????', async () => {
    let wave = 0
    const { deps, calls } = makeDeps({
      team: async () => {
        const current = wave++
        return structuredTeam({ wave: current, totalWaves: 2 })
      },
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'done')
    assert.deepEqual(calls.team.map(c => Number(c.input.fromWave)), [0, 1], 'fromWave ? wave/totalWaves ??')
    assert.equal(calls.galaxy.length, 1, '????? galaxy')
  })
})

describe('STARFLOW_NEXT_WAVE_OF', () => {
  // nextWaveOf ?????????????????????? teamGate ???
  // ????????????????formatTeamSummary ??????????????
  // ?????team-orchestrate.ts:114???????????
  const outcome = (over: Partial<TeamOrchestrationOutcome> = {}): ToolResult => ({
    content: '??????',
    orchestration: {
      kind: 'team', dispatched: 2, wave: 0, totalWaves: 3,
      workers: { total: 2, passed: 2 }, ...over,
    },
  })

  it('???? ? undefined????????????', () => {
    assert.equal(nextWaveOf(outcome({ workers: { total: 2, passed: 0 } })), undefined)
  })

  it('????????? formatTeamSummary ? every(!passed) ?????', () => {
    assert.equal(nextWaveOf(outcome({ workers: { total: 2, passed: 1 } })), 1)
  })

  it('????total 0????????? teamGate ? dispatched ???', () => {
    assert.equal(nextWaveOf(outcome({ workers: { total: 0, passed: 0 } })), 1)
  })

  it('?? ? undefined', () => {
    assert.equal(nextWaveOf(outcome({ wave: 2, totalWaves: 3 })), undefined)
  })

  it('? orchestration ? ????????', () => {
    assert.equal(nextWaveOf({ content: teamPassContent(2) }), 2)
    assert.equal(nextWaveOf({ content: teamPassContent() }), undefined)
  })
})

describe('STARFLOW_COUNCIL_STRUCTURED_GATE', () => {
  it('??????disabled:true????????? blocked?reason ?????????', async () => {
    const { deps, calls } = makeDeps({
      council: async () => ({
        content: '??????????????',
        orchestration: { kind: 'council', disabled: true },
      }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'council')
    assert.equal(run.state.phases.council?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /?????/)
    assert.equal(calls.team.length, 0)
    assert.equal(calls.galaxy.length, 0)
  })

  it('???????disabled:false????????? council ??????', async () => {
    const { deps, calls } = makeDeps({
      council: async () => ({
        content: '??????????????',
        orchestration: { kind: 'council', disabled: false },
      }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'done')
    assert.equal(run.state.phases.council?.status, 'passed')
    assert.equal(calls.team.length, 1)
    assert.equal(calls.galaxy.length, 1)
  })
})

describe('STARFLOW_GALAXY_STRUCTURED_GATE', () => {
  it('?????????failed ???? blocked?reason ?????', async () => {
    const { deps, calls } = makeDeps({
      galaxy: async () => ({
        content: '??????????????',
        orchestration: {
          kind: 'galaxy',
          dimensions: { total: 4, passed: 2, failed: ['frontend ??', 'review ??'] },
        },
      }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'galaxy')
    assert.equal(run.state.phases.galaxy?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /2\/4 ??????/)
    assert.match(run.state.blockedReason ?? '', /frontend ??/)
    assert.match(run.state.blockedReason ?? '', /review ??/)
    assert.equal(calls.galaxy.length, 1)
  })

  it('failed ? passed/total ??? reason ????????0/N ?????????', async () => {
    // ??????????passed/total ? run.results?failed ? targets?????
    // ???????????????? total-passed ???????0/3 ??????
    // ?frontend ?????
    const { deps } = makeDeps({
      galaxy: async () => ({
        content: '??????????????',
        orchestration: { kind: 'galaxy', dimensions: { total: 3, passed: 3, failed: ['frontend ??'] } },
      }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phases.galaxy?.status, 'blocked')
    assert.match(run.state.blockedReason ?? '', /1\/3 ??????/)
    assert.doesNotMatch(run.state.blockedReason ?? '', /0\/3/)
  })

  it('????????failed ??passed === total?? galaxy ??????', async () => {
    const { deps, calls } = makeDeps({
      galaxy: async () => ({
        content: '??????????????',
        orchestration: { kind: 'galaxy', dimensions: { total: 3, passed: 3, failed: [] } },
      }),
    })
    const run = await runStarflow(deps, baseInput())

    assert.equal(run.state.phase, 'done')
    assert.equal(run.state.phases.galaxy?.status, 'passed')
    assert.equal(calls.galaxy.length, 1)
  })
})

describe('STARFLOW_DERIVE_GALAXY_DIMS', () => {
  it('authority ???review/verify?yaoguang?docs/research?tianxuan????tianliang', () => {
    const dims = deriveGalaxyDims([
      { id: 'verify-api', title: '????', detail: 'd1' },
      { id: 'docs', title: '???', detail: 'd2' },
      { id: 'research', title: '????', detail: 'd3' },
      { id: 'impl', title: '??', detail: 'd4', files: ['a.ts'] },
    ])
    assert.deepEqual(dims.map(d => d.authority), ['yaoguang', 'tianxuan', 'tianxuan', 'tianliang'])
    assert.deepEqual(dims.map(d => d.objective), ['d1', 'd2', 'd3', 'd4'])
    assert.deepEqual(dims[3]!.files, ['a.ts'], 'files ????? scope')
  })

  it('id ????? 5 ???', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `t${i % 6}`, title: `??${i}`, detail: `d${i}` }))
    const dims = deriveGalaxyDims(items)
    assert.equal(dims.length, 5)
    assert.equal(new Set(dims.map(d => d.name)).size, 5)
  })
})

// ?? ?? A-D ???docs/tasks/2026-08-03-starflow-iteration-plan.md?????????

describe('STARFLOW_ITERATION_A_SEATS', () => {
  it('???? seats ???? seats ?????????', async () => {
    const plain = makeDeps({})
    await runStarflow(plain.deps, baseInput())
    assert.equal('seats' in plain.calls.council[0]!.input, false, '???? seats ????????')

    const seats: StarflowSeat[] = [{ authority: 'tianquan' }, { authority: 'yaoguang', tierHint: 'strong' }]
    let teamCalls = 0
    const { deps, calls } = makeDeps({
      team: async () => {
        teamCalls++
        return teamCalls === 1
          ? { content: 'team_orchestrate ?????????', isError: true }
          : { content: teamPassContent() }
      },
    })
    const run = await runStarflow(deps, baseInput({ seats }))
    assert.equal(run.state.phase, 'done')
    assert.deepEqual(calls.council[0]!.input.seats, seats, '???? seats')
    assert.deepEqual(calls.council[1]!.input.seats, seats, '????? seats')
    assert.equal(calls.council[1]!.input.rounds, 2)
  })
})

describe('STARFLOW_ITERATION_B_INCREMENTAL_REVIEW', () => {
  it('previousVerdict=passed ???? councilInput ??????????????', async () => {
    const carried = { ...TWO_DRAFTS[0]!, previousVerdict: 'passed' as const }
    const { deps, calls } = makeDeps({})
    const run = await runStarflow(deps, baseInput({ draftItems: [carried, TWO_DRAFTS[1]!] }))
    assert.equal(run.state.phase, 'done')
    const objective = calls.council[0]!.input.objective as string
    assert.match(objective, /????????/)
    assert.match(objective, /impl/, '????????? id')
    assert.deepEqual(calls.council[0]!.input.draftItems, [carried, TWO_DRAFTS[1]!], '?????????????????')
  })

  it('? previousVerdict ??????', async () => {
    const { deps, calls } = makeDeps({})
    await runStarflow(deps, baseInput())
    assert.doesNotMatch(calls.council[0]!.input.objective as string, /????????/)
  })

  it('???revision ? previousVerdict ????????????', async () => {
    // ??? bump revision ??? previousVerdict?????????????????
    // ????????fail-dangerous ???2026-08-03 ????
    const revised = { ...TWO_DRAFTS[0]!, previousVerdict: 'passed' as const, revision: 2 }
    const { deps, calls } = makeDeps({})
    await runStarflow(deps, baseInput({ draftItems: [revised, TWO_DRAFTS[1]!] }))
    assert.doesNotMatch(calls.council[0]!.input.objective as string, /????????/)
    assert.deepEqual(calls.council[0]!.input.draftItems, [revised, TWO_DRAFTS[1]!], '?????????')
  })
})

describe('STARFLOW_ITERATION_C_BASELINE_PRECHECK', () => {
  function makeGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'starflow-git-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'core.ts'), '// v1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir })
    return dir
  }

  it('git ???councilInput.objective ????? status ???????', async () => {
    const dir = makeGitRepo()
    writeFileSync(join(dir, 'src', 'core.ts'), '// v2\n') // ?? dirty ??
    const { deps, calls } = makeDeps({ cwd: dir })
    const run = await runStarflow(deps, baseInput({ draftItems: [{ ...TWO_DRAFTS[0]!, files: ['src/core.ts'] }] }))
    assert.equal(run.state.phase, 'done')
    const objective = calls.council[0]!.input.objective as string
    assert.match(objective, /????/)
    assert.match(objective, /src\/core\.ts/, 'status ???????')
    assert.match(objective, /????????????????????\/???????/)
  })

  it('git ??????????????? precheck', async () => {
    const dir = makeGitRepo()
    const { deps, calls } = makeDeps({ cwd: dir })
    await runStarflow(deps, baseInput({ draftItems: [{ ...TWO_DRAFTS[0]!, files: ['src/core.ts'] }] }))
    const objective = calls.council[0]!.input.objective as string
    assert.match(objective, /????/)
    assert.match(objective, /init/, '?????? init ??')
  })

  it('? git ????????????', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'starflow-nogit-'))
    const { deps, calls } = makeDeps({ cwd: dir })
    const run = await runStarflow(deps, baseInput())
    assert.equal(run.state.phase, 'done')
    assert.doesNotMatch(calls.council[0]!.input.objective as string, /????/)
  })

  it('draftItems ? files????????????????', async () => {
    const { deps, calls } = makeDeps({})
    await runStarflow(deps, baseInput({ draftItems: [{ id: 'x', title: 't', detail: 'd' }] }))
    assert.doesNotMatch(calls.council[0]!.input.objective as string, /????/)
  })

  it('autoReview:false ?? Galaxy ??????', async () => {
    const { deps, calls } = makeDeps({})
    const run = await runStarflow(deps, baseInput({ autoReview: false }))

    assert.equal(run.state.phase, 'done')
    assert.equal(calls.galaxy.length, 1)
    assert.equal(calls.galaxy[0]!.input.autoReview, false)
  })
})
