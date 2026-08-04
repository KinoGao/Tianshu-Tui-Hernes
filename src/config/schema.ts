import { z } from 'zod'
import { mcpConfigSchema, type McpConfig } from '../mcp/config.js'
import { THEME_NAMES } from '../tui/theme.js'

export const modelConfigSchema = z.object({
  id: z.string(),
  alias: z.string().optional(),
  /** ???? ? ?????????ModelPicker?????????? */
  description: z.string().optional(),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max']).optional(),
  /** Model accepts image inputs (multimodal user messages). Declared per model,
   *  NOT per provider ? mixed text/vision model fleets under one provider are
   *  the norm. Gates the computer_use screenshot ? conversation vision channel.
   *  Default undefined = text-only (images are dropped, today's behavior). */
  supportsVision: z.boolean().optional(),
  /** Pricing per 1M tokens (USD). Optional ? used by insights / cost visualization. */
  pricing: z.object({
    input: z.number().min(0).optional(),
    output: z.number().min(0).optional(),
    cacheRead: z.number().min(0).optional(),
    cacheWrite: z.number().min(0).optional(),
    reasoning: z.number().min(0).optional(),
    /** True for a genuinely free model (e.g. GLM-4V-Flash) ? distinct from a
     *  subscription plan whose per-token price is also 0 (e.g. GLM Coding Plan).
     *  Drives a "free" badge in the UI and is a candidate for the vision bridge.
     *  Optional; absent = not known to be free (treated as paid). */
    free: z.boolean().optional(),
  }).optional(),
  /** Model tier for routing/fallback decisions. Overrides name-based inference. */
  tier: z.enum(['cheap', 'balanced', 'strong']).optional(),
})

export const authConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('api-key'),
    keyEnv: z.string(),
  }),
  z.object({
    type: z.literal('oauth'),
    provider: z.enum(['codex']),
  }),
])

export const providerCapabilitiesSchema = z.object({
  cacheControl: z.boolean().default(false),
  stripParams: z.array(z.string()).default([]),
  toolJsonBug: z.boolean().default(false),
  prefixCache: z.enum(['deepseek-native', 'anthropic-cache-control', 'none']).default('none'),
  prefixCompletion: z.boolean().default(false),
}).default({})

export const providerSchema = z.object({
  name: z.string(),
  apiKey: z.string().nullable().optional().transform(value => value ?? undefined),
  apiKeyEnv: z.string().nullable().optional().transform(value => value ?? undefined),
  baseUrl: z.string().url(),
  protocol: z.enum(['openai']).default('openai'),
  auth: authConfigSchema.nullable().optional(),
  capabilities: providerCapabilitiesSchema,
  fallback: z.array(z.string()).optional(),
  /** Model to use when falling back to this provider (defaults to 'deepseek-v4-flash'). */
  fallbackModel: z.string().optional(),
  /** Allow strong/pro tier models to be used as fallback. Default false to avoid
   *  cold-start cache-miss cost on large-context pro models. */
  allowProFallback: z.boolean().optional(),
  models: z.array(modelConfigSchema).min(1),
  thinking: z.enum(['enabled', 'disabled']).default('enabled'),
  maxTokens: z.number().int().positive().default(64000),
  /**
   * Thinking-stall timeout (ms): once reasoning tokens have arrived but no text/tool
   * output yet, abort the stream if no further chunk within this window.
   * ?? undefined = ? readMs??????????? SLOW_THINKING provider?? glm?
   * ???????? < readMs ???factory.ts ? glm ??? 120s ?????
   */
  thinkingStallTimeoutMs: z.number().int().positive().optional(),
  /**
   * First-byte (pre-first-chunk) timeout base override (ms).
   * ?? undefined = ? provider/thinking ???45/90/180s??? base ???????
   * ???????????????????????????????/? OpenAI ????
   * ???????????? token ??????????? base?
   */
  firstByteTimeoutMs: z.number().int().positive().optional(),
  unsupported: z.array(z.string()).default([]),
  /**
   * Provider usage calibration factor for `prompt_tokens` (0?1).
   * 1.0 (default) = trust the API's prompt_tokens as-is.
   * 0 = discard prompt_tokens entirely; use local estimateOaiTokens instead.
   * GLM coding API returns prompt_tokens inflated ~20-100x due to server-side
   * reasoning token re-counting; set to 0 for GLM.
   */
  usageCalibrationFactor: z.number().min(0).max(1).optional(),
})

export const permissionAllowRuleSchema = z.object({
  tool: z.string().min(1),
  params: z.record(z.string()).optional(),
})

export const bashAllowlistSchema = z.object({
  /** Command prefixes that bypass bash-write approval. Matched by prefix: "git status" allows "git status --porcelain". */
  allowlist: z.array(z.string().min(1)).default([]),
  /** Command prefixes that are always blocked, regardless of mode or allowlist. */
  denylist: z.array(z.string().min(1)).default([]),
}).default({})

