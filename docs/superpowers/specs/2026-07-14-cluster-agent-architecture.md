# 星河 (Galaxy) 集群 Agent 架构 — 设计文档

> 日期：2026-07-14
> 状态：设计迭代中（第二版——融入 skill 调用范式 + 意图分析 + 用户确认 + 前缀缓存保持）

## 背景与问题

当前天枢的委派机制是**单层**的：主 Agent 通过 `delegate_task`/`delegate_batch` 将任务派发给 worker，worker 执行完后返回结果。12 星域的能力注入改变了 worker 的**认知姿态**和**工具白名单**，但子 Agent（星域 worker）缺少一个内建的集群编排原语——当任务天然可拆解为多个维度（"前端 + 后端 + 审查"）时，子 Agent 需要手动多次调用 `delegate_task` 来模拟集群行为。

**用户需求**：子 Agent 内部拥有一层"分子 Agent 集群"——命名为**星河（Galaxy）**。星河的理念：

1. 用户下达任务 → 子 Agent 分析任务意图和用户是否启用星河的意图
2. 满足触发条件时**询问用户确认**，确认后启动星河
3. 星河内部**像调用 skill 一样调用不同的星域**——每个星域作为一个分子 Agent 独立执行
4. 结果汇总后由子 Agent 统一审查交付
5. **前缀缓存必须保持**——星河的工具定义字节稳定，与 skill 工具同构

## 调研发现

### Skill 系统的三级渐进装载模式（先例）

Skill 系统的设计是星河的最佳先例：

```
L1 发现层：available-skills 块（仅 name+description，字节稳定，注入 volatile appendix）
    ↓
L2 激活层：skill(name="X") 工具加载完整 SKILL.md 正文（返回 tool result，追加到历史）
    ↓
L3 子文件层：目录技能的 <skill-files> 清单（用到哪个 read_file 哪个）
```

关键设计决策（直接复用到星河）：
- **工具定义字节稳定**：`skill` 工具的 `definition.description` 不嵌入任何具体 skill 名称，技能列表只存在于 volatile discovery block → 前缀缓存安全
- **加载-执行-完成 生命周期**：`skill(name, complete=true)` 标记完成，释放上下文
- **调用后持久注入**：`invoked-skills` 块在 compaction 后重新注入，确保跨压缩轮不丢失

### 现有委派能力与星河的关系

| 现有机制 | 星河中的角色 |
|----------|-------------|
| `delegate_batch` + `dependsOn` | 星河内部分子 Agent 的派发通道（完全复用） |
| `authority` 星域注入 | 每个分子 Agent 使用不同星域姿态 |
| `aggregation.ts` 聚合策略 | 星河结果汇总 |
| `worker-prompts.ts` 续跑提示 | 星河结果可被 resume |
| `skill` 工具加载流程 | 星河的调用范式模板 |

### Worker 工具白名单现状

在 `worker-prompts.ts` 第 441/549/554 行，worker prompt 中**已提示 `delegate_task({resume})` 用法**，说明子 Agent 委派在设计意图内。但当前除天枢外的星域 `toolWhitelist` 未包含委派工具。

## 方案对比

| 方案 | 核心选择 | 优势 | 代价 | 结论 |
|------|----------|------|------|------|
| A: 开放 `delegate_batch` + 手动组合 | 给星域白名单加 `delegate_batch`，子 Agent 手写拆分 | 零新代码 | 模型负担重；无意图分析/确认门禁；无缓存优化 | 淘汰 |
| B: 新建 `galaxy` 工具（独立） | 全新工具，内部调 `delegate_batch`，自带意图分析和确认 | 封装干净；skill 范式一致 | 新工具注册、测试、prompt | **存活** |
| C: 复用 `skill` 框架 | 把星域封装成 skill，skill 内部触发 delegate | skill 框架是加载指令的，星河是派发 agent 的——类型不匹配 | 语义强扭 | 淘汰 |

## 最终方案：`galaxy` 工具 — 星河集群

### 核心理念

> 星河不是一轮对话，而是一个集群执行环境。子 Agent 像加载 skill 一样加载星河，星河内部像调用不同 skill 一样调用不同星域的分子 Agent。

### 调用流程

```
用户下达任务
    │
    ▼
主 Agent 分析 → delegate_task(子 Agent, authority: 某星域)
    │
    ▼
子 Agent 分析任务：
    ├─ 是否多维度可并行？（前端+后端+审查 / 实现+测试+文档 / ...）
    ├─ 用户是否表达了启用星河的意图？（"用星河""集群处理""并行"）
    └─ 任一满足 → 调用 galaxy 工具
            │
            ▼
        galaxy 工具：
            1. 展示集群组成方案（哪些星域，各自做什么）
            2. 如果用户未显式确认 → ask_user_question 请求确认
            3. 确认后 → delegate_batch 派发分子 Agent
            4. 审查维度自动追加（dependsOn 排在执行维度之后）
            5. 汇总结果返回子 Agent
            │
            ▼
        子 Agent 审查汇总结果 → 交付主 Agent
```

