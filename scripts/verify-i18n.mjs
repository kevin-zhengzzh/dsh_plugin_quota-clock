// i18n verification: dictionary key completeness, every key referenced by the
// bundle source, the bundle contract, the official locale wiring, and the
// widget language-button wiring.
// Run: node scripts/verify-i18n.mjs (or npm test)
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Extract a `var NAME = { ... }` object literal from the source and evaluate it (skips braces inside strings). */
function extractLiteral(name) {
  const at = src.indexOf(`var ${name} = {`)
  if (at < 0) throw new Error(`object literal ${name} not found`)
  const start = src.indexOf('{', at)
  let depth = 0
  let end = -1
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) throw new Error(`object literal ${name} is not closed`)
  return eval(`(${src.slice(start, end)})`) // eslint-disable-line no-eval
}

const ZH = extractLiteral('ZH')
const EN = extractLiteral('EN')

// ---- 1) Identical key sets ----
const zhKeys = Object.keys(ZH).sort()
const enKeys = Object.keys(EN).sort()
const onlyZh = zhKeys.filter((k) => !enKeys.includes(k))
const onlyEn = enKeys.filter((k) => !zhKeys.includes(k))
if (onlyZh.length > 0 || onlyEn.length > 0) {
  throw new Error(`key sets differ: zh-only=${JSON.stringify(onlyZh)} en-only=${JSON.stringify(onlyEn)}`)
}
console.log(`key sets match: ${zhKeys.length} keys`)

// ---- 2) Every tt() key used in the source exists in the dictionaries ----
const used = new Set()
for (const m of src.matchAll(/\btt\(\s*"([^"]+)"/g)) used.add(m[1])
const missing = [...used].filter((k) => !(k in ZH))
if (missing.length > 0) throw new Error(`keys used by the source but missing from the dictionaries: ${JSON.stringify(missing)}`)
// Dynamically composed error-code keys ("err." + code) are checked separately
for (const code of ['missing_key', 'http', 'timeout', 'network', 'other']) {
  if (!(`err.${code}` in ZH) || !(`err.${code}` in EN)) throw new Error(`dictionary misses the error code err.${code}`)
}
console.log(`${used.size} keys referenced by the source, all present (including dynamic err.* keys)`)

// ---- 3) The bundle factory executes and exports the contract ----
let handoff = null
globalThis.window = { __ModuleLoader__: { load: (h) => { handoff = h } } }
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US', languages: ['en-US'] },
    configurable: true,
    writable: true,
  })
} catch {
  // Node's own navigator may be non-overridable: the official locale path does not depend on it
}
await import('../lib/client.js')
if (handoff === null || handoff.id !== 'quota-clock') throw new Error('bundle did not register with id=quota-clock')
const mod = handoff.factory(() => { throw new Error('the bundle must not require any module') })
if (mod.name !== 'quota-clock') throw new Error(`wrong name: ${mod.name}`)
if (typeof mod.apply !== 'function') throw new Error('apply is missing')
if (!Array.isArray(mod.inject) || !mod.inject.includes('locale')) throw new Error(`wrong inject: ${JSON.stringify(mod.inject)}`)
console.log(`bundle contract OK: name=${mod.name} inject=${JSON.stringify(mod.inject)}`)

// ---- 4) apply registers dictionaries / binds t / subscribes on the locale service ----
const calls = { registered: [], bound: [], subscribed: 0, effects: 0, setLocale: [] }
const activeSnapshot = { active: 'en', locales: [], revision: 0 }
const fakeLocale = {
  getSnapshot: () => activeSnapshot,
  register: (ns, dicts) => { calls.registered.push({ ns, locales: Object.keys(dicts) }); return () => {} },
  bind: (ns) => { calls.bound.push(ns); return (key, params) => {
    const dict = activeSnapshot.active === 'zh' ? ZH : EN
    let out = dict[key] !== undefined ? dict[key] : key
    if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m))
    return out
  } },
  subscribe: (fn) => { calls.subscribed += 1; fakeLocale.onChange = fn; return () => { fakeLocale.onChange = null } },
  setLocale: (id) => { calls.setLocale.push(id); activeSnapshot.active = id },
}
globalThis.document = {
  querySelector: () => null,
  body: null, // takes the DOMContentLoaded path, so no real DOM is needed
  addEventListener: () => {},
}
const fakeCtx = { locale: fakeLocale, effect: (fn) => { calls.effects += 1; return fn() } }
const dispose = mod.apply(fakeCtx)
if (typeof dispose !== 'function') throw new Error('apply must return a disposer')
if (calls.registered.length !== 1 || calls.registered[0].ns !== 'quota-clock') throw new Error(`unexpected dictionary registration: ${JSON.stringify(calls.registered)}`)
if (JSON.stringify(calls.registered[0].locales) !== JSON.stringify(['zh', 'en'])) throw new Error('dictionaries must register both zh and en')
if (calls.bound[0] !== 'quota-clock') throw new Error('t was not obtained through locale.bind("quota-clock")')
if (calls.subscribed !== 1) throw new Error('locale changes are not subscribed')
if (calls.effects !== 2) throw new Error(`unexpected ctx.effect usage count: ${calls.effects}`)
console.log(`locale wiring OK: register=${JSON.stringify(calls.registered[0])} bind=${calls.bound[0]} subscribe=${calls.subscribed} effect=${calls.effects}`)

