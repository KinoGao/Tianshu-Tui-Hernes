import type { AgentLoop } from '../agent/loop.js'
import type { SessionContext } from '../agent/context.js'
import { looksLikeFilePath } from './engine/app.js'
import { SessionPersist, getSessionDir } from '../agent/session-persist.js'
import { forkSession, listBranches, countMessageLines } from '../agent/session-fork.js'
import { type StarDomainId } from '../agent/star-domain.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import { DOMAIN_SWITCH_CACHE_WARNING } from '../agent/domain-picker-entries.js'
import { microCompactOai, estimateOaiTokens } from '../compact/micro.js'
import { rollbackToCheckpoint, getRollbackPreview } from '../agent/checkpoint.js'
import { runResumePreflightOai } from '../context/resume-preflight.js'
import { resolveCustomCommand } from '../commands/loader.js'
import { getTheme, setTheme, getActiveThemeName, THEMES, listCustomThemes } from './theme.js'
import {
  checkForUpdate,
  detectInstallRoot,
  formatUpdateBanner,
  restartProcess,
  runUpdate,
  spawnWindowsSelfUpdate,
} from './updater.js'
import { PhaseTracker } from './phase-tracker.js'
import { createLogEntry, type LogEntry } from './log-state.js'
import { getPaletteCommands } from './command-palette.js'
import { openInEditor } from './external-editor.js'
import { formatMissionStrip } from './mission.js'
import { PANEL_LABELS, PANELS, type Panel } from './cockpit/types.js'
import type { SummaryState } from './summary-state.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaimStatus } from '../context/claims.js'
import { loadProjectRules } from '../context/rules-loader.js'
import { exportDurableClaims, importClaims } from '../context/claim-export.js'
import { resolveEcosystemWorkflowInput } from '../workflows/ecosystem-workflows.js'
import { formatVolatilePayloadReport } from '../context/payload-diagnostic.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { buildHandoffPrompt } from './handoff.js'
import { ensureVerifyDeclaration, renderRivetMdStack, upsertStackSection } from '../bootstrap/verify-declaration.js'
import { exportsDir } from '../config/paths.js'
import { listPlans, rejectPlan, resolvePlanOptionLabel, resolvePlanRef, stripCopiedTitleSuffix } from '../plan/plan-store.js'
import { approvePlanWithGuards } from '../plan/plan-approval.js'
import { fullRebuild, generateCodebaseIndexBlock, getHeadSha } from '../repo/codebase-index.js'
import { isDiagramType, buildDiagramDoc, renderDiagramBlock, formatDiagramList } from './diagram-templates.js'
import { renderRecoveryStack } from '../agent/recovery-stack.js'
import { skillRegistry, listSkillFiles, importSkillsIntoRivet, countInstalledSkills, RECOMMENDED_MAX_SKILLS, SKILL_RESTRAINT_NOTICE } from '../skills/skill-loader.js'
import { listSkillDrafts, approveSkillDraft, rejectSkillDraft } from '../agent/skill-distill.js'
import { formatReviewHealthLine } from '../agent/review-health.js'
import {
  loadConstellation,
  initConstellation,
  surveySkeleton,
  appendMilestone,
} from '../constellation/store.js'
import { formatConstellationView, formatConstellationHistory } from '../constellation/format.js'
import { extractMilestone, buildDepartureMilestone } from '../constellation/milestone.js'
import { shortHash } from '../constellation/schema.js'
import { buildAgentMark, VOID_SYMBOL } from '../agent/void-identity.js'

import type { TuiApp } from './engine/app.js'
import type { SlashCommand } from './slash-command-registry.js'
import type { BootstrapContext } from '../bootstrap.js'
import type { Config } from '../config/schema.js'
import { isProFeatureEnabled } from '../config/pro-license.js'
import { loadConfig, saveConfig } from '../config/manager.js'
import { installPlugin, removePlugin, getInstalledPlugins, isPluginInstalled } from '../plugins/plugin-installer.js'
import { PLUGIN_PRESETS } from '../plugins/plugin-presets.js'
import { switchAgentRuntime, switchAgentSession, switchAgentCwd, restorePlanModeFromMeta } from '../bootstrap.js'
import { loadTodos, setTodoSession } from '../tools/todo.js'
import { restoreGoalTracker } from '../agent/goal-persist.js'
import { setPlanSession } from '../agent/plan-store.js'
import { isToolAllowed, isToolDenied, isBashCommandAllowlisted, isBashCommandDenied } from '../agent/permissions.js'
import { getMirrorConfig, setMirrorConfig, setCheckpointConfig, setApprovalMode as persistApprovalDefault } from '../config/manager.js'
import { grantPath, listPersistedGrants } from '../tools/path-grants.js'
import { SettingsFlow } from './settings-flow.js'
import { loadSettingsDraft, loadSettingsEnv, saveSettings } from './settings-persist.js'
import { formatMirrorStatus } from '../tools/mirror-env.js'
import { detectEnv, formatEnvGuidance, recommendUvSetup, isPythonProject } from '../tools/env-check.js'
import { getResolvedEnv, getResolvedPathDiff } from '../tools/resolved-env.js'
import { getShellCommand } from '../platform.js'
import { createCoordinatorReviewDeps } from '../agent/review-coordinator-deps.js'
import { routeReviewWorkflow, type ReviewMode, type ReviewOutcome } from '../agent/review-router.js'
import type { ChangeSet } from '../agent/review-discipline.js'
const HELP_TEXT = `Available commands:
/help ? Show this help
/exit ? Exit Rivet
/quit ? Exit
/update ? Check and install the latest Rivet release
/btw <??> ? ??????????????????????????
/compact [status|llm] ? Micro-compact context (/compact status for stats)
/model [name|list] ? Show or switch model
/domain [list|<name>|auto|off] ? Show or switch star domain personality
/verbose ? Toggle verbose tool output
/permission [manual|auto|yolo|allow|deny|bash|remove|reset|test] ? ??????????Manual/Auto/YOLO ???
/grant [path] [read|write] ? ???????????????????????????
/theme [cobalt|gemini|antigravity|slate|ziwei|tianshu|midnight|pastel|cyberpunk|observatory|starfield|claude] ? Switch color theme (default: cobalt)
/vim ? Toggle vim keybindings
/effort [off|low|medium|high|max] ? Set reasoning effort
/undo [<number>|preview <number>] ? Undo file changes with preview
/clear ? Clear screen
/sessions ? List all saved sessions
/fork [name] ? Fork current session into a new copy and switch to it
/fork at <N> [name] ? Fork from message line N (truncate after)
/branch ? Show branch tree (parent + children)
/branch back ? Switch back to parent session
/memory [text|add|search|forget] ? Session memory entries
/mission ? Show current task contract
/constellation [view|init|update <summary>|history|shift <summary>] ? Project blueprint & milestone chronicle
/leave [symbol] <summary> ? Leave your mark in the starmap as you depart
/context [pin|claims|antibodies|conflicts|reload|export|import] ? Context ledger
/verify ? Show verification status
/evidence ? Show last turn evidence summary
/debug [prompt|fingerprint|cache|context-payload|mcp] ? Debug info
/mcp ? Show MCP server status
/cockpit [summary|trace|verify|context|safety|model|mcp|advisory|off] ? Toggle cockpit panel
/scroll ? Browse session history in pager
/skill [list|install <name>|import <name>|<name>|off <name>|review|approve <name>|reject <name>] ? List/load skills; install from .claude/skills; review drafts
/interview <topic> ? Deep interview before coding
/plan <feature> ? Create implementation plan
/plan close <file> --tasks <range|all> [--preview] ? Close implementation plan tasks
/team <task|plan> ? Run team-mode workflow through team_orchestrate
/team max <task> ? Run team-mode max planning through team_orchestrate
/council <task> [--seats id1,id2,...] [--rounds 1-2] ? Convene a star-domain council (single round; --rounds 2 enables a rebuttal round)
/scout <????> [--dims ??,??,??] ? ????????????????????????????
/review ? Manually trigger L2 review (single adversarial verifier) on current changes via deliver_task
/review max ? Manually trigger L3 review (Review Squadron, 5 inspectors) on current changes via deliver_task
/review off|on|status ? ?????/??/????????off ???????? token??? /review ?????
(auto: every non-trivial deliver_task commit runs a single Wiring inspector ? short budget, never blocks on infra failure)
/sensorium ? Show ?? 3D self-awareness state
/dream ? Distill session decisions into project memory
/index ? Rebuild codebase index (modules + CLI entries)
/diagram [list|<type>] ? Generate a mermaid diagram skeleton (architecture|dataflow|sequence|flowchart|comparison|state)
/model [id] ? Switch model (no arg = open model picker)
/domain [id|list] ? Switch star domain (no arg = open domain picker)
/status ? Show agent status (model, domain, cache, tokens)
/mirror [status|on|off|china|default] ? Toggle domestic mirrors for GitHub/npm/pip/go/rust downloads
/python [status|setup] ? Check Python/uv/Git environment or auto-setup a Python project with uv
/doctor ? Environment health check (Node/Git/Python/uv) + which shell the bash tool uses
/logs [open [desktop]] ? ?????????? / ?? / ?? / ?? sidecar?????????????open ???????????
/init [verify] ? ?????????verify ?? / skills / hooks ?????verify ??????????
/cd [<path>] ? ???????????????????????????????????????
/tools ? Show available tools and their descriptions
/prefix-budget ? ???????????/token ?? + ????
/compact ? Compact context (summarize old messages)
/workflow [list|<name>|replay <id>] ? YAML workflow orchestration + trace replay
/todo [list|add <content>|done <id>|skip <id>|move <id> up|down] ? Manage task list
/plan-template [list|<name>|save <name>] ? Reusable plan templates
/ask ? Enter/exit Ask mode (read-only Q&A)
/team-resume [groupId] ? Resume team execution from wave checkpoint
/goal <objective> [--max N] [--budget M] [--criteria '["..."]'] ? Set autonomous goal
/goal-status ? Show current goal state
/goal-pause ? Pause active goal
/goal-resume ? Resume paused/blocked goal
/goal-cancel ? Cancel autonomous goal
/goal-criteria [set '["..."]'] ? View or set success criteria
/rollback [<N>] ? Rollback file changes (alias of /undo)
/write-plan ? Write current plan to file
Ctrl+C ? Interrupt current turn (press twice to exit)
Ctrl+P / Ctrl+N ? ????????? / ?????????????????????
Ctrl+Esc ? ???????????????????

?? ???????DeepSeek V4 ???????

? ????????? token ?????? /handoff ??????????

  ? 50% ?? ? ?? /handoff ?????????????????????????????
  ? 70%-78% ? ??????????? token ??????????????
  ? 80% ?? ? ?? + ???????????? cache miss?????
  ? ?????????????????????????????

  ?????? / ???? / ??? skill ?????????????????`

/**
 * Framework-agnostic mutable ref. Structurally compatible with React's
 * `MutableRefObject<T>` (`{ current: T }`) AND the T9 engine's plain
 * `MutableRef` adapter, so the non-React SlashRouter no longer needs to fake a
 * React type with `as unknown as React.MutableRefObject<...>` / `as any`.
 */
export interface MutableRefLike<T> {
  current: T
}

export interface SlashHandlerContext {
  parts: string[]
  config: Config
  agent: AgentLoop
  session: SessionContext
  persist: SessionPersist
  model: string
  maxTokens: number
  availableModels: Array<{ id: string; alias: string }>
  onModelSwitch: (modelId: string) => { ok: boolean; error?: string }
  allProviders: Record<string, { models: Array<{ id: string; alias: string }> }>
  currentProvider: string
  currentSessionId: string
  /**
   * Runtime session identity switch for /resume <id>. Rebuilds the agent runtime
   * against the target session so subsequent messages/logs write to the SAME id.
   * Returns the loaded message count or an error. Undefined ? /resume falls back
   * to the legacy in-memory-only restore (no identity switch).
   */
  onSessionSwitch?: (targetId: string) => { ok: boolean; error?: string; messageCount?: number; repaired?: boolean; safe?: boolean }
  /** Open the interactive session picker overlay (Chronicle). Wired by the TUI;
   *  /resume with no argument opens it instead of printing usage (Claude Code
   *  parity). Undefined ? fall back to the usage hint (tests / headless). */
  openSessionPicker?: () => void
  /** Open the interactive /init scaffolding wizard (verify / skills / hooks).
   *  Wired by the TUI; undefined ? /init prints a hint to use /init verify. */
  openInitFlow?: () => void
  /** Runtime cwd switch for /cd <path>. Rebuilds the agent runtime against the
   *  new working directory with frozen-snapshot inheritance (prefix cache only
   *  tail-cuts at the next user boundary). Async: drains pending persist writes
   *  before migrating session files. Undefined ? /cd prints current cwd
   *  and a hint that switching is unavailable (tests / headless). */
  onCwdSwitch?: (target: string) => Promise<{ ok: boolean; error?: string; from?: string; to?: string; movedFiles?: string[] }>
  cost: number
  cacheHitRate: number
  autoSafeRef: MutableRefLike<boolean>
  verboseRef: MutableRefLike<boolean>
  setVerbose: (v: boolean) => void
  setAutoSafe: (v: boolean) => void
  /** ???????????? ~/.rivet/config.json?????????
   *  ???????? config manager?????????? no-op?????? */
  persistApprovalMode?: (mode: string) => void
  rollbackTokenRef: MutableRefLike<string | null>
  setCockpitPanel: (v: Panel | ((prev: Panel) => Panel)) => void
  activeOverlay?: string | null
  surfacePush?: (id: string) => void
  /** `/btw` ????????????????????????????
   *  ????headless / ???? `/btw` ??????????? */
  askSideQuestion?: (question: string) => void
  /** ?? choice-panel ???effort / permission????????????? */
  setChoicePanelKind?: (kind: 'effort' | 'permission') => void
  surfacePop?: () => void
  pushStatic: (entry: LogEntry) => void
  setIsStreaming: (v: boolean) => void
  setCacheHitRate: (v: number) => void
  setSummaryState: (v: SummaryState | ((prev: SummaryState) => SummaryState)) => void
  mcpManagerRef: MutableRefLike<import('../mcp/manager.js').McpManager | null>
  claimStoreRef: MutableRefLike<ContextClaimStore | null>
  setReasoningEffort?: (effort: import('../agent/auto-reasoning.js').ReasoningEffort | 'auto') => void
  reasoningEffort?: string
  onDomainChange?: (domainName: string | undefined) => void
  /** T5: bandit promotion state for /status observability. */
  banditState?: import('../server/routes.js').BanditStatusEntry[]
  /** ????????/review ??? deliver_task ??? routeReviewWorkflow?
   *  ???? /review fallback ? resolveAppPromptInput ? deliver_task ???? */
  runReview?: (change: import('../agent/review-discipline.js').ChangeSet, mode: import('../agent/review-router.js').ReviewMode, focus?: string) => Promise<import('../agent/review-router.js').ReviewOutcome>
  /** Submit a prompt directly to the agent pipeline, bypassing slash routing.
   *  Used by commands that need to transform the input before sending (e.g. /goal). */
  submitToAgent?: (prompt: string) => void
  /** /handoff ??????????src=??? .rivet/HANDOFF.md?dest=???? <id>.handoff.md???
   *  TUI ??? turn ???? src ????? dest?loadPrevHandoff ????? dest?? */
  onHandoffStart?: (src: string, dest: string) => void
  /** Mutable ref to the current GoalTracker. Set when /goal creates a tracker;
   *  read by deliver_task's B1Context for auto-review gating. */
  goalTrackerRef?: { current: import('../agent/goal-tracker.js').GoalTracker | null }
  /** ?????????/review off|on ???deliver_task ? isAutoReviewOff ??? */
  reviewGateRef?: { current: 'auto' | 'off' }
}

/** ????????????????unstaged + staged + untracked?? */
async function collectDirtyFiles(cwd: string): Promise<string[]> {
  const { spawnGitSync } = await import('../tools/spawn-git.js')
  const run = (gitArgs: string[]): string[] => {
    const r = spawnGitSync(['-c', 'core.quotePath=false', ...gitArgs], { cwd, encoding: 'utf-8', timeout: 5000 })
    return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : []
  }
  try {
    const unstaged = run(['diff', '--name-only', '-z'])
    const staged = run(['diff', '--cached', '--name-only', '-z'])
    const untracked = run(['ls-files', '--others', '--exclude-standard', '-z'])
    return [...new Set([...unstaged, ...staged, ...untracked])].sort()
  } catch {
    return []
  }
}

interface ParsedGoalArgs {
  goalText: string
  maxIterations?: number
  wallClockMs?: number
  criteria?: string[]
}

/** ?? /goal ???????? --max N / --budget M / --criteria '["..."]'
 *  ???????????? */
function parseGoalArgs(parts: string[]): ParsedGoalArgs {
  const out: ParsedGoalArgs = { goalText: '' }
  const textParts: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p === '--max' && parts[i + 1]) {
      const n = Number(parts[i + 1])
      if (Number.isInteger(n) && n > 0) out.maxIterations = n
      i++
      continue
    }
    if (p === '--budget' && parts[i + 1]) {
      const n = Number(parts[i + 1])
      if (!Number.isNaN(n) && n > 0) out.wallClockMs = Math.round(n * 60000)
      i++
      continue
    }
    if (p === '--criteria' && parts[i + 1]) {
      try {
        const parsed = JSON.parse(parts[i + 1]!)
        if (Array.isArray(parsed) && parsed.every((c: unknown) => typeof c === 'string')) {
          out.criteria = parsed as string[]
        }
      } catch { /* ignore invalid JSON */ }
      i++
      continue
    }
    textParts.push(p)
  }
  out.goalText = textParts.join(' ').trim()
  return out
}

/** ? GoalTracker ???????????best-effort?? */
async function persistGoalState(ctx: SlashHandlerContext, tracker: import('../agent/goal-tracker.js').GoalTracker): Promise<void> {
  if (!ctx.currentSessionId) return
  try {
    const { saveGoalState } = await import('../agent/goal-persist.js')
    const { getSessionDir } = await import('../agent/session-persist.js')
    saveGoalState(getSessionDir(ctx.agent.cwd), ctx.currentSessionId, tracker)
  } catch { /* best-effort */ }
}

