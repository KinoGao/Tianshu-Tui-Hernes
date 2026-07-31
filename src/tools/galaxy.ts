/**
 * galaxy tool — 星河集群派发。
 *
 * 子 Agent（星域 worker）通过此工具将任务拆解为多个维度，由不同星域的
 * 分子 Agent 并行执行，结果汇总后统一审查。
 *
 * 设计原则（与 skill 工具同构）：
 *  - 工具 definition 字节稳定：不嵌入具体星域名称、维度名称或示例参数
 *  - 动态内容仅在 tool result 中返回
 *  - 调用前需过意图门禁（任务适合度 + 用户意图），未确认时展示方案
 *
 * 内部完全复用 delegate_batch 通道。
 */

import { z } from 'zod'
import { deriveStableWorkOrderId, type CoordinatorRun, type DelegationRequest } from '../agent/coordinator.js'
import { classifyProfile } from '../agent/coordination-policy.js'
import { aggregationPolicySchema, type AggregationPolicy, type WorkOrderKind } from '../agent/work-order.js'
import { profileIsWriteCapable, profileRegistry, delegationToolTimeoutMs } from '../agent/profile-registry.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import { formatWorkerResultDigest } from '../agent/worker-result-digest.js'
import { validatePathSafe } from './path-validate.js'
import {
  MAX_TURNS_TOOL_DESCRIPTION,
  TIMEOUT_MS_TOOL_DESCRIPTION,
  delegateMaxTurnsSchema,
  delegateTimeoutMsSchema,
  toBudgetOverride,
} from './delegate-budget.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { createActivityStreamer, createDelegationActivityMapper } from './worker-activity-stream.js'
import type { WorkerActivityEvent } from '../agent/coordinator.js'

// ── Coordinator interface（与 delegate_batch 同构） ──────────────────────

export interface GalaxyCoordinator {
  delegateBatch(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
    onWorkerSettled?: (result: import('../agent/work-order.js').WorkerResult) => void,
  ): Promise<CoordinatorRun>
}

// ── Schema ───────────────────────────────────────────────────────────────

/** Dynamic profile validation — same as delegate-task.ts */
const profileStringSchema = z.string().refine(
  (val) => profileRegistry.getProfileNames().includes(val),
  (val) => ({ message: `未知 profile "${val}"。可用：${profileRegistry.getProfileNames().join(', ')}` }),
)

/** Dynamic star-domain validation — same as delegate-task.ts.
 *  Accepts both Chinese names (天机) and Pinyin IDs (tianji).
 *  Empty string treated as unspecified (not validated). */
const authorityStringSchema = z.string().refine(
  (val) => val === '' || starDomainRegistry.get(val) !== undefined,
  (val) => ({ message: `未知星域 "${val}"。可用：${starDomainRegistry.getDomainIds().join(', ')}` }),
)

const parallelismSchema = z.enum(['expert', 'data'])

const dimensionSchema = z.object({
  name: z.string().min(1).describe('维度标识（如 frontend / backend / review / test / docs）'),
  objective: z.string().min(1).describe('该维度的具体执行目标'),
  authority: authorityStringSchema.optional().describe('该维度使用的星域（单星域，与 authorities 二选一）'),
  authorities: z.array(authorityStringSchema).min(2).max(5).optional().describe(
    '该维度使用的多个星域，分别给出独立的只读视角；它们不共享实时上下文，也不能用于并行写入。与 authority 二选一。',
  ),
  parallelism: parallelismSchema.default('expert').describe(
    'expert：按专长派发单个分片（默认）；data：把同一只读任务复制给多个独立副本。',
  ),
  replicas: z.number().int().min(2).max(5).optional().describe(
    '仅 parallelism=data 时必填，表示独立只读副本数量（2–5）。',
  ),
  profile: profileStringSchema.optional().describe('worker profile，默认 code_scout'),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  maxTurns: delegateMaxTurnsSchema,
  timeoutMs: delegateTimeoutMsSchema,
  modelOverride: z.object({
    provider: z.string(),
    model: z.string(),
  }).optional().describe('为该维度指定专用模型（如审查用强模型、实现用快模型）'),
}).refine(
  d => (d.authority !== undefined && d.authority !== '') || (d.authorities !== undefined && d.authorities.length > 0),
  { message: '每个维度必须指定 authority 或 authorities（至少一个）' },
)

