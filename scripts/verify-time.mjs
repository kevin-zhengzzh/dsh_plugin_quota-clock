// Pricing-rule and timezone-conversion verification (same functions, copied
// verbatim, as in lib/client.js).
// Rule: peak = Beijing **Mon-Fri** 09:00-12:00 and 14:00-18:00; everything else
// is off-peak (off-peak price = peak price x ratio).
// Set the TZ environment variable to check another local timezone; this verifies
// that red arcs only appear on Beijing weekdays, the status decision, and the
// next-peak countdown across weekends.
// Run: node scripts/verify-time.mjs (another timezone: TZ=America/New_York node scripts/verify-time.mjs)
const BEIJING_TZ = 'Asia/Shanghai'
const BJ_OFFSET_MS = 8 * 3600 * 1000

const fmtBeijing = new Intl.DateTimeFormat('en-US', {
  timeZone: BEIJING_TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})
const fmtLocal = new Intl.DateTimeFormat('en-US', {
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})
function partsOf(date, fmt) {
  const arr = fmt.formatToParts(date)
  const map = {}
  for (let i = 0; i < arr.length; i++) map[arr[i].type] = arr[i].value
  return {
    year: +map.year, month: +map.month, day: +map.day,
    hour: (+map.hour) % 24, minute: +map.minute, second: +map.second,
  }
}
function bjInstant(y, m, d, hour) { return Date.UTC(y, m - 1, d, hour) - BJ_OFFSET_MS }
function isoWeekday(y, m, d) {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return dow === 0 ? 7 : dow
}
function isoWeekdayAhead(y, m, d, ahead) {
  const dow = new Date(Date.UTC(y, m - 1, d + ahead)).getUTCDay()
  return dow === 0 ? 7 : dow
}
function isPeakDay(weekdays, iso) { return Array.isArray(weekdays) && weekdays.indexOf(iso) >= 0 }
function localMinutes(date) {
  const p = partsOf(date, fmtLocal)
  return p.hour * 60 + p.minute
}
function peakArcs(now, peakHours, peakWeekdays) {
  const bj = partsOf(now, fmtBeijing)
  if (!isPeakDay(peakWeekdays, isoWeekday(bj.year, bj.month, bj.day))) return []
  const dayStart = bjInstant(bj.year, bj.month, bj.day, 0)
  const arcs = []
  for (let i = 0; i < peakHours.length; i++) {
    const p = peakHours[i]
    const sm = localMinutes(dayStart + p.start * 3600 * 1000)
    const em = localMinutes(dayStart + p.end * 3600 * 1000)
    if (sm === em) continue
    if (sm < em) {
      arcs.push({ startMin: sm, endMin: em })
    } else {
      arcs.push({ startMin: sm, endMin: 1440 })
      if (em > 0) arcs.push({ startMin: 0, endMin: em })
    }
  }
  return arcs
}
/** Mirrors client tick(): returns the current status and the minutes until the next change. */
function statusAt(now, peakHours, peakWeekdays) {
  const bj = partsOf(now, fmtBeijing)
  const bjMin = bj.hour * 60 + bj.minute
  const windows = peakHours.slice().sort((a, b) => a.start - b.start)
  const onPeakDay = isPeakDay(peakWeekdays, isoWeekday(bj.year, bj.month, bj.day)) && windows.length > 0
  let inPeak = false
  let nextMin = null
  for (const w of windows) {
    if (onPeakDay && bjMin >= w.start * 60 && bjMin < w.end * 60) { inPeak = true; nextMin = w.end * 60 - bjMin; break }
  }
  if (!inPeak && onPeakDay) {
    for (const w of windows) if (w.start * 60 > bjMin) { nextMin = w.start * 60 - bjMin; break }
  }
  if (nextMin === null && peakWeekdays.length > 0 && windows.length > 0) {
    for (let ahead = 1; ahead <= 8; ahead++) {
      if (!isPeakDay(peakWeekdays, isoWeekdayAhead(bj.year, bj.month, bj.day, ahead))) continue
      nextMin = ahead * 1440 + windows[0].start * 60 - bjMin
      break
    }
  }
  return { inPeak, nextMin, bjWeekday: isoWeekday(bj.year, bj.month, bj.day) }
}

const PEAK = [{ start: 9, end: 12 }, { start: 14, end: 18 }]
const WEEKDAYS = [1, 2, 3, 4, 5]
// Beijing wall clock (y-m-d hh:mm) -> absolute instant (Beijing = UTC+8)
const bjWall = (y, m, d, h, min) => Date.UTC(y, m - 1, d, h, min) - BJ_OFFSET_MS
const fmtArc = (a) => `${String(Math.floor(a.startMin / 60)).padStart(2, '0')}:${String(a.startMin % 60).padStart(2, '0')}–${String(Math.floor(a.endMin / 60)).padStart(2, '0')}:${String(a.endMin % 60).padStart(2, '0')}`

console.log('local timezone:', Intl.DateTimeFormat().resolvedOptions().timeZone)
console.log('local wall clock at Beijing 2026-08-17 (Mon) 10:30:', JSON.stringify(partsOf(bjWall(2026, 8, 17, 10, 30), fmtLocal)))