/** ????? goal ??? /goal-status ??? */
function formatGoalStatus(tracker: import('../agent/goal-tracker.js').GoalTracker): string {
  const status = tracker.getStatus()
  const statusLabels: Record<string, string> = { active: '???', paused: '???', blocked: '???', complete: '???' }
  const lines = [
    `?? ${tracker.getGoal()}`,
    `??: ${statusLabels[status] ?? status}`,
    `??: ${tracker.getIteration()}/${tracker.getMaxIterations()}`,
    `????: ${Math.round(tracker.getWallClockElapsedMs() / 1000)}s`,
  ]
  const budget = tracker.getWallClockBudgetMs()
  if (budget !== undefined) lines.push(`????: ${Math.round(budget / 60000)}m`)
  const criteria = tracker.getSuccessCriteria()
  if (criteria.length > 0) {
    lines.push('???:')
    criteria.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`))
  }
  const verdict = tracker.getLastVerdict()
  if (verdict) {
    lines.push(`????: ${verdict.overall} ? ${verdict.criteriaMet}/${verdict.criteriaTotal} ???`)
  }
  return lines.join('\n')
}

function formatClaimLine(claim: import('../context/claims.js').ContextClaim): string {
  return `- [${claim.status}] ${claim.kind}: ${claim.text}`
}

export function formatContextClaimsCommand(store: ContextClaimStore, status?: ContextClaimStatus): string {
  const claims = status
    ? store.listClaims({ status: [status] })
    : store.listClaims()
  if (claims.length === 0) return 'No context claims.'
  return claims.map(formatClaimLine).join('\n')
}

export function formatVerificationStatus(agent: AgentLoop): string {
  const summary = agent.getVerificationSummary()
  if (summary.total === 0) return 'Verification Status\n\nNo modified files tracked in this turn.'
  const lines = summary.files.map(file => {
    const icon = file.level === 'pending' ? '?' : '?'
    return `  ${icon} ${file.path} (${file.level})`
  })
  const percent = Math.round((summary.verified / summary.total) * 100)
  const state = agent.getEvidenceState()
  const last = state.verifications.at(-1)
  const lastLine = last ? `\nLast verification: ${last.status} ? ${last.command}` : '\nLast verification: none'
  return `Verification Status\n\nModified files:\n${lines.join('\n')}\n\nVerification: ${summary.verified}/${summary.total} (${percent}%)${lastLine}`
}

function knowledgeDir(): string {
  return join(process.cwd(), '.rivet', 'knowledge')
}

function appendProjectKnowledge(text: string): string {
  const dir = knowledgeDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'memory.md')
  const line = `- ${new Date().toISOString()} ${text}\n`
  writeFileSync(file, line, { flag: 'a' })
  return file
}

export function formatMemoryOverview(ctx: SlashHandlerContext): string {
  const memory = ctx.persist.loadMemory()
  const sessionLines = memory.entries.length === 0
    ? ['  (empty)']
    : memory.entries.slice(-8).map(e => `  ? [${e.id}] ${e.text}`)

  const pheromones = ctx.agent.getLatestPheromones?.() ?? []
  const pheromoneLines = pheromones.length === 0
    ? ['  (none loaded yet)']
    : pheromones.slice(0, 8).map(p => `  ? ${p.path} ? ${p.signal} (${p.strength.toFixed(2)})`)

  const dir = knowledgeDir()
  const knowledgeFiles = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.md')).slice(0, 8)
    : []
  const knowledgeLines = knowledgeFiles.length === 0
    ? ['  (none)']
    : knowledgeFiles.map(f => `  ? ${f}`)

  return `????\n\n?? ?? session (${memory.entries.length} ?)\n${sessionLines.join('\n')}\n\n?? ???? (${pheromones.length} ?)\n${pheromoneLines.join('\n')}\n\n?? ???? (${knowledgeFiles.length} ?)\n${knowledgeLines.join('\n')}\n\n??: /memory add <??> | /memory search <query> | /memory forget <id>`
}

export function searchMemory(ctx: SlashHandlerContext, query: string): string {
  const needle = query.toLowerCase()
  const sessionHits = ctx.persist.loadMemory().entries
    .filter(e => e.text.toLowerCase().includes(needle))
    .map(e => `session:${e.id} ${e.text}`)
  const pheromoneHits = (ctx.agent.getLatestPheromones?.() ?? [])
    .filter(p => `${p.path} ${p.signal} ${p.context ?? ''}`.toLowerCase().includes(needle))
    .map(p => `pheromone:${p.path} ${p.signal} ${p.context ?? ''}`)
  const dir = knowledgeDir()
  const knowledgeHits = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.md')).flatMap(file => {
      const content = readFileSync(join(dir, file), 'utf-8')
      return content.toLowerCase().includes(needle) ? [`knowledge:${file} ${content.slice(0, 160).replaceAll('\n', ' ')}`] : []
    })
    : []
  const hits = [...sessionHits, ...pheromoneHits, ...knowledgeHits].slice(0, 20)
  return hits.length === 0 ? `No memory found for "${query}".` : `Memory search: ${query}\n${hits.map(h => `- ${h}`).join('\n')}`
}

export interface ResolvedPromptInput {
  prompt: string
  /** ? WorkflowResolveResult.requiredTools?? ecosystem workflow ??????? */
  requiredTools?: readonly string[]
}

export function resolveAppPromptInput(
  input: string,
  cwd: string,
  isKnownCommand?: (name: string) => boolean,
  pluginCommands?: { name: string; file: string }[],
): ResolvedPromptInput | null {
  if (!input.startsWith('/')) return { prompt: input }
  const workflow = resolveEcosystemWorkflowInput(input)
  if (workflow) return { prompt: workflow.prompt, requiredTools: workflow.requiredTools }
  const custom = resolveCustomCommand(cwd, input, pluginCommands)
  if (custom) return { prompt: custom }
  const skillPrompt = resolveSkillPrompt(input, cwd)
  if (skillPrompt !== null) return { prompt: skillPrompt }
  // /review off|on|status ? TUI ????????????server/headless ??????
  // refs ???????????? "off" ?? focus ????????? worker token??
  if (/^\/review\s+(?:off|on|status)\s*$/i.test(input)) {
    return { prompt: `User typed "${input}". /review off|on|status is a TUI-local session toggle (auto-review gate) that this surface cannot flip. To disable auto review here, set review.skipAuto in config (desktop: Settings ? Routing); manual /review [max] keeps working either way.` }
  }
  // /review [max|l1|l2|l3] [focus description] ? map to deliver_task instruction for the agent
  const reviewMatch = input.match(/^\/review(?:\s+(max|l1|l2|l3))?(?:\s+(.*))?$/i)
  if (reviewMatch) {
    const kw = reviewMatch[1]?.toLowerCase()
    const focusText = reviewMatch[2]?.trim()
    const level: 'L1' | 'L2' | 'L3' = kw === 'max' || kw === 'l3' ? 'L3' : kw === 'l1' ? 'L1' : 'L2'
    const levelLabel = level === 'L3'
      ? 'L3 Review Squadron (5 inspectors)'
      : level === 'L1'
        ? 'L1 nudge (review-discipline reminder, zero review workers)'
        : 'L2 adversarial verifier'
    const focusInstruction = focusText ? ` Focus specifically on: ${focusText}.` : ''
    return { prompt: `Run code review on the current uncommitted changes: call deliver_task with commit=true and review_level="${level}". This triggers ${levelLabel}.${focusInstruction}` }
  }
  // /review typos ? don't silently drop user input
  if (/^\/review/i.test(input)) {
    return { prompt: `User typed "${input}" which looks like a /review command but didn't match the expected format. Usage: /review [max] [focus description]. Run /review max to trigger L3 Review Squadron.` }
  }
  // Linux/WSL path like /etc, /mnt, /usr ? not a recognized command, pass through
  // as plain text so the agent can handle it (e.g. "look at /etc/hosts").
  if (looksLikeFilePath(input, isKnownCommand)) return { prompt: input }
  // Unrecognized slash command ? return null to signal "blocked"
  return null
}

/**
 * Resolve `/skill <name> [user task...]` into the skill's full body prompt.
 * Reserved subcommands (list/install/etc.) and unknown skills return null so
 * they fall back to the slash handler's local behavior or error message.
 */
function resolveSkillPrompt(input: string, cwd: string): string | null {
  const match = input.trim().match(/^\/skill\s+(\S+)(?:\s+(.*))?$/s)
  if (!match) return null
  const name = match[1]!
  const userTask = match[2]?.trim() ?? ''
  const reserved = new Set(['list', 'ls', 'install', 'import', 'review', 'drafts', 'approve', 'reject', 'off', 'complete'])
  if (reserved.has(name.toLowerCase())) return null
  const skill = skillRegistry.get(name) ?? skillRegistry.list().find(s => s.name.toLowerCase() === name.toLowerCase())
  if (!skill) return null
  let prompt = `[Skill loaded: ${skill.name}]\n<skill name="${skill.name}">\n${skill.body}\n</skill>`
  if (skill.skillDir) {
    const files = listSkillFiles(skill.skillDir)
    if (files.length > 0) {
      prompt += `\n<skill-files dir="${skill.skillDir}" note="Read on demand with read_file/grep/glob; page large sub-files completely with offset/limit.">\n${files.map(f => '  ' + f.path).join('\n')}\n</skill-files>`
    }
  }
  if (userTask) {
    prompt += `\n\nUser task: ${userTask}`
  }
  return prompt
}

/**
 * Resolve `/enter <worker-id-or-label> [message]` into a prompt that resumes
 * the worker via delegate_task, or return a usage/error message.
 */
export function resolveEnterWorkerInput(
  app: TuiApp,
  input: string,
): { prompt: string } | { error: string } | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/enter')) return null
  const parts = trimmed.split(/\s+/)
  if (parts.length < 2) {
    return { error: 'Usage: /enter <worker-id-or-label> [continuation message]' }
  }
  const target = parts[1]!
  const message = parts.slice(2).join(' ').trim()
  const resolved = app.resolveWorkerId(target)
  if (!resolved) {
    return { error: `Worker not found: "${target}". Use /tasks to see available workers.` }
  }
  const objective = message || 'Continue from where you left off.'
  const prior = resolved.objective ? ` Previous objective: ${resolved.objective}.` : ''
  const prompt = `Resume worker ${resolved.workerId} (profile: ${resolved.profile}).${prior} Continue with: ${objective} Call delegate_task with resume="${resolved.workerId}" and objective="${objective}".`
  return { prompt }
}


// ?????????+????+?? kickoff??????????
// server ????? TUI ??????????? re-export ???????
export { buildPlanKickoff } from '../plan/plan-approval.js'

/**
 * ??????? kickoff ??????????slash `/plan-approve` ? plan-picker
 * overlay ????:approve ? setActivePlan(???? + ?? plan mode)? ?? kickoff?
 * ?? false ???????(???????)?
 */
export async function approvePlanAndKickoff(
  deps: {
    cwd: string
    agent: Pick<AgentLoop, 'setActivePlan'>
    submitToAgent?: (prompt: string) => void
    notify: (content: string, isError?: boolean) => void
  },
  slug: string,
  resolvedApproach?: string,
): Promise<boolean> {
  const result = await approvePlanWithGuards(deps.cwd, slug, resolvedApproach)
  if (!result.ok) {
    if (result.code === 'invalid-content') {
      deps.notify(`???? **${result.title}** (\`${slug}\`)?${result.reason} ??? APPROVED ??????????`, true)
    } else {
      deps.notify(`Plan not found: "${slug}". Use /plan-list to see available plans.`, true)
    }
    return false
  }
  const { approved, driftNote, kickoff, tierWarning } = result
  deps.agent.setActivePlan({ slug, title: approved.title, selectedApproach: resolvedApproach })
  const approachLine = resolvedApproach ? `\nSelected approach: **${resolvedApproach}**` : ''
  const driftLine = driftNote
    ? `\n\n? ??????:??????????????(???????,?????????):\n${driftNote}`
    : ''
  const tierWarnLine = tierWarning ? `\n\n${tierWarning}` : ''
  deps.notify(
    `? Plan approved: **${approved.title}** (\`${slug}\`)${approachLine}\n\n???????,??? \`.rivet/plans/${slug}.md\`?Plan Mode ??? ? ?????????${tierWarnLine}${driftLine}`,
  )
  deps.submitToAgent?.(kickoff)
  return true
}

interface TuiSlashCommandDef {
  readonly name: string
  readonly description?: string
  readonly immediate?: true
  readonly handler: (ctx: SlashHandlerContext) => boolean | Promise<boolean>
}

/** /plan-mode ??????????????????????? */
let planModeExitArmedAt = 0
const PLAN_MODE_EXIT_CONFIRM_MS = 3000