const galaxyInputSchema = z.object({
  objective: z.string().min(1).describe('集群总目标——要解决的完整任务描述'),
  dimensions: z.array(dimensionSchema).min(2).max(5).describe(
    '至少 2 个维度，最多 5 个。每个维度由指定星域的分子 Agent 独立执行。',
  ),
  autoReview: z.boolean().default(true).describe(
    '执行完成后自动追加审查维度（瑶光审查者）。默认开启。',
  ),
  confirm: z.boolean().default(false).describe(
    '用户已确认集群方案。首次调用不带此参数以展示方案并请求确认。',
  ),
  policy: aggregationPolicySchema.optional().describe('聚合策略。默认：all_required。'),
})

// ── Dimension → WorkOrderKind 映射 ──────────────────────────────────────

const DIMENSION_KIND_MAP: Record<string, WorkOrderKind> = {
  review: 'review',
  verify: 'verify',
  test: 'verify',
  plan: 'plan',
  design: 'plan',
  docs: 'doc_research',
  research: 'doc_research',
  search: 'code_search',
  scout: 'code_search',
  frontend: 'patch_proposal',
  backend: 'patch_proposal',
  impl: 'patch_proposal',
  patch: 'patch_proposal',
  fix: 'patch_proposal',
}

function mapDimensionToKind(name: string): WorkOrderKind {
  const key = name.toLowerCase().replace(/[\s_-]/g, '')
  return DIMENSION_KIND_MAP[key] ?? 'code_search'
}

function mapDimensionToProfile(name: string): string {
  const key = name.toLowerCase().replace(/[\s_-]/g, '')
  if (key === 'review' || key === 'verify') return 'reviewer'
  if (key === 'plan') return 'planner'
  if (key === 'docs' || key === 'research') return 'doc_scout'
  // 实现类维度（含 design/frontend/backend 等）默认用 patcher（可写）
  return 'patcher'
}

function isReviewDimension(name: string): boolean {
  const key = name.toLowerCase().replace(/[\s_-]/g, '')
  return key === 'review' || key === 'verify'
}

function galaxyWorkerParentTurnId(
  toolUseId: string,
  dimensionIndex: number,
  authorityIndex: number,
  replicaIndex?: number,
): string {
  // `batch:` makes coordinator work-order IDs deterministic, so dependency
  // edges point at the IDs the queue actually tracks.
  const replicaSuffix = replicaIndex === undefined ? '' : `:${replicaIndex}`
  return `batch:${toolUseId}-galaxy-${dimensionIndex}:${authorityIndex}${replicaSuffix}`
}

function workerOrderId(parentTurnId: string): string {
  return deriveStableWorkOrderId(parentTurnId) ?? parentTurnId
}

// ── Formatting ───────────────────────────────────────────────────────────

const GALAXY_GLYPH = '🌌'

