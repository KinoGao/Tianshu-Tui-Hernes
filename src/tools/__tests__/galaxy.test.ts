/**
 * galaxy tool tests — 星河集群派发。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGalaxyTool, type GalaxyCoordinator } from '../galaxy.js'
import { deriveStableWorkOrderId, type CoordinatorRun, type DelegationRequest } from '../../agent/coordinator.js'
import { aggregationPolicySchema, type AggregationPolicy } from '../../agent/work-order.js'

function makeRun(resultsCount = 1): CoordinatorRun {
  const results = Array.from({ length: resultsCount }, (_, i) => ({
    workOrderId: `wo_${i}`,
    status: 'passed' as const,
    summary: `Worker ${i} completed.`,
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified' as const,
  }))
  return {
    status: 'completed',
    results,
    packet: '<worker_results>galaxy packet</worker_results>',
  }
}

describe('GALAXY_TOOL', () => {
  it('has byte-stable definition (no star-domain names in description)', () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun() })
    const def = tool.definition

    // 工具名固定
    assert.equal(def.name, 'galaxy')

    // description 不嵌入任何内置星域名称（保证前缀缓存字节稳定）
    const desc = def.description
    assert.ok(!desc.includes('tianshu'), 'description must not embed star domain IDs')
    assert.ok(!desc.includes('tianquan'))
    assert.ok(!desc.includes('tianliang'))
    assert.ok(!desc.includes('pojun'))
    assert.ok(!desc.includes('yaoguang'))

    // schema 不嵌入具体值
    const schema = def.input_schema as any
    assert.equal(schema.properties.dimensions.minItems, 2)
    assert.equal(schema.properties.dimensions.maxItems, 5)
    assert.equal(schema.required.includes('objective'), true)
    assert.equal(schema.required.includes('dimensions'), true)
  })

  it('aggregation policy schema is exposed from work-order', () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun() })
    const schema = tool.definition.input_schema as any
    assert.deepEqual(schema.properties.policy.enum, [...aggregationPolicySchema.options])
    assert.ok(schema.properties.policy.enum.includes('all_required'))
    assert.ok(schema.properties.policy.enum.includes('weighted_confidence'))
  })

  it('proposal mode: returns cluster plan without dispatching when confirm=false', async () => {
    const calls: Array<{ requests: DelegationRequest[]; policy?: AggregationPolicy }> = []
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests, policy) => {
        calls.push({ requests, policy })
        return makeRun(requests.length)
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_galaxy',
      cwd: '/repo',
      input: {
        objective: '实现用户登录功能',
        dimensions: [
          { name: 'frontend', objective: '实现登录页面', authority: 'wenqu' },
          { name: 'backend', objective: '实现后端 API', authority: 'tianji' },
        ],
        autoReview: true,
        confirm: false,
      },
    })

    // 未确认 → 不派发
    assert.equal(calls.length, 0)
    // 返回方案展示
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('星河集群方案'), 'content should contain proposal header')
    assert.ok(result.content.includes('实现用户登录功能'), 'content should contain objective')
    assert.ok(result.content.includes('frontend'), 'content should contain dimension name')
    assert.ok(result.content.includes('backend'), 'content should contain dimension name')
    assert.ok(result.content.includes('confirm: true'), 'content should tell user to confirm')
    assert.ok(result.uiContent?.includes('星河方案'))
  })

  it('proposal mode: autoReview adds review hint', async () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun() })

    const result = await tool.execute({
      toolUseId: 'tu_galaxy',
      cwd: '/repo',
      input: {
        objective: '重构数据库层',
        dimensions: [
          { name: 'impl', objective: '重写 ORM', authority: 'tianliang' },
          { name: 'test', objective: '写测试', authority: 'kaiyang' },
        ],
        autoReview: true,
        confirm: false,
      },
    })

    assert.ok(result.content.includes('审查'), 'autoReview should add review hint')
  })

  it('proposal mode: explicit review dimension suppresses auto review hint', async () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun() })

    const result = await tool.execute({
      toolUseId: 'tu_galaxy',
      cwd: '/repo',
      input: {
        objective: '实现文件上传功能',
        dimensions: [
          { name: 'frontend', objective: '上传组件', authority: 'wenqu' },
          { name: 'backend', objective: '上传 API', authority: 'tianji' },
          { name: 'review', objective: '审查', authority: 'yaoguang' },
        ],
        autoReview: true,
        confirm: false,
      },
    })

    // 已有显式 review 维度 → 不追加自动审查提示
    assert.ok(!result.content.includes('+ 1 自动审查'), 'should not mention auto review when explicit review exists')
  })

  it('execute mode: dispatches to delegateBatch with confirm=true', async () => {
    const calls: Array<{ requests: DelegationRequest[]; policy?: AggregationPolicy }> = []
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests, policy) => {
        calls.push({ requests, policy })
        return makeRun(requests.length)
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_galaxy_exec',
      cwd: '/repo',
      input: {
        objective: '添加搜索功能',
        dimensions: [
          { name: 'frontend', objective: '搜索框 UI', authority: 'wenqu' },
          { name: 'backend', objective: '搜索 API', authority: 'tianji' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    // 确认模式 → 已派发
    assert.equal(calls.length, 1)
    const reqs = calls[0]!.requests
    assert.equal(reqs.length, 2) // 2 execution dimensions, no auto review

    // 验证每个请求的结构
    assert.equal(reqs[0]!.authority, 'wenqu')
    assert.ok(reqs[0]!.objective.includes('搜索框 UI'))
    assert.equal(reqs[0]!.parentTurnId, 'batch:tu_galaxy_exec-galaxy-0:0')

    assert.equal(reqs[1]!.authority, 'tianji')
    assert.ok(reqs[1]!.objective.includes('搜索 API'))

    // 结果格式
    assert.ok(result.content.includes('星河集群执行报告'))
    assert.ok(result.content.includes('frontend'))
    assert.ok(result.content.includes('backend'))
    // 没有 auto review
    assert.ok(!result.content.includes('审查'))
  })

  it('execute mode: autoReview appends yaoguang reviewer with dependsOn', async () => {
    const calls: Array<{ requests: DelegationRequest[]; policy?: AggregationPolicy }> = []
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests, policy) => {
        calls.push({ requests, policy })
        return makeRun(requests.length)
      },
    }
    const tool = createGalaxyTool(coordinator)

    await tool.execute({
      toolUseId: 'tu_galaxy_review',
      cwd: '/repo',
      input: {
        objective: '性能优化',
        dimensions: [
          { name: 'profile', objective: '性能分析', authority: 'tianji' },
          { name: 'optimize', objective: '优化热点', authority: 'tianliang' },
        ],
        autoReview: true,
        confirm: true,
      },
    })

    assert.equal(calls.length, 1)
    const reqs = calls[0]!.requests
    // 2 execution + 1 auto review = 3
    assert.equal(reqs.length, 3)

    const reviewReq = reqs[2]!
    assert.equal(reviewReq!.authority, 'yaoguang')
    assert.equal(reviewReq!.profile, 'reviewer')
    assert.equal(reviewReq!.kind, 'review')
    // 审查依赖前两个执行维度
    assert.ok(reviewReq!.dependencies)
    assert.equal(reviewReq!.dependencies!.length, 2)
    assert.deepEqual(reviewReq!.dependencies, [
      'tu_galaxy_review-galaxy-0:0',
      'tu_galaxy_review-galaxy-1:0',
    ])
  })

  it('maps out-of-order worker results by stable work-order ID, including auto review', async () => {
    const tool = createGalaxyTool({
      delegateBatch: async () => {
        const run = makeRun(3)
        run.results[0] = { ...run.results[0]!, workOrderId: 'tu_result_map-galaxy-1:0', summary: 'BACKEND_RESULT' }
        run.results[1] = { ...run.results[1]!, workOrderId: 'tu_result_map-galaxy-0:0', summary: 'FRONTEND_RESULT' }
        run.results[2] = { ...run.results[2]!, workOrderId: 'tu_result_map-galaxy:auto-review', summary: 'REVIEW_RESULT' }
        return run
      },
    })

    const result = await tool.execute({
      toolUseId: 'tu_result_map',
      cwd: '/repo',
      input: {
        objective: '结果映射',
        dimensions: [
          { name: 'frontend', objective: '前端', authority: 'wenqu' },
          { name: 'backend', objective: '后端', authority: 'tianji' },
        ],
        autoReview: true,
        confirm: true,
      },
    })

    assert.match(result.content, /frontend 文曲:.*FRONTEND_RESULT/)
    assert.match(result.content, /backend 天机:.*BACKEND_RESULT/)
    assert.match(result.content, /全局审查:.*REVIEW_RESULT/)
  })

  it('makes an explicit review wait for every execution dimension', async () => {
    const calls: DelegationRequest[][] = []
    const tool = createGalaxyTool({
      delegateBatch: async (requests) => {
        calls.push(requests)
        return makeRun(requests.length)
      },
    })

    await tool.execute({
      toolUseId: 'tu_explicit_review',
      cwd: '/repo',
      input: {
        objective: '实现并审查上传功能',
        dimensions: [
          { name: 'frontend', objective: '上传组件', authority: 'wenqu' },
          { name: 'backend', objective: '上传 API', authority: 'tianji' },
          { name: 'review', objective: '审查集成结果', authority: 'yaoguang' },
        ],
        autoReview: true,
        confirm: true,
      },
    })

    const review = calls[0]![2]!
    assert.deepEqual(review.dependencies, [
      'tu_explicit_review-galaxy-0:0',
      'tu_explicit_review-galaxy-1:0',
    ])
  })

  it('rejects multiple authorities for a writable execution dimension', async () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun() })
    const result = await tool.execute({
      toolUseId: 'tu_multi_write',
      cwd: '/repo',
      input: {
        objective: '并行实现',
        dimensions: [
          { name: 'frontend', objective: '实现 UI', authorities: ['wenqu', 'tianliang'] },
          { name: 'docs', objective: '写文档', authority: 'tianxuan' },
        ],
        confirm: true,
      },
    })

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('多个 authority'))
  })

  it('keeps independent multi-perspective readers distinct in the queue', async () => {
    const calls: DelegationRequest[][] = []
    const tool = createGalaxyTool({
      delegateBatch: async (requests) => {
        calls.push(requests)
        return makeRun(requests.length)
      },
    })

    await tool.execute({
      toolUseId: 'tu_perspectives',
      cwd: '/repo',
      input: {
        objective: '多视角审查',
        dimensions: [
          { name: 'review', objective: '审查鉴权', authorities: ['yaoguang', 'tianquan'], files: ['src/auth/index.ts'] },
          { name: 'docs', objective: '核对文档', authority: 'tianxuan' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    const perspectives = calls[0]!.filter(request => request.groupId)
    assert.equal(perspectives.length, 2)
    assert.equal(perspectives[0]!.groupId, perspectives[1]!.groupId)
    assert.notEqual(perspectives[0]!.parentTurnId, perspectives[1]!.parentTurnId)
  })

  it('fans out data-parallel replicas as independent read-only work orders and reports their execution quorum', async () => {
    const captured: DelegationRequest[][] = []
    const tool = createGalaxyTool({
      delegateBatch: async (requests) => {
        captured.push(requests)
        return {
          ...makeRun(requests.length),
          results: requests.map((request, index) => ({
            ...makeRun(1).results[0]!,
            workOrderId: deriveStableWorkOrderId(request.parentTurnId)!,
            status: index === 2 ? 'failed' as const : 'passed' as const,
          })),
        }
      },
    })

    const result = await tool.execute({
      toolUseId: 'tu_data_parallel',
      cwd: '/repo',
      input: {
        objective: '独立复核鉴权风险',
        dimensions: [
          { name: 'review', objective: '审查鉴权边界', authority: 'yaoguang', profile: 'reviewer', parallelism: 'data', replicas: 3, files: ['src/auth/index.ts'] },
          { name: 'docs', objective: '核对文档', authority: 'tianxuan' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    const replicas = captured[0]!.filter(request => request.groupId?.startsWith('galaxy:data:'))
    assert.equal(replicas.length, 3)
    assert.equal(new Set(replicas.map(request => request.parentTurnId)).size, 3)
    assert.equal(new Set(replicas.map(request => request.groupId)).size, 1)
    assert.ok(replicas.every(request => request.profile === 'reviewer' && request.authority === 'yaoguang'))
    assert.ok(replicas.every(request => request.objective.includes('Data-parallel replica')))
    assert.match(result.content, /DP review: execution quorum reached \(2\/3, quorum 2\)/)
    assert.match(result.content, /final semantic review remains required/)
  })

  it('rejects data-parallel work that defaults to a writable profile', async () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun() })
    const result = await tool.execute({
      toolUseId: 'tu_data_write',
      cwd: '/repo',
      input: {
        objective: '并行实现页面',
        dimensions: [
          { name: 'frontend', objective: '实现 UI', authority: 'wenqu', parallelism: 'data', replicas: 2 },
          { name: 'docs', objective: '核对文档', authority: 'tianxuan' },
        ],
        confirm: true,
      },
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('DP') && result.content.includes('可写 profile'))
  })

  it('keeps every data-parallel replica observable by rejecting lossy aggregation policies', async () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun() })
    const result = await tool.execute({
      toolUseId: 'tu_data_policy',
      cwd: '/repo',
      input: {
        objective: '独立复核',
        dimensions: [
          { name: 'review', objective: '审查鉴权', authority: 'yaoguang', profile: 'reviewer', parallelism: 'data', replicas: 2 },
          { name: 'docs', objective: '核对文档', authority: 'tianxuan' },
        ],
        policy: 'first_success',
        confirm: true,
      },
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('all_required'))
  })

  it('implementation dimensions default to patcher (writable), not code_scout (read-only)', async () => {
    const captured: any[] = []
    const tool = createGalaxyTool({
      delegateBatch: async (requests) => {
        captured.push(...requests)
        return makeRun(requests.length)
      },
    })
    await tool.execute({
      toolUseId: 'tu_profile',
      cwd: '/repo',
      input: {
        objective: 'profile check',
        dimensions: [
          { name: '前端', objective: 'UI', authority: 'wenqu' },
          { name: '后端', objective: 'API', authority: 'tianji' },
        ],
        confirm: true,
      },
      sessionTurnCount: 10,
    })
    assert.ok(captured.length >= 2)
    assert.equal(captured[0].profile, 'patcher', '前端维度默认应 patcher 可写')
    assert.equal(captured[1].profile, 'patcher', '后端维度默认应 patcher 可写')
  })

  it('deduplicates overlapping file scopes — only first dimension keeps the file', async () => {
    const captured: any[] = []
    const tool = createGalaxyTool({
      delegateBatch: async (requests) => {
        captured.push(...requests)
        return makeRun(requests.length)
      },
    })
    await tool.execute({
      toolUseId: 'tu_overlap',
      cwd: '/repo',
      input: {
        objective: 'overlap test',
        dimensions: [
          { name: 'backend', objective: 'API', authority: 'tianji', files: ['src/UserController.java', 'src/UserService.java'] },
          { name: 'cross', objective: 'Cross', authority: 'tianquan', files: ['src/UserController.java', 'src/OrderService.java'] },
        ],
        confirm: true,
        autoReview: false,
      },
      sessionTurnCount: 10,
    })
    assert.ok(captured.length >= 2)
    // backend worker (first) keeps both files
    const backendReq = captured.find((r: any) => r.authority === 'tianji')
    assert.ok(backendReq, 'backend worker should exist')
    assert.deepStrictEqual(backendReq.scope.files.sort(), ['src/UserController.java', 'src/UserService.java'].sort())
    // cross worker gets only its unique file, not the overlapping one
    const crossReq = captured.find((r: any) => r.authority === 'tianquan')
    assert.ok(crossReq, 'cross worker should exist')
    assert.deepStrictEqual(crossReq.scope.files.sort(), ['src/OrderService.java'].sort())
  })

  it('rejects dimensions with empty authority and no authorities', async () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun(0) })
    const result = await tool.execute({
      toolUseId: 'tu_empty_auth',
      cwd: '/repo',
      input: {
        objective: 'empty auth',
        dimensions: [
          { name: 'a', objective: 'first', authority: '' },
          { name: 'b', objective: 'second', authority: 'tianji' },
        ],
        confirm: true,
        autoReview: false,
      },
      sessionTurnCount: 10,
    })
    assert.equal(result.isError, true)
    assert.ok(result.content!.includes('authority') || result.content!.includes('星域'), result.content)
  })

  it('design dimension defaults to patcher (writable), not planner (delegation-only)', async () => {
    const captured: any[] = []
    const tool = createGalaxyTool({
      delegateBatch: async (requests) => {
        captured.push(...requests)
        return makeRun(requests.length)
      },
    })
    await tool.execute({
      toolUseId: 'tu_design',
      cwd: '/repo',
      input: {
        objective: 'design check',
        dimensions: [
          { name: 'design', objective: 'UI design', authority: 'wenqu' },
          { name: 'backend', objective: 'API', authority: 'tianji' },
        ],
        confirm: true,
        autoReview: false,
      },
      sessionTurnCount: 10,
    })
    assert.ok(captured.length >= 2)
    assert.equal(captured[0].profile, 'patcher', 'design 维度默认应 patcher 可写，而非 planner 只读')
  })

  it('rejects empty dimensions', async () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun() })

    // 少于 2 个维度
    const result = await tool.execute({
      toolUseId: 'tu_galaxy',
      cwd: '/repo',
      input: {
        objective: 'single',
        dimensions: [{ name: 'only', objective: 'only', authority: 'tianshu' }],
        confirm: true,
      },
    })

    assert.ok(result.isError)
    assert.ok(result.content.includes('参数错误'))
  })

  it('validates file paths within project root', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async () => makeRun(),
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_galaxy',
      cwd: '/repo',
      input: {
        objective: 'test',
        dimensions: [
          { name: 'a', objective: 'a', authority: 'tianji', files: ['../outside/file.ts'] },
          { name: 'b', objective: 'b', authority: 'wenqu' },
        ],
        confirm: true,
      },
    })

    assert.ok(result.isError)
    assert.ok(result.content.includes('项目目录外'))
    assert.ok(result.content.includes('../outside/file.ts'))
  })

  it('policy defaults to all_required when not specified', async () => {
    const calls: Array<{ policy?: AggregationPolicy }> = []
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (_requests, policy) => {
        calls.push({ policy })
        return makeRun(2)
      },
    }
    const tool = createGalaxyTool(coordinator)

    await tool.execute({
      toolUseId: 'tu_galaxy',
      cwd: '/repo',
      input: {
        objective: 'test',
        dimensions: [
          { name: 'a', objective: 'a', authority: 'tianji' },
          { name: 'b', objective: 'b', authority: 'wenqu' },
        ],
        confirm: true,
      },
    })

    assert.equal(calls[0]!.policy, 'all_required')
  })

  it('forwards explicit policy to delegateBatch', async () => {
    const calls: Array<{ policy?: AggregationPolicy }> = []
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (_requests, policy) => {
        calls.push({ policy })
        return makeRun(2)
      },
    }
    const tool = createGalaxyTool(coordinator)

    await tool.execute({
      toolUseId: 'tu_galaxy',
      cwd: '/repo',
      input: {
        objective: 'test',
        dimensions: [
          { name: 'a', objective: 'a', authority: 'tianji' },
          { name: 'b', objective: 'b', authority: 'wenqu' },
        ],
        confirm: true,
        policy: 'first_success',
      },
    })

    assert.equal(calls[0]!.policy, 'first_success')
  })
})
