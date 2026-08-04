/**
 * Shared Galaxy scheduling metadata.
 *
 * Galaxy and Starflow must calculate the same worker fan-out. Keeping the
 * profile mapping and EP/DP expansion in one place prevents the outer
 * Starflow timeout from drifting away from the Galaxy execution plan.
 */

export interface GalaxyBudgetDimension {
  name?: string
  authority?: string
  authorities?: readonly string[]
  parallelism?: 'expert' | 'data'
  replicas?: number
  profile?: string
  tierFloor?: string
  timeoutMs?: number
}

export interface GalaxyBudgetInputs {
  profiles: Array<string | undefined>
  tierFloors: Array<string | undefined>
  requestedTimeoutMs: Array<number | undefined>
}

/** Resolve the default worker profile used by Galaxy for a dimension. */
export function mapGalaxyDimensionToProfile(name: string): string {
  const key = name.toLowerCase().replace(/[\s_-]/g, '')
  if (key === 'review' || key === 'verify') return 'reviewer'
  if (key === 'plan') return 'planner'
  if (key === 'docs' || key === 'research') return 'doc_scout'
  return 'patcher'
}

/** Whether a dimension is itself the explicit review wave. */
export function isReviewGalaxyDimension(name: string): boolean {
  const key = name.toLowerCase().replace(/[\s_-]/g, '')
  return key === 'review' || key === 'verify'
}

/** Expand dimensions into the worker-level timeout inputs used by Galaxy. */
export function buildGalaxyBudgetInputs(
  dimensions: readonly GalaxyBudgetDimension[],
): GalaxyBudgetInputs {
  const profiles: Array<string | undefined> = []
  const tierFloors: Array<string | undefined> = []
  const requestedTimeoutMs: Array<number | undefined> = []

  for (const rawDimension of dimensions) {
    // timeoutMs runs before Zod executes. Ignore malformed entries here so a
    // bad request still reaches the normal format_error response instead of
    // throwing while the tool pipeline is calculating its watchdog.
    if (!rawDimension || typeof rawDimension !== 'object') continue
    const dimension = rawDimension as GalaxyBudgetDimension
    const authorities = Array.isArray(dimension.authorities)
      ? dimension.authorities
      : (typeof dimension.authority === 'string' && dimension.authority.length > 0 ? [dimension.authority] : [])
    const replicas = dimension.parallelism === 'data' && typeof dimension.replicas === 'number' && Number.isFinite(dimension.replicas)
      ? Math.max(1, Math.trunc(dimension.replicas))
      : 1
    const profile = typeof dimension.profile === 'string'
      ? dimension.profile
      : (typeof dimension.name === 'string' && dimension.name.length > 0 ? mapGalaxyDimensionToProfile(dimension.name) : undefined)
    for (let i = 0; i < authorities.length * replicas; i++) {
      profiles.push(profile)
      tierFloors.push(dimension.tierFloor)
      requestedTimeoutMs.push(dimension.timeoutMs)
    }
  }

  return { profiles, tierFloors, requestedTimeoutMs }
}