const TUI_SLASH_COMMANDS: readonly TuiSlashCommandDef[] = [
  {
    name: '/tools',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()
      if (sub === 'enable') {
        const toolName = parts[2]
        if (!toolName) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /tools enable <tool_name>\nMounts an EXTENDED-layer tool onto the primary agent at this turn boundary.\nAlternatively, use delegate_task to dispatch a worker with that tool (zero cache cost).' }))
        } else if (toolName.toLowerCase() === 'computer_use' && !isProFeatureEnabled(ctx.config, 'computerUse')) {
          pushStatic(createLogEntry({ type: 'system', content: 'computer_use is a Pro feature. Enable Pro (desktop: upgrade in Settings ? About & License; CLI: config.pro.enabled / RIVET_PRO=1 / ~/.rivet/pro.license) to mount this tool.' }))
        } else {
          const result = ctx.agent.enableTool(toolName)
          switch (result.status) {
            case 'mounted': {
              const costLine = result.cacheImpact === 'prefix-invalidated'
                ? `? Cache impact: provider "${result.prefixCacheStrategy}" uses exact-prefix caching ? the NEXT request will be a full prefix-cache MISS (one-time cost; subsequent turns re-cache against the new tool set).`
                : `? Cache impact: provider "${result.prefixCacheStrategy}" has no prefix cache ? no cache penalty.`
              pushStatic(createLogEntry({ type: 'system', content: `Mounted EXTENDED tool "${toolName}" onto the primary agent.\n${costLine}` }))
              break
            }
            case 'already-active':
              pushStatic(createLogEntry({ type: 'system', content: `"${toolName}" is already mounted on the primary agent. No change.` }))
              break
            case 'not-extended':
              pushStatic(createLogEntry({ type: 'system', content: `"${toolName}" is a CORE or already-visible tool ? it's available without mounting. No change.` }))
              break
            case 'unknown':
              pushStatic(createLogEntry({ type: 'system', content: `Unknown tool "${toolName}". Run /tools to list available tiers.` }))
              break
            case 'gating-off':
              pushStatic(createLogEntry({ type: 'system', content: `Tool gating is disabled ? all tools are already visible to the primary agent. No change.` }))
              break
          }
        }
      } else {
        // List current tool tiers
        const { CORE_TOOLS, EXTENDED_TOOLS, isExtendedTool } = await import('../agent/tool-tiers.js')
        const active = new Set(ctx.agent.getActiveToolNames())
        const mountedExtras = [...active].filter(isExtendedTool)
        const disabled = new Set(ctx.config.agent?.toolGating?.disabledTools ?? [])
        const lines: string[] = ['Tool Gating Tiers', '?????????????????????', '', `CORE (${CORE_TOOLS.length}):`, ...CORE_TOOLS.map(t => `  ${disabled.has(t) ? '?' : '?'} ${t}`), '', `EXTENDED (${EXTENDED_TOOLS.length}):`, ...EXTENDED_TOOLS.map(t => `  ${disabled.has(t) ? '?' : active.has(t) ? '? (mounted)' : '?'} ${t}`), '']
        if (mountedExtras.length > 0) {
          lines.push(`Runtime-mounted EXTENDED: ${mountedExtras.join(', ')}`, '')
        }
        if (disabled.size > 0) {
          lines.push(`Disabled tools (config-level, restart to apply): ${[...disabled].join(', ')}`, '')
        }
        lines.push('EXTENDED tools are available to workers via delegate_task.', 'Use /tools enable <name> to mount one onto the primary agent.')
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/help',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      pushStatic(createLogEntry({ type: 'system', content: HELP_TEXT }))
      setIsStreaming(false)
      return true

    },
  },
  {
    name: '/status',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const lines: string[] = ['Bandit Promotion State', '???????????????????????']
      if (ctx.banditState && ctx.banditState.length > 0) {
        for (const b of ctx.banditState) {
          lines.push(`${b.source}: ${b.mode} (enabled=${b.enabled})`)
          lines.push(`  reason: ${b.reason}`)
          lines.push(`  samples: ${b.totalShadowSamples}`)
        }
      } else {
        lines.push('(no bandit state available ? run bootstrap first)')
      }
      lines.push('', 'Review Infra Health', '???????????????????????')
      lines.push(formatReviewHealthLine())
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/exit',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      ctx.persist.compactOai(ctx.session.getMessages())
      pushStatic(createLogEntry({ type: 'system', content: 'Session saved. Goodbye!' }))
      process.emit('SIGINT')
      return true

    },
  },
  {
    name: '/quit',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      ctx.persist.compactOai(ctx.session.getMessages())
      pushStatic(createLogEntry({ type: 'system', content: 'Session saved. Goodbye!' }))
      process.emit('SIGINT')
      return true

    },
  },
  {
    // ???subagent ????????????????????????????
    // ?????????????????????????
    name: '/btw',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const question = parts.slice(1).join(' ').trim()
      if (!question) {
        pushStatic(createLogEntry({
          type: 'system',
          content: '???/btw <??>\n???????????????????????????????????????????',
        }))
      } else if (!ctx.askSideQuestion) {
        pushStatic(createLogEntry({ type: 'system', content: '???????????' }))
      } else {
        ctx.askSideQuestion(question)
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/compact',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()
      const msgs = ctx.session.getMessages()
      const beforeTokens = estimateOaiTokens(msgs)

      if (sub === 'status') {
        const compacts = ctx.session.getCompactEvents()
        const ledger = ctx.session.getContextLedger()
        const pct = ledger ? Math.round(ledger.tokenBudget.estimatedTokens / ledger.tokenBudget.maxTokens * 100) : 0
        const compactStr = compacts.length === 0
          ? 'No compact events yet.'
          : compacts.slice(-5).map(e => `  turn ${e.turn}: tier ${e.tier}, ${e.beforeTokens.toLocaleString()}?${e.afterTokens.toLocaleString()}`).join('\n')
        pushStatic(createLogEntry({ type: 'system', content: `Compact status: ${beforeTokens.toLocaleString()}/${ctx.maxTokens.toLocaleString()} tokens (${pct}%)\n\nRecent events:\n${compactStr}\n\nUse /compact to micro-compact, /compact llm to resume LLM compact.` }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'llm' || sub === 'deep') {
        // LLM compact ? deferred to next turn (triggers automatically at thresholds)
        pushStatic(createLogEntry({ type: 'system', content: `LLM compact will trigger automatically at context thresholds (currently ${beforeTokens.toLocaleString()} tokens). Use /compact for immediate micro-compact.` }))
        setIsStreaming(false)
        return true
      }

      // micro compact (default)
      pushStatic(createLogEntry({ type: 'system', content: 'Micro-compacting conversation...' }))
      const { messages: compacted, truncated } = microCompactOai(msgs, ctx.maxTokens, beforeTokens)
      ctx.session.replaceMessages(compacted)
      ctx.agent.config.promptEngine.resetAppendixBaseline()
      const afterTokens = estimateOaiTokens(compacted)
      ctx.session.recordCompactEvent({
        turn: ctx.session.getTurnCount(),
        tier: 1,
        reason: 'manual /compact command',
        beforeTokens,
        afterTokens,
        createdAt: Date.now(),
      })
      const pctRemoved = beforeTokens > 0 ? Math.round((1 - afterTokens / beforeTokens) * 100) : 0
      pushStatic(createLogEntry({ type: 'system', content: `Compacted: ${beforeTokens.toLocaleString()} ? ${afterTokens.toLocaleString()} tokens (-${pctRemoved}%, ${truncated} msgs removed, ${compacted.length} remaining).` }))
      ctx.setSummaryState(prev => ({ ...prev, compactEvent: { beforeTokens, afterTokens } }))
      setTimeout(() => ctx.setSummaryState(prev => ({ ...prev, compactEvent: null })), 8000)
      ctx.setCacheHitRate(ctx.session.getCacheHitRate())
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/team',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      if (!parts.slice(1).join(' ').trim()) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /team <task|docs/superpowers/plans/file.md>\n       /team max <task>' }))
        setIsStreaming(false)
        return true
      }
      // Pro gate???????team max ?????? fanout ? Pro ???
      // ????????????????? /team ?????
      if (parts[1]?.toLowerCase() === 'max' && !isProFeatureEnabled(ctx.config, 'teamMax')) {
        pushStatic(createLogEntry({ type: 'system', content: 'team max???????? Pro ???Basic ???/team <task> ??????? plan_task ????????? Pro ???' }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/galaxy',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      if (!parts.slice(1).join(' ').trim()) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /galaxy <????>\n       ?????????????????????????' }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/council',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      if (!parts.slice(1).join(' ').trim()) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /council <??????/??> [--seats id1,id2,...] [--rounds 1-2]' }))
        setIsStreaming(false)
        return true
      }
      // Pro gate???????rounds?2?????? Pro ??????????
      // council_convene ????? rounds ???????????? Basic ???
      const roundsMatch = /--rounds[\s=]+(\d+)/.exec(parts.slice(1).join(' '))
      if (roundsMatch && Number(roundsMatch[1]) >= 2 && !isProFeatureEnabled(ctx.config, 'councilMultiRound')) {
        pushStatic(createLogEntry({ type: 'system', content: '??????? 2 ??????? Pro ?????????????? Pro ???????' }))
      }
      return false
    },
  },
  {
    name: '/scout',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      if (!parts.slice(1).join(' ').trim()) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /scout <????> [--dims ??,??,??]\n???????????? ? ???? code_scout ? ?????? + runbook?' }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/starflow',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming, submitToAgent } = ctx
      const task = parts.slice(1).join(' ').trim()
      if (!task) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /starflow <????>\n       ???Starflow???????+???? ? council ?? ? team ?? ? galaxy ?? ? ???????????????????' }))
        setIsStreaming(false)
        return true
      }
      if (submitToAgent) {
        // ??????????? starflow ????????????council?team?galaxy??
        // ?????????? prompt?????????????????
        submitToAgent(`?????Starflow???????${task}

??????????????/???/????????????????????????????????????????????
??????? starflow ???????????????????????council ?? ? team ?? ? galaxy ???????????????
- ? starflow({ objective, draftItems, rounds, confirm: false }) ????????????? confirm: true ???
- draftItems ????????id/title/detail/files??? council ??? galaxy ?????????? rounds: 2?
- ?? blocked ????????????????????????? / resume: true ???????????
- ??????????????????????? deliver_task ???????????????"???"?
????????"?????/?????"?`)
        return true
      }
      return false
    },
  },
  {
    name: '/review',
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // /review off|on|status ? ??????????????????????
      // off ??? deliver_task ?????????????????/??/???
      // ???? spawn ?? worker?? token???? /review [max] ?????
      const sub = parts[1]?.toLowerCase()
      if (sub === 'off' || sub === 'on' || sub === 'status') {
        const gateRef = ctx.reviewGateRef
        if (!gateRef) {
          pushStatic(createLogEntry({ type: 'system', content: '???????????????????? review.skipAuto???????????' }))
          setIsStreaming(false)
          return true
        }
        if (sub === 'status') {
          const state = gateRef.current === 'off' ? '????off?' : '???auto?'
          pushStatic(createLogEntry({ type: 'system', content: `??????${state}?/review off ???????/review on ????? /review [max] ?????` }))
        } else {
          gateRef.current = sub === 'off' ? 'off' : 'auto'
          pushStatic(createLogEntry({ type: 'system', content: sub === 'off'
            ? '? ????????????????????/??/??????? spawn ?? worker??? /review [max] ????/review on ???'
            : '? ??????????????????????????????' }))
        }
        setIsStreaming(false)
        return true
      }
      // /review [max|l1|l2|l3] [focus] ? ?????????? deliver_task??
      // ? ctx.runReview ?????? routeReviewWorkflow??? fallback ?????
      const levelKw = parts[1]?.toLowerCase()
      const forceLevel = levelKw === 'max' || levelKw === 'l3' ? 'L3' as const
        : levelKw === 'l1' ? 'L1' as const
        : levelKw === 'l2' ? 'L2' as const
        : undefined
      const isMax = forceLevel === 'L3'
      const focus = parts.slice(forceLevel ? 2 : 1).join(' ').trim()

      if (!ctx.runReview) {
        // Fallback: ? resolveAppPromptInput ??? deliver_task ??
        return false
      }

      // ?????????? + ???? import ???? bundle
      const { isCrossModule, isFixContext } = await import('../agent/review-discipline.js')
      const { reviewWorkflowBudgetMs } = await import('../agent/review-router.js')
      type ChangeSet = import('../agent/review-discipline.js').ChangeSet
      type ReviewMode = import('../agent/review-router.js').ReviewMode

      // ? git diff ?? ChangeSet
      const dirtyFiles = await collectDirtyFiles(ctx.agent.cwd)
      if (dirtyFiles.length === 0) {
        pushStatic(createLogEntry({ type: 'system', content: '?????????????' }))
        setIsStreaming(false)
        return true
      }

      const change: ChangeSet = {
        files: dirtyFiles,
        crossModule: isCrossModule(dirtyFiles),
        isFix: isFixContext(focus || ''),
        ...(forceLevel ? { forceLevel } : {}),
      }

      const mode: ReviewMode = 'manual'
      const budgetSec = forceLevel === 'L1'
        ? 0
        : Math.round(reviewWorkflowBudgetMs(mode, forceLevel === 'L3' ? 'L3' : forceLevel === 'L2' ? 'L2' : undefined) / 1000)
      const levelLabel = forceLevel === 'L3' ? 'L3 Squadron (5 inspectors)' : forceLevel ?? 'auto-classify'
      pushStatic(createLogEntry({ type: 'system', content: `? ????? (${levelLabel}, ?${budgetSec}s)...\n` }))

      try {
        const outcome = await ctx.runReview(change, mode, focus || undefined)
        const icon = outcome.verdict === 'verified' ? '??'
                   : outcome.verdict === 'rejected' ? '??' : '??'
        const lines = [`${icon} ???? [${outcome.tier}]: ${outcome.verdict}`]
        if (typeof outcome.rounds === 'number') lines.push(`   ???${outcome.rounds}`)
        if (outcome.evidence) lines.push(`   ???${outcome.evidence}`)
        if (outcome.verdict === 'rejected' || outcome.escalated) {
          lines.push('   ? ??????????????')
        }
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      } catch (err) {
        pushStatic(createLogEntry({ type: 'system', content: `?????${(err as Error).message}` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/model',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const targetModel = parts[1]
      if (!targetModel || targetModel === 'list') {
        const lines: string[] = []
        for (const [provName, prov] of Object.entries(ctx.allProviders)) {
          const marker = provName === ctx.currentProvider ? ' ? current' : ''
          lines.push(`[${provName}]${marker}`)
          for (const m of prov.models) {
            const isCurrent = m.alias === ctx.model || m.id === ctx.model
            lines.push(`  ${m.alias} (${m.id})${isCurrent ? ' ?' : ''}`)
          }
        }
        pushStatic(createLogEntry({ type: 'system', content: `Models:\n${lines.join('\n')}\n\nCurrent: ${ctx.model} [${ctx.currentProvider}]\nContext: ${ctx.maxTokens.toLocaleString()} tokens\nCost: ?${ctx.cost.toFixed(4)}` }))
      } else {
        const result = ctx.onModelSwitch(targetModel)
        if (result.ok) {
          pushStatic(createLogEntry({ type: 'system', content: `Switched to ${targetModel}` }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: result.error ?? `Model "${targetModel}" not found.` }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/mirror',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()
      const current = getMirrorConfig()

      if (sub === 'on') {
        const next = setMirrorConfig({ enabled: true, preset: current.preset === 'default' ? 'china' : current.preset })
        pushStatic(createLogEntry({ type: 'system', content: `? Mirrors enabled.\n${formatMirrorStatus(next)}` }))
      } else if (sub === 'off') {
        const next = setMirrorConfig({ enabled: false })
        pushStatic(createLogEntry({ type: 'system', content: `? Mirrors disabled.\n${formatMirrorStatus(next)}` }))
      } else if (sub === 'china') {
        const next = setMirrorConfig({ enabled: true, preset: 'china' })
        pushStatic(createLogEntry({ type: 'system', content: `? Switched to China mirror preset.\n${formatMirrorStatus(next)}` }))
      } else if (sub === 'default') {
        const next = setMirrorConfig({ enabled: false, preset: 'default', github: 'default', npm: 'default', pypi: 'default', go: 'default', rust: 'default' })
        pushStatic(createLogEntry({ type: 'system', content: `? Reset mirrors to default (off).\n${formatMirrorStatus(next)}` }))
      } else {
        pushStatic(createLogEntry({ type: 'system', content: `${formatMirrorStatus(current)}\n\nUsage: /mirror [on|off|china|default]` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/python',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming, agent } = ctx
      const sub = parts[1]?.toLowerCase()
      const env = await detectEnv(agent.cwd)

      if (sub === 'status') {
        const lines = [
          `Python: ${env.python.available ? `${env.python.command} (${env.python.version ?? 'unknown'})` : '???'}`,
          `uv: ${env.uv.available ? `??? (${env.uv.version ?? 'unknown'})` : '???'}`,
          `Git: ${env.git.available ? `??? (${env.git.version ?? 'unknown'})` : '???'}`,
          `Node: ${env.node.available ? `??? (${env.node.version ?? 'unknown'})` : '???'}`,
          `??: ${env.platform}`,
        ]
        const guidance = formatEnvGuidance(env)
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') + (guidance ? '\n\n' + guidance : '') }))
      } else if (sub === 'setup') {
        if (!env.python.available) {
          pushStatic(createLogEntry({ type: 'system', content: '???? Python??????????\n\n' + formatEnvGuidance(env) }))
        } else if (!env.uv.available) {
          pushStatic(createLogEntry({ type: 'system', content: '???? Python????? uv ????????\n\n' + formatEnvGuidance(env) }))
        } else {
          const recommendation = recommendUvSetup(agent.cwd)
          if (recommendation.ok && recommendation.command) {
            pushStatic(createLogEntry({ type: 'system', content: `${recommendation.message}\n?????${recommendation.command}\n\n??????????????"?? Python ?????"?` }))
          } else {
            pushStatic(createLogEntry({ type: 'system', content: recommendation.message }))
          }
        }
      } else {
        const hasProject = isPythonProject(agent.cwd)
        pushStatic(createLogEntry({ type: 'system', content: `???? ${hasProject ? '?' : '??'} Python ???\n\nUsage: /python [status|setup]` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/init',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming, agent } = ctx
      const sub = parts[1]?.toLowerCase()
      // ?? ? ?????????verify / skills / hooks ??????????
      if (!sub) {
        if (ctx.openInitFlow) {
          ctx.openInitFlow()
        } else {
          pushStatic(createLogEntry({ type: 'system', content: '?????????????????/?????? /init verify???? verify ??????' }))
        }
        setIsStreaming(false)
        return true
      }
      if (sub !== 'verify') {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /init [verify] ? ?????????????verify ??? verify ?????', isError: true }))
        setIsStreaming(false)
        return true
      }
      // /init verify ? ????????/???????????
      // A4: (re)generate the project verify declaration from the fingerprint.
      // config ? md single direction: .rivet-config.json is authoritative,
      // the .rivet.md Stack section is rendered from it.
      try {
        const decl = ensureVerifyDeclaration(agent.cwd)
        const lines: string[] = []
        if (decl.fingerprint.language === 'unknown') {
          lines.push('?????????? package.json / Cargo.toml / go.mod / pyproject.toml / gradle ????')
          lines.push('???? .rivet-config.json ????{"verify": {"test": "<??>", "build": "<??>"}}')
        } else {
          lines.push(`????: ${decl.fingerprint.language}${decl.fingerprint.hasTestInfra ? '' : '????????????'}`)
          const v = decl.verify
          for (const [k, val] of Object.entries({ test: v.test, build: v.build, typecheck: v.typecheck, lint: v.lint })) {
            if (val) lines.push(`  verify.${k}: ${val}${decl.filledKeys.includes(k) ? '?????' : '????????'}`)
          }
          lines.push(decl.wrote ? '??? .rivet-config.json ? verify ???' : 'verify ???????????')
          // Render the Stack section into .rivet.md (create when missing).
          try {
            const rivetMdPath = join(agent.cwd, '.rivet.md')
            const stack = renderRivetMdStack(decl.fingerprint, decl.verify)
            const body = existsSync(rivetMdPath) ? readFileSync(rivetMdPath, 'utf-8') : '# Project\n'
            const next = upsertStackSection(body, stack)
            if (next !== body) {
              writeFileSync(rivetMdPath, next, 'utf-8')
              lines.push('??? .rivet.md ? Stack ???????????')
            }
          } catch { lines.push('?.rivet.md ??????????????') }
          if (!decl.fingerprint.hasTestInfra) {
            lines.push('??????????deliver_task ???????????? YELLOW????????????????')
          }
        }
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      } catch (err) {
        pushStatic(createLogEntry({ type: 'system', content: `/init ??: ${err instanceof Error ? err.message : String(err)}` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/cd',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming, agent } = ctx
      const target = parts.slice(1).join(' ').trim()
      // ?? ? ?????????
      if (!target) {
        pushStatic(createLogEntry({ type: 'system', content: `??????: ${agent.cwd}\n\nUsage: /cd <path> ? ?????????????????????????????????` }))
        setIsStreaming(false)
        return true
      }
      if (!ctx.onCwdSwitch) {
        pushStatic(createLogEntry({ type: 'system', content: '??????? /cd ?????/??????', isError: true }))
        setIsStreaming(false)
        return true
      }
      const res = await ctx.onCwdSwitch(target)
      if (!res.ok) {
        pushStatic(createLogEntry({ type: 'system', content: `/cd ??: ${res.error ?? '????'}`, isError: true }))
        setIsStreaming(false)
        return true
      }
      const lines = [
        `???????: ${res.from} ? ${res.to}`,
        `????????${res.movedFiles?.length ?? 0} ?????????? /resume ? --continue ??????`,
        '????????????????????????? /domain ??????',
      ]
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/handoff',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming, agent } = ctx
      const note = parts.slice(1).join(' ').trim() || undefined
      if (!ctx.submitToAgent) {
        pushStatic(createLogEntry({ type: 'system', content: '??????? /handoff???/??????', isError: true }))
        setIsStreaming(false)
        return true
      }
      // ??? .rivet/ ??????auto-safe ??????????????????????
      const projectPath = join(agent.cwd, '.rivet', 'HANDOFF.md')
      const archivePath = join(getSessionDir(agent.cwd), `${ctx.currentSessionId}.handoff.md`)
      // ??????? turn ??? TUI ???????????????
      // ?loadPrevHandoff ????? <id>.handoff.md??
      ctx.onHandoffStart?.(projectPath, archivePath)
      ctx.submitToAgent(buildHandoffPrompt(projectPath, note))
      return true
    },
  },
  {
    name: '/doctor',
    immediate: true,
    async handler(ctx) {
      const { pushStatic, setIsStreaming, agent } = ctx
      // Probe against the RESOLVED env (not raw process env) so results reflect
      // what the agent can actually run after GUI-launch PATH recovery.
      const resolved = getResolvedEnv(agent.cwd)
      const env = await detectEnv(agent.cwd, resolved)
      const shell = getShellCommand()
      const toolLine = (label: string, t: { available: boolean; command?: string; version?: string }): string =>
        `${label} ${t.available ? `??? (${t.version ?? t.command ?? 'unknown'})` : '??? / ?? PATH'}`
      const lines = [
        '???? (/doctor)',
        '???????????????????????',
        `??: ${env.platform}`,
        toolLine('Node:  ', env.node),
        toolLine('Git:   ', env.git),
        toolLine('Python:', env.python),
        toolLine('uv:    ', env.uv),
        toolLine('Java:  ', env.java),
        toolLine('Maven: ', env.maven),
        toolLine('Gradle:', env.gradle),
        '',
        'Shell (bash ??????)',
        '???????????????????????',
        `kind: ${shell.kind}   cmd: ${shell.cmd}`,
      ]
      if (env.platform === 'win32' && shell.kind !== 'bash') {
        lines.push('', '? Windows ??? Git Bash ? ??????? ' + shell.kind + '?')
        lines.push('  ?? Git for Windows ??????? POSIX ?????')
      }

      // PATH recovery diff: show what the resolver added on top of the raw
      // process PATH, so the user knows whether GUI-launch recovery kicked in and
      // what to add to `env.extraPath` if a tool is still missing.
      const diff = getResolvedPathDiff(agent.cwd)
      lines.push('', 'PATH ?? (GUI ????)', '???????????????????????')
      lines.push(`process PATH ??: ${diff.processPath.length}   resolved PATH ??: ${diff.resolvedPath.length}`)
      if (diff.added.length > 0) {
        lines.push('?????????? PATH ???:')
        for (const d of diff.added.slice(0, 20)) lines.push(`  + ${d}`)
        if (diff.added.length > 20) lines.push(`  ? ??? ${diff.added.length - 20} ?`)
      } else {
        lines.push('resolved PATH ? process PATH ?????????')
      }
      const stillMissing = [
        !env.git.available ? 'git' : null,
        !env.java.available ? 'java' : null,
        !env.maven.available ? 'mvn' : null,
        !env.gradle.available ? 'gradle' : null,
      ].filter(Boolean)
      if (stillMissing.length > 0) {
        lines.push('', `????: ${stillMissing.join(', ')}`)
        lines.push('????????????????? env.extraPath??????????? *_HOME ????????')
      }

      const guidance = formatEnvGuidance(env)
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') + (guidance ? '\n\n' + guidance : '') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/logs',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming, agent, currentSessionId } = ctx
      // ???? `rivet logs` ????????????????? open ????
      // ???????????? TUI ?????????????????
      // ?? id ?????CLI ?????????????? TUI ????????
      const { runLogsCLI } = await import('../diagnostics/logs-cli.js')
      const { output } = runLogsCLI(
        ['--session', currentSessionId, ...parts.slice(1)],
        { cwd: agent.cwd },
      )
      const isOpen = parts[1]?.toLowerCase() === 'open'
      const hint = isOpen ? '' : '\n\n? /logs open ???????/logs open desktop ?? sidecar ?????'
      pushStatic(createLogEntry({ type: 'system', content: output + hint }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/chat',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      pushStatic(createLogEntry({ type: 'system', content: '?????????????????????????????????????' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/task',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      pushStatic(createLogEntry({ type: 'system', content: '???????????????????????????????????????????????/?? worker??? /tasks?' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/mode',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      pushStatic(createLogEntry({ type: 'system', content: '????????????????????' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/goal',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const parsed = parseGoalArgs(parts.slice(1))
      if (!parsed.goalText) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /goal <task description> [--max N] [--budget M] [--criteria \'["..."]\']\nSets a persistent goal. The agent will auto-continue until the goal is achieved or the budget is exhausted.\nCancel with /goal-cancel.' }))
        setIsStreaming(false)
        return true
      }
      const { GoalTracker, buildGoalModePrompt } = await import('../agent/goal-tracker.js')
      const maxIterations = parsed.maxIterations ?? Math.max(50, Math.floor(ctx.maxTokens / 4000))
      const tracker = new GoalTracker({
        goal: parsed.goalText,
        maxIterations,
        contextWindow: ctx.maxTokens,
        wallClockMs: parsed.wallClockMs,
        maxJudgeRuns: ctx.agent.config.goalJudge?.maxRuns,
      })
      if (parsed.criteria) {
        tracker.setSuccessCriteria(parsed.criteria)
      }
      ctx.agent.setGoalTracker(tracker)
      if (ctx.goalTrackerRef) ctx.goalTrackerRef.current = tracker
      await persistGoalState(ctx, tracker)
      const budgetHint = parsed.wallClockMs !== undefined
        ? `Wall-clock budget: ${Math.round(parsed.wallClockMs / 60000)}m. `
        : ''
      pushStatic(createLogEntry({ type: 'system', content: `?? Goal activated: ${parsed.goalText}\nMax iterations: ${maxIterations}. ${budgetHint}Output "GOAL ACHIEVED" to complete, "GOAL BLOCKED" for blockers, or /goal-cancel to abort.\nUse /goal-pause to pause, /goal-resume to resume.` }))
      if (ctx.agent.config.goalJudge?.enabled !== false && !parsed.criteria) {
        void (async () => {
          try {
            const { extractGoalCriteria, completionFromClient, buildCheapClient } = await import('../agent/goal-criteria.js')
            const { loadConfig } = await import('../config/manager.js')
            const cfg = await loadConfig()
            const cheapProfile = cfg.workers?.profiles?.cheap
            const allProviders = ctx.agent.config.allProviders ?? {}
            let completion
            if (cheapProfile && allProviders[cheapProfile.provider]) {
              const cheap = buildCheapClient(cheapProfile, allProviders)
              completion = cheap
                ? completionFromClient(cheap.client, cheap.model)
                : completionFromClient(ctx.agent.config.client, ctx.agent.config.promptEngine.getModel())
            } else {
              completion = completionFromClient(ctx.agent.config.client, ctx.agent.config.promptEngine.getModel())
            }
            const criteria = await extractGoalCriteria(parsed.goalText, completion)
            tracker.setSuccessCriteria(criteria)
            await persistGoalState(ctx, tracker)
            pushStatic(createLogEntry({ type: 'system', content: `?? Judge ?????????????\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}` }))
          } catch {
            pushStatic(createLogEntry({ type: 'system', content: '?? ??????????????extraction failed??' }))
          }
        })()
      }
      setIsStreaming(false)
      ctx.submitToAgent?.(buildGoalModePrompt(parsed.goalText))
      return true
    },
  },
  {
    name: '/cancel-goal',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      ctx.agent.setGoalTracker(null)
      if (ctx.goalTrackerRef) ctx.goalTrackerRef.current = null
      // Clean up persisted goal state if session info is available
      if (ctx.currentSessionId) {
        try {
          const { deleteGoalState } = await import('../agent/goal-persist.js')
          const { getSessionDir } = await import('../agent/session-persist.js')
          deleteGoalState(getSessionDir(ctx.agent.cwd), ctx.currentSessionId)
        } catch { /* best-effort */ }
      }
      pushStatic(createLogEntry({ type: 'system', content: '?? Goal cancelled.' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/goal-resume',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const tracker = ctx.goalTrackerRef?.current
      if (!tracker) {
        pushStatic(createLogEntry({ type: 'system', content: 'No paused or blocked goal to resume. Use /goal <task> to start one.' }))
        setIsStreaming(false)
        return true
      }
      const status = tracker.getStatus()
      if (status !== 'paused' && status !== 'blocked') {
        pushStatic(createLogEntry({ type: 'system', content: `Goal is ${status}, cannot resume.` }))
        setIsStreaming(false)
        return true
      }
      tracker.resume('user')
      const wallElapsed = Math.round(tracker.getWallClockElapsedMs() / 1000)
      pushStatic(createLogEntry({ type: 'system', content: `?? Goal resumed: ${tracker.getGoal()}\nIteration: ${tracker.getIteration()}/${tracker.getMaxIterations()} | ? ${wallElapsed}s elapsed.` }))
      ctx.submitToAgent?.(`[GOAL RESUME] ??????: ${tracker.getGoal()}`)
      return true
    },
  },
  {
    name: '/goal-criteria',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const tracker = ctx.goalTrackerRef?.current
      if (!tracker) {
        pushStatic(createLogEntry({ type: 'system', content: 'No active goal. Use /goal <task> first.' }))
        setIsStreaming(false)
        return true
      }
      const subCmd = parts[1]?.toLowerCase()
      if (subCmd === 'set') {
        // /goal-criteria set <json array>
        const jsonText = parts.slice(2).join(' ').trim()
        if (!jsonText) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /goal-criteria set \'["criterion 1", "criterion 2"]\'' }))
          setIsStreaming(false)
          return true
        }
        try {
          const criteria = JSON.parse(jsonText)
          if (!Array.isArray(criteria) || !criteria.every((c: unknown) => typeof c === 'string')) {
            throw new Error('Expected a JSON array of strings')
          }
          tracker.setSuccessCriteria(criteria as string[])
          pushStatic(createLogEntry({ type: 'system', content: `? ???????${(criteria as string[]).length} ??:\n${(criteria as string[]).map((c, i) => `${i + 1}. ${c}`).join('\n')}` }))
        } catch (e) {
          pushStatic(createLogEntry({ type: 'system', content: `? ????: ${(e as Error).message}` }))
        }
      } else {
        // Show current criteria
        const criteria = tracker.getSuccessCriteria()
        if (criteria.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: '?????????????????\n? /goal-criteria set \'["..."]\' ?????' }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: `?? Judge ????${criteria.length} ??:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n? /goal-criteria set \'["..."]\' ???` }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/goal-status',
    immediate: true,
    handler(ctx) {
      const { pushStatic, setIsStreaming } = ctx
      const tracker = ctx.goalTrackerRef?.current
      if (!tracker) {
        pushStatic(createLogEntry({ type: 'system', content: 'No active goal. Use /goal <task> to start one.' }))
      } else {
        pushStatic(createLogEntry({ type: 'system', content: formatGoalStatus(tracker) }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/goal-pause',
    immediate: true,
    async handler(ctx) {
      const { pushStatic, setIsStreaming } = ctx
      const tracker = ctx.goalTrackerRef?.current
      if (!tracker) {
        pushStatic(createLogEntry({ type: 'system', content: 'No active goal to pause. Use /goal <task> to start one.' }))
        setIsStreaming(false)
        return true
      }
      const status = tracker.getStatus()
      if (status !== 'active') {
        pushStatic(createLogEntry({ type: 'system', content: `Goal is ${status}, cannot pause.` }))
        setIsStreaming(false)
        return true
      }
      tracker.pause('Paused by user', 'user')
      await persistGoalState(ctx, tracker)
      pushStatic(createLogEntry({ type: 'system', content: `? Goal paused: ${tracker.getGoal()}\nIteration: ${tracker.getIteration()}/${tracker.getMaxIterations()} | Use /goal-resume to continue.` }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/domain',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()
      if (!sub || sub === 'status') {
        // Show current domain
        const current = ctx.agent.getSessionDomain()
        if (current === undefined) {
          pushStatic(createLogEntry({ type: 'system', content: '??\n\n???????????????????????\n?? /domain list ???????/domain <??> ?????' }))
        } else if (current === null) {
          pushStatic(createLogEntry({ type: 'system', content: '??\n\n???????????????\n?? /domain <??> ?????? /domain auto ????????' }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: `??\n\n??: ${current.name} (${current.id})\n???: ${current.motto}\n\n${current.volatileBlock}` }))
        }
      } else if (sub === 'list' || sub === 'ls') {
        const current = ctx.agent.getSessionDomain()
        const currentId = current?.id
        const lines = (starDomainRegistry.list() as Array<{ id: StarDomainId; name: string; keywords: string[]; decisionStyle: string; motto: string }>).map(d => {
          const marker = d.id === currentId ? ' ? current' : ''
          return `  ${d.name} (${d.id}) [${d.decisionStyle}]${marker}\n    ${d.motto}\n    keywords: ${d.keywords.join(', ')}`
        })
        pushStatic(createLogEntry({ type: 'system', content: `????\n\n${lines.join('\n\n')}\n\n?? /domain <id|??> ???/domain auto ???????` }))
      } else if (sub === 'auto') {
        const midSession = ctx.agent.getSessionTurnCount() > 0
        ctx.agent.resetSessionDomain()
        ctx.onDomainChange?.(undefined)
        pushStatic(createLogEntry({ type: 'system', content: '????????????????????????????????' }))
        if (midSession) pushStatic(createLogEntry({ type: 'system', content: DOMAIN_SWITCH_CACHE_WARNING }))
      } else {
        // Try to match by id or Chinese name
        const allDomains = starDomainRegistry.list()
        const matched = allDomains.find(d => d.id === sub || d.name === parts[1] || d.id === parts[1]?.toLowerCase())
        if (matched) {
          const midSession = ctx.agent.getSessionTurnCount() > 0
          const domain = { id: matched.id, name: matched.name, volatileBlock: matched.volatileBlock, motto: matched.motto, courageThreshold: matched.courageThreshold }
          ctx.agent.setSessionDomain(domain)
          ctx.onDomainChange?.(domain.name)
          pushStatic(createLogEntry({ type: 'system', content: `????: ${domain.name} (${domain.id})\n${domain.motto}\n\n${domain.volatileBlock}` }))
          if (midSession) pushStatic(createLogEntry({ type: 'system', content: DOMAIN_SWITCH_CACHE_WARNING }))
        } else {
          const validNames = allDomains.map(d => `${d.name}|${d.id}`).join(', ')
          pushStatic(createLogEntry({ type: 'system', content: `????: "${parts[1]}"\n\n????: ${validNames}\n\n?? /domain list ???????`, isError: true }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/verbose',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const nextVerbose = !ctx.verboseRef.current
      ctx.setVerbose(nextVerbose)
      pushStatic(createLogEntry({ type: 'system', content: nextVerbose ? 'Verbose mode: on (show 200 lines)' : 'Verbose mode: off (show 20 lines)' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/evidence',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const state = ctx.agent.getEvidenceState()
      if (state.verifications.length === 0) {
        pushStatic(createLogEntry({ type: 'system', content: 'No evidence recorded yet this session.' }))
      } else {
        const recent = state.verifications.slice(-10)
        const lines = ['Evidence Summary (last 10 verifications):', '']
        for (const v of recent) {
          const glyph = v.status === 'passed' ? '?' : v.status === 'failed' ? '?' : '?'
          const time = v.timestamp ? new Date(v.timestamp).toLocaleTimeString() : ''
          lines.push(`  ${glyph} ${v.command}  (${v.status})  ${time}`)
        }
        const passRate = Math.round((recent.filter(v => v.status === 'passed').length / recent.length) * 100)
        lines.push('', `Pass rate: ${passRate}% (${recent.filter(v => v.status === 'passed').length}/${recent.length})`)
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/permission',
    immediate: true,
    handler(ctx) {
      const { parts, agent, pushStatic, setIsStreaming } = ctx
      const sub = parts[1]?.toLowerCase()

      const VALID_MODES = ['auto-accept', 'auto-safe', 'manual', 'dangerously-skip-permissions'] as const
      type RuntimeMode = typeof VALID_MODES[number]
      function isRuntimeMode(m: string): m is RuntimeMode {
        return (VALID_MODES as readonly string[]).includes(m)
      }
      const MODE_LABELS: Record<RuntimeMode, string> = {
        'auto-accept': 'auto-accept ? ???????????',
        'auto-safe': 'auto-safe ? ?/??????????????',
        'manual': 'manual ? ??? approval ???????',
        'dangerously-skip-permissions': 'yolo (dangerously-skip-permissions) ? ????????',
      }

      function parseKvPairs(tokens: string[]): Record<string, string> {
        const out: Record<string, string> = {}
        for (const t of tokens) {
          const idx = t.indexOf('=')
          if (idx > 0) {
            let value = t.slice(idx + 1)
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1)
            }
            out[t.slice(0, idx)] = value
          }
        }
        return out
      }

      function ruleSource(rules: unknown[], overlay: unknown[], index: number): string {
        if (index < rules.length) return '[config]'
        return '[session]'
      }

      function formatRules() {
        const cfg = agent.config.permissions
        const overlay = agent.config.permissionsOverlay
        const allow = [...(cfg?.allow ?? []), ...(overlay?.allow ?? [])]
        const deny = [...(cfg?.deny ?? []), ...(overlay?.deny ?? [])]
        const bashAllow = [...(cfg?.bash?.allowlist ?? []), ...(overlay?.bashAllow ?? [])]
        const bashDeny = [...(cfg?.bash?.denylist ?? []), ...(overlay?.bashDeny ?? [])]

        const lines: string[] = []
        const currentMode = agent.config.approvalMode ?? 'manual'
        const currentLabel = { manual: 'Manual', 'auto-safe': 'Auto', 'auto-accept': 'Auto', 'dangerously-skip-permissions': 'YOLO' }[currentMode] ?? currentMode
        lines.push(`????: ${currentLabel} (${currentMode})`)
        lines.push('')
        lines.push('????: /permission manual | /permission auto [??] | /permission yolo [confirm]')
        lines.push('')

        if (allow.length > 0) {
          lines.push('\nAllow ???')
          allow.forEach((r, i) => {
            const params = r.params ? Object.entries(r.params).map(([k, v]) => `${k}="${v}"`).join(' ') : ''
            lines.push(`  ${i}. ${ruleSource(cfg?.allow ?? [], overlay?.allow ?? [], i)} ${r.tool}${params ? ' ' + params : ''}`)
          })
        }
        if (deny.length > 0) {
          lines.push('\nDeny ???')
          deny.forEach((r, i) => {
            const params = r.params ? Object.entries(r.params).map(([k, v]) => `${k}="${v}"`).join(' ') : ''
            lines.push(`  ${i}. ${ruleSource(cfg?.deny ?? [], overlay?.deny ?? [], i)} ${r.tool}${params ? ' ' + params : ''}`)
          })
        }
        if (bashAllow.length > 0) {
          lines.push(`\nBash ??????${bashAllow.join(', ')}`)
        }
        if (bashDeny.length > 0) {
          lines.push(`\nBash ??????${bashDeny.join(', ')}`)
        }
        if (allow.length === 0 && deny.length === 0 && bashAllow.length === 0 && bashDeny.length === 0) {
          lines.push('\n?????? allow/deny ???')
        }
        lines.push('\n???deny ????? allow ? approval mode?session ??????????')
        return lines.join('\n')
      }

      if (!sub) {
        // ??? ? ??????????????? + ?????? /effort ???kimi-code ???
        ctx.setChoicePanelKind?.('permission')
        ctx.surfacePush?.('choice-panel')
        setIsStreaming(false)
        return true
      }

      if (sub === 'status') {
        // /permission status ? ?????? + ??????????
        pushStatic(createLogEntry({ type: 'system', content: formatRules() }))
        setIsStreaming(false)
        return true
      }

      // ?? ?????? ??

      if (sub === 'manual') {
        agent.setApprovalMode('manual')
        ctx.setAutoSafe(false)
        ctx.persistApprovalMode?.('manual')
        pushStatic(createLogEntry({ type: 'system', content: '? ???? Manual ? ???????????????????????????' }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'auto') {
        const intervalRaw = parts[2]
        if (intervalRaw !== undefined) {
          const v = Number(intervalRaw)
          if (!Number.isInteger(v) || v < 0) {
            pushStatic(createLogEntry({ type: 'system', content: '????????????: /permission auto [??]', isError: true }))
            setIsStreaming(false)
            return true
          }
          setCheckpointConfig({ checkpointEveryTurns: v })
        }
        agent.setApprovalMode('auto-safe')
        ctx.setAutoSafe(true)
        ctx.persistApprovalMode?.('auto-safe')
        const interval = intervalRaw !== undefined ? Number(intervalRaw) : undefined
        const cpNote = interval !== undefined ? (interval > 0 ? `????? ${interval} ???` : '???????') : ''
        pushStatic(createLogEntry({ type: 'system', content: `? ???? Auto ? ?/?????????????????${cpNote}??????????????\n\n  ?????: /permission auto <??>?0 = ??` }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'yolo') {
        const confirmed = parts[2]?.toLowerCase() === 'confirm'
        if (!confirmed) {
          pushStatic(createLogEntry({ type: 'system', content: [
            '? YOLO ??????',
            '',
            '  ? ????? ? run ???????? maxTurns ??',
            '  ? ????? ? ??????',
            '  ? ????????????????',
            '  ? ??????????',
            '  ? ?????/rollback + git ???',
            '  ? Windows ?????????',
            '',
            '????: /permission yolo confirm  ?  /yes',
          ].join('\n') }))
          setIsStreaming(false)
          return true
        }
        agent.setApprovalMode('dangerously-skip-permissions')
        agent.config.maxTurns = 0
        ctx.setAutoSafe(false)
        ctx.persistApprovalMode?.('dangerously-skip-permissions')
        pushStatic(createLogEntry({ type: 'system', content: '? ???? YOLO ? ???????????????????????????/rollback ????????: /yes off' }))
        setIsStreaming(false)
        return true
      }

      // ?? ?? mode ???????? ??

      if (sub === 'mode') {
        const mode = parts[2]
        if (!mode || !isRuntimeMode(mode)) {
          pushStatic(createLogEntry({ type: 'system', content: `??: /permission mode <${VALID_MODES.join('|')}>`, isError: true }))
          setIsStreaming(false)
          return true
        }
        agent.setApprovalMode(mode)
        ctx.setAutoSafe(mode === 'auto-safe')
        pushStatic(createLogEntry({ type: 'system', content: `Approval mode ? ${mode}` }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'allow' || sub === 'deny') {
        const tool = parts[2]
        if (!tool) {
          pushStatic(createLogEntry({ type: 'system', content: `??: /permission ${sub} <tool> [param=value]...`, isError: true }))
          setIsStreaming(false)
          return true
        }
        const rule = { tool, params: parseKvPairs(parts.slice(3)) }
        if (Object.keys(rule.params).length === 0) delete (rule as { params?: Record<string, string> }).params
        if (sub === 'allow') agent.addAllowRule(rule)
        else agent.addDenyRule(rule)
        const paramsStr = rule.params ? Object.entries(rule.params).map(([k, v]) => `${k}="${v}"`).join(' ') : ''
        pushStatic(createLogEntry({ type: 'system', content: `??? ${sub} ??: ${tool}${paramsStr ? ' ' + paramsStr : ''}` }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'bash') {
        const action = parts[2]?.toLowerCase()
        if (action !== 'allow' && action !== 'deny') {
          pushStatic(createLogEntry({ type: 'system', content: '??: /permission bash allow|deny <prefix>', isError: true }))
          setIsStreaming(false)
          return true
        }
        const prefix = parts.slice(3).join(' ')
        if (!prefix) {
          pushStatic(createLogEntry({ type: 'system', content: '??: /permission bash allow|deny <prefix>', isError: true }))
          setIsStreaming(false)
          return true
        }
        if (action === 'allow') agent.addBashAllowPrefix(prefix)
        else agent.addBashDenyPrefix(prefix)
        pushStatic(createLogEntry({ type: 'system', content: `??? bash ${action === 'allow' ? '???' : '???'}??: ${prefix}` }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'remove') {
        const kindRaw = parts[2]?.toLowerCase()
        const target = parts[3]
        if (!kindRaw || !target || !['allow', 'deny', 'bashallow', 'bashdeny'].includes(kindRaw)) {
          pushStatic(createLogEntry({ type: 'system', content: '??: /permission remove allow|deny|bashAllow|bashDeny <index|pattern>', isError: true }))
          setIsStreaming(false)
          return true
        }
        const kind = kindRaw as 'allow' | 'deny' | 'bashAllow' | 'bashDeny'
        const idx = parseInt(target, 10)
        const key = Number.isNaN(idx) ? target : idx
        const ok = agent.removePermissionRule(kind, key)
        pushStatic(createLogEntry({ type: 'system', content: ok ? `??? ${kind} ??: ${target}` : `??? ${kind} ??: ${target}`, isError: !ok }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'reset') {
        agent.resetPermissionOverlay()
        pushStatic(createLogEntry({ type: 'system', content: '?????????????????' }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'test') {
        const tool = parts[2]
        const json = parts.slice(3).join(' ')
        if (!tool || !json) {
          pushStatic(createLogEntry({ type: 'system', content: '??: /permission test <tool> <json input>', isError: true }))
          setIsStreaming(false)
          return true
        }
        let input: Record<string, unknown>
        try {
          input = JSON.parse(json) as Record<string, unknown>
        } catch {
          pushStatic(createLogEntry({ type: 'system', content: 'JSON ????', isError: true }))
          setIsStreaming(false)
          return true
        }
        const allDeny = [...(agent.config.permissions?.deny ?? []), ...(agent.config.permissionsOverlay?.deny ?? [])]
        const allAllow = [...(agent.config.permissions?.allow ?? []), ...(agent.config.permissionsOverlay?.allow ?? [])]
        const bashDeny = [...(agent.config.permissions?.bash?.denylist ?? []), ...(agent.config.permissionsOverlay?.bashDeny ?? [])]
        const bashAllow = [...(agent.config.permissions?.bash?.allowlist ?? []), ...(agent.config.permissionsOverlay?.bashAllow ?? [])]

        const denied = tool === 'bash' && typeof input.command === 'string'
          ? isBashCommandDenied(input.command, bashDeny)
          : isToolDenied(tool, input, allDeny)
        if (denied) {
          pushStatic(createLogEntry({ type: 'system', content: `??: deny??? deny ???` }))
          setIsStreaming(false)
          return true
        }
        const allowlisted = tool === 'bash' && typeof input.command === 'string'
          ? isBashCommandAllowlisted(input.command, bashAllow)
          : isToolAllowed(tool, input, allAllow)
        if (allowlisted) {
          pushStatic(createLogEntry({ type: 'system', content: '??: allow??? allow ???' }))
          setIsStreaming(false)
          return true
        }
        const needsApproval = agent.config.toolRegistry.needsApproval(tool, { input, toolUseId: 'test', cwd: ctx.agent.cwd })
        pushStatic(createLogEntry({ type: 'system', content: `??: ask??? approval?${needsApproval ? '?' : '?'}?` }))
        setIsStreaming(false)
        return true
      }

      pushStatic(createLogEntry({ type: 'system', content: '????????: /permission [status|mode|allow|deny|bash|remove|reset|test]', isError: true }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/grant',
    immediate: true,
    async handler(ctx) {
      const { parts, agent, pushStatic, setIsStreaming } = ctx
      const cwd = agent.cwd
      const target = parts[1]

      if (!target) {
        // ?? ? ????????????????? listPersistedGrants?
        // ?? store ??????/raw ???????????????????
        // ?????????????????/?????
        const persisted = listPersistedGrants(cwd)
        const lines: string[] = ['????????????', '??????????????????????']
        if (persisted.length === 0) {
          lines.push('???? /grant <??> [read|write] ??????????????????????????????')
        } else {
          for (const g of persisted) {
            lines.push(`  ${g.mode === 'write' ? '?' : '??'} ${g.root}${g.mode === 'write' ? ' (??)' : ' (??)'}`)
          }
          lines.push('', '???rivet config revoke-dir <??>????? ?? ? ?????')
        }
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
        setIsStreaming(false)
        return true
      }

      const mode = parts[2]?.toLowerCase() === 'write' ? 'write' : 'read'
      grantPath(target, mode, { persist: true, cwd })
      pushStatic(createLogEntry({
        type: 'system',
        content: `? ?????? ${mode === 'write' ? '??' : '??'}?? "${target}"?????????????`,
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-mode',
    immediate: true,
    handler(ctx) {
      const { pushStatic, setIsStreaming } = ctx
      if (ctx.agent.getPlanModeState() === 'planning') {
        const now = Date.now()
        if (planModeExitArmedAt !== 0 && now - planModeExitArmedAt <= PLAN_MODE_EXIT_CONFIRM_MS) {
          planModeExitArmedAt = 0
          ctx.agent.exitPlanMode()
          pushStatic(createLogEntry({ type: 'system', content: 'Plan Mode ??? ? ????????' }))
        } else {
          planModeExitArmedAt = now
          const activePath = ctx.agent.getActivePlanFilePath()
          pushStatic(createLogEntry({
            type: 'system',
            content: `?? Plan Mode ?????${activePath ? `\n??????: \`${activePath}\`` : ''}\n\n? ???????????? /plan-mode ???????????? /plan-approve <slug> ??????`,
          }))
        }
        setIsStreaming(false)
        return true
      }
      planModeExitArmedAt = 0
      ctx.agent.enterPlanMode()
      pushStatic(createLogEntry({ type: 'system', content: '?? Plan Mode activated. Write operations are blocked except the active plan file.\n\nWorkflow: identify key questions ? delegate_task (code_scout) / web_search ? write plan incrementally ? ask_user_question or plan submit.\n\nWhen ready:\n  plan action=submit ? submit for approval\n  /plan-list ? list submitted plans\n  /plan-approve <slug> [option] ? approve and start execution\n  /plan-reject <slug> <feedback> ? reject with feedback (plan mode stays active)\n\n/plan-mode ? exit plan mode (double-confirm if unapproved)' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/ask',
    immediate: true,
    handler(ctx) {
      const { pushStatic, setIsStreaming } = ctx
      if (ctx.agent.getAskModeState?.() === 'asking' || ctx.agent.askModeState === 'asking') {
        ctx.agent.exitAskMode()
        pushStatic(createLogEntry({ type: 'system', content: 'Ask Mode ??? ? ???????????' }))
        setIsStreaming(false)
        return true
      }
      ctx.agent.enterAskMode()
      pushStatic(createLogEntry({
        type: 'system',
        content:
          '? Ask Mode activated. Only read / search / ask_user_question are allowed.\n\n' +
          'Ask Mode ????????????????????????????? /ask ???',
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-list',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const cwd = ctx.agent.cwd
      const plans = await listPlans(cwd)
      if (plans.length === 0) {
        pushStatic(createLogEntry({ type: 'system', content: 'No plans found. Use /plan-mode to enter plan mode and create a plan.' }))
      } else {
        const lines = plans.map(p => {
          const statusIcon = p.status === 'approved' ? '?' : p.status === 'rejected' ? '?' : p.status === 'executed' ? '??' : '??'
          const tierTag = p.modelTier === 'cheap' ? ' ???????' : ''
          return `  ${statusIcon} \`${p.slug}\` ? ${p.title} (${p.status}, ${p.createdAt.toLocaleString()})${tierTag}`
        })
        pushStatic(createLogEntry({ type: 'system', content: `Plans (.rivet/plans/):\n\n${lines.join('\n')}\n\nUse /plan-approve <slug> to approve, /plan-reject <slug> to reject.` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-approve',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cwd = ctx.agent.cwd
      const notify = (content: string, isError?: boolean) =>
        pushStatic(createLogEntry({ type: 'system', content, isError }))
      const kickoffDeps = { cwd, agent: ctx.agent, submitToAgent: ctx.submitToAgent, notify }
      const rawArg = parts.slice(1).join(' ').trim()
      const plans = await listPlans(cwd)

      // ?? No arg: approve the single pending plan, else open the picker ??
      if (!rawArg) {
        const submitted = plans.filter(p => p.status === 'submitted')
        if (submitted.length === 0) {
          notify(plans.length > 0
            ? 'No submitted plans awaiting approval.\n\nUse /plan-list to see all plans.'
            : 'No plans to approve. Use /plan-mode to create one.')
          setIsStreaming(false)
          return true
        }
        if (submitted.length === 1) {
          // Sole pending plan ? approve + kickoff directly (no slug typing needed).
          await approvePlanAndKickoff(kickoffDeps, submitted[0]!.slug)
          setIsStreaming(false)
          return true
        }
        // Multiple pending ? interactive picker (arrow-select + Enter approves).
        if (ctx.surfacePush) {
          ctx.surfacePush('plan-picker')
        } else {
          const hint = submitted.map(p => `  /plan-approve ${p.slug}`).join('\n')
          notify(`Submitted plans awaiting approval:\n\n${hint}`)
        }
        setIsStreaming(false)
        return true
      }

      // ?? Explicit arg: resolve tolerantly (handles copied "slug ? title") ??
      // A copied hint contains " ? "; a real approach is space-separated. Split so
      // the em-dash title junk never gets mistaken for an approach.
      let slugCandidate: string
      let approachRaw = ''
      if (rawArg.includes(' ? ')) {
        slugCandidate = stripCopiedTitleSuffix(rawArg)
      } else {
        slugCandidate = parts[1]!
        approachRaw = parts.slice(2).join(' ').trim()
      }

      let resolution = resolvePlanRef(plans, slugCandidate)
      // Fallback: the whole arg may be a multi-word title, not slug + approach.
      if (resolution.kind === 'none' && approachRaw) {
        const full = resolvePlanRef(plans, rawArg)
        if (full.kind === 'match') { resolution = full; approachRaw = '' }
      }
      if (resolution.kind === 'none') {
        notify(`Plan not found: "${stripCopiedTitleSuffix(rawArg)}". Use /plan-list to see available plans.`, true)
        setIsStreaming(false)
        return true
      }
      if (resolution.kind === 'ambiguous') {
        notify(`Ambiguous plan ref "${stripCopiedTitleSuffix(rawArg)}". Matches:\n${resolution.slugs.map(s => `  \`${s}\``).join('\n')}\n\nUse the full slug, or /plan-approve (no arg) to pick interactively.`, true)
        setIsStreaming(false)
        return true
      }

      const plan = resolution.plan
      const slug = plan.slug

      // Validate the selected approach BEFORE mutating the plan file ? approving
      // first would leave the file marked APPROVED even when the option is bogus.
      let resolvedApproach: string | undefined
      if (approachRaw) {
        if (plan.options && plan.options.length > 0) {
          resolvedApproach = resolvePlanOptionLabel(plan.options, approachRaw)
          if (!resolvedApproach) {
            const available = plan.options.map(o => `  \`${o.label}\``).join('\n')
            notify(`Unknown option "${approachRaw}". Available options:\n${available}`, true)
            setIsStreaming(false)
            return true
          }
        } else {
          resolvedApproach = approachRaw
        }
      }

      await approvePlanAndKickoff(kickoffDeps, slug, resolvedApproach)
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-reject',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const slug = parts[1]?.toLowerCase()
      const feedback = parts.slice(2).join(' ').trim()
      if (!slug) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /plan-reject <slug> [feedback]\n\nUse /plan-list to see available plans.', isError: true }))
        setIsStreaming(false)
        return true
      }

      const cwd = ctx.agent.cwd
      const rejected = await rejectPlan(cwd, slug)
      if (!rejected) {
        pushStatic(createLogEntry({ type: 'system', content: `Plan not found: "${slug}". Use /plan-list to see available plans.`, isError: true }))
        setIsStreaming(false)
        return true
      }

      ctx.agent.enterPlanMode({ planFilePath: `.rivet/plans/${slug}.md` })
      pushStatic(createLogEntry({
        type: 'system',
        content: `? Plan rejected: **${rejected.title}** (\`${slug}\`)\n\nPlan mode remains active. Revise \`.rivet/plans/${slug}.md\` in place, then resubmit with \`plan action=submit\`.${feedback ? '' : '\n\nTip: /plan-reject <slug> <feedback> injects revision guidance.'}`,
      }))
      if (feedback && ctx.submitToAgent) {
        ctx.submitToAgent(`User rejected the plan. Feedback:\n\n${feedback}`)
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/theme',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const raw = parts[1]?.toLowerCase()
      // validThemes derives from THEMES + custom registry so theme.ts remains the single source of truth.
      const validThemes: string[] = [
        ...Object.keys(THEMES),
        ...listCustomThemes().map(n => `custom:${n}`),
      ]
      if (!raw || raw === 'list') {
        const current = getActiveThemeName()
        const list = validThemes.map(t => `  ${t}${t === current ? ' ? current' : ''}`).join('\n')
        pushStatic(createLogEntry({ type: 'system', content: `Available themes:\n${list}\n\nUsage: /theme <name>` }))
      } else if (validThemes.includes(raw)) {
        setTheme(raw)
        pushStatic(createLogEntry({ type: 'system', content: `Theme switched to: ${raw}` }))
      } else {
        pushStatic(createLogEntry({ type: 'system', content: `Theme "${raw}" not found. Available: ${validThemes.join(', ')}` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/prefix-budget',
    immediate: true,
    async handler(ctx) {
      const { pushStatic, setIsStreaming } = ctx
      const { formatBudgetReport } = await import('../prompt/prefix-budget.js')
      const { profile, toolDescriptions, report } = ctx.agent.getPrefixBudget()
      const lines = [
        formatBudgetReport(report),
        '',
        `?? ${profile}????? ${toolDescriptions}?????????????????????????`,
        '???prompt.profile = standard | lean | full?? RIVET_PROMPT_PROFILE ?????',
        'token ? chars/4 ????????????????????? API usage ?????',
      ]
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/debug',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const subcmd = parts[1]
      const info = ctx.agent.getDebugInfo()
      if (subcmd === 'prompt') {
        pushStatic(createLogEntry({ type: 'system', content: `System prompt (${info.systemPromptLength} chars):\n${info.systemPromptPreview}\n\nTools (${info.toolCount}): ${info.toolNames.join(', ')}` }))
      } else if (subcmd === 'fingerprint') {
        const fp = info.fingerprint
        const drift = info.drift
        pushStatic(createLogEntry({ type: 'system', content: `Fingerprint:\n  system:  ${fp.systemSha256.slice(0, 16)}...\n  tools:   ${fp.toolsSha256.slice(0, 16)}...\n  combined: ${fp.combinedSha256.slice(0, 16)}...\n\nDrift: ${drift ? drift.message : 'none (cache stable)'}` }))
      } else if (subcmd === 'cache') {
        const usage = ctx.session.getTotalUsage()
        const hitRate = ctx.cacheHitRate
        const totalCached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        pushStatic(createLogEntry({ type: 'system', content: `Cache:\n  hit rate: ${(hitRate * 100).toFixed(1)}%\n  read tokens: ${usage.cache_read_input_tokens.toLocaleString()}\n  write tokens: ${usage.cache_creation_input_tokens.toLocaleString()}\n  total cached: ${totalCached.toLocaleString()}\n  input tokens: ${usage.input_tokens.toLocaleString()}\n  output tokens: ${usage.output_tokens.toLocaleString()}\n  estimated: ${ctx.session.getEstimatedTokens().toLocaleString()}\n  cost: ?${ctx.cost.toFixed(4)}\n  saved: ?${((usage.cache_read_input_tokens * 0.9) / 1_000_000).toFixed(4)} (cache discount)` }))
      } else if (subcmd === 'context-payload') {
        pushStatic(createLogEntry({ type: 'system', content: formatVolatilePayloadReport(info.volatilePayloadReport) }))
      } else if (subcmd === 'mcp') {
        const mgr = ctx.mcpManagerRef.current
        if (!mgr) {
          pushStatic(createLogEntry({ type: 'system', content: 'MCP not initialized (no servers configured or MCP disabled).' }))
        } else {
          const states = mgr.getStates()
          const tools = mgr.getAllTools()
          const lines = [`MCP Status (${states.length} server(s), ${tools.length} tool(s)):`]
          for (const s of states) {
            const detail = s.status === 'connected'
              ? `connected ? ${s.toolCount} tools`
              : s.status === 'error'
                ? `error: ${s.error}`
                : s.status
            lines.push(`  ${s.serverId}: ${detail}`)
          }
          if (tools.length > 0) {
            lines.push('Tools: ' + tools.map(t => t.definition.name).join(', '))
          }
          pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
        }
      } else {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /debug [prompt|fingerprint|cache|context-payload|mcp]' }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/rollback',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      return false

    },
  },
  {
    name: '/clear',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // Clear visual state ? reset streaming text and thinking buffers
      setIsStreaming(false)
      pushStatic(createLogEntry({ type: 'system', content: 'Screen cleared.' }))
      return true

    },
  },
  {
    name: '/fork',
    description: 'Fork current session (optionally from a message line)',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // /fork [name]       ? fork current session, auto-switch to the copy
      // /fork at <N>       ? fork from message line N (truncate after)
      // /fork at <N> <name>? fork from line N with a branch name
      const sessionDir = getSessionDir(ctx.agent.cwd)
      const sourceJsonl = join(sessionDir, `${ctx.currentSessionId}.jsonl`)
      const arg1 = parts[1]?.toLowerCase()

      let upToLine: number | undefined
      let branchName: string | undefined

      if (arg1 === 'at') {
        const n = parseInt(parts[2] ?? '', 10)
        if (!Number.isFinite(n) || n < 1) {
          pushStatic(createLogEntry({ type: 'system', content: '??: /fork at <??> [???]????? ? 1?' }))
          setIsStreaming(false)
          return true
        }
        upToLine = n
        branchName = parts.slice(3).join(' ').trim() || undefined
      } else if (arg1) {
        branchName = parts.slice(1).join(' ').trim() || undefined
      }

      if (!existsSync(sourceJsonl)) {
        pushStatic(createLogEntry({ type: 'system', content: `?????????: ${sourceJsonl}` }))
        setIsStreaming(false)
        return true
      }

      // Validate upToLine against actual message count
      if (upToLine !== undefined) {
        const total = countMessageLines(sourceJsonl)
        if (upToLine > total) {
          pushStatic(createLogEntry({ type: 'system', content: `?? ${upToLine} ???????? (${total})?` }))
          setIsStreaming(false)
          return true
        }
      }

      const result = forkSession({
        sourceJsonlPath: sourceJsonl,
        targetDir: sessionDir,
        upToLine,
        parentSessionId: ctx.currentSessionId,
        branchName,
      })

      const lineInfo = upToLine ? ` (??? ${upToLine} ?)` : ' (????)'
      const nameInfo = branchName ? ` ???: ${branchName}` : ''
      pushStatic(createLogEntry({
        type: 'system',
        content: `?? Fork ???\n  ??? ID: ${result.newSessionId}${lineInfo}${nameInfo}\n  (??: ${result.newSessionId.slice(0, 8)})\n????????...`,
      }))

      // Auto-switch to the new session
      if (ctx.onSessionSwitch) {
        const res = ctx.onSessionSwitch(result.newSessionId)
        if (!res.ok) {
          pushStatic(createLogEntry({ type: 'system', content: `? Fork ??????????: ${res.error ?? '????'}\n? /resume ${result.newSessionId.slice(0, 8)} ?????\n?? ID: ${result.newSessionId}` }))
        } else {
          pushStatic(createLogEntry({
            type: 'system',
            content: `? ???? fork ?? (${result.newSessionId.slice(0, 8)})?\n?? ID: ${result.newSessionId}\n????????? /branch back ???`,
          }))
        }
      } else {
        pushStatic(createLogEntry({ type: 'system', content: `? Fork ????\n? /resume ${result.newSessionId.slice(0, 8)} ?????\n?? ID: ${result.newSessionId}` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/branch',
    description: 'Show or switch session branches',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // /branch            ? show branch tree for current session
      // /branch list       ? same
      // /branch back       ? switch back to parent session
      const sub = parts[1]?.toLowerCase()
      const sessionDir = getSessionDir(ctx.agent.cwd)

      if (sub === 'back') {
        // Read current session's parentSessionId from meta.json
        const metaPath = join(sessionDir, `${ctx.currentSessionId}.meta.json`)
        if (!existsSync(metaPath)) {
          pushStatic(createLogEntry({ type: 'system', content: '???????????????????' }))
          setIsStreaming(false)
          return true
        }
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
          if (!meta.parentSessionId) {
            pushStatic(createLogEntry({ type: 'system', content: '??????????' }))
            setIsStreaming(false)
            return true
          }
          if (ctx.onSessionSwitch) {
            const res = ctx.onSessionSwitch(meta.parentSessionId)
            if (!res.ok) {
              pushStatic(createLogEntry({ type: 'system', content: `????????: ${res.error ?? '????'}` }))
            } else {
              pushStatic(createLogEntry({ type: 'system', content: `?? ??????? (${meta.parentSessionId.slice(0, 8)})?\n?? ID: ${meta.parentSessionId}` }))
            }
          } else {
            pushStatic(createLogEntry({ type: 'system', content: `???: ${meta.parentSessionId}\n? /resume ${meta.parentSessionId.slice(0, 8)} ???` }))
          }
        } catch {
          pushStatic(createLogEntry({ type: 'system', content: '?????????????' }))
        }
        setIsStreaming(false)
        return true
      }

      // Default: /branch or /branch list ? show branch tree
      const lines: string[] = ['???', '????????']

      // Check if current session has a parent
      const currentMetaPath = join(sessionDir, `${ctx.currentSessionId}.meta.json`)
      if (existsSync(currentMetaPath)) {
        try {
          const meta = JSON.parse(readFileSync(currentMetaPath, 'utf-8'))
          if (meta.parentSessionId) {
            const parentMetaPath = join(sessionDir, `${meta.parentSessionId}.meta.json`)
            let parentLabel = meta.parentSessionId
            if (existsSync(parentMetaPath)) {
              const parentMeta = JSON.parse(readFileSync(parentMetaPath, 'utf-8'))
              if (parentMeta.title) parentLabel += ` "${parentMeta.title}"`
              if (parentMeta.branchName) parentLabel += ` (${parentMeta.branchName})`
            }
            lines.push(`?? ???: ${parentLabel}`)
          } else {
            lines.push('?? ???: ? (???)')
          }
          if (meta.branchName) {
            lines.push(`??? ?????: ${meta.branchName}`)
          }
        } catch { /* meta corrupted */ }
      } else {
        lines.push('?? ???: ? (???)')
      }

      // List child branches
      const children = listBranches(sessionDir, ctx.currentSessionId)
      if (children.length > 0) {
        lines.push('', `?? ??? (${children.length}):`)
        for (const child of children) {
          const name = child.branchName ?? '(unnamed)'
          const time = existsSync(join(sessionDir, `${child.sessionId}.meta.json`))
            ? (() => {
                try {
                  const m = JSON.parse(readFileSync(join(sessionDir, `${child.sessionId}.meta.json`), 'utf-8'))
                  return m.createdAt ? new Date(m.createdAt).toLocaleString() : ''
                } catch { return '' }
              })()
            : ''
          lines.push(`  ?? ${child.sessionId} "${name}" ${time}`)
        }
      } else {
        lines.push('', '?? ???: ?')
      }

      lines.push('', '??: /fork [??] ?????, /branch back ?????')
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/sessions',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const list = SessionPersist.formatSessionList(ctx.agent.cwd, ctx.currentSessionId)
      // Enhance with fork annotations: mark sessions that have a parentSessionId
      const sessionDir = getSessionDir(ctx.agent.cwd)
      const mainSessions = SessionPersist.listMainSessions(ctx.agent.cwd)
      const forkAnnotations: string[] = []
      for (const s of mainSessions) {
        const metaPath = join(sessionDir, `${s.id}.meta.json`)
        if (!existsSync(metaPath)) continue
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
          if (meta.parentSessionId) {
            const shortId = s.id.slice(0, 8)
            const shortParent = String(meta.parentSessionId).slice(0, 8)
            const name = meta.branchName ? ` "${meta.branchName}"` : ''
            forkAnnotations.push(`  ${shortId} ? fork from ${shortParent}${name}`)
          }
        } catch { /* skip */ }
      }
      const forkSection = forkAnnotations.length > 0
        ? `\n\n Fork ??:\n${forkAnnotations.join('\n')}`
        : ''
      pushStatic(createLogEntry({
        type: 'system',
        content: `????(???????):\n${list}${forkSection}`,
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/resume',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const arg = parts[1]
      if (!arg) {
        // ?? = ?????????? Claude Code /resume?????????????????
        if (ctx.openSessionPicker) {
          ctx.openSessionPicker()
        } else {
          pushStatic(createLogEntry({ type: 'system', content: '??: /resume <id?? ? ??>?? /sessions ???????' }))
        }
        setIsStreaming(false)
        return true
      }

      // ??(?????)? id ?? ? ????? id?
      const ordered = SessionPersist.listMainSessions(ctx.agent.cwd)
      let targetId: string | null = null
      if (/^\d+$/.test(arg)) {
        const idx = parseInt(arg, 10) - 1
        if (idx < 0 || idx >= ordered.length) {
          pushStatic(createLogEntry({ type: 'system', content: `??????(? ${ordered.length} ???)?? /sessions ???` }))
          setIsStreaming(false)
          return true
        }
        targetId = ordered[idx]!.id
      } else {
        const resolved = SessionPersist.resolveSessionId(ctx.agent.cwd, arg)
        if (!resolved) {
          pushStatic(createLogEntry({ type: 'system', content: `???????: "${arg}"?? /sessions ???????` }))
          setIsStreaming(false)
          return true
        }
        if ('ambiguous' in resolved) {
          const cands = resolved.ambiguous.map(id => `  ${id.slice(0, 12)}`).join('\n')
          pushStatic(createLogEntry({ type: 'system', content: `?? "${arg}" ??????,??????:\n${cands}` }))
          setIsStreaming(false)
          return true
        }
        targetId = resolved.id
      }

      if (targetId === ctx.currentSessionId) {
        pushStatic(createLogEntry({ type: 'system', content: `????? ${targetId.slice(0, 8)} ??` }))
        setIsStreaming(false)
        return true
      }

      // ???????(Phase 4):??id = ??id = pointer id ???
      if (ctx.onSessionSwitch) {
        const res = ctx.onSessionSwitch(targetId)
        if (!res.ok) {
          pushStatic(createLogEntry({ type: 'system', content: `????: ${res.error ?? '????'}` }))
        } else {
          pushStatic(createLogEntry({
            type: 'system',
            content: `?? ?????? ${targetId.slice(0, 8)}: ?? ${res.messageCount ?? 0} ???(???????)${res.repaired ? ' ? ?????????' : ''}?`,
          }))
        }
        setIsStreaming(false)
        return true
      }

      // Fallback:??????????????(????,???)?
      const p = new SessionPersist(targetId, ctx.agent.cwd)
      const preflight = runResumePreflightOai(p.loadOai())
      ctx.session.replaceMessages(preflight.messages)
      ctx.agent.config.promptEngine.resetAppendixBaseline()
      if (preflight.repaired) p.compactOai(preflight.messages)
      pushStatic(createLogEntry({ type: 'system', content: `????? ${targetId.slice(0, 8)} (${preflight.messages.length} ???, apiSafe=${preflight.safe})` }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/context',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const args = parts.slice(1).join(' ').trim()
      if (args.startsWith('pin ')) {
        const text = args.slice(4).trim()
        if (text) {
          ctx.agent.addAnchor('user_preference', text)
          pushStatic(createLogEntry({ type: 'system', content: `Pinned: "${text}"` }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /context pin <text>' }))
        }
        setIsStreaming(false)
        return true
      }

      if (args.startsWith('claims')) {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const statusArg = args.slice(7).trim()
        const validStatuses = ['active', 'stale', 'conflicted', 'durable']
        if (statusArg && !validStatuses.includes(statusArg)) {
          pushStatic(createLogEntry({ type: 'system', content: `Usage: /context claims [${validStatuses.join('|')}]` }))
          setIsStreaming(false)
          return true
        }
        const output = formatContextClaimsCommand(store, statusArg as ContextClaimStatus | undefined)
        pushStatic(createLogEntry({ type: 'system', content: output }))
        setIsStreaming(false)
        return true
      }

      if (args === 'antibodies') {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const antibodies = store.listClaims({ kind: ['failure_pattern'], status: ['active', 'durable_candidate', 'durable'] })
        if (antibodies.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: 'No active antibodies.' }))
          setIsStreaming(false)
          return true
        }
        const lines = antibodies.map(c => {
          const tag = c.tags.filter(t => t !== 'antibody')[0] ?? c.kind
          return `  [${tag}] ${c.text.slice(0, 80)}`
        })
        pushStatic(createLogEntry({ type: 'system', content: `Antibodies (${antibodies.length}):\n${lines.join('\n')}` }))
        setIsStreaming(false)
        return true
      }

      if (args === 'conflicts') {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const conflicted = store.listClaims({ status: ['conflicted'] })
        if (conflicted.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: 'No conflicted claims.' }))
          setIsStreaming(false)
          return true
        }
        const lines = conflicted.map(c => `  [${c.id.slice(0, 8)}] ${c.text.slice(0, 80)}`)
        pushStatic(createLogEntry({ type: 'system', content: `Conflicts (${conflicted.length}):\n${lines.join('\n')}` }))
        setIsStreaming(false)
        return true
      }

      if (args === 'reload') {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        // Stale existing project_rule claims so deleted rule files are cleaned up
        const existing = store.listClaims({ kind: ['project_rule'] })
        for (const c of existing) {
          store.updateClaimStatus(c.id, 'stale', 'reload: rules directory refreshed')
        }
        const proposals = loadProjectRules(process.cwd())
        let loaded = 0
        for (const p of proposals) {
          store.propose(p)
          loaded++
        }
        pushStatic(createLogEntry({ type: 'system', content: `Reloaded ${loaded} project rules from .rivet/rules/ (${existing.length} previous rules cleared)` }))
        setIsStreaming(false)
        return true
      }

      if (args === 'export') {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const outPath = join(exportsDir(), `${timestamp}.json`)
        const count = exportDurableClaims(store, outPath)
        pushStatic(createLogEntry({ type: 'system', content: `Exported ${count} durable claims to ${outPath}` }))
        setIsStreaming(false)
        return true
      }

      if (args.startsWith('import ')) {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const filePath = args.slice('import '.length).trim()
        const count = importClaims(store, filePath)
        pushStatic(createLogEntry({ type: 'system', content: count > 0 ? `Imported ${count} claims (confidence ?0.8)` : `No claims imported. Check file path: ${filePath}` }))
        setIsStreaming(false)
        return true
      }

      const ledger = ctx.session.getContextLedger()
      if (!ledger) {
        pushStatic(createLogEntry({ type: 'system', content: 'Context ledger not available yet. Send a message to build the first ledger snapshot.' }))
        setIsStreaming(false)
        return true
      }

      const sections = ledger.tokenBudget
      const diagnostics = ledger.apiInvariantStatus.brokenRounds === 0
        ? 'API rounds: safe'
        : `? ${ledger.apiInvariantStatus.brokenRounds} broken rounds`
      const compacts = ctx.session.getCompactEvents()
      const compactStr = compacts.length === 0
        ? 'No compact events.'
        : compacts.slice(-5).map(e => `- turn ${e.turn}: tier ${e.tier}, ${e.beforeTokens}?${e.afterTokens}`).join('\n')

      const anchorLines = ledger.anchors.length > 0
        ? `\n\nPinned Anchors:\n${ledger.anchors.map(a => `  [${a.kind}] ${a.text.slice(0, 60)}`).join('\n')}`
        : ''

      // ??????cache ??? + ?? cost?? GlanceBar ?????? Claude Code /context?
      const usagePct = sections.maxTokens > 0 ? Math.round(sections.estimatedTokens / sections.maxTokens * 100) : 0
      const cacheStr = ctx.cacheHitRate !== undefined ? `${Math.round(ctx.cacheHitRate * 100)}%` : 'n/a'
      const costStr = `?${(ctx.cost ?? 0).toFixed(2)}`
      const realTokens = ctx.session.getLastRealPromptTokens()
      const realStr = realTokens > 0 ? `\nAPI (last): ${realTokens.toLocaleString()} tokens` : ''

      // Recall visibility: compacted history can be pulled back verbatim via
      // read_section. Surface how often that happened this session (observe-only).
      const recall = ctx.agent.getRecallSummary?.()
      const recallStr = recall && recall.totalRecalls > 0
        ? `\nRecall: ${recall.totalRecalls} recalls / ${recall.uniqueArtifacts} archives${recall.avgTurnDistance !== null ? `, avg ${Math.round(recall.avgTurnDistance)} turns back` : ''}`
        : ''

      pushStatic(createLogEntry({
        type: 'system',
        content: `Context: ${sections.compactionState}\nTokens (est): ${sections.estimatedTokens.toLocaleString()}/${sections.maxTokens.toLocaleString()} (${usagePct}%)${realStr}${recallStr}\nCache hit: ${cacheStr}    Cost: ${costStr}\nRounds: ${ledger.rounds.length}\n${diagnostics}\n\nCompaction:\n${compactStr}${anchorLines}`,
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/verify',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const verify = formatVerificationStatus(ctx.agent)
      const recovery = renderRecoveryStack(process.cwd())
      pushStatic(createLogEntry({ type: 'system', content: `${verify}\n\n${recovery}` }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/memory',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const subcmd = parts[1]
      const text = parts.slice(2).join(' ').trim()
      if (!subcmd) {
        pushStatic(createLogEntry({ type: 'system', content: formatMemoryOverview(ctx) }))
      } else if (subcmd === 'add') {
        if (!text) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /memory add <content>', isError: true }))
        } else {
          const file = appendProjectKnowledge(text)
          pushStatic(createLogEntry({ type: 'system', content: `Saved to project knowledge: ${file}` }))
        }
      } else if (subcmd === 'search') {
        if (!text) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /memory search <query>', isError: true }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: searchMemory(ctx, text) }))
        }
      } else if (subcmd === 'forget') {
        pushStatic(createLogEntry({ type: 'system', content: 'Forget is not yet destructive in Wave 1. Use the displayed memory id/file to remove manually for now.' }))
      } else {
        const legacyText = parts.slice(1).join(' ').trim()
        ctx.persist.appendMemory({ text: legacyText, source: 'manual', createdAt: Date.now() })
        ctx.agent.updateSessionMemory(ctx.persist.buildMemoryBlock())
        pushStatic(createLogEntry({ type: 'system', content: 'Saved to session memory.' }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/mcp',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const subcmd = parts[0]?.toLowerCase() ?? 'status'
      const serverId = parts[1]

      if (subcmd === 'auth' && serverId) {
        try {
          const { startMcpOAuth } = await import('../mcp/oauth/connector.js')
          const { findMcpOAuthProvider } = await import('../mcp/oauth/providers.js')
          const { loadConfig } = await import('../config/manager.js')
          const cfg = loadConfig().mcp?.servers[serverId]
          if (!cfg) {
            pushStatic(createLogEntry({ type: 'system', content: `MCP server "${serverId}" not found in config.`, isError: true }))
            setIsStreaming(false)
            return true
          }
          const auth = cfg.auth
          if (!auth || auth.type !== 'oauth') {
            pushStatic(createLogEntry({ type: 'system', content: `Server "${serverId}" does not support OAuth.`, isError: true }))
            setIsStreaming(false)
            return true
          }
          const provider = findMcpOAuthProvider(auth.provider)
          if (!provider) {
            pushStatic(createLogEntry({ type: 'system', content: `Unknown OAuth provider: ${auth.provider}`, isError: true }))
            setIsStreaming(false)
            return true
          }
          const clientId = process.env.RIVET_MCP_OAUTH_CLIENT_ID ?? ''
          if (!clientId) {
            pushStatic(createLogEntry({ type: 'system', content: 'Set RIVET_MCP_OAUTH_CLIENT_ID env var with your OAuth app client ID, then retry.', isError: true }))
            setIsStreaming(false)
            return true
          }
          pushStatic(createLogEntry({ type: 'system', content: `Starting OAuth for ${serverId} (${provider.name})...\nA browser window should open shortly.` }))
          try {
            const scopes = [...provider.defaultScopes, ...(auth.scopes ?? [])]
            await startMcpOAuth(serverId, provider, clientId, scopes)
            pushStatic(createLogEntry({ type: 'system', content: `? OAuth connected for ${serverId} (${provider.name})` }))
          } catch (err) {
            pushStatic(createLogEntry({ type: 'system', content: `OAuth failed: ${(err as Error).message}`, isError: true }))
          }
        } catch (err) {
          pushStatic(createLogEntry({ type: 'system', content: `OAuth failed: ${(err as Error).message}`, isError: true }))
        }
        setIsStreaming(false)
        return true
      }

      if (subcmd === 'logs' && serverId) {
        try {
          const mgr = ctx.mcpManagerRef?.current
          if (!mgr) {
            pushStatic(createLogEntry({ type: 'system', content: 'MCP manager not initialized.', isError: true }))
            setIsStreaming(false)
            return true
          }
          const tail = Number.parseInt(parts[2] ?? '100', 10) || 100
          const entries = mgr.getLogs(serverId, tail)
          if (entries.length === 0) {
            pushStatic(createLogEntry({ type: 'system', content: `No log entries for server "${serverId}".` }))
          } else {
            const lines = entries.map((entry) => `[${new Date(entry.ts).toISOString()}] ${entry.stream === 'stderr' ? 'stderr' : 'event'}: ${entry.text.trimEnd()}`)
            pushStatic(createLogEntry({ type: 'system', content: `Logs for ${serverId} (last ${entries.length} entries):\n${lines.join('\n')}` }))
          }
        } catch (err) {
          pushStatic(createLogEntry({ type: 'system', content: `Logs failed: ${(err as Error).message}`, isError: true }))
        }
        setIsStreaming(false)
        return true
      }

      // Default: show status
      pushStatic(createLogEntry({ type: 'system', content: 'Usage:\n  /mcp ? show status\n  /mcp auth <serverId> ? start OAuth flow\n  /mcp logs <serverId> [tail] ? view stderr log buffer' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/todo',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const { getTodos, setTodos } = await import('../tools/todo.js')
      const { TodoStore } = await import('../tools/todo-store.js')
      const subcmd = parts[1]
      const arg = parts.slice(2).join(' ').trim()
      const todos = getTodos()

      if (!subcmd || subcmd === 'list') {
        // List current todos
        const text = todos.length === 0
          ? 'No todos. The agent will create tasks via the todo tool.'
          : TodoStore.formatList(todos)
        pushStatic(createLogEntry({ type: 'system', content: text }))
      } else if (subcmd === 'add') {
        if (!arg) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /todo add <content>', isError: true }))
        } else {
          const id = `user-${Date.now().toString(36)}`
          setTodos([...todos, { id, content: arg, status: 'pending' as const }])
          pushStatic(createLogEntry({ type: 'system', content: `Added: ? [${id}] ${arg}` }))
        }
      } else if (subcmd === 'done') {
        const item = todos.find(t => t.id === arg || t.id.startsWith(arg))
        if (!item) {
          pushStatic(createLogEntry({ type: 'system', content: `No todo matching "${arg}". Use /todo list to see ids.`, isError: true }))
        } else {
          setTodos(todos.map(t => t.id === item.id ? { ...t, status: 'completed' as const } : t))
          pushStatic(createLogEntry({ type: 'system', content: `? Done: ${item.content}` }))
        }
      } else if (subcmd === 'skip') {
        const item = todos.find(t => t.id === arg || t.id.startsWith(arg))
        if (!item) {
          pushStatic(createLogEntry({ type: 'system', content: `No todo matching "${arg}". Use /todo list to see ids.`, isError: true }))
        } else {
          // Remove the item entirely (skip = don't do it)
          setTodos(todos.filter(t => t.id !== item.id))
          pushStatic(createLogEntry({ type: 'system', content: `? Skipped: ${item.content}` }))
        }
      } else if (subcmd === 'move') {
        const id = parts[2]
        const dir = parts[3] // 'up' or 'down'
        if (!id || (dir !== 'up' && dir !== 'down')) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /todo move <id> <up|down>', isError: true }))
        } else {
          const idx = todos.findIndex(t => t.id === id || t.id.startsWith(id))
          if (idx === -1) {
            pushStatic(createLogEntry({ type: 'system', content: `No todo matching "${id}".`, isError: true }))
          } else {
            const swapWith = dir === 'up' ? idx - 1 : idx + 1
            if (swapWith < 0 || swapWith >= todos.length) {
              pushStatic(createLogEntry({ type: 'system', content: 'Already at edge.' }))
            } else {
              const next = [...todos]
              ;[next[idx], next[swapWith]] = [next[swapWith]!, next[idx]!]
              setTodos(next)
              pushStatic(createLogEntry({ type: 'system', content: `Moved ${dir}: ${todos[idx]!.content}` }))
            }
          }
        }
      } else {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /todo [list|add <content>|done <id>|skip <id>|move <id> <up|down>]' }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/mission',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const snapshot = ctx.agent.getCognitiveSnapshot?.()
      const strip = formatMissionStrip(snapshot)
      pushStatic(createLogEntry({ type: 'system', content: strip ? `Mission\n\n${strip}` : 'Mission\n\nNo actionable task contract is active.' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-template',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const cwd = ctx.agent.cwd ?? process.cwd()
      const sub = parts[1]
      const { loadPlanTemplates, getPlanTemplate, savePlanTemplate, formatTemplateList } = await import('../agent/plan-templates.js')

      if (!sub || sub === 'list') {
        const templates = loadPlanTemplates(cwd)
        pushStatic(createLogEntry({ type: 'system', content: formatTemplateList(templates) }))
      } else if (sub === 'save') {
        const name = parts[2]
        const description = parts.slice(3).join(' ').trim()
        if (!name) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /plan-template save <name> [description]', isError: true }))
        } else {
          // Save current plan (if any) as template
          const { getStoredPlan } = await import('../agent/plan-store.js')
          const currentPlan = getStoredPlan(ctx.currentSessionId)
          if (!currentPlan) {
            pushStatic(createLogEntry({ type: 'system', content: 'No active plan to save. Run /plan first.', isError: true }))
          } else {
            savePlanTemplate(cwd, name, `\`\`\`json\n${currentPlan}\n\`\`\`\n`, description)
            pushStatic(createLogEntry({ type: 'system', content: `? Saved template "${name}" to .rivet/plan-templates/${name}.md` }))
          }
        }
      } else {
        // Treat as template name to load
        const tpl = getPlanTemplate(cwd, sub)
        if (!tpl) {
          pushStatic(createLogEntry({ type: 'system', content: `Template "${sub}" not found. Use /plan-template list to see available templates.`, isError: true }))
        } else {
          pushStatic(createLogEntry({
            type: 'system',
            content: `Loaded template: ${tpl.name}\n${tpl.description ? tpl.description + '\n' : ''}${tpl.estimatedWaves ? `Estimated waves: ${tpl.estimatedWaves}\n` : ''}\n${tpl.content}\n\n? Use /plan to refine, or /team to execute.`,
          }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/workflow',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const cwd = ctx.agent.cwd ?? process.cwd()
      const sub = parts[1]
      const { listWorkflows, loadWorkflow, listTraces, loadTrace, formatTrace, parseWorkflow } = await import('../agent/workflow-runner.js')

      if (!sub || sub === 'list') {
        const names = listWorkflows(cwd)
        const text = names.length === 0
          ? 'No workflows. Create one in .rivet/workflows/*.yaml'
          : `Available workflows:\n\n${names.map(n => `  ${n}`).join('\n')}\n\nUse: /workflow <name> to execute.`
        pushStatic(createLogEntry({ type: 'system', content: text }))
      } else if (sub === 'replay') {
        const traceId = parts[2]
        if (!traceId) {
          const traces = listTraces(cwd, 10)
          const text = traces.length === 0
            ? 'No traces available.'
            : `Recent traces:\n\n${traces.map(t => `  ${t.traceId} ? ${t.workflowName} (${t.finalStatus})`).join('\n')}\n\nUse: /workflow replay <id> to view.`
          pushStatic(createLogEntry({ type: 'system', content: text }))
        } else {
          const trace = loadTrace(cwd, traceId)
          if (!trace) {
            pushStatic(createLogEntry({ type: 'system', content: `Trace "${traceId}" not found.`, isError: true }))
          } else {
            pushStatic(createLogEntry({ type: 'system', content: formatTrace(trace) }))
          }
        }
      } else {
        // Execute workflow by name
        const wf = loadWorkflow(cwd, sub)
        if (!wf) {
          pushStatic(createLogEntry({ type: 'system', content: `Workflow "${sub}" not found. Use /workflow list to see available workflows.`, isError: true }))
        } else {
          pushStatic(createLogEntry({
            type: 'system',
            content: `? Workflow "${wf.name}" loaded (${wf.steps.length} steps).\n${wf.description ?? ''}\n\n? Type your objective to execute, or /cancel to abort.`,
          }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/constellation',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const cwd = ctx.agent.cwd ?? process.cwd()
      const sub = (parts[1] ?? 'view').toLowerCase()
      const now = Date.now()

      if (sub === 'init') {
        const skeleton = surveySkeleton(cwd)
        const c = initConstellation(cwd, { skeleton, sessionId: ctx.currentSessionId }, now)
        pushStatic(createLogEntry({
          type: 'system',
          content: `Constellation initialized for ${c.name}\n\n${formatConstellationView(c, { now })}`,
        }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'shift') {
        const summary = parts.slice(2).join(' ').trim() || 'skeleton re-surveyed'
        const skeleton = surveySkeleton(cwd)
        const c = initConstellation(cwd, { skeleton, sessionId: ctx.currentSessionId, shiftSummary: summary }, now)
        pushStatic(createLogEntry({
          type: 'system',
          content: `Architecture shift recorded (${c.architectureShifts.length} total): ${summary}`,
        }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'update') {
        const summary = parts.slice(2).join(' ').trim()
        if (!summary) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /constellation update <summary> ? records a milestone for current changes.' }))
          setIsStreaming(false)
          return true
        }
        const dirty = await collectDirtyFiles(cwd)
        const domain = ctx.agent.getSessionDomain()?.id ?? ''
        const milestone = extractMilestone({
          sessionId: ctx.currentSessionId,
          agentMark: buildAgentMark({ symbol: VOID_SYMBOL, domain }),
          domain,
          chronicleEntries: [{ type: 'milestone', turn: 0, timestamp: now, summary, files: dirty }],
          cycleClose: shortHash(`${ctx.currentSessionId}:${now}`),
          now,
          force: true,
        })
        if (!milestone) {
          pushStatic(createLogEntry({ type: 'system', content: 'Nothing to record.' }))
          setIsStreaming(false)
          return true
        }
        appendMilestone(cwd, milestone, now)
        pushStatic(createLogEntry({ type: 'system', content: `Milestone recorded: ${milestone.summary} (${milestone.filesChanged.length} files)` }))
        setIsStreaming(false)
        return true
      }

      const c = loadConstellation(cwd)
      if (!c) {
        pushStatic(createLogEntry({ type: 'system', content: 'No constellation yet. Use /constellation init to survey this project.' }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'history') {
        pushStatic(createLogEntry({ type: 'system', content: formatConstellationHistory(c, { now }) }))
        setIsStreaming(false)
        return true
      }

      // default: view
      pushStatic(createLogEntry({ type: 'system', content: formatConstellationView(c, { now }) }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/leave',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // User-triggered departure ritual: seal a mark into the starmap now.
      // First token may be a single-glyph symbol; the rest is the summary.
      const cwd = ctx.agent.cwd ?? process.cwd()
      const now = Date.now()
      const rest = parts.slice(1)
      let symbol = VOID_SYMBOL
      let summaryParts = rest
      if (rest.length > 0 && [...rest[0]!].length <= 2) {
        symbol = rest[0]!
        summaryParts = rest.slice(1)
      }
      const summary = summaryParts.join(' ').trim()
      if (!summary) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /leave [symbol] <summary> ? leave your mark in the starmap as you depart.' }))
        setIsStreaming(false)
        return true
      }
      const domain = ctx.agent.getSessionDomain()?.id ?? ''
      const dirty = await collectDirtyFiles(cwd)
      const milestone = buildDepartureMilestone({
        sessionId: ctx.currentSessionId,
        agentMark: buildAgentMark({ symbol, domain }),
        domain,
        summary,
        filesChanged: dirty,
        now,
      })
      appendMilestone(cwd, milestone, now)
      pushStatic(createLogEntry({
        type: 'system',
        content: `? Mark ${milestone.agentMark.symbol} sealed into the starmap.\n${milestone.summary}`,
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/undo',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const fh = ctx.agent.getFileHistory()
      if (!fh) {
        pushStatic(createLogEntry({ type: 'system', content: 'Undo not available (no file history).' }))
        setIsStreaming(false)
        return true
      }
      const snapshots = fh.getAllSnapshots()
      if (snapshots.length === 0) {
        pushStatic(createLogEntry({ type: 'system', content: 'No undo history yet.' }))
        setIsStreaming(false)
        return true
      }
      const arg = parts[1]
      if (arg && /^\d+$/.test(arg)) {
        const idx = parseInt(arg, 10) - 1
        if (idx < 0 || idx >= snapshots.length) {
          pushStatic(createLogEntry({ type: 'system', content: `Invalid index. History has ${snapshots.length} entries (1-${snapshots.length}).` }))
          setIsStreaming(false)
          return true
        }
        const target = snapshots[idx]!
        const pinnedPush = pushStatic
        fh.rewind(target.messageId).then(
          restored => pinnedPush(createLogEntry({ type: 'system', content: `Undo complete. Restored files: ${restored.join(', ') || '(none)'}` })),
          err => pinnedPush(createLogEntry({ type: 'system', content: `Undo failed: ${(err as Error).message}` })),
        )
        pushStatic(createLogEntry({ type: 'system', content: `Undoing snapshot #${idx + 1}...` }))
      } else if (arg === 'preview' || arg === 'p') {
        const previewIdx = parts[2] ? parseInt(parts[2], 10) - 1 : snapshots.length - 1
        if (previewIdx < 0 || previewIdx >= snapshots.length) {
          pushStatic(createLogEntry({ type: 'system', content: `Invalid index. History has ${snapshots.length} entries.` }))
          setIsStreaming(false)
          return true
        }
        const target = snapshots[previewIdx]!
        const files = Object.keys(target.trackedFileBackups)
        const detail = files.map(f => `  ${f}`).join('\n')
        pushStatic(createLogEntry({ type: 'system', content: `Undo preview #${previewIdx + 1} [${target.messageId.slice(0, 8)}]:\n${detail || '(no files)'}\n\nUse /undo ${previewIdx + 1} to revert.` }))
      } else {
        const recent = snapshots.slice(-10).reverse()
        const lines = recent.map((s, i) => {
          const n = snapshots.length - i
          const files = Object.keys(s.trackedFileBackups).join(', ')
          return `  ${n}. [${s.messageId.slice(0, 8)}] ${files || '(no files)'}`
        })
        pushStatic(createLogEntry({ type: 'system', content: `Undo history (${snapshots.length} total):\n${lines.join('\n')}\n\nUse /undo <number> to revert, /undo preview <number> to inspect.` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/team-resume',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cwd = ctx.agent.cwd ?? process.cwd()
      const { listCheckpoints, formatCheckpointList, loadCheckpoint, buildResumeFromCheckpoint } = await import('../agent/wave-checkpoint.js')
      const groupId = parts[1]

      if (!groupId) {
        const checkpoints = listCheckpoints(cwd)
        pushStatic(createLogEntry({ type: 'system', content: formatCheckpointList(checkpoints) }))
        setIsStreaming(false)
        return true
      }
      const cp = loadCheckpoint(cwd, groupId)
      if (!cp) {
        pushStatic(createLogEntry({ type: 'system', content: `No checkpoint found for "${groupId}".`, isError: true }))
        setIsStreaming(false)
        return true
      }
      // A2: real resume ? rebuild the remaining tasks into a stored plan and
      // kick the master so it re-dispatches via team_orchestrate.
      const resume = buildResumeFromCheckpoint(cp)
      if (!resume) {
        pushStatic(createLogEntry({
          type: 'system',
          content: `Checkpoint ${cp.groupId} has no remaining tasks (wave ${cp.lastCompletedWave + 1}/${cp.totalWaves} was the last).\n?????????????????????????checkpoint ????????`,
        }))
        setIsStreaming(false)
        return true
      }
      if (!ctx.submitToAgent) {
        pushStatic(createLogEntry({ type: 'system', content: 'Resume unavailable: agent submission channel missing.', isError: true }))
        setIsStreaming(false)
        return true
      }
      const { storePlan } = await import('../agent/plan-store.js')
      storePlan(resume.planJson)
      pushStatic(createLogEntry({
        type: 'system',
        content: `?? Resuming ${cp.groupId}: ${cp.remainingOrders.length} tasks re-planned (objective: ${cp.objective.slice(0, 80)}). Dispatching to master?`,
      }))
      setIsStreaming(false)
      ctx.submitToAgent(resume.prompt)
      return true
    },
  },
  {
    name: '/cockpit',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const subcmd = parts[1] as Panel | 'off' | undefined
      if (subcmd === 'off') {
        ctx.surfacePop?.()
        pushStatic(createLogEntry({ type: 'system', content: 'Cockpit panel collapsed.' }))
      } else if (subcmd && subcmd in PANEL_LABELS) {
        ctx.setCockpitPanel(subcmd as Panel)
        ctx.surfacePush?.('cockpit')
        pushStatic(createLogEntry({ type: 'system', content: `Cockpit: ${PANEL_LABELS[subcmd as Panel]} panel. /cockpit off to collapse.` }))
      } else {
        const wasOpen = ctx.activeOverlay === 'cockpit'
        if (wasOpen) {
          ctx.surfacePop?.()
        } else {
          ctx.setCockpitPanel('summary')
          ctx.surfacePush?.('cockpit')
        }
        pushStatic(createLogEntry({ type: 'system', content: wasOpen ? 'Cockpit panel collapsed.' : `Cockpit: ${PANEL_LABELS['summary']} panel. /cockpit off to collapse.` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/scroll',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      ctx.surfacePush?.('pager')
      pushStatic(createLogEntry({ type: 'system', content: 'Scrollback pager opened. Press q or Esc to close.' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/effort',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming, surfacePush } = ctx
      const cmd = parts[0]!.toLowerCase()
      const level = parts[1]?.toLowerCase() as 'off' | 'low' | 'medium' | 'high' | 'max' | 'auto' | undefined
      const valid: Array<'off' | 'low' | 'medium' | 'high' | 'max' | 'auto'> = ['off', 'low', 'medium', 'high', 'max', 'auto']
      if (!level) {
        // ??? ? ????????????????????
        surfacePush?.('choice-panel')
        setIsStreaming(false)
        return true
      }
      if ((valid as string[]).includes(level)) {
        ctx.setReasoningEffort?.(level)
        pushStatic(createLogEntry({ type: 'system', content: level === 'auto'
          ? 'Reasoning effort: auto (autoReasoning picks per task)'
          : `Reasoning effort set to: ${level}` }))
      } else {
        pushStatic(createLogEntry({ type: 'system', content: `Usage: /effort [off|low|medium|high|max|auto]\n\nSet max for full reasoning on every turn. auto lets autoReasoning pick per-task complexity.` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/yes',
    immediate: true,
    handler(ctx) {
      // ?? YOLO ????/permission ????????????????????????
      // /yes / /yes on ? YOLO?/yes off ? ?? Auto????????????????
      const { parts, agent, pushStatic, setIsStreaming } = ctx
      const arg = parts[1]?.toLowerCase()
      if (arg === 'off') {
        agent.setApprovalMode('auto-safe')
        agent.config.maxTurns = 200
        ctx.setAutoSafe(true)
        ctx.persistApprovalMode?.('auto-safe')
        pushStatic(createLogEntry({ type: 'system', content: '? ??? YOLO??? Auto ? ?/???????????????????????????' }))
        setIsStreaming(false)
        return true
      }
      agent.setApprovalMode('dangerously-skip-permissions')
      agent.config.maxTurns = 0
      ctx.setAutoSafe(false)
      ctx.persistApprovalMode?.('dangerously-skip-permissions')
      pushStatic(createLogEntry({ type: 'system', content: '? YOLO ??? ? ??????????????????????????????????: /yes off ? ??: /rollback' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/interview',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const topic = parts.slice(1).join(' ').trim()
      if (!topic) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /interview <topic>\nExample: /interview add a notification system' }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/plan',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const feature = parts.slice(1).join(' ').trim()
      if (!feature) {
        pushStatic(createLogEntry({ type: 'system', content: `Usage: ${cmd} <feature>\n       /plan close <docs/superpowers/plans/file.md> --tasks <1-7|all> [--preview]\nExample: ${cmd} add Context7 MCP preset` }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/write-plan',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const feature = parts.slice(1).join(' ').trim()
      if (!feature) {
        pushStatic(createLogEntry({ type: 'system', content: `Usage: ${cmd} <feature>\n       /plan close <docs/superpowers/plans/file.md> --tasks <1-7|all> [--preview]\nExample: ${cmd} add Context7 MCP preset` }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/skill',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()

      // Single source of truth: the shared skillRegistry (loaded at bootstrap
      // from .rivet/skills only ? external .claude dirs are never scanned in
      // place; designated skills are copied in via importFromClaude). No
      // re-scan, no truncation ? same Tier-1/Tier-2 model the model uses.
      const sourceTag = (source?: string): string =>
        source === 'global-claude' ? '??' : '??'
      const allSkills = skillRegistry.list()

      // ?? Auto-distilled draft review (human-in-loop) ??
      if (sub === 'review' || sub === 'drafts') {
        const drafts = listSkillDrafts(ctx.agent.cwd)
        if (drafts.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: '?????? skill ???\n?????,???????????????? .rivet/skills/_drafts/?' }))
        } else {
          const lines = drafts.map(d => `  ?? ${d.name} ? ${(d.description || '(no description)').slice(0, 120)}`)
          pushStatic(createLogEntry({ type: 'system', content: `??? skill ?? (${drafts.length}):\n${lines.join('\n')}\n\n/skill approve <name> ??  ?  /skill reject <name> ??` }))
        }
        setIsStreaming(false)
        return true
      }

      if (sub === 'approve') {
        const name = parts[2]
        if (!name) {
          pushStatic(createLogEntry({ type: 'system', content: '??: /skill approve <name>(? /skill review ????)' }))
          setIsStreaming(false)
          return true
        }
        const res = approveSkillDraft(ctx.agent.cwd, name)
        if (res.ok && res.skill) {
          // Do NOT hot-load into the live registry: changing the available-skill
          // set mid-session shatters the prefix cache (cost can be tens of times
          // higher). The draft is persisted to disk; it takes effect on next session.
          pushStatic(createLogEntry({ type: 'system', content: `? ??? skill: ${res.skill.name} ? .rivet/skills/\n? ????????:????????????????,????????` }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: `? ????: ${res.error ?? 'unknown error'}` }))
        }
        setIsStreaming(false)
        return true
      }

      if (sub === 'reject') {
        const name = parts[2]
        if (!name) {
          pushStatic(createLogEntry({ type: 'system', content: '??: /skill reject <name>(? /skill review ????)' }))
          setIsStreaming(false)
          return true
        }
        const ok = rejectSkillDraft(ctx.agent.cwd, name)
        pushStatic(createLogEntry({ type: 'system', content: ok ? `?? ?????: ${name}` : `?? "${name}" ???` }))
        setIsStreaming(false)
        return true
      }

      // /skill off <name> ? manually release an invoked skill so its instructions
      // are no longer re-injected into the dynamic appendix.
      if (sub === 'off' || sub === 'complete') {
        const name = parts[2]
        if (!name) {
          pushStatic(createLogEntry({ type: 'system', content: `??: /skill ${sub} <name>\n???????????????` }))
          setIsStreaming(false)
          return true
        }
        ctx.agent.markSkillCompleted?.(name)
        pushStatic(createLogEntry({ type: 'system', content: `?? ?????: ${name}` }))
        setIsStreaming(false)
        return true
      }

      // /skill install <name> [...] ? copy from .claude/skills/ into .rivet/skills/
      if (sub === 'install' || sub === 'import') {
        const names = parts.slice(2).filter(Boolean)
        if (names.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: `??: /skill ${sub} <name> [name2 ...]\n? .claude/skills/<name> ??? .rivet/skills/<name>?` }))
          setIsStreaming(false)
          return true
        }
        const { copied, skipped, errors } = importSkillsIntoRivet(ctx.agent.cwd, names)
        // Do NOT hot-load into the live registry: changing the available-skill set
        // mid-session shatters the prefix cache (cost can be tens of times higher).
        // Files are copied to disk; they take effect on next session.
        const lines: string[] = []
        if (copied.length > 0) lines.push(`? ???: ${copied.join(', ')}`)
        if (skipped.length > 0) lines.push(`? ???/??: ${skipped.join(', ')}`)
        if (errors.length > 0) lines.push(`? ??:\n${errors.map(e => `  ? ${e}`).join('\n')}`)
        if (copied.length > 0) {
          lines.push('? ????????:????????????????,????????')
          const installed = countInstalledSkills(ctx.agent.cwd)
          if (installed >= RECOMMENDED_MAX_SKILLS) {
            lines.push(`? ??? ${installed} ?,?????? ${RECOMMENDED_MAX_SKILLS}?${SKILL_RESTRAINT_NOTICE}`)
          }
        }
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') || '????' }))
        setIsStreaming(false)
        return true
      }

      if (!sub || sub === 'list' || sub === 'ls') {
        if (allSkills.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: 'No skills found in .rivet/skills/.\nInstall one with:\n  /skill install <name>\nor copy manually:\n  cp -r ~/.claude/skills/<name> .rivet/skills/<name>\nor list it under skills.importFromClaude in config.' }))
        } else {
          const lines = [...allSkills]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(s => {
              const size = s.body.length > 1024 ? `${(s.body.length / 1024).toFixed(1)}KB` : `${s.body.length}B`
              const desc = (s.description || '(no description)').replace(/\s+/g, ' ').slice(0, 120)
              return `  ${sourceTag(s.source)} ${s.name} (${size}) ? ${desc}`
            })
          const draftCount = listSkillDrafts(ctx.agent.cwd).length
          const draftHint = draftCount > 0 ? `\n?? ${draftCount} ?????????? ? /skill review` : ''
          pushStatic(createLogEntry({ type: 'system', content: `Skills (${allSkills.length}):\n${lines.join('\n')}\n\nUse /skill <name> to load a skill's full instructions into the conversation.${draftHint}` }))
        }
        setIsStreaming(false)
        return true
      }

      // /skill <name> ? load the FULL body into the conversation and immediately
      // invoke it as the current prompt. The slash handler just acknowledges the
      // load; the actual body is expanded by resolveAppPromptInput so the agent
      // sees the skill instructions as the user message and responds in this turn.
      const skill = skillRegistry.get(parts[1]!) ?? allSkills.find(s => s.name.toLowerCase() === sub)
      if (!skill) {
        pushStatic(createLogEntry({ type: 'system', content: `Skill "${parts[1]}" not found.\nUse /skill list to see available skills.` }))
        setIsStreaming(false)
        return true
      }

      const sizeKb = (skill.body.length / 1024).toFixed(1)
      const taskHint = parts.slice(2).join(' ').trim()
      pushStatic(createLogEntry({ type: 'system', content: `? Loaded skill: ${skill.name} (${sizeKb}KB from ${skill.source ?? 'rivet'})\nThe full skill instructions are now in the conversation.${taskHint ? `\nUser task: ${taskHint}` : ''}` }))

      // Remember that this skill was invoked so the prompt engine can re-inject
      // its instructions into the dynamic appendix after context compaction.
      ctx.agent.markSkillInvoked?.(skill.name)

      // Fall through to the agent pipeline. resolveAppPromptInput will expand
      // `/skill <name> [...]` into the skill body so the agent responds now.
      return false
    },
  },
  {
    name: '/sensorium',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const snapshot = ctx.agent.getCognitiveSnapshot?.()
      if (!snapshot) {
        pushStatic(createLogEntry({ type: 'system', content: 'Sensorium not available yet. Send a message first to build cognitive state.' }))
        setIsStreaming(false)
        return true
      }
      const s = snapshot
      const sensoriumLines = [
        '?? Sensorium ? ?? 3D ???',
        '',
        `  ????: ${s.contractStatus ?? 'idle'}`,
        `  ??: ${s.objective ?? '(none)'}`,
        `  ????: ${s.scopeFileCount}`,
        `  ?????: ${s.isActionableTask ? 'yes' : 'no'}`,
        `  ????: ${s.hasVerificationGap ? 'WARNING: yes' : 'OK: no'}`,
        `  ????: ${s.deliveryStatus}`,
        '',
        '?????? Immune ???Sycophancy Trap?Doom Loop ?????????',
        '????: /debug [prompt|fingerprint|cache|context-payload]',
      ]
      pushStatic(createLogEntry({ type: 'system', content: sensoriumLines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/index',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // Rebuild codebase index from MeridianDB
      const indexer = ctx.agent.getIndexer?.()
      if (!indexer) {
        pushStatic(createLogEntry({ type: 'system', content: '? MeridianIndexer not available. Index requires better-sqlite3.' }))
        setIsStreaming(false)
        return true
      }
      const db = indexer.getDb()
      const cwd = ctx.agent.cwd ?? process.cwd()

      // Read main.ts and headless.ts for CLI extraction
      let mainTsSource = ''
      let headlessSource: string | null = null
      const mainTsPath = 'src/main.ts'
      const headlessPath = 'src/headless.ts'
      try {
        mainTsSource = readFileSync(join(cwd, mainTsPath), 'utf-8')
      } catch { /* not found */ }
      try {
        headlessSource = readFileSync(join(cwd, headlessPath), 'utf-8')
      } catch { /* not found */ }

      const result = fullRebuild(db, mainTsSource, headlessSource, mainTsPath, headlessPath, cwd)
      const indexBlock = generateCodebaseIndexBlock(db, getHeadSha())

      pushStatic(createLogEntry({ type: 'system', content: `?? Codebase Index Rebuilt\n\n${result}\n\nIndex will be injected into agent context on next turn.` }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/dream',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // Show dream status ? memory distillation runs automatically at session end
      const dir = knowledgeDir()
      const memPath = join(dir, 'project-memory.md')
      const hasMemory = existsSync(memPath)
      const size = hasMemory ? readFileSync(memPath, 'utf-8').length : 0
      const entries = hasMemory
        ? (readFileSync(memPath, 'utf-8').match(/^### /gm) ?? []).length
        : 0

      pushStatic(createLogEntry({ type: 'system', content:
        `?? Dream ? ????\n\n` +
        `  ??: ${hasMemory ? 'active' : 'empty'}\n` +
        `  ??: ${entries} curated memories\n` +
        `  ??: ${(size / 1024).toFixed(1)} KB\n` +
        `  ??: .rivet/knowledge/project-memory.md\n\n` +
        `Dream ??????????????????\n` +
        `  ? convergence_insight ? ????\n` +
        `  ? architectural_invariant ? ?????\n` +
        `  ? selection_rule ? ????\n` +
        `  ? conceptual_reframe ? ????\n` +
        `  ? reusable_design_pattern ? ???????\n\n` +
        `??????????? recall ???????`
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/diagram',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const arg = (parts[1] ?? '').toLowerCase()
      if (!arg || arg === 'list') {
        pushStatic(createLogEntry({ type: 'system', content:
          `${formatDiagramList()}\n\n???/diagram <type> ? ??????? docs/diagrams/<type>.md\n????????{{???}}=LLM?[[???]]=Agent?[(??)]=???{??}=???(??)=????`
        }))
        setIsStreaming(false)
        return true
      }
      if (!isDiagramType(arg)) {
        pushStatic(createLogEntry({ type: 'system', content:
          `???? "${arg}"?\n${formatDiagramList()}`
        }))
        setIsStreaming(false)
        return true
      }
      const cwd = ctx.agent.cwd
      const outDir = join(cwd, 'docs', 'diagrams')
      const outPath = join(outDir, `${arg}.md`)
      let writeNote: string
      try {
        mkdirSync(outDir, { recursive: true })
        writeFileSync(outPath, buildDiagramDoc(arg), 'utf-8')
        writeNote = `??? docs/diagrams/${arg}.md ? ? VSCode/GitHub/Obsidian ???????`
      } catch (e) {
        writeNote = `??????${e instanceof Error ? e.message : String(e)}?????????????`
      }
      pushStatic(createLogEntry({ type: 'system', content:
        `?? ${arg} ?????\n\n${writeNote}\n\n${renderDiagramBlock(arg)}\n\n???????????????????????????`
      }))
      setIsStreaming(false)
      return true
    },
  },
]

export async function handleSlashCommand(ctx: SlashHandlerContext): Promise<boolean> {
  const cmd = ctx.parts[0]!.toLowerCase()
  const command = TUI_SLASH_COMMANDS.find(c => c.name === cmd)
  if (!command) return false
  return await command.handler(ctx)
}

export function registerTuiSlashCommands(app: TuiApp, ctx: BootstrapContext): void {
  const autoSafeRef: MutableRefLike<boolean> = { current: true }
  const verboseRef: MutableRefLike<boolean> = { current: false }
  const rollbackTokenRef: MutableRefLike<string | null> = { current: null }
  let cacheHitRate = 0

  const allProviders: Record<string, { models: Array<{ id: string; alias: string }> }> = {}
  for (const [name, prov] of Object.entries(ctx.config.provider.providers)) {
    allProviders[name] = { models: prov.models.map(m => ({ id: m.id, alias: m.alias ?? m.id })) }
  }

  function buildHandlerContext(input: string): SlashHandlerContext {
    const trimmed = input.trim()
    const parts = trimmed.split(/\s+/)
    const metrics = app.getMetrics()
    const maxTokens = metrics?.maxTokens && metrics.maxTokens > 0
      ? metrics.maxTokens
      : (ctx.provider.models[0]?.contextWindow ?? 128000)
    const cost = metrics?.cost ?? 0

    return {
      parts,
      config: ctx.config,
      agent: ctx.agent,
      session: ctx.session,
      persist: ctx.persist,
      model: app.getModelInfo().modelName,
      maxTokens,
      availableModels: ctx.provider.models.map(m => ({ id: m.id, alias: m.alias ?? m.id })),
      onModelSwitch: (modelId: string) => {
        try { ctx.agent.abort() } catch {}
        const res = switchAgentRuntime(ctx, modelId)
        if (res.ok && res.modelName) {
          app.setModelInfo(res.modelName, res.contextWindow)
        }
        return { ok: res.ok, error: res.error }
      },
      onSessionSwitch: (targetId: string) => {
        try { ctx.agent.abort() } catch {}
        const res = switchAgentSession(ctx, targetId)
        if (res.ok) {
          app.setStreamingState(false)
          // ????????todo ??? side panel ???????????
          try {
            const restoredGoal = restoreGoalTracker(getSessionDir(ctx.cwd), targetId, {
              maxJudgeRuns: ctx.config.agent.goal?.judge?.maxRuns,
            })
            if (restoredGoal) {
              ctx.agent.setGoalTracker(restoredGoal)
              ctx.refs.goalTrackerRef.current = restoredGoal
            } else {
              ctx.refs.goalTrackerRef.current = null
            }
          } catch { /* goal restore best-effort */ }
          try {
            loadTodos(targetId, ctx.cwd)
            setTodoSession(targetId, ctx.cwd)
            setPlanSession(targetId)
          } catch { /* todo/plan restore best-effort */ }
          try {
            const meta = ctx.persist.loadMetadata()
            if (meta?.sidePanelOpen) app.setSidePanelOpen(true)
            else app.setSidePanelOpen(false)
            // ??????????????? planning ? draft ?? ? ???
            const restoredPlan = restorePlanModeFromMeta(ctx.agent, ctx.cwd, meta)
            if (restoredPlan) {
              app.commitStatic(`?? ????????draft: ${restoredPlan}?? /plan-mode ???????????`)
            }
          } catch { /* panel/plan restore best-effort */ }
        }
        return res
      },
      openSessionPicker: () => { app.activateOverlay('chronicle') },
      openInitFlow: () => { app.openInitFlow(ctx.agent.cwd) },
      onCwdSwitch: async (target: string) => {
        const res = await switchAgentCwd(ctx, target)
        if (res.ok) {
          // ???? cwd + git ????? cwd ????? git ?????????
          const newCwd = ctx.agent.cwd
          app.setCwd(newCwd)
          try {
            const { spawnGitSync } = await import('../tools/spawn-git.js')
            const r = spawnGitSync(['-c', 'core.quotePath=false', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: newCwd, encoding: 'utf-8', timeout: 5000 })
            app.setGitBranch(r.status === 0 ? r.stdout.trim() || undefined : undefined)
          } catch {
            app.setGitBranch(undefined)
          }
        }
        return res
      },
      allProviders,
      currentProvider: ctx.provider.name,
      currentSessionId: ctx.sessionId,
      cost,
      cacheHitRate: metrics?.cacheHitRate ?? cacheHitRate,
      autoSafeRef,
      verboseRef,
      setVerbose: (v: boolean) => { verboseRef.current = v },
      setAutoSafe: (v: boolean) => { autoSafeRef.current = v },
      persistApprovalMode: (mode: string) => { try { persistApprovalDefault(mode) } catch { /* best-effort persist */ } },
      rollbackTokenRef,
      setCockpitPanel: () => {},
      pushStatic: (entry) => { app.commitStatic(entry.content, { isError: entry.isError }) },
      setIsStreaming: (v: boolean) => { app.setStreamingState(v) },
      setCacheHitRate: (v: number) => { cacheHitRate = v },
      setSummaryState: () => {},
      mcpManagerRef: { current: ctx.refs.mcpManager },
      claimStoreRef: { current: ctx.claimStore },
      banditState: ctx.refs.banditState ?? undefined,
      onDomainChange: (domainName: string | undefined) => {
        app.setSessionStarDomain(domainName)
      },
      runReview: ctx.refs.coordinator
        ? (() => {
            const reviewDeps = createCoordinatorReviewDeps(ctx.refs.coordinator!, {
              parentTurnId: 'slash-review',
              reviewDepth: 0,
            })
            return (change: ChangeSet, mode: ReviewMode, focus?: string) =>
              routeReviewWorkflow(change, reviewDeps, { mode, focusHint: focus })
          })()
        : undefined,
      submitToAgent: (prompt: string) => { app.submitText(prompt) },
      onHandoffStart: (src: string, dest: string) => { app.pendingHandoffCopy = { src, dest, sinceMs: Date.now() } },
      goalTrackerRef: ctx.refs.goalTrackerRef,
      reviewGateRef: ctx.refs.reviewGateRef,
      surfacePush: (id: string) => { app.activateOverlay(id) },
      askSideQuestion: (question: string) => { app.askSideQuestion(question) },
      setChoicePanelKind: (kind) => { app.choicePanelKind = kind },
      surfacePop: () => { app.deactivateOverlay() },
      setReasoningEffort: (effort) => { ctx.agent.setReasoningEffort(effort) },
      reasoningEffort: ctx.agent.getReasoningEffort() ?? ctx.agent.config.reasoningEffort,
    }
  }

  function getHandler(name: string) {
    return TUI_SLASH_COMMANDS.find(c => c.name === name)?.handler
  }

  function register(name: string, command: Omit<SlashCommand, "name">) {
    app.registerSlashCommand({ name, ...command })
  }

  // Register all switch-case commands using the shared handler context adapter.
  for (const cmd of TUI_SLASH_COMMANDS) {
    app.registerSlashCommand({
      name: cmd.name,
      description: cmd.description,
      immediate: cmd.immediate,
      handler: async ({ app, input, trimmed }) => cmd.handler(buildHandlerContext(trimmed)),
    })
  }

  // TUI-specific overrides that need the app handle or resolve ecosystem workflows.
  register("/clear", {
    description: "Clear screen",
    immediate: true,
    handler: () => {
      process.stdout.write('\x1B[2J\x1B[H')
      app.setStreamingState(false)
      return true
    },
  })

  // GlanceBar ???????Wave 2 ??????
  register("/glance", {
    description: "Toggle GlanceBar density (compact/full)",
    immediate: true,
    handler: ({ trimmed }) => {
      const arg = trimmed.split(/\s+/)[1]?.toLowerCase()
      const next = arg === 'full' ? 'full'
        : arg === 'compact' ? 'compact'
        : (app.glanceDensity === 'compact' ? 'full' : 'compact')
      app.glanceDensity = next
      app.forceRedraw()
      app.commitStatic(`GlanceBar density ? ${next}${next === 'compact' ? '???/??/???%/???' : '??????'}`)
      return true
    },
  })

  // ? SIGINT ? main.ts ??? shutdown?app.dispose ? ctx.shutdown ?
  // ???? + resume ?? ? process.exit????? ctx.shutdown() ????
  // ???????????
  register("/exit", {
    description: "Exit Rivet",
    immediate: true,
    handler: () => {
      process.emit('SIGINT')
      return true
    },
  })

  register("/quit", {
    description: "Exit Rivet",
    immediate: true,
    handler: () => {
      process.emit('SIGINT')
      return true
    },
  })

  register("/update", {
    description: "Check and install the latest Rivet release",
    immediate: true,
    handler: async () => {
      if (app.busy) {
        app.commitStatic('??  Cannot update while the agent is running.')
        return true
      }

      const root = detectInstallRoot()
      if (!root) {
        app.commitStatic('??  Cannot detect Rivet install root.')
        return true
      }

      app.commitStatic('Checking for updates...')
      const check = await checkForUpdate(root, { bypassCache: true })
      if (!check) {
        app.commitStatic('??  Could not check for updates right now.')
        return true
      }

      if (!check.hasUpdate) {
        app.commitStatic(`Rivet is up to date (${check.current}).`)
        return true
      }

      app.commitStatic(formatUpdateBanner(check.current, check.latest))
      app.commitStatic(`Install source: ${check.installType}`)

      // Windows ?????????? npm ????????????
      // ?better_sqlite3.node?? "????????????"??????????
      // ???????????????????
      if (process.platform === 'win32' && check.installType === 'global') {
        const schedule = spawnWindowsSelfUpdate(root, 'latest', true, ctx.sessionId)
        if (!schedule.ok) {
          app.commitStatic(`? ??????????${schedule.error ?? 'unknown'}`)
          app.commitStatic('   ??????npm install -g tianshu-tui@latest')
          return true
        }
        app.commitStatic('? ????????????????????????????????')
        app.commitStatic('   ????????????? rivet?????????')
        app.commitStatic('   ?? ??????/rivet ??????????????? npm ??????????????????')
        app.commitStatic(`   ???${schedule.logPath}`)
        setTimeout(() => {
          void (async () => {
            await ctx.shutdown()
            app.dispose()
            process.exit(0)
          })()
        }, 400)
        return true
      }

      const result = await runUpdate(root, 'latest', (line) => app.commitStatic(line))
      if (result.skipped) {
        app.commitStatic(`??  ${result.message}`)
        return true
      }
      if (!result.ok) {
        app.commitStatic(`? ${result.message}`)
        // Windows ?????npm install ???????better_sqlite3.node??
        // ?????????? ? "????????????"????????
        if (process.platform === 'win32') {
          app.commitStatic('   Windows ???????????EBUSY/EPERM??????????????????????????????')
        }
        return true
      }

      app.commitStatic('? Update complete. Restarting...')
      setTimeout(() => {
        void (async () => {
          await ctx.shutdown()
          app.dispose()
          restartProcess(ctx.sessionId)
        })()
      }, 250)
      return true
    },
  })

  register("/starmap", {
    description: "Open starmap overlay",
    immediate: true,
    overlay: "starmap",
    handler: () => true,
  })

  register("/chronicle", {
    description: "Open chronicle overlay",
    immediate: true,
    overlay: "chronicle",
    handler: () => true,
  })

  register("/scroll", {
    description: "Open scrollback pager",
    immediate: true,
    overlay: "pager",
    handler: () => true,
  })

  register("/pager", {
    description: "Open scrollback pager",
    immediate: true,
    overlay: "pager",
    handler: () => true,
  })

  register("/rewind", {
    description: "Open rewind overlay",
    immediate: true,
    overlay: "rewind",
    handler: () => true,
  })

  register("/tasks", {
    description: "Open tasks overlay",
    immediate: true,
    overlay: "tasks",
    handler: () => true,
  })

  register("/jobs", {
    description: "??????",
    immediate: true,
    overlay: "jobs",
    handler: () => true,
  })

  register("/cache", {
    description: "?????token ?? / ??? / ???? ? DeepSeek ?????",
    immediate: true,
    overlay: "cache",
    handler: () => true,
  })

  register("/enter", {
    description: "Resume a worker session (e.g. /enter wo_team:T1 continue fixing bug)",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const result = resolveEnterWorkerInput(app, trimmed)
      if (!result) return false
      if ('error' in result) {
        app.commitStatic(`??  ${result.error}`)
        return true
      }
      app.submitText(result.prompt)
      return true
    },
  })

  register("/palette", {
    description: "Open command palette",
    immediate: true,
    overlay: "command-palette",
    handler: () => true,
  })

  register("/domain", {
    description: "Show or switch star domain",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      if (parts.length === 1) {
        app.activateOverlay("domain-picker")
        return true
      }
      const handler = getHandler("/domain")
      return handler ? handler(buildHandlerContext(trimmed)) : false
    },
  })

  register("/model", {
    description: "Show or switch model",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      if (parts.length === 1) {
        app.activateOverlay("model-picker")
        return true
      }
      const handler = getHandler("/model")
      return handler ? handler(buildHandlerContext(trimmed)) : false
    },
  })

  register("/connect", {
    description: "?????????????????? API ???",
    immediate: true,
    handler: ({ app }) => {
      app.startConnect()
      return true
    },
  })

  // /config ?? ????????????????? /mirror ?????app.ts ??
  // ???????????????? config manager?
  const openSettingsPanel = (): boolean => {
    const flow = new SettingsFlow(loadSettingsDraft(), loadSettingsEnv())
    app.startSettings(flow, request => saveSettings(request, {
      // ?????????????????????????????? agent
      // ? badge????????????????????????
      onApprovalChange: (mode: string) => {
        try {
          ctx.agent.setApprovalMode(mode as Parameters<typeof ctx.agent.setApprovalMode>[0])
          app.setApprovalMode(mode as Parameters<typeof app.setApprovalMode>[0])
          persistApprovalDefault(mode)
          return true
        } catch {
          return false
        }
      },
    }))
    return true
  }

  register("/config", {
    description: "?????????? / ????? / ???? / ????",
    immediate: true,
    handler: openSettingsPanel,
  })
  register("/settings", {
    description: "?????? /config?",
    immediate: true,
    handler: openSettingsPanel,
  })
  register("/setup", {
    description: "?????? /config?",
    immediate: true,
    handler: openSettingsPanel,
  })

  register("/theme", {
    description: "Show or switch color theme",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      if (parts.length === 1) {
        app.activateOverlay("theme-picker")
        return true
      }
      const handler = getHandler("/theme")
      return handler ? handler(buildHandlerContext(trimmed)) : false
    },
  })

  register("/cockpit", {
    description: "Toggle cockpit panel",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      const arg = parts[1]?.toLowerCase() as Panel | "off" | undefined
      if (arg === "off") {
        app.deactivateOverlay()
        app.commitStatic('Cockpit panel collapsed.')
        app.setStreamingState(false)
        return true
      }
      if (arg && (PANELS as string[]).includes(arg)) {
        app.setCockpitPanel(arg as Panel)
        app.activateOverlay("cockpit")
        app.commitStatic(`Cockpit: ${PANEL_LABELS[arg as Panel]} panel. /cockpit off to collapse.`)
        app.setStreamingState(false)
        return true
      }
      const wasOpen = app.activeOverlayId() === "cockpit"
      if (wasOpen) {
        app.deactivateOverlay()
      } else {
        app.setCockpitPanel('summary')
        app.activateOverlay("cockpit")
      }
      app.commitStatic(wasOpen ? 'Cockpit panel collapsed.' : `Cockpit: ${PANEL_LABELS['summary']} panel. /cockpit off to collapse.`)
      app.setStreamingState(false)
      return true
    },
  })

  register("/vim", {
    description: "Toggle vim keybindings",
    immediate: true,
    handler: () => {
      const next = app.toggleVim()
      app.commitStatic(next
        ? 'Vim keybindings: on (Esc ? normal mode, i/a ? insert)'
        : 'Vim keybindings: off')
      app.setStreamingState(false)
      return true
    },
  })

  register("/permission", {
    description: "?????Manual / Auto / YOLO ??????",
    immediate: true,
    handler: () => {
      // Delegate to the main permission handler ? it reads approvalMode live.
      app.setApprovalMode(ctx.agent.config.approvalMode ?? 'manual')
      app.commitStatic(`????: ${ctx.agent.config.approvalMode ?? 'manual'} ? /permission manual|auto|yolo ???? ? /yes ?? YOLO`)
      app.setStreamingState(false)
      return true
    },
  })

  // /yes??? YOLO??????????? TUI badge?planning ????? stash?
  register("/yes", {
    description: "?? YOLO?/yes off ???? ??????",
    immediate: true,
    handler: ({ trimmed }) => {
      const arg = trimmed.split(/\s+/)[1]?.toLowerCase()
      const applyLive = (mode: 'dangerously-skip-permissions' | 'auto-safe') => {
        ctx.agent.setApprovalMode(mode)
        ctx.agent.config.maxTurns = mode === 'dangerously-skip-permissions' ? 0 : 200
        app.setApprovalMode(mode)
        // Plan ??????? ? ?? stash?Shift+Tab ???????????
        if (ctx.agent.planModeState === 'planning') {
          app.approvalModeBeforePlan = mode
        }
        try { persistApprovalDefault(mode) } catch { /* best-effort */ }
      }
      // YOLO ????????/yes ?????????
      if (app.choicePanelKind === 'permission-yolo-confirm' && app.activeOverlayId() === 'choice-panel') {
        app.choicePanelKind = 'effort'
        app.deactivateOverlay()
      }
      if (arg === 'off') {
        applyLive('auto-safe')
        app.commitStatic('? ??? YOLO??? Auto ? ?/???????????????????????????')
        app.setStreamingState(false)
        return true
      }
      applyLive('dangerously-skip-permissions')
      app.commitStatic('? YOLO ??? ? ??????????????????????????????????: /yes off ? ??: /rollback')
      app.setStreamingState(false)
      return true
    },
  })

  // Ecosystem workflow commands: resolve to agent prompt and submit directly.
  // When the resolver has no mapping (e.g. empty /team or /plan), fall back to
  // the shared handler so usage hints are shown instead of being rejected.
  function registerWorkflow(name: string) {
    register(name, {
      handler: ({ app, input, trimmed }) => {
        const resolved = resolveAppPromptInput(trimmed, ctx.cwd)
        if (resolved !== null) {
          app.submitText(resolved.prompt)
          return true
        }
        const fallback = getHandler(name)
        return fallback ? fallback(buildHandlerContext(trimmed)) : false
      },
    })
  }
  registerWorkflow("/team")
  registerWorkflow("/council")
  registerWorkflow("/scout")
  registerWorkflow("/galaxy")
  registerWorkflow("/starflow")
  registerWorkflow("/plan")
  registerWorkflow("/write-plan")
  registerWorkflow("/plan-close")

  // ?? Plugin management ????????????????????????????????????????????

  register("/plugin", {
    description: "Manage plugins ? list, install, remove, enable, disable, info",
    immediate: true,
    handler: ({ app, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      const sub = parts[1]?.toLowerCase()
      const arg = parts[2]

      if (!sub || sub === 'list') {
        const plugins = getInstalledPlugins()
        const cfg = loadConfig()
        if (plugins.length === 0) {
          app.commitStatic('No plugins installed. Use /plugin install <path> to add one.')
          return true
        }
        const lines = ['Installed plugins:']
        for (const p of plugins) {
          const enabled = cfg.plugins.enabled[p.name] !== false ? 'enabled' : 'disabled'
          lines.push(`  ${p.name} (${p.version}) ? ${enabled} ? ${p.description}`)
        }
        lines.push('')
        lines.push('Use /plugin info <name> for details.')
        app.commitStatic(lines.join('\n'))
        return true
      }

      if (sub === 'info') {
        if (!arg) { app.commitStatic('Usage: /plugin info <name>'); return true }
        const plugins = getInstalledPlugins()
        const p = plugins.find(x => x.name === arg)
        if (!p) { app.commitStatic(`Plugin "${arg}" not installed.`); return true }
        const lines = [
          `Plugin: ${p.name}`,
          `Version: ${p.version}`,
          `Description: ${p.description}`,
          `Entry: ${p.entry}`,
          `Tools: ${p.tools}`,
          `Path: ${p.installPath}`,
        ]
        app.commitStatic(lines.join('\n'))
        return true
      }

      if (sub === 'install') {
        if (!arg) {
          app.commitStatic('Usage: /plugin install <local-path>')
          app.commitStatic('Install a plugin from a local directory.\n')
          return true
        }
        app.commitStatic(`Installing plugin from ${arg}...`)
        installPlugin({ kind: 'local', path: arg }).then((result) => {
          if (result.ok) {
            const perms = result.manifest.permissions
            const permStr = Object.entries(perms).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'
            app.commitStatic(
              `? Installed "${result.manifest.name}" v${result.manifest.version}\n` +
              `  Tools: ${result.manifest.tools.map(t => t.name).join(', ')}\n` +
              `  Permissions: ${permStr}\n` +
              `  This plugin will be available on next session start.`
            )
          } else {
            app.commitStatic(`? Install failed: ${result.error}`, { isError: true })
          }
        }).catch((err) => {
          app.commitStatic(`? Install error: ${(err as Error).message}`, { isError: true })
        })
        return true
      }

      if (sub === 'remove') {
        if (!arg) { app.commitStatic('Usage: /plugin remove <name>'); return true }
        const result = removePlugin(arg)
        if (result.ok) {
          app.commitStatic(`? Removed plugin "${arg}".`)
        } else {
          app.commitStatic(`? ${result.error}`, { isError: true })
        }
        return true
      }

      if (sub === 'enable' || sub === 'disable') {
        if (!arg) { app.commitStatic(`Usage: /plugin ${sub} <name>`); return true }
        if (!isPluginInstalled(arg)) {
          app.commitStatic(`? Plugin "${arg}" is not installed.`, { isError: true })
          return true
        }
        const cfg = loadConfig()
        cfg.plugins.enabled[arg] = sub === 'enable'
        saveConfig(cfg)
        app.commitStatic(
          `? Plugin "${arg}" ${sub === 'enable' ? 'enabled' : 'disabled'}. ` +
          `Changes take effect on next session start.`
        )
        return true
      }

      app.commitStatic(
        'Usage: /plugin [list|install <path>|remove <name>|enable <name>|disable <name>|info <name>]'
      )
      return true
    },
  })
}
