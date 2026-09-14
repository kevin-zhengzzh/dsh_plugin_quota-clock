// quota-clock Node half: DeepSeek API balance fetching + /quota-clock/state route + config registration.
// Contract:
// - Node half of an official bundle plugin (dsh.bundle/dsh.client in the repo root package.json);
//   the client is mounted via the official client-modules (__ModuleLoader__ channel), and this half injects no page.
// - Balance source: DeepSeek official GET {baseURL}/user/balance (Bearer API key). The key is
//   resolved via the credentials service (env ref, default DEEPSEEK_API_KEY, same source as llm-deepseek);
//   baseURL prefers llm-deepseek's settings (the user-configured gateway), then $DEEPSEEK_BASE_URL,
//   and finally the official https://api.deepseek.com. The API key is never sent to the client (/state only carries the balance).
// - Cache: balances carry a TTL (quotaRefreshMs, default 60s) to avoid hammering the external API; on failure the last value is kept and
//   error is reported (stale flag); concurrent requests are coalesced (single-flight).
// - Config (L1 experience layer): the settings service is wired in conditionally, falling back to DEFAULTS when absent (the plugin still runs).
//   Peak hours (peakHours) are hour ranges in [Beijing time], default 09:00–12:00, 14:00–18:00,
//   everything else is off-peak; the timezone conversion happens on the client side (Beijing is fixed UTC+8, the client converts to local with Intl).
import z from 'schemastery'

export const name = 'quota-clock'
// inject only declares services every web composition has (webServer/settings); credentials is an optional seam,
// lazily obtained via ctx.get() the same way as llm-deepseek (putting it in inject would make the fiber wait for that service to appear, so it would not activate without it).
export const inject = ['webServer', 'settings']

export const NAMESPACE = 'quota-clock'
export const STATE_PATH = '/quota-clock/state'
export const BALANCE_PATH = '/user/balance'
export const PUBLIC_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
export const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'
export const FETCH_TIMEOUT_MS = 10000

/** Experience-layer defaults (single authority for consumers; values are already clamped to the safe domain). */
export const DEFAULTS = Object.freeze({
  enabled: true,        // Floating-window render switch (can be turned off in settings; once off the client unmounts the component)
  pollMs: 10000,        // Client polling interval for /state
  quotaRefreshMs: 60000, // TTL for the Node half to refresh the balance (lower bound between two external API calls)
  peakHours: [          // Beijing-time peak billing hours (everything else is off-peak)
    { start: 9, end: 12 },
    { start: 14, end: 18 },
  ],
  peakWeekdays: [1, 2, 3, 4, 5], // Beijing weekdays when peak applies (ISO: 1=Mon … 7=Sun) → Monday to Friday
  offPeakRatio: 0.5,             // Off-peak price / peak price (0.5 = half price)
})

/** schemastery schema (used by settings.register; defaults = DEFAULTS to prevent drift between two sources). */
export function buildSchema() {
  return z.object({
    enabled: z.boolean().default(DEFAULTS.enabled),
    pollMs: z.number().min(2000).max(60000).default(DEFAULTS.pollMs),
    quotaRefreshMs: z.number().min(5000).max(3600000).default(DEFAULTS.quotaRefreshMs),
    peakHours: z.array(z.object({
      start: z.number().step(1).min(0).max(23),
      end: z.number().step(1).min(1).max(24),
    })).default(DEFAULTS.peakHours),
    peakWeekdays: z.array(z.number().step(1).min(1).max(7)).default(DEFAULTS.peakWeekdays),
    offPeakRatio: z.number().min(0.05).max(1).default(DEFAULTS.offPeakRatio),
  })
}

/** Cross-field validation (paired constraints the schema cannot express; used as settings.register's validate). */
export function validateConfig(value) {
  const list = Array.isArray(value?.peakHours) ? value.peakHours : []
  for (const p of list) {
    if (p.start >= p.end) throw new Error(`peakHours range must satisfy start < end (got ${p.start}-${p.end})`)
  }
}

/** Deep-copy and normalize the config (so externally mutable objects cannot leak into configRef). */
function normalizeConfig(value) {
  const src = value && typeof value === 'object' ? value : {}
  const peakHours = Array.isArray(src.peakHours)
    ? src.peakHours
      .filter((p) => p && Number.isInteger(p.start) && Number.isInteger(p.end))
      .map((p) => ({ start: p.start, end: p.end }))
    : DEFAULTS.peakHours
  // An empty array is a valid config (no peak on that weekday) — only a missing field falls back to the default.
  const peakWeekdays = Array.isArray(src.peakWeekdays)
    ? [...new Set(src.peakWeekdays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b)
    : DEFAULTS.peakWeekdays.slice()
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULTS.enabled,
    pollMs: Number.isFinite(src.pollMs) ? src.pollMs : DEFAULTS.pollMs,
    quotaRefreshMs: Number.isFinite(src.quotaRefreshMs) ? src.quotaRefreshMs : DEFAULTS.quotaRefreshMs,
    peakHours: peakHours.length > 0 ? peakHours : DEFAULTS.peakHours,
    peakWeekdays,
    offPeakRatio: Number.isFinite(src.offPeakRatio) && src.offPeakRatio > 0 && src.offPeakRatio <= 1
      ? src.offPeakRatio
      : DEFAULTS.offPeakRatio,
  }
}

