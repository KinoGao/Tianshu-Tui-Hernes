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
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import { aggregationPolicySchema, type AggregationPolicy, type WorkOrderKind } from '../agent/work-order.js'
import { DEFAULT_DELEGATE_PROFILE, profileRegistry } from '../agent/profile-registry.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import { formatWorkerResultDigest } from '../agent/worker-result-digest.js'
import { formatWorkerIdentity } from '../tui/format/profile-labels.js'
import { validatePathSafe } from './path-validate.js'
import {
  MAX_TURNS_TOOL_DESCRIPTION,
  TIMEOUT_MS_TOOL_DESCRIPTION,
  delegateMaxTurnsSchema,
  delegateTimeoutMsSchema,
  toBudgetOverride,
} from './delegate-budget.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { createActivityStreamer, createDelegationActivityMapper, progressSnippet } from './worker-activity-stream.js'
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

/** Dynamic star-domain validation — same as delegate-task.ts */
const authorityStringSchema = z.string().refine(
  (val) => starDomainRegistry.getDomainIds().includes(val),
  (val) => ({ message: `未知星域 "${val}"。可用：${starDomainRegistry.getDomainIds().join(', ')}` }),
)

const dimensionSchema = z.object({
  name: z.string().min(1).describe('维度标识（如 frontend / backend / review / test / docs）'),
  objective: z.string().min(1).describe('该维度的具体执行目标'),
  authority: authorityStringSchema.optional().describe('该维度使用的星域（单星域，与 authorities 二选一）'),
  authorities: z.array(authorityStringSchema).min(2).max(5).optional().describe(
    '该维度使用的多个星域，共享同一个"房间"——同组 worker 互相感知，可并行讨论。与 authority 二选一，多个星域时用此字段。',
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
  d => d.authority !== undefined || d.authorities !== undefined,
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
  if (key === 'plan' || key === 'design') return 'planner'
  if (key === 'docs' || key === 'research') return 'doc_scout'
  return DEFAULT_DELEGATE_PROFILE
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
    `分子 Agent 组成（${dimensions.length} 个维度${autoReview && !dimensions.some(d => d.name === 'review') ? ' + 1 自动审查' : ''}）：`,
  ]

  for (let i = 0; i < dimensions.length; i++) {
    const d = dimensions[i]!
    const stars = d.authorities ?? (d.authority ? [d.authority] : [])
    const starLabels = stars.map(s => {
      const star = starDomainRegistry.get(s)
      return star ? `${star.name}` : s
    })
    const roomTag = stars.length > 1 ? ` 🏠 共享房间（${starLabels.join(' + ')}）` : ` — ${starLabels[0]}`
    lines.push(`  ${i + 1}. ${d.name}${roomTag}`)
    lines.push(`     ${d.objective}`)
  }

  if (autoReview && !dimensions.some(d => d.name === 'review')) {
    const yaoguang = starDomainRegistry.get('yaoguang')
    const label = yaoguang ? `瑶光（${yaoguang.motto.slice(0, 12)}…）` : '瑶光'
    lines.push(`  ${dimensions.length + 1}. review — ${label}`)
    lines.push(`     审查以上所有维度的输出，验证正确性、完整性和安全性`)
  }

  lines.push('')
  lines.push('调用 galaxy({..., confirm: true}) 确认并执行。')

  return lines.join('\n')
}

function formatGalaxyResult(
  run: CoordinatorRun,
  dimensions: z.infer<typeof dimensionSchema>[],
): string {
  const passed = run.results.filter(r => r.status === 'passed').length
  const total = run.results.length

  // Rebuild dimension→results mapping (multi-authority dims produce N results)
  const expandedDims: { dimName: string; starName: string; starId: string; isRoom: boolean }[] = []
  for (const dim of dimensions) {
    const stars = dim.authorities ?? (dim.authority ? [dim.authority] : [])
    for (const star of stars) {
      const starDef = starDomainRegistry.get(star)
      expandedDims.push({
        dimName: dim.name,
        starName: starDef?.name ?? star,
        starId: star,
        isRoom: stars.length > 1,
      })
    }
  }

  const lines: string[] = [
    `${GALAXY_GLYPH} 星河集群执行报告 · ${passed}/${total} 通过`,
    '',
  ]

  let ri = 0
  for (const ed of expandedDims) {
    const r = run.results[ri]
    if (!r) break
    const roomTag = ed.isRoom ? ' 🏠' : ''

    const digest = formatWorkerResultDigest({
      status: r.status,
      summary: r.summary,
      findingsCount: r.findings?.length ?? 0,
      changedFilesCount: r.changedFiles?.length ?? 0,
      failureReason: r.failureReason,
      evidenceStatus: r.evidenceStatus,
    })

    lines.push(`  ${ed.dimName}${roomTag} ${ed.starName}: ${digest}`)
    if (r.changedFiles.length > 0) {
      lines.push(`      changed: ${r.changedFiles.slice(0, 5).join(', ')}`)
      if (r.changedFiles.length > 5) lines.push(`      … (+${r.changedFiles.length - 5} more)`)
    }
    lines.push('')
    ri++
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

**门控输出格式：** 自动生成 galaxy dimensions 数组，每个维度带 authority + files 范围。

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
                authorities: { type: 'array', items: { type: 'string' }, description: '该维度使用的多个星域 id，共享同一个"房间"互相感知。与 authority 二选一。' },
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

      // Pre-flight: validate file paths
      for (let i = 0; i < dimensions.length; i++) {
        const files = dimensions[i]!.files
        if (files && files.length > 0) {
          const bad = files.filter(f => !validatePathSafe(params.cwd, f).ok)
          if (bad.length > 0) {
            return {
              content: `星河已拦截：维度「${dimensions[i]!.name}」引用了项目目录外的文件：${bad.join(', ')}`,
              isError: true,
            }
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

      // Build delegate_batch requests: expand authorities arrays into individual workers
      const requests: DelegationRequest[] = []
      const roomMap = new Map<string, string[]>() // groupId → worker labels for prompt injection

      for (let i = 0; i < dimensions.length; i++) {
        const dim = dimensions[i]!
        const stars = dim.authorities ?? (dim.authority ? [dim.authority] : [])
        const roomId = `galaxy:room:${i}`

        for (let j = 0; j < stars.length; j++) {
          const star = stars[j]!
          const workerId = `${params.toolUseId}:galaxy:${i}:${j}`

          requests.push({
            parentTurnId: workerId,
            objective: stars.length > 1
              ? `${dim.objective}\n\n协作指令：你是房间「${dim.name}」的一员（共 ${stars.length} 席）。\n1. 先读代码分析职责边界 → 2. 在你的输出开头声明「我负责：[具体文件/模块]」→ 3. 只改你声明的部分，不要碰同伴的领地 → 4. 完成后等互审。同伴是：${stars.filter(s => s !== star).map(s => { const sd = starDomainRegistry.get(s); return sd ? sd.name : s; }).join('、')}。`
              : dim.objective,
            kind: mapDimensionToKind(dim.name),
            profile: (dim.profile ?? mapDimensionToProfile(dim.name)) as import('../agent/work-order.js').WorkerProfile,
            authority: star,
            scope: { files: dim.files, symbols: dim.symbols },
            modelOverride: dim.modelOverride,
            groupId: stars.length > 1 ? roomId : undefined,
          })

          if (stars.length > 1) {
            const entry = roomMap.get(roomId) ?? []
            entry.push(star)
            roomMap.set(roomId, entry)
          }
        }
      }

      // Auto-append review dimension (with per-room peer review if rooms exist)
      let reviewDimIndex = -1
      const hasExplicitReview = dimensions.some(d => {
        const k = d.name.toLowerCase().replace(/[\s_-]/g, '')
        return k === 'review' || k === 'verify'
      })
      if (autoReview && !hasExplicitReview) {
        // 同房间互审：每个共享房间追加一个互审 worker，依赖该房间所有执行 worker
        for (const [roomId, stars] of roomMap) {
          const roomWorkers = requests.filter(r => r.groupId === roomId)
          const roomWorkerIds = roomWorkers.map(r => r.parentTurnId)
          const roomName = roomId.split(':').pop() ?? roomId
          requests.push({
            parentTurnId: `${roomId}:peer-review`,
            objective: `同房间协商合并——${roomName}房间（${stars.join('、')}）各席已完成独立修改。请做三件事：\n1. 合并各席声明负责的部分，标注领地冲突（两席改了同一文件）\n2. 跑一次完整测试验证合并后没问题\n3. 输出统一汇总：做了什么、测试结果、遗留问题`,
            kind: 'review',
            profile: 'reviewer',
            authority: 'yaoguang',
            scope: { files: [] },
            dependencies: roomWorkerIds,
            groupId: roomId,
          })
        }

        // 全局审查：依赖所有 worker（含互审 worker），做跨维度一致性检查
        reviewDimIndex = requests.length
        const allWorkerIds = requests.map(r => r.parentTurnId)
        requests.push({
          parentTurnId: `${params.toolUseId}:galaxy:review`,
          objective: `全局审查——星河集群所有维度（含互审）已完成。逐项验证：正确性、完整性、安全性、边界条件。特别关注跨维度冲突（如前后端接口不一致）。输出通过的项和需修复的项。`,
          kind: 'review',
          profile: 'reviewer',
          authority: 'yaoguang',
          scope: { files: [] },
          dependencies: allWorkerIds,
        })
      }

      // Activity streaming
      const textStreamer = params.onOutput ? createActivityStreamer(params.onOutput) : undefined
      // Activity streaming — map all worker IDs to their objectives
      const objectiveById = new Map<string, string>()
      for (const req of requests) {
        const dimIdx = req.parentTurnId.match(/:galaxy:(\d+)/)?.[1]
        const dim = dimIdx !== undefined ? dimensions[parseInt(dimIdx)] : undefined
        const stars = dim ? (dim.authorities ?? (dim.authority ? [dim.authority] : [])) : []
        const roomNote = stars.length > 1 ? ` 🏠 ${dim!.name}` : ''
        objectiveById.set(req.parentTurnId, req.objective || roomNote || '')
      }
      if (reviewDimIndex >= 0) {
        objectiveById.set(`${params.toolUseId}:galaxy:review`, '审查')
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
        content: formatGalaxyResult(run, dimensions),
        uiContent: formatGalaxyUi(run, dimensions),
      }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}