export const permissionsSchema = z.object({
  allow: z.array(permissionAllowRuleSchema).default([]),
  /** Deny rules take precedence over allow rules and approval mode. */
  deny: z.array(permissionAllowRuleSchema).default([]),
  bash: bashAllowlistSchema,
  /**
   * Codex-style standing directory grants, applied at session start without an
   * approval round-trip. Each entry is an absolute or ~-relative directory
   * whose whole subtree becomes readable (additionalReadDirs) or read+writable
   * (additionalWriteDirs) beyond the workspace boundary. A drive root
   * ("F:/", "D:\\") grants the entire drive. Project-level config lets a
   * parent-folder workspace pre-authorize sibling/child project dirs.
   */
  additionalReadDirs: z.array(z.string().min(1)).default([]),
  additionalWriteDirs: z.array(z.string().min(1)).default([]),
})

export const antiAnchoringSchema = z.object({
  enabled: z.boolean().default(false),
  blindExploration: z.boolean().default(true),
  mctsPlanning: z.boolean().default(false),
  branches: z.number().int().positive().default(3),
  planningTurn: z.number().int().positive().default(1),
  projectionThreshold: z.number().min(0).max(1).default(0.4),
  seedMaxTokens: z.number().int().positive().default(512),
  anchorBreakScout: z.object({
    enabled: z.boolean().default(false),
    complexityThreshold: z.number().min(0).max(1).default(0.5),
    minTurn: z.number().int().positive().default(3),
    scoutBudgetMs: z.number().int().positive().default(60_000),
    scoutMaxTokens: z.number().int().positive().default(2048),
  }).default({}),
}).default({})

/** Tier 2 LLM speculation: during a tool-batch await window, fire a side-path
 *  LLM request sharing the main session prefix (near-free on DeepSeek prefix
 *  cache) to predict the next read-only tool calls, feeding ShadowQueue.
 *  ? INERT since 2026-07-07: the speculative pre-execution chain is sealed
 *  (stale-read incident ? ShadowQueue served pre-edit file content); the
 *  engine is no longer constructed regardless of this setting. Schema kept so
 *  existing configs still parse. See P3Config.speculativeEnabled. */
export const llmSpeculationSchema = z.preprocess(
  value => {
    if (value === true) return { enabled: true }
    if (value === false || value === undefined) return {}
    return value
  },
  z.object({
    enabled: z.boolean().default(false),
    maxPerTurn: z.number().int().positive().default(3),
    maxTokens: z.number().int().positive().default(320),
    timeoutMs: z.number().int().positive().default(8_000),
    minProbability: z.number().min(0).max(1).default(0.5),
    /** Only fire when the executing batch contains a slow tool (bash/run_tests/delegate/...). */
    slowToolsOnly: z.boolean().default(true),
  }).default({}),
)

export const intentRetrievalRouterSchema = z.preprocess(
  value => {
    if (value === true) return { enabled: true }
    if (value === false) return { enabled: false }
    if (value === undefined) return { enabled: true }
    return value
  },
  z.object({
    enabled: z.boolean().default(true),
    classifier: z.enum(['heuristic', 'llm']).default('heuristic'),
    timeoutMs: z.number().int().positive().default(4_000),
    maxTokens: z.number().int().positive().default(600),
    temperature: z.number().min(0).max(2).default(0),
  }).default({}),
)

export const banditPromotionModeSchema = z.enum(['off', 'shadow', 'auto', 'forced'])

/** Per-profile review model override. When set, review workers with the
 *  matching profile use this provider+model instead of the session's primary
 *  model. The provider must exist in config.provider.providers. */
export const reviewProfileOverrideSchema = z.object({
  provider: z.string(),
  model: z.string(),
})

/** Review worker configuration block.
 *  - profiles: per-profile override map; omitted profiles fall back to session model
 *  - skipAuto: bypass deliver_task post-commit auto review (per-config equivalent
 *    of RIVET_REVIEW_DISCIPLINE=0, but scoped to this config file). Default true:
 *    auto review is off by default ? users opt in via explicit `false` here, the
 *    RIVET_REVIEW_DISCIPLINE env, or a manual `/review` invocation. */
export const reviewConfigSchema = z.object({
  profiles: z.record(z.string(), reviewProfileOverrideSchema).default({}),
  skipAuto: z.boolean().default(true),
  /** Enable mechanical-change fast-path: docs-only and pure rename changes
   *  bypass verification gate (unverified RED only) and skip review workers.
   *  owned_failure RED is NEVER bypassed. Default true. */
  mechanicalFastPath: z.boolean().default(true),
}).default({})

/** Inferred TS type for the review config block. Consumers (e.g. B1Context.reviewConfig)
 *  should use this instead of redeclaring the shape inline. */
export type ReviewConfig = z.infer<typeof reviewConfigSchema>

/** Per-seat council configuration. When `provider`+`model` are set, that seat's
 *  worker runs on an independent provider/model (its own server-side cache),
 *  enabling heterogeneous councils ? e.g. one seat on DeepSeek Pro, another on
 *  GLM ? for genuine cross-model deliberation. Provider must exist in
 *  config.provider.providers; otherwise the seat silently falls back to the
 *  session model (same rule as agent.review / workers routing). */
export const councilSeatConfigSchema = z.object({
  authority: z.string().min(1),
  charter: z.string().optional(),
  tierHint: z.enum(['cheap', 'balanced', 'strong']).optional(),
  noDowngrade: z.boolean().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
})

/** council_convene seat configuration. `seats` overrides the built-in
 *  tianquan/tianfu/tianxuan default when non-empty. */
