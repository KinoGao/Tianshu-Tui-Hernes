import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGalaxyTool, type GalaxyCoordinator } from '../galaxy.js'
import { deriveStableWorkOrderId, type CoordinatorRun, type DelegationRequest } from '../../agent/coordinator.js'

function makeRun(requests: DelegationRequest[], opts?: { durationMs?: number }): CoordinatorRun {
  return {
    status: 'completed',
    results: requests.map(r => ({
      workOrderId: deriveStableWorkOrderId(r.parentTurnId ?? '') ?? r.parentTurnId ?? 'wo_unknown',
      status: 'passed',
      summary: 'Worker completed.',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
      ...(opts?.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      // ?? coordinator ?????????? WorkerResult?work-order.ts
      // workerResultSchema.profile/authority???mock ???????????
      profile: r.profile,
      authority: r.authority,
    })),
    packet: '<worker_results>packet</worker_results>',
  }
}

function capturingCoordinator(calls: Array<{ requests: DelegationRequest[] }>): GalaxyCoordinator {
  return {
    delegateBatch: async (requests) => {
      calls.push({ requests })
      return makeRun(requests)
    },
  }
}

describe('GALAXY_TOOL', () => {
  it('rejects ambiguous or duplicate EP/DP contracts before dispatch', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_contract',
      cwd: '/repo',
      input: {
        objective: 'validate the galaxy plan',
        dimensions: [
          { name: 'Review', objective: 'check the change', authority: 'yaoguang', authorities: ['yaoguang', 'tianji'] },
          { name: ' review ', objective: 'duplicate name', authority: 'tianji', replicas: 2 },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /ambiguous|duplicates dimension|cannot set replicas/i)
    assert.equal(calls.length, 0, 'invalid plans must not reach the coordinator')
  })

  it('blocks new fan-out while the coordinator is shutting down', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator = capturingCoordinator(calls)
    coordinator.getRuntimeSnapshot = () => ({
      activeWorkers: 1,
      maxWorkers: 2,
      pendingWorkers: 0,
      stalledWorkers: 0,
      inFlightFileScopes: 1,
      backgroundRunning: 0,
      activeClaims: 1,
      providerDegradation: 0,
      shuttingDown: true,
    })
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_shutdown',
      cwd: '/repo',
      input: {
        objective: 'do not admit new work during handoff',
        dimensions: [
          { name: 'backend', objective: 'inspect backend', authority: 'tianji' },
          { name: 'review', objective: 'review the plan', authority: 'yaoguang' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /????|??/)
    assert.equal(result.errorKind, 'runtime_gate')
    assert.equal(calls.length, 0, 'shutdown gate must reject before fan-out')
  })

  it('keeps dispatch fail-open when optional runtime telemetry throws', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator = capturingCoordinator(calls)
    coordinator.getRuntimeSnapshot = () => { throw new Error('health probe unavailable') }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_runtime_probe',
      cwd: '/repo',
      input: {
        objective: 'dispatch despite optional telemetry failure',
        dimensions: [
          { name: 'backend', objective: 'inspect backend', authority: 'tianji' },
          { name: 'review', objective: 'review the plan', authority: 'yaoguang' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.equal(calls.length, 1, 'telemetry failure must not suppress a valid dispatch')
  })

  it('rejects duplicate EP authorities and malformed DP replicas atomically', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_contract_dp',
      cwd: '/repo',
      input: {
        objective: 'validate parallel work',
        dimensions: [
          { name: 'perspectives', objective: 'independent review', authorities: ['tianji', 'tianji'] },
          { name: 'replicas', objective: 'independent evidence', authority: 'yaoguang', parallelism: 'data' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /repeats authority|requires replicas/i)
    assert.equal(calls.length, 0)
  })

  it('DP ??????? work order ID?B2 ???', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_dp',
      cwd: '/repo',
      input: {
        objective: '?? DP ?????????',
        dimensions: [
          { name: 'verify', objective: '????????', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'research', objective: '????????', authority: 'tianxuan', parallelism: 'data', replicas: 2 },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.equal(result.orchestration?.kind, 'galaxy')
    assert.equal(result.orchestration?.runId, 'tu_dp')
    assert.equal(result.orchestration?.planned, 4)
    assert.equal(result.orchestration?.dispatched, 4)
    assert.deepEqual(result.orchestration?.parallelism, { expert: 0, data: 4 })
    const ids = calls[0]!.requests.map(r => deriveStableWorkOrderId(r.parentTurnId ?? ''))
    assert.equal(ids.length, 4)
    assert.equal(new Set(ids).size, 4, `work order IDs must be unique, got: ${ids.join(', ')}`)
  })

  it('??? authority ??????? TDD ???W4?', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_ro',
      cwd: '/repo',
      input: {
        objective: '?????? + ??????',
        dimensions: [
          { name: 'frontend', objective: '?? UI ??', authority: 'wenqu' },
          { name: 'search', objective: '??????', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const reqs = calls[0]!.requests
    const writer = reqs.find(r => r.profile === 'patcher')!
    const reader = reqs.find(r => r.profile === 'code_scout')!
    assert.ok(writer.objective.includes('???????'), 'write-capable worker should get TDD requirements')
    assert.ok(!reader.objective.includes('???????'), 'read-only worker must not get TDD requirements')
    assert.ok(reader.objective.includes('????'), 'read-only worker should get read-only instructions')
  })

  it('??????? profile ? autoReview ?????W2?', async () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun([]) })
    const execDims = [
      { name: 'frontend', objective: '?? UI', authority: 'wenqu' },
      { name: 'backend', objective: '????', authority: 'tianji' },
    ]

    const withReview = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: execDims, autoReview: true } } as any)
    const withoutReview = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: execDims, autoReview: false } } as any)
    assert.ok(withReview! > withoutReview!, `autoReview wave must widen the budget (${withReview} vs ${withoutReview})`)

    // profile ????????? patcher?????????????????????
    const readOnlyDims = execDims.map(d => ({ ...d, profile: 'code_scout' }))
    const writeBudget = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: execDims, autoReview: false } } as any)
    const readBudget = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: readOnlyDims, autoReview: false } } as any)
    assert.ok(writeBudget! > readBudget!, `effective write profile must widen the budget (${writeBudget} vs ${readBudget})`)
  })

  it('tierFloor=strong ??? 1.5x ?????????P2-5?', async () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun([]) })
    const dims = [
      { name: 'review', objective: '????', authority: 'yaoguang' },
      { name: 'search', objective: '????', authority: 'tianji', profile: 'code_scout' },
    ]
    const base = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: dims, autoReview: false } } as any)
    const strong = tool.timeoutMs?.({ sessionTurnCount: 5, input: {
      dimensions: dims.map(d => ({ ...d, tierFloor: 'strong' })),
      autoReview: false,
    } } as any)
    assert.ok(strong! > base!, `strong tierFloor must widen the timeout (${strong} vs ${base})`)
  })

  it('??????????? DP per-replica cacheRead?P0-2?', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => ({
        status: 'completed',
        results: requests.map((r, i) => ({
          workOrderId: deriveStableWorkOrderId(r.parentTurnId ?? '') ?? r.parentTurnId ?? 'wo_unknown',
          status: 'passed' as const,
          summary: 'Worker completed.',
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified' as const,
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: (i + 1) * 100 },
        })),
        packet: '',
      }),
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_usage',
      cwd: '/repo',
      input: {
        objective: 'DP ????',
        dimensions: [
          { name: 'verify', objective: '????????', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'search', objective: '??????', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.ok(result.content.includes('????'), '????????????')
    assert.ok(result.content.includes('input ?3000'), `?? input ????got:\n${result.content}`)
    assert.ok(result.content.includes('cacheRead ?600'), `?? cacheRead ????got:\n${result.content}`)
    assert.ok(result.content.includes('replica cacheRead: 100 / 200'), `DP ???? per-replica cacheRead ??got:\n${result.content}`)
  })

  it('?????????? onWorkerActivity/onOutput ???P1-2?', async () => {
    const terminalEvents: Array<{ workOrderId?: string; status?: string; authority?: string; profile?: string }> = []
    const outputs: string[] = []
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests, _policy, _signal, onProgress, onWorkerSettled) => {
        const run = makeRun(requests)
        for (const r of run.results) onWorkerSettled?.(r)
        onProgress?.(run.results.length, requests.length)
        return run
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_stream',
      cwd: '/repo',
      input: {
        objective: '??????',
        dimensions: [
          { name: 'frontend', objective: '?? UI', authority: 'wenqu' },
          { name: 'backend', objective: '????', authority: 'tianji' },
        ],
        autoReview: false,
        confirm: true,
      },
      onWorkerActivity: (ev: any) => { if (ev.status) terminalEvents.push(ev) },
      onOutput: (text: string) => outputs.push(text),
    } as any)

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.equal(terminalEvents.length, 2, '?? worker ???????????')
    assert.ok(terminalEvents.every(e => e.status === 'passed'))
    // ?????????????? worker ???????????????? ID ???
    const authorities = terminalEvents.map(e => e.authority).sort()
    assert.deepEqual(authorities, ['tianji', 'wenqu'], '???????? authority')
    assert.ok(terminalEvents.every(e => typeof e.profile === 'string' && e.profile.length > 0), '???????? profile')
    assert.ok(outputs.some(t => t.includes('galaxy progress: 2/2')), `??????? onOutput?got: ${outputs.join('')}`)
  })

  it('?????????????P1-2?', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => {
        const run = makeRun(requests)
        run.results[0]!.findings.push({ claim: '?????', evidence: ['src/a.ts:12'] } as any)
        return run
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_guard',
      cwd: '/repo',
      input: {
        objective: '???',
        dimensions: [
          { name: 'search', objective: '??????', authority: 'tianji', profile: 'code_scout' },
          { name: 'research', objective: '????', authority: 'tianxuan' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.ok(result.content.includes('?????'), `???????????????got:\n${result.content}`)
  })

  it('??????????????????????????P2-1?', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_overlap',
      cwd: '/repo',
      input: {
        objective: '?????????? + ?????????',
        dimensions: [
          { name: 'frontend', objective: '?? UI', authority: 'wenqu', files: ['src/a.ts', 'src/b.ts'] },
          { name: 'backend', objective: '????', authority: 'tianji', files: ['src/a.ts', 'src/c.ts'] },
          { name: 'search', objective: '????????', authority: 'tianxuan', profile: 'code_scout', files: ['src/a.ts'] },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const reqs = calls[0]!.requests
    const byProfile = (p: string) => reqs.filter(r => r.profile === p)
    const frontend = byProfile('patcher').find(r => r.authority === 'wenqu')!
    const backend = byProfile('patcher').find(r => r.authority === 'tianji')!
    const reader = byProfile('code_scout')[0]!
    assert.deepEqual(frontend.scope?.files, ['src/a.ts', 'src/b.ts'], '????????????')
    assert.deepEqual(backend.scope?.files, ['src/c.ts'], '???????????')
    assert.deepEqual(reader.scope?.files, ['src/a.ts'], '?????????')
    assert.ok(result.content.includes('???????'), `??????????got:\n${result.content}`)
    assert.ok(result.content.includes('src/a.ts'), '?????????')
  })

  it('??????????????????M3???? scope ????', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_emptied',
      cwd: '/repo',
      input: {
        objective: '??????????????????????',
        dimensions: [
          { name: 'frontend', objective: '?? UI', authority: 'wenqu', files: ['src/a.ts'] },
          { name: 'backend', objective: '????', authority: 'tianji', files: ['src/a.ts'] },
          { name: 'search', objective: '??????', authority: 'tianxuan', profile: 'code_scout', files: ['src/z.ts'] },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const reqs = calls[0]!.requests
    assert.ok(reqs.some(r => r.authority === 'wenqu'), '??????????')
    assert.ok(!reqs.some(r => r.authority === 'tianji' && r.profile === 'patcher'), '??????????????')
    assert.ok(reqs.some(r => r.profile === 'code_scout'), '????????')
    assert.ok(result.content.includes('?????'), `???????????got:\n${result.content}`)
    assert.ok(result.content.includes('backend'), '??????????')
  })

  it('tierFloor ??? DelegationRequest?P2-2?', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_floor',
      cwd: '/repo',
      input: {
        objective: '?????? strong ?',
        dimensions: [
          { name: 'review', objective: '????', authority: 'yaoguang', tierFloor: 'strong' },
          { name: 'search', objective: '????', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const review = calls[0]!.requests.find(r => r.tierFloor === 'strong')
    assert.ok(review, 'tierFloor ????? request')
  })

  it('modelOverride ????????????????P2-3?', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => ({
        ...makeRun(requests),
        workerModels: requests.map(r => ({
          workOrderId: deriveStableWorkOrderId(r.parentTurnId ?? '') ?? r.parentTurnId ?? 'wo_unknown',
          model: 'actual-cheap-model',
        })),
      }),
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_fb',
      cwd: '/repo',
      input: {
        objective: '?????',
        dimensions: [
          { name: 'review', objective: '?????', authority: 'yaoguang', modelOverride: { provider: 'deepseek', model: 'requested-strong-model' } },
          { name: 'search', objective: '????', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.ok(
      result.content.includes('??????? requested-strong-model ? ?? actual-cheap-model'),
      `??????????got:\n${result.content}`,
    )
  })

  it('DP quorum ???? tool result ?? isError?P2-4 ????????', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => {
        const run = makeRun(requests)
        // DP ?????? failed??quorum ?? 2/2+1=2?0 passed < 2 ? not reached
        for (const r of run.results) {
          r.status = 'failed'
          r.summary = 'replica failed'
        }
        return run
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_quorum_fail',
      cwd: '/repo',
      input: {
        objective: 'DP quorum ??',
        dimensions: [
          { name: 'verify', objective: '????????', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'search', objective: '??????', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, true, `DP quorum ???? isError ??? true?got: ${result.isError}`)
    assert.ok(result.content.includes('quorum not reached'), `????? quorum ?????got:\n${result.content}`)
  })

  it('DP quorum ??? tool result ??? isError?P2-4 ???', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => ({
        ...makeRun(requests),
        // ????? passed??quorum ??
      }),
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_quorum_pass',
      cwd: '/repo',
      input: {
        objective: 'DP quorum ??',
        dimensions: [
          { name: 'verify', objective: '????????', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'search', objective: '??????', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `quorum ??? isError ?? undefined?got: ${result.isError}`)
    assert.ok(result.content.includes('quorum reached'), `????? quorum ?????got:\n${result.content}`)
  })

  it('DP ????? policy ? quorum ?????? quorumK??? #1 ???', async () => {
    let capturedPolicy: import('../../agent/work-order.js').AggregationPolicy | undefined
    let capturedRequests: DelegationRequest[] = []
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests, policy) => {
        capturedPolicy = policy
        capturedRequests = requests
        return makeRun(requests)
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_qk',
      cwd: '/repo',
      input: {
        objective: 'DP ? EP ??',
        dimensions: [
          { name: 'verify', objective: '????????', authority: 'yaoguang', parallelism: 'data', replicas: 3 },
          { name: 'search', objective: '??????', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    // ?? policy?DP ?? ? quorum ????? worker ???? k=1?
    assert.equal(typeof capturedPolicy, 'object')
    assert.equal((capturedPolicy as { kind: string }).kind, 'quorum')
    // DP ????? quorumK = floor(3/2)+1 = 2?EP ?????
    const dpReqs = capturedRequests.filter(r => r.groupId?.startsWith('galaxy:data:'))
    const epReqs = capturedRequests.filter(r => !r.groupId)
    assert.equal(dpReqs.length, 3)
    assert.ok(dpReqs.every(r => r.quorumK === 2), `DP quorumK ?? 2?got: ${dpReqs.map(r => r.quorumK).join(',')}`)
    assert.equal(epReqs.length, 1)
    assert.equal(epReqs[0]!.quorumK, undefined)
  })

  it('DP quorumK ???2 ???? k=2???????ceil ??? 1 ??????', async () => {
    let capturedRequests: DelegationRequest[] = []
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => {
        capturedRequests = requests
        return makeRun(requests)
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_qk2',
      cwd: '/repo',
      input: {
        objective: 'DP ?????????????????',
        dimensions: [
          { name: 'verify', objective: '????????', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'search', objective: '??????', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const dpReqs = capturedRequests.filter(r => r.groupId?.startsWith('galaxy:data:'))
    assert.equal(dpReqs.length, 2)
    // floor(2/2)+1 = 2?????????????????ceil(2/2)=1 ??
    // ????????????????DP ???????
    assert.ok(dpReqs.every(r => r.quorumK === 2), `DP quorumK ?? 2?got: ${dpReqs.map(r => r.quorumK).join(',')}`)
  })

  it('? DP ? policy ????????DP ?? quorum ??????? #1 ?????', async () => {
    let capturedPolicy: import('../../agent/work-order.js').AggregationPolicy | undefined
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests, policy) => {
        capturedPolicy = policy
        return makeRun(requests)
      },
    }
    const tool = createGalaxyTool(coordinator)

    // ? DP??? all_required ????
    const ep = await tool.execute({
      toolUseId: 'tu_ep',
      cwd: '/repo',
      input: {
        objective: 'EP ??',
        dimensions: [
          { name: 'search', objective: '??', authority: 'tianji', profile: 'code_scout' },
          { name: 'plan', objective: '??', authority: 'tianquan', profile: 'planner' },
        ],
        autoReview: false,
        confirm: true,
        policy: 'all_required',
      },
    })
    assert.equal(ep.isError, undefined)
    assert.equal(capturedPolicy, 'all_required')

    // DP + ?? quorum???????? all_required ????????
    const dp = await tool.execute({
      toolUseId: 'tu_dp_q',
      cwd: '/repo',
      input: {
        objective: 'DP quorum ??',
        dimensions: [
          { name: 'verify', objective: '????', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'search', objective: '??', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
        policy: { kind: 'quorum', k: 2 },
      },
    })
    assert.equal(dp.isError, undefined, `DP ?? quorum ????got: ${dp.content}`)
    assert.equal((capturedPolicy as unknown as { kind: 'quorum'; k: number }).k, 2)

    // DP + first_success????
    const blocked = await tool.execute({
      toolUseId: 'tu_dp_fs',
      cwd: '/repo',
      input: {
        objective: 'DP ????',
        dimensions: [
          { name: 'verify', objective: '????', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'search', objective: '??', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
        policy: 'first_success',
      },
    })
    assert.equal(blocked.isError, true)
    assert.ok(blocked.content.includes('??'))
  })
})

describe('GALAXY_TOOL ? DP ??????? #2?', () => {
  function dpInput() {
    return {
      objective: '?????????',
      dimensions: [
        { name: 'verify', objective: '???????', authority: 'yaoguang', parallelism: 'data', replicas: 2, files: ['src/a.ts'] },
        { name: 'search', objective: '????', authority: 'tianji', profile: 'code_scout' },
      ],
      autoReview: false,
      confirm: true,
    }
  }

  it('k ??? verified ???? ? ???? satisfied', async () => {
    const { ObligationTracker } = await import('../../agent/obligation-tracker.js')
    const tracker = new ObligationTracker()
    const tool = createGalaxyTool({ ...capturingCoordinator([]), obligationTracker: tracker })

    const result = await tool.execute({ toolUseId: 'tu_ob1', cwd: '/repo', input: dpInput() })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const obs = tracker.getStore().obligations
    assert.equal(obs.length, 1, 'DP ????????????')
    assert.equal(obs[0]!.redundancy?.k, 2)
    assert.equal(obs[0]!.satisfyCount, 2)
    assert.equal(obs[0]!.state, 'satisfied')
  })

  it('?? 1 ? verified ?? ? ???? attempted?deliver ?????', async () => {
    const { ObligationTracker } = await import('../../agent/obligation-tracker.js')
    const tracker = new ObligationTracker()
    const coordinator: GalaxyCoordinator = {
      obligationTracker: tracker,
      delegateBatch: async (requests) => {
        const run = makeRun(requests)
        // ??? DP ?????? unverified????????
        const dpIds = requests
          .filter(r => r.parentTurnId?.includes('-galaxy-0:'))
          .map(r => deriveStableWorkOrderId(r.parentTurnId ?? '') ?? '')
        const second = run.results.find(r => r.workOrderId === dpIds[1])
        if (second) (second as any).evidenceStatus = 'unverified'
        return run
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({ toolUseId: 'tu_ob2', cwd: '/repo', input: dpInput() })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const obs = tracker.getStore().obligations
    assert.equal(obs.length, 1)
    assert.equal(obs[0]!.satisfyCount, 1, 'unverified ?????')
    assert.equal(obs[0]!.state, 'attempted', 'k=2 ???????')
  })

  it('? obligationTracker ????????????', async () => {
    const tool = createGalaxyTool(capturingCoordinator([]))
    const result = await tool.execute({ toolUseId: 'tu_ob3', cwd: '/repo', input: dpInput() })
    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
  })
})

describe('GALAXY_PLAN_PRECHECK', () => {
  it('??????? ? overlap ???? proposal ??', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_precheck_overlap',
      cwd: '/repo',
      input: {
        objective: 'proposal with overlap',
        dimensions: [
          { name: 'frontend', objective: '???', authority: 'wenqu', files: ['src/app.ts', 'src/btn.ts'] },
          { name: 'backend', objective: '???', authority: 'tianji', files: ['src/app.ts', 'src/api.ts'] },
        ],
        autoReview: false,
      },
    })

    assert.equal(result.isError, undefined)
    assert.equal(calls.length, 0, 'proposal ?????')
    assert.match(result.content, /????/)
    assert.match(result.content, /?backend??????????????????????src\/app\.ts/)
    // ?????backend ? src/app.ts ?????? src/api.ts??? emptied?
    assert.doesNotMatch(result.content, /??????????/)
  })

  it('????????? ? emptied ???proposal ??', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_precheck_emptied',
      cwd: '/repo',
      input: {
        objective: 'proposal with emptied write dim',
        dimensions: [
          { name: 'frontend', objective: '???', authority: 'wenqu', files: ['src/app.ts'] },
          { name: 'backend', objective: '???', authority: 'tianji', files: ['src/app.ts'] },
        ],
        autoReview: false,
      },
    })

    assert.equal(result.isError, undefined)
    assert.match(result.content, /?backend?????????????????????????src\/app\.ts/)
  })

  it('??????????????????????', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_precheck_readonly',
      cwd: '/repo',
      input: {
        objective: 'readonly overlap is fine',
        dimensions: [
          { name: 'search', objective: '??', authority: 'tianji', profile: 'code_scout', files: ['src/app.ts'] },
          { name: 'review', objective: '??', authority: 'yaoguang', profile: 'reviewer', files: ['src/app.ts'] },
        ],
        autoReview: false,
      },
    })

    assert.equal(result.isError, undefined)
    assert.match(result.content, /? ????????????????/)
  })

  it('S4: DP ?? 2..N ????????? 1 ?????', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator = capturingCoordinator(calls)
    coordinator.getCandidateModels = () => [
      { provider: 'minimax', model: 'MiniMax-M2.7' },
      { provider: 'glm', model: 'glm-5.2' },
    ]
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_ab',
      cwd: '/repo',
      input: {
        objective: 'ab test across replicas',
        dimensions: [
          { name: 'verify', objective: '???????', authority: 'yaoguang', parallelism: 'data', replicas: 3, files: ['src/a.ts'] },
          { name: 'search', objective: '????', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const reqs = calls[0]!.requests
    const dpReqs = reqs.filter(r => r.parentTurnId?.includes('-galaxy-0:'))
    assert.equal(dpReqs.length, 3, 'DP ???? 3 ???')
    assert.equal(dpReqs[0]!.modelOverride, undefined, '?? 1 ?????')
    assert.deepEqual(dpReqs[1]!.modelOverride, { provider: 'minimax', model: 'MiniMax-M2.7' }, '?? 2 ????? 1')
    assert.deepEqual(dpReqs[2]!.modelOverride, { provider: 'glm', model: 'glm-5.2' }, '?? 3 ????? 2')
  })

  it('S4: ?? modelOverride ??????', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator = capturingCoordinator(calls)
    coordinator.getCandidateModels = () => [{ provider: 'minimax', model: 'MiniMax-M2.7' }]
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_ab_override',
      cwd: '/repo',
      input: {
        objective: 'explicit override wins',
        dimensions: [
          { name: 'verify', objective: '????', authority: 'yaoguang', parallelism: 'data', replicas: 2, files: ['src/a.ts'], modelOverride: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
          { name: 'search', objective: '????', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined)
    const dpReqs = calls[0]!.requests.filter(r => r.parentTurnId?.includes('-galaxy-0:'))
    assert.equal(dpReqs.length, 2)
    for (const req of dpReqs) {
      assert.deepEqual(req.modelOverride, { provider: 'deepseek', model: 'deepseek-v4-pro' }, '??????????')
    }
  })

  it('S4: ??????????????modelOverride ???', async () => {
    const recorded: Array<Record<string, unknown>> = []
    const coordinator = capturingCoordinator([])
    coordinator.getCandidateModels = () => [{ provider: 'minimax', model: 'MiniMax-M2.7' }]
    coordinator.domainKnowledgeStore = {
      recallGalaxyRouting: () => [],
      recordGalaxyRoutingBatch: (records: Array<Record<string, unknown>>) => recorded.push(...records),
    } as never
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_ab_record',
      cwd: '/repo',
      input: {
        objective: 'record routing with model',
        dimensions: [
          { name: 'verify', objective: '????', authority: 'yaoguang', parallelism: 'data', replicas: 2, files: ['src/a.ts'] },
          { name: 'search', objective: '????', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined)
    assert.ok(recorded.length > 0, '??????????')
    const dpWithModel = recorded.find(r => r.taskShape === 'review' && r.model === 'MiniMax-M2.7')
    assert.ok(dpWithModel, '?? 2 ????????????????????')
    assert.ok(recorded.some(r => r.taskShape === 'review' && r.model === undefined), '?? 1 ????? model ??')
  })

  it('M2: ?????? wall-clock???????????', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator = capturingCoordinator(calls)
    const originalRun = coordinator.delegateBatch
    coordinator.delegateBatch = async (requests) => {
      const run = await originalRun!(requests)
      for (const r of run.results) r.durationMs = 1250
      return run
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_timebook',
      cwd: '/repo',
      input: {
        objective: 'time book across dimensions',
        dimensions: [
          { name: 'frontend', objective: '???', authority: 'wenqu', profile: 'patcher', files: ['src/app.ts'] },
          { name: 'review', objective: '??', authority: 'yaoguang', profile: 'reviewer' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined)
    assert.match(result.content, /? 1\.3s/, '??????1.25s ? 1.3s????')
  })

  it('L3: ??????? token ???input+output?', async () => {
    const recorded: Array<Record<string, unknown>> = []
    const coordinator = capturingCoordinator([])
    coordinator.domainKnowledgeStore = {
      recallGalaxyRouting: () => [],
      recordGalaxyRoutingBatch: (records: Array<Record<string, unknown>>) => recorded.push(...records),
    } as never
    const originalRun = coordinator.delegateBatch
    coordinator.delegateBatch = async (requests) => {
      const run = await originalRun!(requests)
      for (const r of run.results) {
        r.usage = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      }
      return run
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_cost',
      cwd: '/repo',
      input: {
        objective: 'cost tracking across replicas',
        dimensions: [
          { name: 'verify', objective: '????', authority: 'yaoguang', parallelism: 'data', replicas: 2, files: ['src/a.ts'] },
          { name: 'search', objective: '????', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined)
    assert.ok(recorded.length > 0)
    const withCost = recorded.filter(r => typeof r.costTokens === 'number')
    assert.equal(withCost.length, 3, '3 ? worker ?????')
    assert.ok(withCost.every(r => r.costTokens === 1500), '?? = input + output')
  })

  it('L3: proposal ??????????/????????', async () => {
    const coordinator = capturingCoordinator([])
    coordinator.domainKnowledgeStore = {
      recallGalaxyRouting: () => [
        { dimensionName: 'verify', authority: 'yaoguang', taskShape: 'review', status: 'passed', model: 'deepseek-v4-pro', costTokens: 9000, depositedAt: 1 },
        { dimensionName: 'verify', authority: 'yaoguang', taskShape: 'review', status: 'passed', model: 'deepseek-v4-pro', costTokens: 11000, depositedAt: 2 },
        { dimensionName: 'verify', authority: 'yaoguang', taskShape: 'review', status: 'failed', model: 'deepseek-v4-pro', costTokens: 5000, depositedAt: 3 },
      ],
      recordGalaxyRoutingBatch: () => {},
    } as never
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_prop_cost',
      cwd: '/repo',
      input: {
        objective: 'proposal with cost stats',
        dimensions: [
          { name: 'verify', objective: '????', authority: 'yaoguang' },
          { name: 'search', objective: '????', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
      },
    })

    assert.equal(result.isError, undefined)
    assert.match(result.content, /?????/)
    assert.match(result.content, /2\/3 ???67%? ? ??? ~12\.5k tokens/, '??????????25000/2?')
  })
})