function formatGalaxyProposal(
  objective: string,
  dimensions: z.infer<typeof dimensionSchema>[],
  autoReview: boolean,
): string {
  const lines: string[] = [
    `${GALAXY_GLYPH} 星河集群方案`,
    '',
    `目标：${objective}`,
    '',
    `分子 Agent 组成（${dimensions.length} 个维度${autoReview && !dimensions.some(d => isReviewDimension(d.name)) ? ' + 1 自动审查' : ''}）：`,
  ]

  for (let i = 0; i < dimensions.length; i++) {
    const d = dimensions[i]!
    const stars = d.authorities ?? (d.authority ? [d.authority] : [])
    const starLabels = stars.map(s => {
      const star = starDomainRegistry.get(s)
      return star ? `${star.name}` : s
    })
    const parallelTag = d.parallelism === 'data' ? ` DP × ${d.replicas ?? '?'}` : ' EP'
    const roomTag = stars.length > 1 ? ` ◌ 多视角（${starLabels.join(' + ')}）` : ` — ${starLabels[0]}`
    lines.push(`  ${i + 1}. ${d.name}${parallelTag}${roomTag}`)
    lines.push(`     ${d.objective}`)
  }

  if (autoReview && !dimensions.some(d => isReviewDimension(d.name))) {
    const yaoguang = starDomainRegistry.get('yaoguang')
    const label = yaoguang ? `瑶光（${yaoguang.motto.slice(0, 12)}…）` : '瑶光'
    lines.push(`  ${dimensions.length + 1}. review — ${label}`)
    lines.push(`     审查以上所有维度的输出，验证正确性、完整性和安全性`)
  }

  lines.push('')
  lines.push('调用 galaxy({..., confirm: true}) 确认并执行。')

  return lines.join('\n')
}

interface GalaxyResultTarget {
  workOrderId: string
  label: string
}

interface GalaxyDataParallelGroup {
  label: string
  workOrderIds: string[]
}

function formatGalaxyResult(
  run: CoordinatorRun,
  targets: GalaxyResultTarget[],
  dataParallelGroups: GalaxyDataParallelGroup[],
): string {
  const passed = run.results.filter(r => r.status === 'passed').length
  const total = run.results.length

  const lines: string[] = [
    `${GALAXY_GLYPH} 星河集群执行报告 · ${passed}/${total} 通过`,
    '',
  ]

  const resultsById = new Map(run.results.map(result => [result.workOrderId, result]))
  const unmatched = [...run.results]
  for (const target of targets) {
    const r = resultsById.get(target.workOrderId) ?? unmatched.shift()
    if (!r) continue
    const matchedIndex = unmatched.indexOf(r)
    if (matchedIndex >= 0) unmatched.splice(matchedIndex, 1)

    const digest = formatWorkerResultDigest({
      status: r.status,
      summary: r.summary,
      findingsCount: r.findings?.length ?? 0,
      changedFilesCount: r.changedFiles?.length ?? 0,
      failureReason: r.failureReason,
      evidenceStatus: r.evidenceStatus,
    })

    lines.push(`  ${target.label}: ${digest}`)
    if (r.changedFiles.length > 0) {
      lines.push(`      changed: ${r.changedFiles.slice(0, 5).join(', ')}`)
      if (r.changedFiles.length > 5) lines.push(`      … (+${r.changedFiles.length - 5} more)`)
    }
    lines.push('')
  }
  for (const r of unmatched) {
    const digest = formatWorkerResultDigest({
      status: r.status,
      summary: r.summary,
      findingsCount: r.findings?.length ?? 0,
      changedFilesCount: r.changedFiles?.length ?? 0,
      failureReason: r.failureReason,
      evidenceStatus: r.evidenceStatus,
    })
    lines.push(`  未映射 worker ${r.workOrderId}: ${digest}`)
    lines.push('')
  }

  for (const group of dataParallelGroups) {
    const replicaResults = group.workOrderIds
      .map(id => resultsById.get(id))
      .filter((result): result is NonNullable<typeof result> => result !== undefined)
    const passedReplicas = replicaResults.filter(result => result.status === 'passed').length
    const quorum = Math.floor(group.workOrderIds.length / 2) + 1
    const verdict = passedReplicas >= quorum ? 'reached' : 'not reached'
    lines.push(`  DP ${group.label}: execution quorum ${verdict} (${passedReplicas}/${group.workOrderIds.length}, quorum ${quorum})`)
  }
  if (dataParallelGroups.length > 0) {
    lines.push('  DP replicas are independent evidence sources; final semantic review remains required.')
    lines.push('')
  }

  // 聚合结论
  const allPassed = passed === total
  const hasFindings = run.results.some(r => r.findings.length > 0)

  if (allPassed) {
    lines.push('聚合结论: 所有维度通过。')
  } else {
    const failed = total - passed
    lines.push(`聚合结论: ${failed}/${total} 个维度未通过，请检查上述摘要并在本回合内修复后再交付。`)
  }
  if (hasFindings && !allPassed) {
    lines.push('各维度发现的问题已标注在上方，优先修复阻塞项。')
  }

  if (run.escalated) {
    lines.push('⚠ 子代理连续失败已升级，建议改为内联执行或缩小范围。')
  }

  return lines.join('\n')
}