export const councilConfigSchema = z.object({
  seats: z.array(councilSeatConfigSchema).default([]),
}).default({})

export type CouncilConfig = z.infer<typeof councilConfigSchema>

export const agentSchema = z.object({
  approval: z.enum(['auto-accept', 'auto-safe', 'suggest', 'manual', 'dangerously-skip-permissions']).default('auto-safe'),
  // ????????runaway ? wedged-loop/convergence/watchdog/context-pressure
  // ????????? Claude Code/Codex ?"????"??? 4 ????50?200?
  // ?? 5158719d ?? 50 ??????????????????????
  // 0 = ?????????? YOLO??wedged-loop ??????????
  maxTurns: z.number().int().nonnegative().default(200),
  mode: z.enum(['code', 'ask', 'plan']).default('code'),
  autoReasoning: z.boolean().default(true),
  /** ?????qiming | tianshu | kaiyang | ? | auto?????????????
   *  ???????? qiming??????????????????'auto' ???
   *  ???????????????????????? domainKeywordRouting?? */
  defaultDomain: z.string().default('qiming'),
  /**
   * ?????provider:modelId ???? "deepseek:deepseek-v4-pro"??
   * ?????????????????????????? provider ?????
   * ????? setDefaultModelConfig ???????? provider + model ????? */
  defaultModel: z.string().optional(),
  /**
   * ?? Auto ???????????????? defaultDomain='auto' ?????
   * ?? true?Auto ?????? auto ????/??/??/?? + ?????
   * ? matchDomain?????? DEFAULT_DOMAIN???????????????
   * ? defaultDomain ??? /domain ????????? false ? Auto ????
   * DEFAULT_DOMAIN?
   */
  domainKeywordRouting: z.boolean().default(true),
  /**
   * ?????????????????????????????????????
   * ?????????????????????????UI ?????????
   * ???? fail-closed?????????????????????????
   */
  resumeFallbackModel: z.string().optional(),
  /** Explicit opt-in for Songline substrate post-session pheromone/cycle relay. */
  songlineEnabled: z.boolean().default(false),
  /** ???????????????1??????????? API ?????????
   *  ??? advisory hook ???? false ? RIVET_SECURITY_GUIDANCE=0 ???
   *  ????????????????????GUI ??? sidecar ???? shell ????? */
  securityGuidance: z.boolean().default(true),
  /** ????? Phase 2?jidoka ?????deliver_task commit ????????
   *  ????? delegate/scout file:line ?? ? isError ???????opt-in?
   *  Phase 1 ???????????????env RIVET_SCOUT_FIREWALL ??? */
  scoutEvidenceFirewall: z.boolean().default(false),
  /** Enable cross-session knowledge loading (memory block, playbook, companion presence).
   *  Default true ? injects distilled project knowledge from .rivet/knowledge/.
   *  Set false for fully isolated sessions. Env RIVET_NO_CROSS_SESSION=1 overrides as force-off. */
  crossSessionEnabled: z.boolean().default(true),
  /** T8 ????????create_document ? 7 ????????????? kernel budget??25?? */
  desktopTools: z.boolean().default(false),
  /** Tool gating: ?????????enabled ???? CORE_TOOLS ????
   *  EXTENDED ?????????????????????? */
  toolGating: z.object({
    enabled: z.boolean().default(true),
    /** ??????? CORE ????????? */
    coreTools: z.array(z.string()).optional(),
    /** ??????? CORE ????????????? */
    extraCore: z.array(z.string()).default([]),
    /** ??????????CORE/EXTENDED/MCP ????Session ?????????????????? */
    disabledTools: z.array(z.string()).optional(),
  }).default({ enabled: true }),
  /** Explicit opt-in for HEARTH anchor invariant observation (postTurn, diagnostic only). */
  hearthObserveEnabled: z.boolean().default(false),
  /** VSW ???????C4??auto = ?6 ?????????????????
   *  ???? worktree ????????????? in-place??????????
   *  always = ??????? RIVET_VSW=1??off = ??????????
   *  ???? RIVET_VSW=1 ??????? always ???? */
  verificationSnapshot: z.enum(['auto', 'always', 'off']).default('auto'),
  /** Explicit opt-in for anti-anchoring harness hooks (prompt-flow intervention). */
  antiAnchoring: antiAnchoringSchema,
  /** Explicit opt-in for auto-delegation of exploration tasks. Default off ? workers cost API budget. */
  autoDelegateEnabled: z.boolean().default(false),
  /** Max nesting depth for delegation (a worker delegating to a sub-worker). Default 2. */
  maxDelegationDepth: z.number().int().positive().default(2),
  /** ?? worker ??????P1-6?coordinator ??????? delegate/
   *  batch/background ?????????????? planner ?????????
   *  ?? 3?RIVET_MAX_WORKERS env ???? */
  maxWorkers: z.number().int().min(1).optional(),
  /** ?? worker?explore ??????S1 ?????? = maxWorkers?
   *  galaxy ????? fan-out ????? 6????????? maxWorkers
   *  ????????? = max(maxWorkers, maxExploreWorkers, maxWriteWorkers)? */
  maxExploreWorkers: z.number().int().min(1).optional(),
  /** ? worker?hands ??????S1 ?????? = maxWorkers?
   *  ????? maxWorkers ?????????????????????
   *  ??????????????? */
  maxWriteWorkers: z.number().int().min(1).optional(),
  /** Default max concurrent workers per team wave when input.maxParallel is unset. Clamped 1..5. */
  maxTeamParallel: z.number().int().min(1).max(5).default(3),
  /** council_convene seat configuration ? custom seats with optional per-seat
   *  provider/model for heterogeneous (cross-model) councils. */
  council: councilConfigSchema,
  /**
   * C3 ????? ? Auto ???? N ???????????0 = ???
   * YOLO ? Manual ???????????????????? auto-safe ??????
   */
  checkpointEveryTurns: z.number().int().min(0).default(0),
  /** Explicit opt-in for current-turn intent retrieval route guidance. */
  intentRetrievalRouter: intentRetrievalRouterSchema,
  /** Tier 2 LLM speculation (shared-prefix next-tool prediction). INERT ? chain sealed 2026-07-07. */
  llmSpeculation: llmSpeculationSchema,
  /** @deprecated Use banditPromotion.teamScheduler ('forced') instead. True still works as forced. */
  teamSchedulerBanditEnabled: z.boolean().default(false),
  /** @deprecated Use banditPromotion.modelTier ('forced') instead. True still works as forced. */
  modelTierBanditEnabled: z.boolean().default(false),
  /** @deprecated Use banditPromotion.modelRouting ('forced') instead. True still works as forced. */
  modelRoutingGatedEnabled: z.boolean().default(false),
  /** Track 1: ?? bandit shadow?gated ????
   *  off=???? / shadow=???? / auto=?????? gated / forced=????? */
  banditPromotion: z.object({
    modelTier: banditPromotionModeSchema.default('shadow'),
    teamScheduler: banditPromotionModeSchema.default('shadow'),
    modelRouting: banditPromotionModeSchema.default('shadow'),
    effort: banditPromotionModeSchema.default('shadow'),
    /** One-key rollback: forces every bandit path off, regardless of modes or legacy flags. */
    killSwitch: z.boolean().default(false),
  }).default({}),
  permissions: permissionsSchema.default({}),
  /** Review worker model routing ? see reviewConfigSchema. */
  review: reviewConfigSchema,
  /** Optional dedicated multimodal model for image recognition.
   *  When the primary model does not declare supportsVision, images sent by the
   *  user are first routed through this model to produce a text description,
   *  which is then prepended to the user prompt sent to the primary model. */
  visionModel: z.object({
    provider: z.string(),
    model: z.string(),
    /** Prompt template for the vision model. Defaults to a generic Chinese description request. */
    prompt: z.string().optional(),
    /** Max output tokens for the generated description. */
    maxTokens: z.number().int().positive().default(1024),
    /** Optional backup vision model ? used when the primary vision model errors
     *  (5xx/timeout). Wrapped in a FallbackStreamClient. Same provider list. */
    fallback: z.object({
      provider: z.string(),
      model: z.string(),
    }).optional(),
  }).optional(),
  /**
   * Opt-in: when `visionModel` is unset and the primary model is text-only, pick
   * the first vision-capable model that has usable credentials and bridge through
   * it. Off by default on purpose ? auto-bridging ships the user's images to a
   * provider they never chose for this purpose, which is a cost and a privacy
   * decision, not a convenience default. When off, an available candidate is
   * reported (TUI hint / `visionBridge.detail`) instead of being used silently.
   */
  visionAutoBridge: z.boolean().default(false),
  /** Greeting LLM: welcome page dynamic greeting feature toggle + model selection. */
  greeting: z.object({
    /** When false, all greeting LLM calls are skipped (algorithm templates only). */
    enabled: z.boolean(),
    /** Model ID for greeting generation (e.g. deepseek-v4-flash). */
    model: z.string(),
  }).optional(),
  /** Goal autonomy (/goal & --goal) completion judge. */
  goal: z.object({
    judge: z.object({
      /** Independently verify a self-declared completion before accepting. Default true. */
      enabled: z.boolean().default(true),
      /** Max judge runs before accepting unverified (anti reject-loop). Clamped 1..10. */
      maxRuns: z.number().int().min(1).max(10).default(3),
      /** Phase 2: allow the judge UI/API/DB browser verification. Default false. */
      browser: z.boolean().default(false),
    }).default({}),
  }).default({}),
  /** ??????? */
  delivery: z.object({
    /** ??????????? git commit??? true???????
     *  ?? false ??deliver_task ???????????????????
     *  ???????????? git commit? */
    autoCommit: z.boolean().default(true),
  }).default({}),
})

