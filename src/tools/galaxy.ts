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
  authority: authorityStringSchema.describe('该维度使用的星域'),
  profile: profileStringSchema.optional().describe('worker profile，默认 code_scout'),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  maxTurns: delegateMaxTurnsSchema,
  timeoutMs: delegateTimeoutMsSchema,
})

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
  frontend: 'code_search',
  backend: 'code_search',
  impl: 'code_search',
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
    `分子 Agent 组成（${dimensions.length} 个维度${autoReview ? ' + 1 自动审查' : ''}）：`,
  ]

  for (let i = 0; i < dimensions.length; i++) {
    const d = dimensions[i]!
    const star = starDomainRegistry.get(d.authority)
    const label = star ? `${star.name}（${star.motto.slice(0, 12)}…）` : d.authority
    lines.push(`  ${i + 1}. ${d.name} — ${label}`)
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
  const execCount = dimensions.length
  const reviewCount = total - execCount

  const lines: string[] = [
    `${GALAXY_GLYPH} 星河集群执行报告 · ${passed}/${total} 通过 · ${execCount} 执行 + ${reviewCount} 审查`,
    '',
  ]

  for (let i = 0; i < run.results.length; i++) {
    const r = run.results[i]!
    const dim = dimensions[i]
    const dimName = dim?.name ?? (i < execCount ? `维度 ${i + 1}` : '审查')
    const authority = dim?.authority ?? (r as any).authority ?? 'unknown'

    const star = starDomainRegistry.get(authority)
    const starName = star?.name ?? authority

    const identity = formatWorkerIdentity({ profile: r.profile ?? 'code_scout', authority })
    const digest = formatWorkerResultDigest({
      status: r.status,
      summary: r.summary,
      findingsCount: r.findings?.length ?? 0,
      changedFilesCount: r.changedFiles?.length ?? 0,
      failureReason: r.failureReason,
      evidenceStatus: r.evidenceStatus,
    })

    lines.push(`  ${dimName} (${starName}/${r.profile ?? 'code_scout'}): ${digest}`)
    if (r.changedFiles.length > 0) {
      lines.push(`      changed: ${r.changedFiles.slice(0, 5).join(', ')}`)
      if (r.changedFiles.length > 5) lines.push(`      … (+${r.changedFiles.length - 5} more)`)
    }
    lines.push('')
  }

  // 聚合结论
  const allPassed = passed === total
  const hasFindings = run.results.some(r => r.findings.length > 0)
  const hasChanges = run.results.some(r => r.changedFiles.length > 0)

  if (allPassed) {
    lines.push('聚合结论: 所有维度通过。')
  } else {
    const failed = total - passed
    lines.push(`聚合结论: ${failed}/${total} 个维度未通过，请检查上述摘要并在本回合内修复后再交付。`)
  }
  if (hasFindings && !allPassed) {
    lines.push('审查发现的问题已标注在各维度下方，优先修复阻塞项。')
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
      description: `启动星河集群——将当前任务拆解为多个维度，由不同星域的分子 Agent 并行执行，结果汇总后统一审查。

调用前先判断：任务是否可拆解为 2+ 个独立维度（如前端+后端+审查）？用户是否表达了启用星河的意图？
任一条件满足 → 用此工具展示星河方案 → 等待用户确认 → 再次调用 galaxy({..., confirm: true}) 执行。

星河内部每个维度由指定星域的分子 Agent 独立执行，像调用不同 skill 一样调用不同星域。
执行完成后自动追加审查维度（瑶光），确保输出质量。

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
                authority: { type: 'string', description: '该维度使用的星域 id（如 tianquan、tianji、yaoguang、wenqu、pojun）。必填——星河的核心是星域选择。' },
                profile: { type: 'string', enum: profileRegistry.getProfileNames(), description: 'worker profile。默认按维度名自动推导。' },
                files: { type: 'array', items: { type: 'string' }, description: '可选，聚焦的文件路径。' },
                symbols: { type: 'array', items: { type: 'string' }, description: '可选，聚焦的符号。' },
                maxTurns: { type: 'integer', description: MAX_TURNS_TOOL_DESCRIPTION },
                timeoutMs: { type: 'integer', description: TIMEOUT_MS_TOOL_DESCRIPTION },
              },
              required: ['name', 'objective', 'authority'],
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
      const taskCount = dimensions.length

      // Build delegate_batch requests
      const requests: DelegationRequest[] = dimensions.map((dim, i) => ({
        parentTurnId: `${params.toolUseId}:galaxy:${i}`,
        objective: dim.objective,
        kind: mapDimensionToKind(dim.name),
        profile: (dim.profile ?? mapDimensionToProfile(dim.name)) as import('../agent/work-order.js').WorkerProfile,
        authority: dim.authority,
        scope: { files: dim.files, symbols: dim.symbols },
      }))

      // Auto-append review dimension
      let reviewDimIndex = -1
      const hasExplicitReview = dimensions.some(d => {
        const k = d.name.toLowerCase().replace(/[\s_-]/g, '')
        return k === 'review' || k === 'verify'
      })
      if (autoReview && !hasExplicitReview) {
        reviewDimIndex = requests.length
        requests.push({
          parentTurnId: `${params.toolUseId}:galaxy:review`,
          objective: `审查星河集群所有执行维度的输出。原始目标：${objective}。逐项验证：正确性、完整性、安全性、边界条件。输出通过的项和需修复的项，每项标注具体文件位置。`,
          kind: 'review',
          profile: 'reviewer',
          authority: 'yaoguang',
          scope: { files: [] },
          // 审查依赖所有执行维度——等它们全部完成后再审查
          dependencies: dimensions.map((_, i) => `${params.toolUseId}:galaxy:${i}`),
        })
      }

      // Activity streaming
      const textStreamer = params.onOutput ? createActivityStreamer(params.onOutput) : undefined
      const objectiveById = new Map<string, string>()
      for (let i = 0; i < taskCount; i++) {
        objectiveById.set(`${params.toolUseId}:galaxy:${i}`, dimensions[i]!.objective)
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