### 工具 Schema

```typescript
// galaxy 工具 —— 子 Agent 的集群派发原语
const galaxyInputSchema = z.object({
  objective: z.string().min(1),       // 集群总目标
  dimensions: z.array(z.object({
    name: z.string(),                  // 维度标识（frontend / backend / review / test / docs）
    objective: z.string(),             // 该维度的具体目标
    authority: authorityStringSchema,  // 使用的星域（必填——星河的核心是星域选择）
    profile: profileStringSchema.optional(),
    files: z.array(z.string()).optional(),
  })).min(2).max(5),
  autoReview: z.boolean().default(true), // 自动追加审查维度（瑶光）
  confirm: z.boolean().default(false),   // 用户已确认（跳过询问）
  policy: aggregationPolicySchema.optional(),
})
```

### 工具定义（字节稳定设计——完全复刻 skill 工具模式）

```typescript
// galaxy 工具的 definition.description 不嵌入任何具体星域名称或维度名称
// 全部动态内容通过 tool result 返回 → 字节稳定 → 前缀缓存安全
{
  name: 'galaxy',
  description: `启动星河集群——将当前任务拆解为多个维度，由不同星域的分子 Agent 并行执行，结果汇总后统一审查。

调用前先判断：任务是否可拆解为 2+ 个独立维度（如前端+后端+审查）？用户是否表达了启用星河的意图？
任一条件满足 → 用此工具展示集群方案 → 等待用户确认 → 执行。

星河内部每个维度由指定星域的分子 Agent 独立执行，像调用不同 skill 一样调用不同星域。
执行完成后自动追加审查维度（瑶光），确保输出质量。`,
  input_schema: { ... }
}
```

### 星河与 Skill 的范式同构

| Skill | 星河 |
|-------|------|
| `available-skills` 块（名+描述） | `available-stars` 块（12 星域名+简述）——已存在于 system prompt |
| `skill(name="X")` 加载指令 | `galaxy({dimensions: [{authority: "yaoguang"}, ...]})` 启动集群 |
| skill body 注入 prompt | 星域 volatileBlock 注入分子 Agent system prompt |
| `skill(name, complete=true)` 释放 | 集群执行完毕自动释放（无状态残留） |
| `invoked-skills` 跨压缩持久 | 星河结果通过 tool result 留在历史中，自然跨压缩 |

### 意图分析与确认门禁

子 Agent 在决定调用 `galaxy` 前需过两道门：

**门 1：任务适合度判断**
- 任务是否可拆解为 2+ 个独立维度？
- 维度之间是否有明确的依赖关系（适合 dependsOn 排序）？
- 单个维度的复杂度是否值得启动独立 worker？（避免"杀鸡用牛刀"）

**门 2：用户意图判断**
- 用户原始消息中是否包含"星河""集群""并行""多路"等触发词？
- 用户是否在之前的交互中表达过对并行处理的需求？

至少一道门通过 → 子 Agent 调用 `galaxy` 工具（不带 `confirm: true`）→ 工具展示方案 → 自动 `ask_user_question` 请求确认 → 用户确认后子 Agent 重新调用 `galaxy({..., confirm: true})` → 执行。

如果两道门都不通过但子 Agent 判断"可能适合"→ 可以先在回复中用一句话建议"这个任务可以拆成 X + Y 并行，要用星河吗？"。

### 内部实现

```typescript
// src/tools/galaxy.ts
export function createGalaxyTool(coordinator: DelegateBatchCoordinator): Tool {
  return {
    definition: { /* 字节稳定定义，见上 */ },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = galaxyInputSchema.safeParse(params.input)
      if (!parsed.success) return { content: `星河参数错误：${parsed.error.message}`, isError: true }

      const { objective, dimensions, autoReview, confirm, policy } = parsed.data

      // 1. 如果没有 confirm 且用户未显式确认 → 展示方案并请求确认
      if (!confirm) {
        return renderGalaxyProposal(objective, dimensions, autoReview)
      }

      // 2. 构建 delegate_batch 的 tasks 数组
      const tasks = dimensions.map((dim, i) => ({
        objective: dim.objective,
        kind: mapDimensionToKind(dim.name),
        profile: dim.profile ?? 'code_scout',
        authority: dim.authority,
        files: dim.files,
      }))

      // 3. 自动追加审查维度
      if (autoReview && !dimensions.some(d => d.name === 'review')) {
        const reviewIndex = tasks.length
        tasks.push({
          objective: `审查以上所有维度的输出，验证正确性、完整性和安全性。原始目标：${objective}`,
          kind: 'review',
          profile: 'reviewer',
          authority: 'yaoguang',
          dependsOn: dimensions.map((_, i) => i), // 依赖所有执行维度
        })
      }

      // 4. 派发
      const requests = tasks.map(t => ({
        parentTurnId: `${params.toolUseId}:galaxy`,
        objective: t.objective,
        kind: t.kind,
        profile: t.profile,
        authority: t.authority,
        scope: { files: t.files ?? [] },
        dependsOn: t.dependsOn,
      }))

      const run = await coordinator.delegateBatch(requests, policy ?? 'all_required')

      // 5. 格式化结果
      return {
        content: formatGalaxyResult(run, dimensions),
        uiContent: formatGalaxyUi(run, dimensions),
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false, // 涉及多 worker 派发
    isEnabled: () => true,
  }
}
```