export const compactSchema = z.object({
  /** Master switch for discretionary compaction (ratio tiers, 1M LLM compact).
   *  Emergency paths (session split, 95% ceiling) ignore this. */
  enabled: z.boolean().default(true),
  /** @deprecated Superseded by ratio-based policy (compactPolicyRatios).
   *  Retained for config compatibility; not read by the runtime. */
  autoThreshold: z.number().int().positive().default(800_000),
  /** @deprecated Superseded by ratio-based policy (compactPolicyRatios).
   *  Retained for config compatibility; not read by the runtime. */
  autoFloor: z.number().int().positive().default(500_000),
  /** Model that performs the compaction summarization (LLM compact / partial
   *  compact). When the model exists on the primary (or any configured)
   *  provider, a dedicated cheap client is built even if `provider` is unset
   *  ? see resolveCompactProviderName(). Pair with `provider` to force a
   *  specific host. Without a resolvable provider+credentials, compaction
   *  uses the session's primary model (backward compatible). */
  model: z.string().default('deepseek-v4-flash'),
  /** Provider hosting the compaction model (must exist in provider.providers).
   *  Optional: when omitted, the runtime infers a provider that lists `model`
   *  (preferring the session primary). Set explicitly to pin compaction onto
   *  an isolated cheap model. Unknown provider / missing model / no
   *  credentials ? silent fallback to the session primary. */
  provider: z.string().optional(),
  /** T9 turn-0 quality-compaction trigger ratios (provider cost-aware).
   *  Only the turn-0, phase-gated quality lever ? mid-turn delay guards are
   *  unaffected. Per-token cache-preserving providers (DeepSeek) skip T9
   *  entirely regardless of these. */
  qualityCompact: z.object({
    /** Context ratio to trigger T9 on per-token providers (e.g. openai). */
    perTokenThreshold: z.number().min(0).max(1).default(0.55),
    /** Leaner ratio for cost-insensitive subscription providers (GLM/MiMo/Codex/Claude). */
    subscriptionThreshold: z.number().min(0).max(1).default(0.45),
    /** Ceiling ratio that fires T9 for subscription providers even with no phase transition. */
    subscriptionCeiling: z.number().min(0).max(1).default(0.6),
  }).default({}),
})

