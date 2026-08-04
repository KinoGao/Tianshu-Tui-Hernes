/**
 * session_vitals tool ? ?????????
 *
 * ????"????"??????????????????????????
 * ???????????????????????????????? IO?
 *
 * ?????????????????"???"???????
 */
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { RuntimeSelfModel } from '../agent/runtime-self-model.js'

/** ????????????????AgentLoop.getSessionVitals ?????? */
export interface SessionVitalsData {
  ctx: { estimatedTokens: number; contextWindow: number; ratio: number }
  /** ? 5 ??????cacheRead / cacheCreation ?? API usage ??? */
  cache: Array<{ turn: number; cacheRead: number; cacheCreation: number }>
  sensorium: {
    momentum: number; pressure: number; confidence: number
    complexity: number; freshness: number; stability?: number
  } | null
  cvm: { overheadRatio: number; throttled: boolean; ceiling: boolean }
  advisories: {
    rendered: number; dropped: number; adopted: number; ignored: number
    /** delivered ?? top5 */
    top: Array<{ key: string; delivered: number; adopted: number; ignored: number; silenced: boolean }>
  }
  /** Read-only orchestration self-model; absent in worker/non-agent contexts. */
  runtime?: RuntimeSelfModel | null
  turn: number
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

export function formatVitals(v: SessionVitalsData): string {
  const lines: string[] = []
  lines.push(`# session vitals?turn ${v.turn}??????????`)
  lines.push('')
  lines.push(`## ???`)
  lines.push(`- ?? ${v.ctx.estimatedTokens.toLocaleString()} / ${v.ctx.contextWindow.toLocaleString()} token?${pct(v.ctx.ratio)}?`)
  lines.push('')
  lines.push('## ???? 5 ??API usage ???')
  if (v.cache.length === 0) {
    lines.push('- ??????? usage ? API ???')
  } else {
    for (const c of v.cache) {
      const denom = c.cacheRead + c.cacheCreation
      const rate = denom > 0 ? pct(c.cacheRead / denom) : 'n/a'
      lines.push(`- turn ${c.turn}: read=${c.cacheRead.toLocaleString()} create=${c.cacheCreation.toLocaleString()} ???${rate}`)
    }
  }
  lines.push('')
  lines.push('## sensorium')
  if (!v.sensorium) {
    lines.push('- ???????????')
  } else {
    const s = v.sensorium
    const r2 = (x: number | undefined) => x === undefined ? 'n/a' : x.toFixed(2)
    lines.push(`- momentum=${r2(s.momentum)} pressure=${r2(s.pressure)} confidence=${r2(s.confidence)} complexity=${r2(s.complexity)} freshness=${r2(s.freshness)} stability=${r2(s.stability)}`)
  }
  lines.push('')
  lines.push('## CVM ??')
  lines.push(`- overheadRatio=${pct(v.cvm.overheadRatio)}????????? throttled=${v.cvm.throttled} ? ceiling=${v.cvm.ceiling}`)
  lines.push('')
  lines.push('## advisory ????????')
  lines.push(`- rendered=${v.advisories.rendered} dropped=${v.advisories.dropped} adopted=${v.advisories.adopted} ignored=${v.advisories.ignored}`)
  if (v.advisories.top.length > 0) {
    for (const t of v.advisories.top) {
      lines.push(`- ${t.key}: delivered=${t.delivered} adopted=${t.adopted} ignored=${t.ignored}${t.silenced ? ' [???]' : ''}`)
    }
  }
  lines.push('')
  lines.push('## ??????')
  if (!v.runtime) {
    lines.push('- ?????????????? worker ????')
  } else {
    const r = v.runtime
    const phase = r.phase ? ` phase=${r.phase}` : ''
    lines.push(`- health=${r.health} attention=${r.attention}${phase} confidence=${r.confidence.toFixed(2)}`)
    lines.push(`- workers=${r.activeWorkers}/${r.maxWorkers} pending=${r.pendingWorkers} stalled=${r.stalledWorkers} fileScopes=${r.inFlightFileScopes} claims=${r.activeClaims}`)
    lines.push(`- providerDegradation=${pct(r.providerDegradation)} contextPressure=${pct(r.contextPressure)} verificationDebt=${pct(r.verificationDebt)}`)
    if (r.signals.length === 0) {
      lines.push('- signals=none')
    } else {
      for (const signal of r.signals.slice(0, 5)) {
        lines.push(`- signal ${signal.kind} [${signal.attention}] score=${signal.score.toFixed(2)}: ${signal.reason}`)
      }
    }
  }
  return lines.join('\n')
}

export function createSessionVitalsTool(getVitals: () => SessionVitalsData | null): Tool {
  return {
    definition: {
      name: 'session_vitals',
      description: `???????????????????????? token ? + ???????????????sensorium ????CVM ??/??????? advisory ???

### ????
?????????????????????????????????????????????????????? advisory ???????????

### ??
?? markdown?????????????????????????`,
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },

    async execute(_params: ToolCallParams): Promise<ToolResult> {
      const vitals = getVitals()
      if (!vitals) {
        return { content: 'session vitals ??????????????????? worker ?????', isError: false }
      }
      return { content: formatVitals(vitals) }
    },

    isConcurrencySafe: () => true,
    isEnabled: () => true,
    requiresApproval: () => false,
  }
}
