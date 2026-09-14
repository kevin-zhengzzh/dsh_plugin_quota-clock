// Node-half smoke test: loads the quota-clock Node half and verifies schema
// construction plus cross-field validation.
// Run: node scripts/smoke-test.mjs (or npm test)
import { DEFAULTS, buildSchema, validateConfig } from '../lib/index.mjs'

const schema = buildSchema()
console.log('DEFAULTS:', JSON.stringify(DEFAULTS))

// 0) Defaults of the pricing rule: peak on Beijing Mon-Fri only; off-peak = peak x 0.5
if (JSON.stringify(DEFAULTS.peakWeekdays) !== JSON.stringify([1, 2, 3, 4, 5])) {
  throw new Error(`peakWeekdays should default to Mon-Fri, got ${JSON.stringify(DEFAULTS.peakWeekdays)}`)
}
if (DEFAULTS.offPeakRatio !== 0.5) throw new Error(`offPeakRatio should default to 0.5, got ${DEFAULTS.offPeakRatio}`)
console.log('Rule defaults OK: peakWeekdays=[1..5] (Mon-Fri), offPeakRatio=0.5')

// 1) Defaults survive schema normalization (a schemastery 3.x schema is callable)
const resolved = schema(DEFAULTS)
console.log('resolve(DEFAULTS) ok:', JSON.stringify(resolved.peakHours))
if (JSON.stringify(resolved.peakWeekdays) !== JSON.stringify([1, 2, 3, 4, 5])) throw new Error('peakWeekdays drifted through resolve')
if (resolved.offPeakRatio !== 0.5) throw new Error('offPeakRatio drifted through resolve')

// 2) A user config merges and validates (including the new fields)
const user = {
  enabled: true,
  pollMs: 5000,
  quotaRefreshMs: 30000,
  peakHours: [{ start: 9, end: 12 }, { start: 14, end: 18 }],
  peakWeekdays: [1, 2, 3, 4, 5, 6],
  offPeakRatio: 0.5,
}
const merged = schema(user)
console.log('resolve(user) ok:', JSON.stringify(merged))
if (merged.peakWeekdays.length !== 6) throw new Error('user peakWeekdays did not take effect')
// Omitted fields fall back to their defaults
const partial = schema({ enabled: true })
if (JSON.stringify(partial.peakWeekdays) !== JSON.stringify([1, 2, 3, 4, 5])) throw new Error('missing peakWeekdays did not fall back to the default')
if (partial.offPeakRatio !== 0.5) throw new Error('missing offPeakRatio did not fall back to the default')

// 3) An inverted window must be rejected
try {
  validateConfig({ peakHours: [{ start: 12, end: 9 }] })
  console.error('FAIL: the inverted window was not rejected')
  process.exit(1)
} catch (error) {
  console.log('inverted window rejected:', error.message)
}

// 4) Out-of-range weekdays / ratio must be rejected by the schema
for (const bad of [{ peakWeekdays: [0] }, { peakWeekdays: [8] }, { offPeakRatio: 0 }, { offPeakRatio: 1.5 }]) {
  let rejected = false
  try {
    schema(bad)
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error(`out-of-range config was not rejected: ${JSON.stringify(bad)}`)
}
console.log('out-of-range peakWeekdays / offPeakRatio rejected')

// 5) schema.toJSON must serialize (settings.describe depends on it)
const json = schema.toJSON()
console.log('schema.toJSON keys:', Object.keys(json).slice(0, 8).join(', '))

console.log('SMOKE OK')