export const cacheSchema = z.object({
  enabled: z.boolean().default(true),
  minSystemTokens: z.number().int().positive().default(256),
  showHitRate: z.boolean().default(true),
})

export const searchSchema = z.object({
  /** Ordered backend chain for web_search. First available backend with a
   *  non-empty result wins; the rest are skipped. Unknown names are ignored.
   *  Default `['bing', 'duckduckgo']` covers both China (cn.bing.com direct)
   *  and offshore (DDG) without an API key. */
  backends: z.array(z.string()).default(['bing', 'duckduckgo']),
  /** Env var holding the Brave Search API key (subscription token). */
  braveApiKeyEnv: z.string().default('BRAVE_API_KEY'),
  /** Env var holding the Tavily Search API key. */
  tavilyApiKeyEnv: z.string().default('TAVILY_API_KEY'),
  /** Env var holding the Bocha (??) Search API key ? ???? AI ???Tavily ?????? */
  bochaApiKeyEnv: z.string().default('BOCHA_API_KEY'),
  /** Inline API key???? config?? provider.apiKey ??????? UI ???
   *  ??????inline config > apiKeyEnv ??? env > ?? BOCHA_API_KEY? */
  bochaApiKey: z.string().optional(),
  /** Inline Brave Search API key???? config?? */
  braveApiKey: z.string().optional(),
  /** Inline Tavily Search API key???? config?? */
  tavilyApiKey: z.string().optional(),
  /** Per-backend request timeout (ms). */
  timeoutMs: z.number().int().positive().default(15_000),
  /** Optional region/country hint passed to backends that support it (Brave). */
  region: z.string().optional(),
}).default({})

export const fetchSchema = z.object({
  /** Per-request timeout (ms) for web_fetch and URL import downloads. */
  timeoutMs: z.number().int().positive().default(15_000),
  /** Maximum response body size (bytes). Larger bodies are cancelled mid-read. */
  maxResponseBytes: z.number().int().positive().default(10_485_760),
  /** Maximum number of redirects to follow. */
  maxRedirects: z.number().int().positive().default(5),
  /** User-Agent header sent with fetch requests. */
  userAgent: z.string().default('Tianshu/1.0 (terminal coding agent)'),
  /** Extract <main>/<article> content from HTML instead of returning full page noise. */
  extractMainContent: z.boolean().default(true),
  /** ?? Playwright ?? SPA ????????????????? chromium ?????????? */
  enablePlaywright: z.boolean().default(false),
  /** Playwright ?????ms????? timeoutMs? */
  renderTimeoutMs: z.number().int().positive().default(30_000),
  /** ????????ms?SPA ?????????? ? renderTimeoutMs/2?? */
  renderWaitMs: z.number().int().nonnegative().default(0),
  /** ??????????ms??? 2 ??0 = ?????? */
  cacheMaxAgeMs: z.number().int().nonnegative().default(172_800_000),
  /** Jina Reader ??????? https://r.jina.ai?
   *  ???????????? Cloudflare Worker ??????????
   *  ? host ????? `/` ???? URL ?????? */
  jinaBaseUrl: z.string().default('https://r.jina.ai'),
}).default({})

export type FetchConfig = z.infer<typeof fetchSchema>