function formatGalaxyUi(
  run: CoordinatorRun,
  dimensions: z.infer<typeof dimensionSchema>[],
): string {
  const passed = run.results.filter(r => r.status === 'passed').length
  const total = run.results.length
  return `${GALAXY_GLYPH} 星河 · ${passed}/${total} 通过`
}

// ── Tool factory ─────────────────────────────────────────────────────────

export function createGalaxyTool(coordinator: GalaxyCoordinator): Tool {
  return {
    definition: {
      name: 'galaxy',
      description: `启动星河集群——将任务拆解为多个维度，由不同星域的分子 Agent 并行执行，结果汇总后统一审查。

## 主动激活（分析任务特征，自行判断）

收到任务后先做基础分析——读代码结构、理解模块边界、识别可并行的维度。满足以下任一条件时主动提议星河：
- 任务天然跨层（同时涉及 UI + 逻辑 + 数据 / 前端 + 后端 / 实现 + 测试）
- 用户描述中出现了"同时""并行""一起""整个""全部"等批量语义
- 当前任务可拆为 2+ 个互不阻塞的独立子目标
- 任务复杂度高，单一 worker 轮次预算可能不够

## 被动激活（响应用户信号）

用户消息中出现以下信号时直接激活：
- 明确指令："用星河""集群处理""并行分析""多维审查"
- 隐式意图："从多个角度""前后端都要改""改完帮我审一下"
- 对当前进度不满："太慢了""能不能快点""一步到位"

## 星域选择指南（什么维度选什么星域）

分析代码结构后按维度特征选星域（调用 galaxy 时在 dimensions[].authority 中填对应的星域标识）：
- 前端/UI/交互 → 文曲：代码美学与用户界面
- 后端/逻辑/API → 天机：前提质疑与边界条件
- 架构/方案/规划 → 天权：规划审查与权衡
- 实现/编码/落地 → 天梁：执行落地与分波交付
- 审查/验证/安全 → 瑶光：复现验证与缺陷归族
- 探索/实验/攻坚 → 破军：突破勘探与不计成本
- 重构/优化/清理 → 天府：守护结构与 fail-closed
- 数据/存储/模型 → 开阳：对账与精确构成
- 文档/调研/知识 → 天璇：跨域视角与缝隙寻光
- 全局统筹/编排 → 天枢：全貌定向与架构枢纽

## MoE 自动路由（混合专家门控）

星河采用 MoE（Mixture of Experts）架构。每个星域是一个"专家"，门控网络根据任务特征自动选择激活哪些专家：

**门控规则（按优先级）：**
1. 任务关键词 → 匹配星域 keywords（如"界面"→文曲，"安全"→瑶光）
2. 文件后缀分布 → 按上述文件后缀映射确定维度
3. 任务复杂度 → 高复杂度自动启用审查（瑶光）+ 架构审查（天权）
4. 历史模式 → 同类型任务复用之前成功的星域组合

**稀疏激活：** 只有匹配的星域进入集群，不活跃专家不进 prompt，节省 token 和缓存。

**方案生成边界：** 上层 Agent 基于上述信号提出 galaxy dimensions 数组；galaxy 工具负责校验、隔离与执行，不在工具内部实现确定性的关键词路由器。

调用方式：/galaxy <任务描述> → 自动门控选择专家 → 展示方案 → 确认执行。

## 文件后缀→维度推断（自动拆解参考）

分析代码时按文件后缀自动判定维度归属：
- 前端：*.vue *.tsx *.jsx *.html *.css *.scss *.less *.svg → 文曲/天梁
- 后端：*.java *.go *.rs *.py *.rb *.php *.cs *.kt *.swift → 天机/天梁
- 类型/接口：*.d.ts *.graphql *.proto *.avsc → 天机/开阳
- 配置/构建：*.json *.yaml *.toml *.env Dockerfile Makefile → 天府
- 测试：*.test.ts *.spec.ts __tests__/ → 瑶光
- 文档：*.md *.mdx *.rst → 天璇

若任务涉及跨后缀文件组，优先按上述分组拆解为独立维度。

## 汇总机制

星河的核心价值不仅是并行执行，更在于结果汇总。所有分子 Agent 并行工作完成后：
- 自动追加的审查维度（瑶光）收到全部执行结果后统一审查
- 最终返回的聚合报告包含：各维度通过/失败状态、变更文件清单、跨维度冲突标注
- 审查维度发现的跨维度问题（前后端接口不一致、类型定义不匹配等）在汇总中单独列出

聚合策略默认 all_required（所有维度必须通过）。`,
      input_schema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: '集群总目标——要解决的完整任务描述' },
          dimensions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '维度标识（如 frontend / backend / review / test / docs）' },
                objective: { type: 'string', description: '该维度的具体执行目标' },
                authority: { type: 'string', description: '该维度使用的星域 id。单星域时使用，与 authorities 二选一。' },
                authorities: { type: 'array', items: { type: 'string' }, description: '该维度使用多个星域作独立只读分析；不共享实时上下文，也不能用于并行写入。与 authority 二选一。' },
                parallelism: { type: 'string', enum: ['expert', 'data'], default: 'expert', description: 'expert 为按专长的单分片派发；data 为同一只读任务的独立副本。' },
                replicas: { type: 'integer', minimum: 2, maximum: 5, description: '仅 data 模式：独立副本数。' },
                profile: { type: 'string', enum: profileRegistry.getProfileNames(), description: 'worker profile。默认按维度名自动推导。' },
                files: { type: 'array', items: { type: 'string' }, description: '可选，聚焦的文件路径。' },
                symbols: { type: 'array', items: { type: 'string' }, description: '可选，聚焦的符号。' },
                maxTurns: { type: 'integer', description: MAX_TURNS_TOOL_DESCRIPTION },
                timeoutMs: { type: 'integer', description: TIMEOUT_MS_TOOL_DESCRIPTION },
                modelOverride: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } }, description: '可选，为该维度指定专用 provider/model。审查用强模型，实现用快/便宜模型。' },
              },
              required: ['name', 'objective'],
            },
            minItems: 2,
            maxItems: 5,
            description: '至少 2 个维度，最多 5 个。每个维度由指定星域的分子 Agent 独立执行。',
          },
          autoReview: { type: 'boolean', default: true, description: '执行完成后自动追加审查维度（瑶光）。默认开启。' },
          confirm: { type: 'boolean', default: false, description: '用户已确认集群方案。首次调用不带此参数以展示方案并请求确认。' },
          policy: { type: 'string', enum: [...aggregationPolicySchema.options], description: '聚合策略。默认：all_required。' },
        },
        required: ['objective', 'dimensions'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = galaxyInputSchema.safeParse(params.input)
      if (!parsed.success) {
        return {
          content: `星河参数错误：${parsed.error.message}`,
          isError: true,
          errorKind: 'format_error',
        }
      }

      const { objective, dimensions, autoReview, confirm, policy } = parsed.data

      if (dimensions.some(dimension => dimension.parallelism === 'data') && policy && policy !== 'all_required') {
        return {
          content: '星河已拦截：DP 需要保留每个副本的结果和证据，因此只支持 all_required 聚合策略（默认）。语义分歧由后续审查维度处理。',
          isError: true,
        }
      }

      // Pre-flight: validate file paths
      for (let i = 0; i < dimensions.length; i++) {
        const dimension = dimensions[i]!
        const files = dimension.files
        if (files && files.length > 0) {
          const bad = files.filter(f => !validatePathSafe(params.cwd, f).ok)
          if (bad.length > 0) {
            return {
              content: `星河已拦截：维度「${dimensions[i]!.name}」引用了项目目录外的文件：${bad.join(', ')}`,
              isError: true,
            }
          }
        }
        const stars = dimension.authorities ?? []
        const profile = (dimension.profile ?? mapDimensionToProfile(dimension.name)) as import('../agent/work-order.js').WorkerProfile
        if (dimension.parallelism === 'data') {
          if (!dimension.replicas) {
            return { content: `星河已拦截：DP 维度「${dimension.name}」必须指定 replicas（2–5）。`, isError: true }
          }
          if (dimension.authorities?.length) {
            return { content: `星河已拦截：DP 维度「${dimension.name}」只能使用单个 authority；多专家意见请使用 expert 模式的 authorities。`, isError: true }
          }
          if (profileIsWriteCapable(profile)) {
            return { content: `星河已拦截：DP 维度「${dimension.name}」使用了可写 profile「${profile}」。DP 只允许独立只读/验证副本，写入请拆成 EP 单专家分片。`, isError: true }
          }
        }
        if (stars.length > 1 && classifyProfile(profile) === 'hands') {
          return {
            content: `星河已拦截：维度「${dimension.name}」包含多个 authority，但其 profile 可写。多 authority 只用于独立只读视角；请拆成文件范围不重叠的单 authority 执行维度。`,
            isError: true,
          }
        }
      }

      // ── Phase 1: Proposal (no confirm) ────────────────────────────
      if (!confirm) {
        const proposal = formatGalaxyProposal(objective, dimensions, autoReview)
        return {
          content: [
            proposal,
            '',
            '请确认此星河方案是否可行。确认后调用 galaxy({..., confirm: true}) 启动执行。',
            '如需调整维度或星域，请说明修改内容。',
          ].join('\n'),
          uiContent: `${GALAXY_GLYPH} 星河方案 · ${dimensions.length} 维度`,
        }
      }

      // ── Phase 2: Execute ──────────────────────────────────────────

      // Build delegate_batch requests. A multi-authority dimension is a
      // read-only, independent-perspectives fan-out, not a shared room.
      const requests: DelegationRequest[] = []
      const dimensionIndexByParentTurnId = new Map<string, number>()
      const replicaIndexByParentTurnId = new Map<string, number>()
      const dataParallelGroups = new Map<number, GalaxyDataParallelGroup>()
      const explicitReviewIndexes = new Set(
        dimensions.flatMap((dimension, index) => isReviewDimension(dimension.name) ? [index] : []),
      )

      for (let i = 0; i < dimensions.length; i++) {
        const dim = dimensions[i]!
        const stars = dim.authorities ?? (dim.authority && dim.authority !== '' ? [dim.authority] : [])
        const isDataParallel = dim.parallelism === 'data'
        const perspectiveGroupId = stars.length > 1 ? `galaxy:perspectives:${params.toolUseId}:${i}` : undefined
        const dataParallelGroupId = isDataParallel ? `galaxy:data:${params.toolUseId}:${i}` : undefined
        const replicaCount = isDataParallel ? dim.replicas! : 1
        if (isDataParallel) dataParallelGroups.set(i, { label: dim.name, workOrderIds: [] })

        for (let j = 0; j < stars.length; j++) {
          const star = stars[j]!
          for (let replicaIndex = 0; replicaIndex < replicaCount; replicaIndex++) {
            const parentTurnId = galaxyWorkerParentTurnId(params.toolUseId, i, j, isDataParallel ? replicaIndex : undefined)
            dimensionIndexByParentTurnId.set(parentTurnId, i)
            if (isDataParallel) replicaIndexByParentTurnId.set(parentTurnId, replicaIndex)
            const workOrderId = workerOrderId(parentTurnId)
            if (isDataParallel) dataParallelGroups.get(i)!.workOrderIds.push(workOrderId)

            requests.push({
            parentTurnId,
            objective: isDataParallel
              ? `${dim.objective}\n\nData-parallel replica ${replicaIndex + 1}/${replicaCount}: independently inspect the same evidence. Do not modify files, do not assume other replicas' conclusions, and report concrete evidence, uncertainty, and recommended follow-up.`
              : stars.length > 1
              ? `${dim.objective}\n\n多视角分析：你与其他星域专家独立检查同一问题，但不共享实时上下文。只做证据驱动的分析与建议，不修改文件；明确列出依据、风险和建议。其他视角：${stars.filter(s => s !== star).map(s => { const sd = starDomainRegistry.get(s); return sd ? sd.name : s }).join('、')}。`
              : `${dim.objective}\n\n工业级交付要求：1. 读代码→2. 先写失败测试复现问题（RED）→3. 修改代码使测试通过（GREEN）→4. 运行 typecheck/lint→5. 确认路径通达。不满足任何一条不算完成。注意：不先写测试直接改代码会被 evidence gate 拦截。`,
            kind: mapDimensionToKind(dim.name),
            profile: (dim.profile ?? mapDimensionToProfile(dim.name)) as import('../agent/work-order.js').WorkerProfile,
            authority: star,
            scope: { files: dim.files, symbols: dim.symbols },
            modelOverride: dim.modelOverride,
            groupId: dataParallelGroupId ?? perspectiveGroupId,
            ...(dim.timeoutMs || dim.maxTurns
              ? { budget: toBudgetOverride({ timeoutMs: dim.timeoutMs, maxTurns: dim.maxTurns }) }
              : {}),
            })
          }
        }
      }

      // Fail early if any dimension has no valid star assigned
      if (requests.length === 0) {
        return { content: '星河执行失败：所有维度均未指定有效星域。每个维度必须指定 authority 或 authorities。', isError: true }
      }

      // ── Detect & deduplicate overlapping file scopes to prevent worker conflicts ──
      const fileOwner = new Map<string, number>() // file path → first dimension index
      for (let i = 0; i < dimensions.length; i++) {
        for (const f of dimensions[i]!.files ?? []) {
          if (!fileOwner.has(f)) fileOwner.set(f, i)
        }
      }
      // Remove overlapping files from non-owning workers' scopes
      for (const req of requests) {
        const dimIdx = dimensionIndexByParentTurnId.get(req.parentTurnId)
        if (dimIdx === undefined) continue
        const owned = dimensions[dimIdx]?.files ?? []
        const deduped = owned.filter(f => {
          const owner = fileOwner.get(f)
          return owner === undefined || owner === dimIdx
        })
        ;(req as any).scope = { ...req.scope, files: deduped }
      }

      // A review is a true join node. Use stable work-order IDs, not request
      // parent IDs, because the queue only tracks the former.
      const executionWorkerIds = requests
        .filter(request => !explicitReviewIndexes.has(dimensionIndexByParentTurnId.get(request.parentTurnId) ?? -1))
        .map(request => workerOrderId(request.parentTurnId))
      const explicitReviewRequests = requests.filter(request =>
        explicitReviewIndexes.has(dimensionIndexByParentTurnId.get(request.parentTurnId) ?? -1),
      )
      for (const request of explicitReviewRequests) {
        request.dependencies = executionWorkerIds
      }

      const hasExplicitReview = explicitReviewIndexes.size > 0
      if (autoReview && !hasExplicitReview) {
        const autoReviewParentTurnId = `batch:${params.toolUseId}-galaxy:auto-review`
        requests.push({
          parentTurnId: autoReviewParentTurnId,
          objective: '全局审查——星河集群所有执行维度已完成。逐项验证：正确性、完整性、安全性、边界条件。特别关注跨维度冲突（如前后端接口不一致）。输出通过的项和需修复的项。',
          kind: 'review',
          profile: 'reviewer',
          authority: 'yaoguang',
          scope: { files: [] },
          dependencies: executionWorkerIds,
        })
      }

      // Activity streaming
      const textStreamer = params.onOutput ? createActivityStreamer(params.onOutput) : undefined
      // Activity streaming — map all worker IDs to their objectives
      const objectiveById = new Map<string, string>()
      for (const req of requests) {
        const dim = dimensions[dimensionIndexByParentTurnId.get(req.parentTurnId) ?? -1]
        const stars = dim ? (dim.authorities ?? (dim.authority ? [dim.authority] : [])) : []
        const perspectiveNote = stars.length > 1 ? ` ◌ ${dim!.name}` : ''
        const label = req.objective || perspectiveNote || '审查'
        objectiveById.set(req.parentTurnId, label)
        objectiveById.set(workerOrderId(req.parentTurnId), label)
      }
      const activityMapper = params.onWorkerActivity
        ? createDelegationActivityMapper(params.toolUseId, params.onWorkerActivity, {
            objectiveOf: (id) => objectiveById.get(id),
          })
        : undefined
      const streamActivity = (textStreamer || activityMapper)
        ? (ev: WorkerActivityEvent) => {
            textStreamer?.(ev)
            activityMapper?.(ev)
          }
        : undefined

      // Attach activity handler to requests
      for (const req of requests) {
        req.onActivity = streamActivity
        req.onNestedActivity = params.onWorkerActivity
      }

      let run: CoordinatorRun
      try {
        run = await coordinator.delegateBatch(
          requests,
          policy ?? 'all_required',
          params.abortSignal,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: `星河执行失败：${msg}`,
          isError: true,
        }
      }

      return {
        content: formatGalaxyResult(run, requests.map(request => {
          const dimensionIndex = dimensionIndexByParentTurnId.get(request.parentTurnId)
          if (dimensionIndex === undefined) return { workOrderId: workerOrderId(request.parentTurnId), label: '全局审查' }
          const dimension = dimensions[dimensionIndex]!
          const stars = dimension.authorities ?? (dimension.authority ? [dimension.authority] : [])
          const authorityIndex = stars.indexOf(request.authority ?? '')
          const star = starDomainRegistry.get(request.authority ?? '')
          const perspective = stars.length > 1 ? ' ◌ 多视角' : ''
          const replicaIndex = replicaIndexByParentTurnId.get(request.parentTurnId)
          const replica = replicaIndex === undefined ? '' : ` DP replica ${replicaIndex + 1}/${dimension.replicas}`
          return {
            workOrderId: workerOrderId(request.parentTurnId),
            label: `${dimension.name}${perspective}${replica} ${star?.name ?? request.authority ?? authorityIndex}`,
          }
        }), [...dataParallelGroups.values()]),
        uiContent: formatGalaxyUi(run, dimensions),
      }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    // 外层超时必须覆盖 worker pool 的波次 × profile 预算，否则工具层先杀
    timeoutMs: (params) => {
      const dims = (params?.input?.dimensions as Array<{ authorities?: string[]; authority?: string; profile?: string; timeoutMs?: number; parallelism?: 'expert' | 'data'; replicas?: number }> | undefined) ?? []
      const profiles: Array<string | undefined> = []
      const requestedTimeoutMs: Array<number | undefined> = []
      for (const d of dims) {
        const stars = d.authorities ?? (d.authority ? [d.authority] : [])
        const replicaCount = d.parallelism === 'data' ? d.replicas ?? 1 : 1
        for (let i = 0; i < stars.length * replicaCount; i++) {
          profiles.push(d.profile)
          requestedTimeoutMs.push(d.timeoutMs)
        }
      }
      return delegationToolTimeoutMs(
        params?.sessionTurnCount,
        profiles,
        { taskCount: profiles.length, requestedTimeoutMs },
      )
    },
  }
}