export function apply(ctx) {
  // Config (L1 experience layer): the settings service is wired in conditionally — falling back to DEFAULTS when absent (the plugin still runs).
  // configRef is the only read surface; configRevision is delivered with /state and the client uses it to gate config changes.
  let configRef = normalizeConfig(DEFAULTS)
  let configRevision = 0
  const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
  const applyConfig = (next) => {
    configRef = normalizeConfig(next)
    configRevision += 1
  }
  if (settings !== undefined && typeof settings.register === 'function') {
    try {
      const scope = settings.register(NAMESPACE, buildSchema(), { applies: 'live', validate: validateConfig })
      applyConfig(scope.get())
      scope.watch((next) => applyConfig(next))
    } catch {
      // register failed (e.g. duplicate registration) → keep DEFAULTS
    }
  }

  // ---- Credential / endpoint resolution (same source as llm-deepseek; reading its settings follows the user's gateway config) ----
  const readLlmSettings = () => {
    if (settings === undefined || typeof settings.read !== 'function') return undefined
    try {
      const v = settings.read('llm-deepseek')
      return v !== null && typeof v === 'object' ? v : undefined
    } catch {
      return undefined
    }
  }
  const resolveApiKeyRef = () => {
    const llm = readLlmSettings()
    return typeof llm?.apiKeyEnv === 'string' && llm.apiKeyEnv.length > 0
      ? llm.apiKeyEnv
      : DEFAULT_API_KEY_ENV
  }
  const resolveBaseURL = () => {
    const llm = readLlmSettings()
    if (typeof llm?.baseURL === 'string' && llm.baseURL.length > 0) return llm.baseURL
    if (typeof process.env[BASE_URL_ENV] === 'string' && process.env[BASE_URL_ENV].length > 0) return process.env[BASE_URL_ENV]
    return PUBLIC_BASE_URL
  }
  const resolveApiKey = async () => {
    const ref = resolveApiKeyRef()
    try {
      const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
      if (credentials !== undefined && typeof credentials.resolve === 'function') {
        const hit = await credentials.resolve(ref)
        if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
      }
    } catch {
      // credentials service missing/threw: try the environment variable as a fallback
    }
    const ambient = process.env[ref]
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : null
  }

  // ---- Balance cache (single-flight + TTL; on failure keep the last value and flag error/stale) ----
  let quota = null // { isAvailable, balances: [{currency,total,granted,toppedUp}], fetchedAt }
  let quotaError = null
  let fetching = null
  const refreshQuota = async (force) => {
    const now = Date.now()
    if (!force && quota !== null && quotaError === null && now - quota.fetchedAt < configRef.quotaRefreshMs) {
      return quota
    }
    if (fetching !== null) return fetching
    fetching = (async () => {
      const key = await resolveApiKey()
      if (key === null) {
        // Structured error code: the copy is rendered by the client in the current language; detail carries the missing env ref name.
        quotaError = { code: 'missing_key', status: null, detail: resolveApiKeyRef() }
        return quota
      }
      const base = resolveBaseURL().replace(/\/+$/, '')
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
      try {
        const res = await fetch(`${base}${BALANCE_PATH}`, {
          headers: { authorization: `Bearer ${key}` },
          signal: ac.signal,
        })
        if (!res.ok) {
          // Structured error code: the copy is rendered by the client in the current language (the Node half is unaware of the UI language).
          quotaError = { code: 'http', status: res.status, detail: null }
          return quota
        }
        const body = await res.json()
        const balances = Array.isArray(body?.balance_infos)
          ? body.balance_infos
            .filter((b) => b !== null && typeof b === 'object')
            .map((b) => ({
              currency: typeof b.currency === 'string' ? b.currency : '?',
              total: typeof b.total_balance === 'string' ? b.total_balance : null,
              granted: typeof b.granted_balance === 'string' ? b.granted_balance : null,
              toppedUp: typeof b.topped_up_balance === 'string' ? b.topped_up_balance : null,
            }))
          : []
        quota = { isAvailable: body?.is_available === true, balances, fetchedAt: Date.now() }
        quotaError = null
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError'
        quotaError = {
          code: aborted ? 'timeout' : 'network',
          status: null,
          detail: aborted ? null : (error instanceof Error ? error.message : String(error)),
        }
      } finally {
        clearTimeout(timer)
      }
      return quota
    })()
    try {
      return await fetching
    } finally {
      fetching = null
    }
  }

  // ---- Routes (degrade to a UI-less tool plugin when webServer is absent) ----
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  ctx.effect(() => {
    const disposers = []
    if (webServer !== undefined && typeof webServer.register === 'function') {
      disposers.push(webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              res.writeHead(405, { allow: 'GET' })
              res.end()
              return
            }
            // ?refresh=1 forces a refetch bypassing the TTL (a read-only balance query, no side effects, no CSRF protection).
            let force = false
            try {
              force = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('refresh') === '1'
            } catch {
              force = false
            }
            await refreshQuota(force)
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify({
              quota: {
                isAvailable: quota === null ? null : quota.isAvailable,
                balances: quota === null ? [] : quota.balances,
                fetchedAt: quota === null ? null : quota.fetchedAt,
                error: quotaError,
                stale: quota !== null && quotaError !== null,
              },
              config: {
                enabled: configRef.enabled,
                pollMs: configRef.pollMs,
                quotaRefreshMs: configRef.quotaRefreshMs,
                peakHours: configRef.peakHours,
                peakWeekdays: configRef.peakWeekdays,
                offPeakRatio: configRef.offPeakRatio,
                revision: configRevision,
              },
            }))
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        },
      }))
    }
    // Warm up the balance once at startup (the first client poll then hits the cache).
    refreshQuota(false).catch(() => {})
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'quota-clock: state route')
}