// ---- 1) Red arcs only appear on peak days ----
const monArcs = peakArcs(bjWall(2026, 8, 17, 10, 30), PEAK, WEEKDAYS) // Monday
const satArcs = peakArcs(bjWall(2026, 8, 22, 10, 30), PEAK, WEEKDAYS) // Saturday
const sunArcs = peakArcs(bjWall(2026, 8, 23, 10, 30), PEAK, WEEKDAYS) // Sunday
console.log('Monday arcs:', monArcs.map(fmtArc).join(' | ') || '(none)')
console.log('Saturday arcs:', satArcs.map(fmtArc).join(' | ') || '(none)')
console.log('Sunday arcs:', sunArcs.map(fmtArc).join(' | ') || '(none)')
if (satArcs.length !== 0 || sunArcs.length !== 0) throw new Error('a Beijing weekend must have no red arc')
let monTotal = 0
for (const a of monArcs) {
  if (a.startMin >= a.endMin) throw new Error(`degenerate arc ${JSON.stringify(a)}`)
  monTotal += a.endMin - a.startMin
}
if (monTotal !== 420) throw new Error(`weekday peak total ${monTotal} != 420`)

// ---- 2) Status decision (weekends and window boundaries included) ----
const cases = [
  { label: 'Mon 10:30 (peak)', now: bjWall(2026, 8, 17, 10, 30), peak: true, next: 90 },
  { label: 'Mon 12:00 (morning peak ends)', now: bjWall(2026, 8, 17, 12, 0), peak: false, next: 120 },
  { label: 'Mon 17:59 (peak)', now: bjWall(2026, 8, 17, 17, 59), peak: true, next: 1 },
  { label: 'Mon 18:00 (all peaks end)', now: bjWall(2026, 8, 17, 18, 0), peak: false, next: 900 },      // -> Tue 09:00
  { label: 'Fri 20:00 (across the weekend)', now: bjWall(2026, 8, 21, 20, 0), peak: false, next: 3660 }, // -> Mon 09:00
  { label: 'Fri 08:00 (before the peak)', now: bjWall(2026, 8, 21, 8, 0), peak: false, next: 60 },       // -> Fri 09:00
  { label: 'Sat 10:30 (would-be peak, weekend)', now: bjWall(2026, 8, 22, 10, 30), peak: false, next: 2790 }, // -> Mon 09:00
  { label: 'Sun 23:59 (into Monday)', now: bjWall(2026, 8, 23, 23, 59), peak: false, next: 541 },      // -> Mon 09:00
]
for (const c of cases) {
  const s = statusAt(c.now, PEAK, WEEKDAYS)
  console.log(`${c.label} (Beijing weekday ${s.bjWeekday}) -> ${s.inPeak ? 'peak' : 'off-peak'}, next change in ${s.nextMin} min`)
  if (s.inPeak !== c.peak) throw new Error(`${c.label}: status ${s.inPeak} != expected ${c.peak}`)
  if (s.nextMin !== c.next) throw new Error(`${c.label}: next change ${s.nextMin} != expected ${c.next}`)
}

// ---- 3) Cross-timezone: the peak day follows the Beijing weekday, not the local one ----
// Example: Beijing Monday 10:30 is still Sunday locally in the Americas, yet Beijing is
// Monday -> it must count as peak and must draw a red arc.
const crossNow = bjWall(2026, 8, 17, 10, 30)
const crossLocal = partsOf(crossNow, fmtLocal)
const crossLocalDow = new Date(Date.UTC(crossLocal.year, crossLocal.month - 1, crossLocal.day)).getUTCDay()
const crossStatus = statusAt(crossNow, PEAK, WEEKDAYS)
console.log(`cross-timezone sample: local ${crossLocal.year}-${crossLocal.month}-${crossLocal.day} ${crossLocal.hour}:${crossLocal.minute} (local dow=${crossLocalDow}) -> ${crossStatus.inPeak ? 'peak' : 'off-peak'}, Beijing weekday ${crossStatus.bjWeekday}`)
if (!crossStatus.inPeak) throw new Error('Beijing Monday 10:30 must be peak regardless of the local weekday')
if (crossStatus.bjWeekday !== 1) throw new Error(`Beijing weekday should be 1, got ${crossStatus.bjWeekday}`)
if (peakArcs(crossNow, PEAK, WEEKDAYS).length === 0) throw new Error('Beijing Monday must draw red arcs')

// ---- 4) Weekday helpers self-check ----
if (isoWeekday(2026, 8, 17) !== 1) throw new Error('2026-08-17 should be a Monday')
if (isoWeekday(2026, 8, 21) !== 5) throw new Error('2026-08-21 should be a Friday')
if (isoWeekday(2026, 8, 22) !== 6) throw new Error('2026-08-22 should be a Saturday')
if (isoWeekday(2026, 8, 23) !== 7) throw new Error('2026-08-23 should be a Sunday')
if (isoWeekdayAhead(2026, 8, 22, 2) !== 1) throw new Error('Saturday + 2 days should be a Monday')

console.log('VERIFY OK')