// ---- 5) Widget language-button wiring (structural assertions) ----
const wiring = [
  ['language button markup in the header', 'class="qc-lang"'],
  ['language button styles', '.qc-lang {'],
  ['button click handler', 'els.lang.addEventListener("click"'],
  ['official language write surface', 'svc.setLocale(id)'],
  ['local-override storage key', 'quota-clock:lang'],
  ['button shows the target language', 'els.lang.textContent = toZh ? "中" : "EN"'],
  ['directional tooltip', 'tt("switchTo.zh")'],
  ['post-switch verification', 'active === next'],
  ['local fallback switch', 'function applyLocalLang'],
  ['late locale service adoption', 'function adoptLocale'],
  ['retry timer', 'localeRetry = setInterval'],
  ['drag excludes the language button', '".qc-collapse, .qc-lang"'],
]
for (const [what, needle] of wiring) {
  if (!src.includes(needle)) throw new Error(`missing ${what}: ${JSON.stringify(needle)} not found`)
}
console.log(`language button wiring OK: ${wiring.length} structural assertions passed`)

// ---- 6) Semantics: the button must show the language a click switches TO ----
const labelExpr = 'els.lang.textContent = toZh ? "中" : "EN"'
const toZhExpr = 'var toZh = displayLang() !== "zh";'
if (!src.includes(labelExpr) || !src.includes(toZhExpr)) throw new Error('the target-language semantics of the button are missing')
if (!src.includes('switchLang(displayLang() === "zh" ? "en" : "zh")')) throw new Error('the language switch direction is missing')
console.log('switch semantics OK: a Chinese UI shows EN and an English UI shows 中 (a click switches to the shown language)')

// ---- 7) Behaviour: a locale service provided AFTER apply must still be adopted ----
// This is the classic root cause of "the UI language switch does nothing to the widget":
// the plugin loads first and the service arrives later.
const calls2 = { registered: 0, bound: 0, subscribed: 0, effects: 0 }
const snap2 = { active: 'zh', locales: [], revision: 0 }
const lateLocale = {
  getSnapshot: () => snap2,
  register: () => { calls2.registered += 1; return () => {} },
  bind: () => { calls2.bound += 1; return (key) => key },
  subscribe: () => { calls2.subscribed += 1; return () => {} },
  setLocale: (id) => { snap2.active = id },
}
let provideLocale = false
const lateCtx = {
  // The cordis proxy throws while the service is absent: mimic that behaviour
  get locale() {
    if (!provideLocale) throw new Error('cannot get property "locale" without inject')
    return lateLocale
  },
  effect: (fn) => { calls2.effects += 1; return fn() },
}
const modLate = handoff.factory(() => { throw new Error('the bundle must not require any module') })
const disposeLate = modLate.apply(lateCtx)
if (calls2.registered !== 0) throw new Error('dictionaries must not be registered while the service is absent')
provideLocale = true // the service appears only now
await new Promise((resolve) => setTimeout(resolve, 700))
console.log(`after the late arrival: register=${calls2.registered} bind=${calls2.bound} subscribe=${calls2.subscribed} effect=${calls2.effects}`)
if (calls2.registered !== 1) throw new Error('dictionaries were not registered after the late arrival')
if (calls2.bound !== 1) throw new Error('t was not bound after the late arrival')
if (calls2.subscribed !== 1) throw new Error('locale changes were not subscribed after the late arrival')
if (calls2.effects !== 2) throw new Error(`unexpected effect count after the late arrival: ${calls2.effects}`)
disposeLate()
console.log('late arrival wiring OK: adopted and subscribed automatically')

console.log('VERIFY I18N OK')