export const networkSchema = z.object({
  /** HTTP/HTTPS ?????? http://127.0.0.1:7890??
   *  ??????? HTTPS_PROXY/HTTP_PROXY????????????? */
  proxy: z.string().optional(),
  /** ????????????????? * ??? . ????
   *  ?????? curl/wget ? NO_PROXY?????? NO_PROXY ????? */
  noProxy: z.string().optional(),
}).default({})
export type NetworkConfig = z.infer<typeof networkSchema>
export const editorSchema = z.object({
  /**
   * Target-OS conventions for file artifacts and the system-prompt OS hint.
   * 'auto' (default) follows the real host (process.platform). Explicit values
   * let a project opt into another OS's conventions (e.g. a Windows-targeted
   * project authored on macOS). NOTE: this only affects file conventions and
   * the prompt hint ? command execution always runs on the real host shell.
   */
  platform: z.enum(['auto', 'windows', 'macos', 'linux']).default('auto'),
  /**
   * New-file line-ending default. 'auto' derives from `platform`
   * (windows ? crlf, otherwise lf). Explicit 'lf'/'crlf' overrides it ? for
   * example a Windows host that still wants LF source files. Existing files
   * always keep their own EOL, and .bat/.cmd are always CRLF regardless.
   */
  eol: z.enum(['auto', 'lf', 'crlf']).default('auto'),
})

export const workerProfileSchema = z.object({
  provider: z.string(),
  model: z.string(),
})

export const workerRoutingSchema = z.record(z.string(), z.string()).default({
  repo_summarization: 'cheap-flash',
  code_edit: 'cheap-flash',
  test_failure_diagnosis: 'cheap-flash',
  risky_refactor: 'cheap-flash',
  // ?????????2026-08-02 ???? cheap-flash?deepseek-v4-flash???
  // v4-flash ?????? v4-pro???? 1/3????????? capable?
  planning: 'cheap-flash',
})

export const workersSchema = z.object({
  profiles: z.record(z.string(), workerProfileSchema).default({}),
  routing: workerRoutingSchema,
  /** ?? patcher ?????? tier?config.workers.patcherTier??
   *  flash ?????????????????? 'cheap'??? riskTier ????
   *  ??????????? 'balanced' ? 'strong' ??????????? DeepSeek Pro?? */
  patcherTier: z.enum(['cheap', 'balanced', 'strong']).default('cheap'),
  /** ???????????**????**???????????
   *  ?consecutiveFailures?2 ? strong?? Flash?Pro ?????
   *  ????????workers.routing ? planning?capable?planner hardFloor?
   *  ????????review.profiles ??????? modelOverride??
   *  ????????????????????? work order????? flash
   *  ????????? worker ???????????????????
   *  'off'????= ???????????????
   *  'balanced' = ???? balanced ????'strong' = ????? Pro ??? */
  escalationCap: z.enum(['off', 'balanced', 'strong']).default('off'),
}).default({})

export const skillsSchema = z.object({
  /** Skill names to COPY from .claude/skills/ (project then global ~/.claude)
   *  into .rivet/skills/ at load time. Only listed skills are imported ? avoids
   *  pulling in all 70+ Claude skills when the user only needs a few. The copy
   *  is idempotent (existing .rivet/skills entries are never overwritten) and
   *  the runtime only ever loads from .rivet/skills ? external dirs are never
   *  scanned in place. Empty array (default) = import nothing. */
  importFromClaude: z.array(z.string()).default([]),
}).default({})

export const mirrorsSchema = z.object({
  /** Master switch for domestic mirror injection. When enabled, bash tool
   *  executions automatically receive mirror registry env vars and GitHub
   *  clone URLs are rewritten to the chosen mirror. */
  enabled: z.boolean().default(false),
  /** Preset selector: 'default' = no mirrors, 'china' = domestic mirrors. */
  preset: z.enum(['default', 'china']).default('default'),
  /** GitHub mirror override. 'default' falls back to the preset default. */
  github: z.enum(['default', 'gitcode', 'kkgithub', 'fastgit']).default('default'),
  /** npm/yarn/pnpm registry override. */
  npm: z.enum(['default', 'taobao', 'tencent', 'huawei']).default('default'),
  /** PyPI pip index override. */
  pypi: z.enum(['default', 'tsinghua', 'aliyun', 'tencent']).default('default'),
  /** Go module proxy override. */
  go: z.enum(['default', 'goproxy_cn', 'aliyun']).default('default'),
  /** Rust rustup/crates.io override. */
  rust: z.enum(['default', 'tsinghua', 'tuna', 'ustc']).default('default'),
  /** When true (default), automatically retry GitHub clones through the mirror
   *  list if the direct clone fails or times out. Only active when the user has
   *  NOT explicitly chosen a mirror (mirrors.enabled=false OR
   *  mirrors.github='default'). No effect when user picked a specific mirror. */
  autoFallback: z.boolean().default(true),
  /** Per-mirror cooldown: after a mirror succeeds, remember it for this many
   *  minutes and try it first on subsequent clones. 0 = no memory. */
  fallbackMemoryMinutes: z.number().default(10),
  /** Max seconds for a single clone attempt before declaring it failed and
   *  moving to the next mirror. Default 60s (shorter than git's own 120s
   *  timeout so we get a chance to try mirrors). */
  fallbackTimeoutSec: z.number().default(60),
}).default({})

/** GitHub PR panel defaults (desktop CI loop). Initial values for the per-PR
 *  toggles/method ? the panel can override them per PR without writing back. */