### 结果格式化

```
🌌 星河集群执行报告 · 3/3 通过 · 2 执行 + 1 审查

  前端 (文曲/code_scout): ✓ 实现了登录页面组件和表单验证
      changed: src/components/Login.tsx, src/hooks/useAuth.ts

  后端 (天机/code_scout): ✓ 实现了 JWT 签发和 /api/login 端点
      changed: src/api/auth.ts, src/middleware/jwt.ts

  审查 (瑶光/reviewer): ⚠ 1 个发现
      - token 未设 expiresIn，建议设为 24h

  聚合结论: 前后端实现对接到位。审查发现 1 个安全建议，已在风险中标注。
```

### 前缀缓存策略

`galaxy` 工具的字节稳定保证：

1. **工具 definition 不嵌入动态内容**：与 `skill` 工具完全同构——description 中不出现任何星域名称、维度名称或示例参数值
2. **工具 schema 使用类型引用**：`authorityStringSchema`、`profileStringSchema` 等已存在的 schema 引用
3. **动态内容仅在 tool result 中返回**：集群方案展示、执行结果等全部活在 tool result 里，不影响 frozen prefix
4. **星域列表已在 system prompt 中**：12 星域的 name+简述是 system prompt 的固定部分，不作为工具 definition 的一部分

### 边界标定

**会碰的文件：**

| 文件 | 改动 | 说明 |
|------|------|------|
| `src/tools/galaxy.ts` | **新建** | 星河工具实现 |
| `src/tools/default-registry.ts` | 修改 | 注册 `galaxy` |
| `src/agent/star-domain-data.ts` | 修改 | 向天权/天梁/破军/天枢白名单加 `galaxy` |
| `src/agent/worker-prompts.ts` | 修改 | worker prompt 增加星河使用指南 |
| `src/prompt/` | 修改 | system prompt 工具描述块增加 `galaxy` |
| `src/tools/__tests__/galaxy.test.ts` | **新建** | 测试 |

**不改的：**
- `coordinator.ts` — 复用 `delegateBatch`
- `aggregation.ts` — 复用聚合策略
- `council/` — 星河是执行原语，council 是计划审查
- `skill.ts` — 星河借鉴 skill 范式但不耦合 skill 实现

### 先例引用

- `skill` 工具的三级装载 + 字节稳定 definition 是星河设计的直接模板
- `council-orchestrator.ts` 的 `CouncilFanoutRequest → delegateBatch` 证明"高层抽象内部调 delegate_batch"可行
- `aggregation.ts` 的 `detectVerificationGap` 是 `autoReview` 维度的先例
- `worker-prompts.ts:441` 已有 `delegate_task({resume})` 引用

### 风险与应对

| 风险 | 应对 |
|------|------|
| Worker 嵌套委派 token 消耗 | 星河仅向天权/天梁/破军/天枢开放；工具描述含用量建议 |
| 用户确认打断流程 | confirm 参数支持预确认跳过；简单任务子 Agent 自行判断不调用 |
| 分子 Agent 质量不稳定 | 自动审查维度（瑶光）作为硬门禁 |
| 前缀缓存膨胀 | 工具定义字节稳定 + 动态内容在 tool result |
| 与 `team_orchestrate` 语义重叠 | 星河：子 Agent 内即时并行；team：主 Agent 级计划驱动。工具描述中区分 |

## 实施路径

**Wave 1：核心工具 + 注册 + 白名单**
1. 新建 `src/tools/galaxy.ts`
2. 在 `default-registry.ts` 注册
3. 向天枢/天权/天梁/破军的 `toolWhitelist` 添加 `galaxy`
4. 写测试 `galaxy.test.ts`
5. typecheck + 测试

**Wave 2：Prompt 集成**
6. 更新 `worker-prompts.ts` 中的星河使用指南
7. 更新 system prompt 中的工具描述
8. 端到端验证