export const prDefaultsSchema = z.object({
  /** Default merge method for the PR panel's merge action. */
  mergeMethod: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  /** Auto-fix default: offer to dispatch a fix worker when a PR's CI fails. */
  autoFix: z.boolean().default(false),
  /** Auto-merge default: offer the merge confirm when checks go green. */
  autoMerge: z.boolean().default(false),
  /** CI checks polling interval (seconds) while any check is pending. */
  ciPollSeconds: z.number().int().min(5).max(300).default(10),
}).default({})

export const envSchema = z.object({
  /** Auto-resolve the real login-shell / registry PATH + toolchain vars so the
   *  agent finds tools (mvn/git/...) even when the app is launched from a GUI
   *  (Explorer/Finder/Dock) with a minimal PATH. Default true; set false to use
   *  the raw process env only. */
  resolve: z.boolean().default(true),
  /** Extra directories appended to PATH for command execution ? a manual
   *  escape hatch when auto-resolution still misses a tool. */
  extraPath: z.array(z.string()).default([]),
  /** Extra environment variables injected into command execution. Highest
   *  priority ? overrides both process env and resolved values. */
  extraVars: z.record(z.string(), z.string()).default({}),
  /** Windows only: absolute path to a custom Git Bash `bash.exe`. When set,
   *  it seeds `RIVET_GIT_BASH_PATH` at startup so both the agent bash tool
   *  (platform.ts) and the desktop integrated terminal (pty.rs) use it. A real
   *  OS env var of the same name always wins (explicit override). Empty/unset
   *  falls back to the normal probe chain (where git ? common dirs ? bundled
   *  PortableGit). */
  gitBashPath: z.string().optional(),
  /** Absolute path to a custom `git.exe` (Windows) or `git` binary (macOS/Linux).
   *  When set, it seeds `RIVET_GIT_PATH` at startup so the environment probe
   *  (`/environment`) uses it directly instead of searching PATH. A real OS env
   *  var of the same name always wins (explicit override). Empty/unset falls
   *  back to the normal probe chain (PATH ? common install dirs ? bundled git). */
  gitPath: z.string().optional(),
}).default({})

export const uiSchema = z.object({
  /** Default TUI color theme used on startup. Runtime /theme switches are not persisted.
   *  Accepts: builtin theme name | 'auto' (detect terminal background via OSC 11 /
   *  COLORFGBG, pick graphite/paper) | 'custom:<name>' (~/.rivet/themes/<name>.json). */
  theme: z.union([
    z.enum(THEME_NAMES),
    z.literal('auto'),
    z.string().regex(/^custom:[A-Za-z0-9_-]+$/),
  ]).optional(),
  /** Spinner verb pool override. With mode 'replace' (default) it replaces the
   *  built-in pool; 'append' extends it. Empty array = keep defaults. */
  spinnerVerbs: z.array(z.string().min(1)).optional(),
  spinnerVerbsMode: z.enum(['replace', 'append']).optional(),
  /** Accessibility: freeze spinner animation frames and verb rotation. */
  reducedMotion: z.boolean().optional(),
  /** Accessibility: drop the live region's dynamic segment (which repaints every
   *  120ms and gets re-announced endlessly) and speak activity starts as static
   *  lines instead. Implies reducedMotion. CLI: `--screen-reader`. */
  screenReader: z.boolean().optional(),
  /** GlanceBar density on startup. 'compact' (default) = mode/model/context%/elapsed;
   *  'full' = everything (goal/todo/effort/cache/cost). Runtime `/glance` toggles. */
  glanceDensity: z.enum(['compact', 'full']).optional(),
  /** Scriptable statusline (Claude Code protocol subset). The command receives a
   *  session-state JSON on stdin and its first stdout line renders above the input
   *  box. See src/tui/statusline.ts for the payload shape. */
  statusLine: z.object({
    command: z.string().min(1),
    intervalMs: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).optional(),
}).default({})

/** Project verify command declarations (A1). Machine-readable source of truth
 *  for the project's verification commands ? declared in the project-layer
 *  `.rivet-config.json`, consumed by run_tests (test), the deliver review gate
 *  (typecheck/build for non-TS projects), and bash verification annotation.
 *  Typically generated by /init from the project fingerprint; hand-edits win. */
export const verifySchema = z.object({
  /** Full test command, e.g. "cargo test" / "go test ./..." / "pytest". */
  test: z.string().optional(),
  /** Build command ? for compiled languages, build success is a more basic
   *  signal than tests, e.g. "cargo build" / "go build ./...". */
  build: z.string().optional(),
  /** Typecheck command, e.g. "tsc --noEmit" / "cargo check" / "mypy .". */
  typecheck: z.string().optional(),
  /** Lint command, e.g. "eslint ." / "cargo clippy" / "ruff check .".
   *  Declared-only for now: no dedicated lint gate consumes it yet (deferred);
   *  bash verification annotation recognizes it. */
  lint: z.string().optional(),
  /** Path-routed check commands (A3): when a changed file matches `match`
   *  (glob, repo-relative POSIX, supports `**`/`*`), the deliver review gate
   *  runs `run` and escalates on non-zero exit. Covers sub-projects the root
   *  typecheck cannot see (e.g. desktop/ has its own tsconfig). */
  routes: z.array(z.object({
    match: z.string(),
    run: z.string(),
    kind: z.enum(['test', 'build', 'typecheck', 'lint']),
  })).optional(),
}).default({})

export const proSchema = z.object({
  /** Whether Pro features are active. Can also be enabled via RIVET_PRO=1
   *  or by placing a non-empty key in ~/.rivet/pro.license. */
  enabled: z.boolean().default(false),
  /** Optional license key (opaque string). The runtime does not validate
   *  signatures; online seat/validation is handled by a licensing service. */
  licenseKey: z.string().optional(),
  /** Per-feature Pro gates. When Pro is active, features default to enabled
   *  unless explicitly set to false here. */
  features: z.object({
    computerUse: z.boolean().default(true),
    chatGateway: z.boolean().default(true),
    /** team_orchestrate mode:'max'???? planner fanout?? */
    teamMax: z.boolean().default(true),
    /** council_convene rounds?2???/????? */
    councilMultiRound: z.boolean().default(true),
    /** ??????????? v1 ? T2??? always-review ???? +
     *  ? computer_use ?????? */
    unattendedAutomation: z.boolean().default(true),
  }).default({}),
}).default({})

export type ProConfig = z.infer<typeof proSchema>

/**
 * ?????? ? ?? frozen ??????????????
 *
 * ??????????? prompt/block-policy.ts??
 * - standard?????????????????????????
 * - lean????????capsule ?? / manifest / codebase-index /
 *   project-memory / historical-lessons???????????
 * - full???????????????????????
 *
 * ??**???????**?static.ts ? rules / delivery-contract /
 * workflow??? volatileBlock???????????????????
 * V3.1 (0c776b9?17b496a) ?????????????
 *
 * ?????????????????????????? = ??????
 */
const promptSchema = z.object({
  profile: z.enum(['standard', 'lean', 'full']).optional(),
  /** ?? schema ?????compact ??????????????
   *  ???????????????????????? */
  toolDescriptions: z.enum(['full', 'compact']).optional(),
  /** ???????????? profile????? profile ??? */
  blocks: z.object({
    seedCapsule: z.boolean().optional(),
    knowledgeManifest: z.boolean().optional(),
    codebaseIndex: z.boolean().optional(),
    projectMemory: z.boolean().optional(),
    historicalLessons: z.boolean().optional(),
  }).default({}),
}).default({})

export type PromptConfig = z.infer<typeof promptSchema>

export const configSchema = z.object({
  provider: z.object({
    default: z.string(),
    providers: z.record(z.string(), providerSchema),
  }),
  agent: agentSchema.default({}),
  compact: compactSchema.default({}),
  cache: cacheSchema.default({}),
  search: searchSchema,
  fetch: fetchSchema,
  network: networkSchema,
  editor: editorSchema.default({}),
  mcp: mcpConfigSchema.default({}),
  workers: workersSchema,
  skills: skillsSchema,
  mirrors: mirrorsSchema,
  prDefaults: prDefaultsSchema,
  env: envSchema,
  ui: uiSchema,
  verify: verifySchema,
  /** ???????minimal????/ frontend / full?????????
   *  ??????????????RIVET_TOOL_PRESET env ??????? */
  tools: z.object({
    preset: z.enum(['minimal', 'frontend', 'full']).optional(),
  }).default({}),
  prompt: promptSchema,
  pro: proSchema,
  plugins: z.object({
    enabled: z.record(z.boolean()).default({}),
  }).default({}),
})

export type Config = {
  provider: { default: string; providers: Record<string, ProviderConfig> }
  agent: AgentConfig
  compact: CompactConfig
  cache: CacheConfig
  search: SearchConfig
  fetch: FetchConfig
  network: NetworkConfig
  editor: EditorConfig
  mcp: McpConfig
  workers: WorkersConfig
  skills: SkillsConfig
  mirrors: MirrorsConfig
  prDefaults: PrDefaultsConfig
  env: EnvConfig
  ui: UiConfig
  verify: VerifyConfig
  tools: { preset?: 'minimal' | 'frontend' | 'full' | undefined }
  prompt: PromptConfig
  pro: ProConfig
  plugins: { enabled: Record<string, boolean> }
}

export type ProviderConfig = z.infer<typeof providerSchema>
export type AuthConfig = z.infer<typeof authConfigSchema>
export type ProviderCapabilitiesConfig = z.infer<typeof providerCapabilitiesSchema>
export type ModelConfig = z.infer<typeof modelConfigSchema>
export type EditorConfig = z.infer<typeof editorSchema>
export type EditorPlatform = EditorConfig['platform']
export type EditorEol = EditorConfig['eol']
export type AgentConfig = z.infer<typeof agentSchema>
export type CompactConfig = z.infer<typeof compactSchema>
export type CacheConfig = z.infer<typeof cacheSchema>
export type SearchConfig = z.infer<typeof searchSchema>
export type WorkersConfig = z.infer<typeof workersSchema>
export type SkillsConfig = z.infer<typeof skillsSchema>
export type MirrorsConfig = z.infer<typeof mirrorsSchema>
export type PrDefaultsConfig = z.infer<typeof prDefaultsSchema>
export type EnvConfig = z.infer<typeof envSchema>
export type UiConfig = z.infer<typeof uiSchema>
export type VerifyConfig = z.infer<typeof verifySchema>
