// quota-clock client bundle (hand-written artifact, i.e. the source: pure browser JS, zero deps, no build step).
// Contract: a standard bundle client — `__ModuleLoader__.load({ id, factory })`, factory returns
// `{ name, apply, inject }`, and apply(ctx) is called by the client kernel when mounting. This file imports no modules.
//
// Features:
// - 24-hour analog clock: three hands on local time; the dial maps the [Beijing peak hours] (default 09:00–12:00,
//   14:00–18:00, off-peak otherwise) into **local time** and marks the peak billing intervals with red arcs.
//   Beijing is fixed at UTC+8 (no DST); the conversion uses Intl + Asia/Shanghai and is DST-safe.
// - Digital time: local time / Beijing time / current state (peak·red / off-peak·green) + time to next switch.
// - DeepSeek API balance: polls /quota-clock/state (the Node half fetches via the official balance API),
//   showing total/granted/topped-up balance + availability + a manual refresh button (?refresh=1 forces a refetch).
// - Multi-language (zh/en): dictionaries are registered with the official locale service (inject ["locale"]) and
//   re-render live when Settings → General → Language changes; without the locale service it falls back to the browser language.
// - The widget is draggable (position remembered in localStorage) and collapsible; default position is top-right (no conflict with the bottom-left pet).
window.__ModuleLoader__.load({
  id: "quota-clock",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // ---------- Constants ----------
    var STATE_PATH = "/quota-clock/state";
    var LOCALE_NS = "quota-clock";
    var BEIJING_TZ = "Asia/Shanghai";
    var BJ_OFFSET_MS = 8 * 3600 * 1000; // Beijing = fixed UTC+8 (no DST)
    var TICK_MS = 250; // hand refresh (smooth sweeping second hand)
    var ARC_RECALC_MS = 60000; // peak-arc recompute (safety net across local midnight / DST boundaries)
    var CFG_DEFAULTS = {
      enabled: true,
      pollMs: 10000,
      quotaRefreshMs: 60000,
      peakHours: [{ start: 9, end: 12 }, { start: 14, end: 18 }],
      peakWeekdays: [1, 2, 3, 4, 5], // Beijing weekdays (ISO): peak applies Mon–Fri only
      offPeakRatio: 0.5,             // off-peak price / peak price
    };
    var POS_KEY = "quota-clock:pos";
    var COLLAPSED_KEY = "quota-clock:collapsed";
    var LANG_KEY = "quota-clock:lang";

    // ---------- Dictionaries (namespace dictionaries registered with the official locale service) ----------
    var ZH = {
      "title": "额度 · 时钟",
      "collapse": "折叠/展开",
      "switchTo.zh": "切换到中文（界面与浮窗）",
      "switchTo.en": "切换到 English（界面与浮窗）",
      "beijing": "北京时间 {day} {time}",
      "peak": "高峰中",
      "offPeak": "空闲",
      "peakEnds": "距高峰结束 {dur}",
      "nextPeak": "距下次高峰 {dur}",
      "alwaysOffPeak": "全时段空闲",
      "legend": "空闲价 {ratio} · 高峰限{weekdays}",
      "weekdays.monFri": "周一至周五",
      "weekdays.weekend": "周末",
      "weekdays.every": "每天",
      "balanceTitle": "DeepSeek 余额",
      "refresh": "⟳ 刷新",
      "refreshing": "⟳ …",
      "total": "总余额",
      "granted": "赠送额度",
      "toppedUp": "充值额度",
      "loading": "额度加载中…",
      "noBalance": "暂无余额信息",
      "available": "✔ 账户可用",
      "unavailable": "✖ 账户不可用",
      "unknown": "状态未知",
      "cached": "（余额为缓存）",
      "updated": "更新于 {time}",
      "offline": "额度服务离线：",
      "err.missing_key": "未配置 DeepSeek API Key（请在 设置→模型 页或 .credentials.yaml 配置 {ref}）",
      "err.http": "余额接口返回 HTTP {status}",
      "err.timeout": "余额接口请求超时",
      "err.network": "无法连接余额接口",
      "err.other": "余额获取失败",
      "dur.min": "{n} 分钟",
      "dur.hour": "{n} 小时",
      "dur.hourMin": "{h} 小时 {m} 分钟",
      "dur.day": "{n} 天",
      "dur.dayHour": "{d} 天 {h} 小时",
    };
    var EN = {
      "title": "Quota · Clock",
      "collapse": "Collapse / expand",
      "switchTo.zh": "Switch to Chinese (UI and widget)",
      "switchTo.en": "Switch to English (UI and widget)",
      "beijing": "Beijing {day} {time}",
      "peak": "Peak",
      "offPeak": "Off-peak",
      "peakEnds": "Peak ends in {dur}",
      "nextPeak": "Next peak in {dur}",
      "alwaysOffPeak": "Off-peak at all times",
      "legend": "Off-peak {ratio} · Peak {weekdays}",
      "weekdays.monFri": "Mon–Fri",
      "weekdays.weekend": "weekend",
      "weekdays.every": "every day",
      "balanceTitle": "DeepSeek balance",
      "refresh": "⟳ Refresh",
      "refreshing": "⟳ …",
      "total": "Total",
      "granted": "Granted",
      "toppedUp": "Topped up",
      "loading": "Loading balance…",
      "noBalance": "No balance info",
      "available": "✔ Account available",
      "unavailable": "✖ Account unavailable",
      "unknown": "Status unknown",
      "cached": " (cached)",
      "updated": "Updated {time}",
      "offline": "Quota service offline: ",
      "err.missing_key": "No DeepSeek API key configured (set {ref} on the Models page or in .credentials.yaml)",
      "err.http": "Balance API returned HTTP {status}",
      "err.timeout": "Balance API request timed out",
      "err.network": "Cannot reach the balance API",
      "err.other": "Failed to fetch the balance",
      "dur.min": "{n} min",
      "dur.hour": "{n} h",
      "dur.hourMin": "{h} h {m} min",
      "dur.day": "{n} d",
      "dur.dayHour": "{d} d {h} h",
    };
    var WEEKDAYS = {
      zh: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
      en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    };

    // Current language and translate function: with the official locale service, use its bind(ns) (t reads a live
    // snapshot, so no rebinding is needed after a language switch); otherwise fall back to the browser language with the
    // key name for missing keys (same as the official translate). manualLang is only a local override for a failed official write.
    var lang = "en";
    var manualLang = null;
    var t = null;
    var setLocale = null;
    var clientCtx = null;        // client root ctx (the locale service may only be provided after apply)
    var localeRef = null;        // official locale service reference (checked after a switch to see whether it really took effect)
    var dictRegistered = false;
    var localeSubscribed = false;
    var localeRetry = null;      // retry timer while the service is absent
    function detectLang() {
      try {
        var list = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || ""];
        for (var i = 0; i < list.length; i++) {
          var tag = String(list[i]).toLowerCase();
          if (tag.indexOf("zh") === 0) return "zh";
          if (tag.indexOf("en") === 0) return "en";
        }
      } catch (err) { /* default when there is no navigator */ }
      return "en";
    }
    function interpolate(template, params) {
      if (!params) return template;
      return String(template).replace(/\{(\w+)\}/g, function (match, name) {
        return name in params ? String(params[name]) : match;
      });
    }
    function tt(key, params) {
      if (manualLang === null && t !== null) return t(key, params);
      var dict = displayLang() === "zh" ? ZH : EN;
      var value = dict[key] !== undefined ? dict[key] : (EN[key] !== undefined ? EN[key] : key);
      return interpolate(value, params);
    }
    /** Actually displayed language: a local manual override wins (only produced on the fallback path), otherwise follow the official locale / browser detection. */
    function displayLang() {
      return manualLang !== null ? manualLang : lang;
    }

    // ---------- Timezone-safe date utilities ----------
    var fmtBeijing = new Intl.DateTimeFormat("en-US", {
      timeZone: BEIJING_TZ, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    var fmtLocal = new Intl.DateTimeFormat("en-US", {
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    function partsOf(date, fmt) {
      var arr = fmt.formatToParts(date);
      var map = {};
      for (var i = 0; i < arr.length; i++) map[arr[i].type] = arr[i].value;
      return {
        year: +map.year, month: +map.month, day: +map.day,
        hour: (+map.hour) % 24, minute: +map.minute, second: +map.second,
      };
    }
    // Absolute instant for hour o'clock on Beijing calendar day (y,m,d) (Beijing wall clock = UTC+8)
    function bjInstant(y, m, d, hour) {
      return Date.UTC(y, m - 1, d, hour) - BJ_OFFSET_MS;
    }
    // ISO weekday of Beijing calendar day (y,m,d) (1=Mon … 7=Sun)
    function isoWeekday(y, m, d) {
      var dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sunday
      return dow === 0 ? 7 : dow;
    }
    /** ISO weekday after the given Beijing calendar-day offset (in days). */
    function isoWeekdayAhead(y, m, d, ahead) {
      var dow = new Date(Date.UTC(y, m - 1, d + ahead)).getUTCDay();
      return dow === 0 ? 7 : dow;
    }
    function isPeakDay(weekdays, iso) {
      return Array.isArray(weekdays) && weekdays.indexOf(iso) >= 0;
    }
    // Peak weekday set → label (every day / Mon–Fri / weekend / enumerated)
    function weekdayLabel(weekdays) {
      var zh = displayLang() === "zh";
      var names = WEEKDAYS[displayLang()] || WEEKDAYS.en; // index 0=Sunday
      var sorted = (Array.isArray(weekdays) ? weekdays.slice() : []).sort(function (a, b) { return a - b; });
      if (sorted.length === 0) return zh ? "无" : "none";
      if (sorted.length === 7) return tt("weekdays.every");
      if (sorted.join(",") === "1,2,3,4,5") return tt("weekdays.monFri");
      if (sorted.join(",") === "6,7") return tt("weekdays.weekend");
      return sorted.map(function (iso) { return names[iso % 7]; }).join(zh ? "、" : ", ");
    }
    function trimNum(n) { return String(Math.round(n * 100) / 100); }
    // Off-peak price ratio → label (0.5 → "5 折" in Chinese / "50%" in English)
    function ratioLabel(ratio) {
      var r = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.5;
      return displayLang() === "zh" ? trimNum(r * 10) + " 折" : trimNum(r * 100) + "%";
    }
    // Local minutes-of-day for an instant (0..1439)
    function localMinutes(date) {
      var p = partsOf(date, fmtLocal);
      return p.hour * 60 + p.minute;
    }
    // Peak arcs: red intervals expressed as "local wall-clock positions" (static mapping of Beijing peak → local time).
    // Drawn only on **peak days** (the Beijing weekday is in peakWeekdays) — no red arc at all on weekends/off-peak days.
    // Returns [{ startMin, endMin }]; startMin may be > endMin (crossing local midnight, drawn as two segments).
    // When a boundary falls exactly on local midnight (endMin === 0) only the first segment is drawn, so a zero-length arc is not painted as a full circle.
    function peakArcs(now, peakHours, peakWeekdays) {
      var bj = partsOf(now, fmtBeijing);
      if (!isPeakDay(peakWeekdays, isoWeekday(bj.year, bj.month, bj.day))) return [];
      var dayStart = bjInstant(bj.year, bj.month, bj.day, 0);
      var arcs = [];
      for (var i = 0; i < peakHours.length; i++) {
        var p = peakHours[i];
        var sm = localMinutes(dayStart + p.start * 3600 * 1000);
        var em = localMinutes(dayStart + p.end * 3600 * 1000);
        if (sm === em) continue;
        if (sm < em) {
          arcs.push({ startMin: sm, endMin: em });
        } else {
          arcs.push({ startMin: sm, endMin: 1440 });
          if (em > 0) arcs.push({ startMin: 0, endMin: em });
        }
      }
      return arcs;
    }

    // ---------- SVG utilities ----------
    function svgEl(tag, attrs) {
      var el = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      return el;
    }
    function polar(r, deg) {
      var rad = deg * Math.PI / 180;
      return { x: 100 + r * Math.cos(rad), y: 100 + r * Math.sin(rad) };
    }
    // Arc path centered at (100,100) (stroke style; the band width is determined by stroke-width)
    function arcPath(r, startMin, endMin) {
      if (!(startMin < endMin)) return null;
      var a1 = (startMin / 1440) * 360 - 90;
      var a2 = (endMin / 1440) * 360 - 90;
      if (a2 <= a1) a2 += 360;
      var large = a2 - a1 > 180 ? 1 : 0;
      var p1 = polar(r, a1);
      var p2 = polar(r, a2);
      return "M " + p1.x.toFixed(2) + " " + p1.y.toFixed(2)
        + " A " + r + " " + r + " 0 " + large + " 1 " + p2.x.toFixed(2) + " " + p2.y.toFixed(2);
    }

    // ---------- State ----------
    var cfg = Object.assign({}, CFG_DEFAULTS, { peakHours: CFG_DEFAULTS.peakHours.slice() });
    var quota = null; // { isAvailable, balances[], fetchedAt, error, stale }
    var failStreak = 0;
    var disposed = false;
    var host = null, styleTag = null;
    var clockHands = null, arcsG = null;
    var els = null;
    var lastArcAt = 0;
    var clockTimer = null, pollTimer = null;
    var refreshingNow = false;

    // ---------- CSS ----------
    var CSS = `
[data-quota-clock] { position: fixed; top: 16px; right: 16px; z-index: 2147483000;
  width: 252px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background: rgba(22, 26, 36, .96); backdrop-filter: blur(12px) saturate(1.2);
  border: 1px solid rgba(255,255,255,.12); border-radius: 14px;
  box-shadow: 0 16px 40px rgba(0,0,0,.45), 0 3px 10px rgba(0,0,0,.35);
  color: #e8ebf2; user-select: none; overflow: hidden; }
[data-quota-clock] .qc-header { display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; cursor: grab; border-bottom: 1px solid rgba(255,255,255,.08);
  background: rgba(255,255,255,.03); touch-action: none; }
[data-quota-clock] .qc-header:active { cursor: grabbing; }
[data-quota-clock] .qc-title { font-size: 12px; font-weight: 600; letter-spacing: .3px;
  display: flex; align-items: center; gap: 6px; flex: 1; white-space: nowrap; }
[data-quota-clock] .qc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
[data-quota-clock] .qc-dot.qc-peak { background: #f43f5e; box-shadow: 0 0 8px rgba(244,63,94,.9); }
[data-quota-clock] .qc-dot.qc-off { background: #22c55e; box-shadow: 0 0 8px rgba(34,197,94,.8); }
[data-quota-clock] .qc-collapse { border: 0; background: rgba(255,255,255,.1); color: #cbd2dc;
  width: 22px; height: 22px; border-radius: 6px; cursor: pointer; font-size: 12px; line-height: 1; }
[data-quota-clock] .qc-collapse:hover { background: rgba(255,255,255,.22); }
[data-quota-clock] .qc-lang { border: 0; background: rgba(86,134,254,.18); color: #b7c8fe;
  border-radius: 6px; padding: 2px 7px; font-size: 10.5px; font-weight: 700; line-height: 16px;
  cursor: pointer; font-family: inherit; letter-spacing: .3px; }
[data-quota-clock] .qc-lang:hover { background: rgba(86,134,254,.34); color: #dbe4ff; }
[data-quota-clock] .qc-body { padding: 10px 12px 12px; }
[data-quota-clock] .qc-clock-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; }
[data-quota-clock] svg.qc-clock { width: 168px; height: 168px; display: block; }
[data-quota-clock] .qc-digital { text-align: center; font-variant-numeric: tabular-nums; line-height: 1.5; }
[data-quota-clock] .qc-local { font-size: 19px; font-weight: 650; letter-spacing: .5px; }
[data-quota-clock] .qc-local-sub { font-size: 11px; color: #9aa3b2; }
[data-quota-clock] .qc-bj-row { display: flex; align-items: center; justify-content: center;
  gap: 6px; margin-top: 3px; }
[data-quota-clock] .qc-bj { font-size: 12px; color: #c7cdd8; }
[data-quota-clock] .qc-status { display: inline-block; font-size: 11px; font-weight: 700;
  padding: 1px 8px; border-radius: 999px; }
[data-quota-clock] .qc-status.qc-peak { background: rgba(244,63,94,.18); color: #fb7185; }
[data-quota-clock] .qc-status.qc-off { background: rgba(34,197,94,.16); color: #4ade80; }
[data-quota-clock] .qc-next { font-size: 11px; color: #9aa3b2; margin-top: 2px; }
[data-quota-clock] .qc-legend { font-size: 10px; color: #6f7889; margin-top: 3px;
  letter-spacing: .2px; }
[data-quota-clock] .qc-divider { height: 1px; background: rgba(255,255,255,.08); margin: 10px 0; }
[data-quota-clock] .qc-quota-title { display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; color: #9aa3b2; margin-bottom: 6px; }
[data-quota-clock] .qc-quota-title b { color: #cbd2dc; font-weight: 600; }
[data-quota-clock] .qc-refresh { border: 0; background: rgba(255,255,255,.1); color: #cbd2dc;
  border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
[data-quota-clock] .qc-refresh:hover { background: rgba(255,255,255,.2); }
[data-quota-clock] .qc-refresh:disabled { opacity: .5; cursor: default; }
[data-quota-clock] .qc-rows { display: grid; gap: 3px; font-variant-numeric: tabular-nums; }
[data-quota-clock] .qc-curr { font-size: 10.5px; color: #8a93a3; font-weight: 600;
  letter-spacing: .4px; margin-top: 6px; }
[data-quota-clock] .qc-curr:first-child { margin-top: 0; }
[data-quota-clock] .qc-row { display: flex; justify-content: space-between; font-size: 12px; }
[data-quota-clock] .qc-row .k { color: #9aa3b2; }
[data-quota-clock] .qc-row .v { font-weight: 600; }
[data-quota-clock] .qc-meta { margin-top: 6px; font-size: 10.5px; color: #8a93a3;
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
[data-quota-clock] .qc-ok { color: #4ade80; font-weight: 600; }
[data-quota-clock] .qc-bad { color: #fb7185; font-weight: 600; }
[data-quota-clock] .qc-err { font-size: 11px; color: #fb7185; line-height: 1.5; margin: 2px 0 4px; }
[data-quota-clock] .qc-placeholder { font-size: 12px; color: #9aa3b2; padding: 4px 0; }
@media (prefers-reduced-motion: reduce) { [data-quota-clock] svg.qc-clock * { transition: none !important; } }
`;

    // ---------- Build the clock ----------
    function buildClock() {
      var svg = svgEl("svg", { class: "qc-clock", viewBox: "0 0 200 200" });
      // Dial
      svg.appendChild(svgEl("circle", { cx: 100, cy: 100, r: 96, fill: "rgba(15,18,26,.85)", stroke: "rgba(255,255,255,.14)", "stroke-width": 1 }));
      // Off-peak base ring + peak red arcs (r=81, band 74..88)
      svg.appendChild(svgEl("circle", { cx: 100, cy: 100, r: 81, fill: "none", stroke: "rgba(34,197,94,.20)", "stroke-width": 14 }));
      arcsG = svgEl("g", {});
      svg.appendChild(arcsG);
      // Ticks (24; a major tick every 6 hours + numeric labels)
      var ticksG = svgEl("g", {});
      for (var h = 0; h < 24; h++) {
        var major = h % 6 === 0;
        var a = (h / 24) * 360 - 90;
        var p1 = polar(major ? 84 : 88, a);
        var p2 = polar(94, a);
        ticksG.appendChild(svgEl("line", {
          x1: p1.x.toFixed(2), y1: p1.y.toFixed(2), x2: p2.x.toFixed(2), y2: p2.y.toFixed(2),
          stroke: major ? "#c7ccd4" : "#4a5160", "stroke-width": major ? 1.6 : 0.8,
        }));
        if (major) {
          var lp = polar(58, a);
          var label = svgEl("text", {
            x: lp.x.toFixed(2), y: lp.y.toFixed(2),
            "text-anchor": "middle", "dominant-baseline": "central",
            fill: "#d8dce3", "font-size": 11, "font-weight": 650,
          });
          label.textContent = String(h);
          ticksG.appendChild(label);
        }
      }
      svg.appendChild(ticksG);
      // Hands
      var handsG = svgEl("g", {});
      var handHour = svgEl("line", { x1: 100, y1: 100, x2: 100, y2: 100, stroke: "#e8ebf2", "stroke-width": 4.5, "stroke-linecap": "round" });
      var handMin = svgEl("line", { x1: 100, y1: 100, x2: 100, y2: 100, stroke: "#e8ebf2", "stroke-width": 2.6, "stroke-linecap": "round" });
      var handSec = svgEl("line", { x1: 100, y1: 100, x2: 100, y2: 100, stroke: "#f43f5e", "stroke-width": 1.4, "stroke-linecap": "round" });
      handsG.appendChild(handHour);
      handsG.appendChild(handMin);
      handsG.appendChild(handSec);
      svg.appendChild(handsG);
      svg.appendChild(svgEl("circle", { cx: 100, cy: 100, r: 3.2, fill: "#e8ebf2" }));
      svg.appendChild(svgEl("circle", { cx: 100, cy: 100, r: 1.4, fill: "#f43f5e" }));
      clockHands = { hour: handHour, minute: handMin, second: handSec };
      return svg;
    }

    function setHand(line, deg, len, tail) {
      var head = polar(len, deg);
      var back = polar(-(tail || 0), deg);
      line.setAttribute("x1", back.x.toFixed(2));
      line.setAttribute("y1", back.y.toFixed(2));
      line.setAttribute("x2", head.x.toFixed(2));
      line.setAttribute("y2", head.y.toFixed(2));
    }

    // Redraw the peak red arcs (local-time positions; empty on off-peak days)
    function redrawArcs(now) {
      if (arcsG === null) return;
      while (arcsG.firstChild) arcsG.removeChild(arcsG.firstChild);
      var arcs = peakArcs(now, cfg.peakHours, cfg.peakWeekdays);
      if (arcs.length === 0) return;
      for (var i = 0; i < arcs.length; i++) {
        var a = arcs[i];
        var d = arcPath(81, a.startMin, a.endMin);
        if (d === null) continue;
        arcsG.appendChild(svgEl("path", {
          d: d,
          fill: "none", stroke: "#f43f5e", "stroke-width": 14, opacity: 0.85,
        }));
      }
    }

    function pad(n) { return n < 10 ? "0" + n : String(n); }
    function fmtDuration(minutes) {
      if (minutes < 60) return tt("dur.min", { n: minutes });
      if (minutes < 1440) {
        var h0 = Math.floor(minutes / 60);
        var m0 = minutes % 60;
        return m0 === 0 ? tt("dur.hour", { n: h0 }) : tt("dur.hourMin", { h: h0, m: m0 });
      }
      var d = Math.floor(minutes / 1440);
      var h = Math.floor((minutes % 1440) / 60);
      return h === 0 ? tt("dur.day", { n: d }) : tt("dur.dayHour", { d: d, h: h });
    }

    // Hands + digital time + status (called every TICK_MS)
    function tick(now) {
      if (disposed || host === null) return;
      var local = partsOf(now, fmtLocal);
      var bj = partsOf(now, fmtBeijing);
      var h = local.hour + local.minute / 60 + local.second / 3600;
      var m = local.minute + local.second / 60;
      var s = local.second;
      setHand(clockHands.hour, (h / 24) * 360 - 90, 46, 10);
      setHand(clockHands.minute, (m / 60) * 360 - 90, 64, 12);
      setHand(clockHands.second, (s / 60) * 360 - 90, 72, 18);
      // Digital time
      els.localTime.textContent = pad(local.hour) + ":" + pad(local.minute) + ":" + pad(local.second);
      var dlang = displayLang();
      var weekdays = WEEKDAYS[dlang] || WEEKDAYS.en;
      els.localSub.textContent = weekdays[(new Date(now)).getDay()] + " · " + pad(local.month) + "/" + pad(local.day);
      var bjIso = isoWeekday(bj.year, bj.month, bj.day);
      els.bjTime.textContent = tt("beijing", { day: weekdays[bjIso % 7], time: pad(bj.hour) + ":" + pad(bj.minute) + ":" + pad(bj.second) });
      // Billing status: peak = the Beijing weekday is in peakWeekdays and the Beijing wall-clock minute falls in an interval [start, end)
      var bjMin = bj.hour * 60 + bj.minute;
      var windows = cfg.peakHours.slice().sort(function (a, b) { return a.start - b.start; });
      var onPeakDay = isPeakDay(cfg.peakWeekdays, bjIso) && windows.length > 0;
      var inPeak = false;
      var endsIn = 0;
      for (var i = 0; i < windows.length; i++) {
        var s0 = windows[i].start * 60, e0 = windows[i].end * 60;
        if (onPeakDay && bjMin >= s0 && bjMin < e0) {
          inPeak = true;
          endsIn = e0 - bjMin;
          break;
        }
      }
      // Time to next switch: during peak → end of this peak; otherwise → start of the next peak (skipping off-peak days)
      var nextMin = null;
      if (inPeak) {
        nextMin = endsIn;
      } else if (onPeakDay) {
        for (var j = 0; j < windows.length; j++) {
          if (windows[j].start * 60 > bjMin) { nextMin = windows[j].start * 60 - bjMin; break; }
        }
      }
      if (nextMin === null && (cfg.peakWeekdays.length > 0 && windows.length > 0)) {
        for (var ahead = 1; ahead <= 8; ahead++) {
          if (!isPeakDay(cfg.peakWeekdays, isoWeekdayAhead(bj.year, bj.month, bj.day, ahead))) continue;
          nextMin = ahead * 1440 + windows[0].start * 60 - bjMin;
          break;
        }
      }
      els.status.textContent = inPeak ? tt("peak") : tt("offPeak");
      els.status.className = "qc-status " + (inPeak ? "qc-peak" : "qc-off");
      els.dot.className = "qc-dot " + (inPeak ? "qc-peak" : "qc-off");
      if (nextMin === null) {
        els.next.textContent = tt("alwaysOffPeak");
      } else {
        els.next.textContent = inPeak
          ? tt("peakEnds", { dur: fmtDuration(nextMin) })
          : tt("nextPeak", { dur: fmtDuration(nextMin) });
      }
      updateLegend();
      // Safety net for peak arcs across local midnight / weekday boundaries: recompute every ARC_RECALC_MS
      if (now - lastArcAt >= ARC_RECALC_MS) {
        lastArcAt = now;
        redrawArcs(now);
      }
    }

    // ---------- Quota rendering ----------
    function currencySymbol(code) {
      if (code === "CNY") return "¥";
      if (code === "USD") return "$";
      if (code === "EUR") return "€";
      return code ? code + " " : "";
    }
    function fmtAmount(v) {
      var n = parseFloat(v);
      return Number.isFinite(n) ? n.toFixed(2) : (v === null || v === undefined ? "—" : String(v));
    }
    function esc(s) {
      return String(s === null || s === undefined ? "" : s).replace(/</g, "&lt;").replace(/&/g, "&amp;");
    }
    // Node-half structured error code → text in the current language (also handles legacy plain-string errors).
    function errorText(err) {
      if (err === null || err === undefined) return "";
      if (typeof err === "string") return err;
      var code = typeof err.code === "string" ? err.code : "other";
      var key = "err." + code;
      var text = tt(key, {
        ref: err.detail === null || err.detail === undefined ? "" : err.detail,
        status: err.status === null || err.status === undefined ? "" : err.status,
      });
      if (text === key) text = tt("err.other");
      if (code !== "missing_key" && code !== "http" && err.detail) text += ": " + err.detail;
      return text;
    }
    function renderQuota() {
      if (host === null || els === null) return; // dictionary registration may fire the subscribe callback before the DOM is built
      if (quota === null) {
        els.rows.innerHTML = '<div class="qc-placeholder">' + esc(tt("loading")) + '</div>';
        els.meta.textContent = "";
        return;
      }
      var balances = Array.isArray(quota.balances) ? quota.balances : [];
      if (balances.length > 1) {
        // Stable sort: CNY first (the primary account currency), the rest by currency-code alphabetical order — the
        // DeepSeek API returns balance_infos in an unstable order, so rendering directly would shuffle currency blocks between refreshes.
        balances = balances.slice().sort(function (a, b) {
          var ra = a && a.currency === "CNY" ? 0 : 1;
          var rb = b && b.currency === "CNY" ? 0 : 1;
          if (ra !== rb) return ra - rb;
          var ca = a ? String(a.currency) : "";
          var cb = b ? String(b.currency) : "";
          return ca < cb ? -1 : ca > cb ? 1 : 0;
        });
      }
      if (balances.length === 0) {
        els.rows.innerHTML = '<div class="qc-placeholder">' + esc(tt("noBalance")) + '</div>';
      } else {
        // An account may hold several currencies at once (e.g. CNY + USD): one block per currency with the currency
        // in the block header, so several "Total" labels side by side are not ambiguous.
        var html = "";
        for (var i = 0; i < balances.length; i++) {
          var b = balances[i];
          var sym = currencySymbol(b.currency);
          if (balances.length > 1) {
            html += '<div class="qc-curr">' + esc(b.currency) + (sym ? " · " + esc(sym) : "") + '</div>';
          }
          html += '<div class="qc-row"><span class="k">' + esc(tt("total")) + '</span><span class="v">' + esc(sym) + fmtAmount(b.total) + '</span></div>'
            + '<div class="qc-row"><span class="k">' + esc(tt("granted")) + '</span><span class="v">' + esc(sym) + fmtAmount(b.granted) + '</span></div>'
            + '<div class="qc-row"><span class="k">' + esc(tt("toppedUp")) + '</span><span class="v">' + esc(sym) + fmtAmount(b.toppedUp) + '</span></div>';
        }
        els.rows.innerHTML = html;
      }
      if (quota.error && balances.length === 0) {
        els.rows.innerHTML = '<div class="qc-err">⚠ ' + esc(errorText(quota.error)) + '</div>';
      }
      var meta = "";
      if (quota.isAvailable === true) meta += '<span class="qc-ok">' + esc(tt("available")) + '</span>';
      else if (quota.isAvailable === false) meta += '<span class="qc-bad">' + esc(tt("unavailable")) + '</span>';
      else meta += '<span class="qc-bad">' + esc(tt("unknown")) + '</span>';
      if (quota.stale) meta += '<span>' + esc(tt("cached")) + '</span>';
      if (typeof quota.fetchedAt === "number" && quota.fetchedAt > 0) {
        var d = new Date(quota.fetchedAt);
        meta += '<span>' + esc(tt("updated", { time: pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) })) + '</span>';
      }
      els.meta.innerHTML = meta;
    }

    // Rule legend (price ratio + effective peak weekdays), updated with the config/language
    var lastLegend = null;
    function updateLegend() {
      if (host === null || els === null) return;
      var text = tt("legend", { ratio: ratioLabel(cfg.offPeakRatio), weekdays: weekdayLabel(cfg.peakWeekdays) });
      if (text !== lastLegend) {
        lastLegend = text;
        els.legend.textContent = text;
      }
    }

    // Static labels (re-rendered on language switch): title, language button, collapse button, balance section title, refresh button.
    // The language button shows **the language that clicking will switch to** (a Chinese UI shows EN, an English UI shows 中).
    function applyLabels() {
      if (host === null || els === null) return;
      els.titleText.textContent = tt("title");
      els.collapse.setAttribute("aria-label", tt("collapse"));
      var toZh = displayLang() !== "zh";
      els.lang.textContent = toZh ? "中" : "EN";
      els.lang.title = toZh ? tt("switchTo.zh") : tt("switchTo.en");
      els.lang.setAttribute("aria-label", els.lang.title);
      els.quotaLabel.textContent = tt("balanceTitle");
      els.refresh.textContent = refreshingNow ? tt("refreshing") : tt("refresh");
      host.setAttribute("aria-label", tt("title"));
      updateLegend();
    }

    // ---------- State polling ----------
    function applyConfig(next) {
      if (!next || typeof next !== "object") return;
      if (next.enabled === false) { dispose(); return; }
      var changed = false;
      if (typeof next.pollMs === "number" && next.pollMs !== cfg.pollMs) {
        cfg.pollMs = next.pollMs;
        changed = true;
      }
      if (Array.isArray(next.peakHours)) {
        var valid = next.peakHours
          .filter(function (p) { return p && Number.isInteger(p.start) && Number.isInteger(p.end) && p.start < p.end; })
          .map(function (p) { return { start: p.start, end: p.end }; });
        if (valid.length > 0 && JSON.stringify(valid) !== JSON.stringify(cfg.peakHours)) {
          cfg.peakHours = valid;
          changed = true;
        }
      }
      if (Array.isArray(next.peakWeekdays)) {
        var days = next.peakWeekdays
          .filter(function (d) { return Number.isInteger(d) && d >= 1 && d <= 7; })
          .sort(function (a, b) { return a - b; });
        // Compare after de-duplication (the server already sorts and de-duplicates; this is a safety net)
        var unique = days.filter(function (d, i) { return i === 0 || d !== days[i - 1]; });
        if (JSON.stringify(unique) !== JSON.stringify(cfg.peakWeekdays)) {
          cfg.peakWeekdays = unique;
          changed = true;
        }
      }
      if (Number.isFinite(next.offPeakRatio) && next.offPeakRatio > 0 && next.offPeakRatio <= 1
        && next.offPeakRatio !== cfg.offPeakRatio) {
        cfg.offPeakRatio = next.offPeakRatio;
        changed = true;
      }
      if (changed) {
        if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
        if (!disposed) pollTimer = setInterval(pollState, cfg.pollMs);
        applyLabels(); // rule change → refresh the legend + dial immediately
        if (host !== null) { lastArcAt = 0; tick(Date.now()); }
      }
    }
    function pollState(force) {
      if (disposed) return Promise.resolve();
      return fetch(STATE_PATH + (force ? "?refresh=1" : ""), { cache: "no-store" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (body) {
          if (disposed) return;
          applyConfig(body && body.config);
          quota = body && body.quota ? body.quota : quota;
          failStreak = 0;
          renderQuota();
        })
        .catch(function (err) {
          if (disposed) return;
          failStreak += 1;
          if (failStreak >= 3) {
            els.rows.innerHTML = '<div class="qc-err">⚠ ' + esc(tt("offline")) + esc(err && err.message ? err.message : err) + '</div>';
          }
        });
    }

    // ---------- Dragging ----------
    function setupDrag() {
      var startX = 0, startY = 0, origX = 0, origY = 0, dragging = false;
      var header = els.header;
      header.addEventListener("pointerdown", function (e) {
        if (e.target && e.target.closest && e.target.closest(".qc-collapse, .qc-lang")) return;
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        var rect = host.getBoundingClientRect();
        origX = rect.left; origY = rect.top;
        header.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      header.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        var x = origX + (e.clientX - startX);
        var y = origY + (e.clientY - startY);
        x = Math.max(4, Math.min(x, window.innerWidth - host.offsetWidth - 4));
        y = Math.max(4, Math.min(y, window.innerHeight - host.offsetHeight - 4));
        host.style.left = x + "px";
        host.style.top = y + "px";
        host.style.right = "auto";
        host.style.bottom = "auto";
      });
      var end = function () {
        if (!dragging) return;
        dragging = false;
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({ x: parseFloat(host.style.left), y: parseFloat(host.style.top) }));
        } catch (err) { /* ignored when localStorage is unavailable */ }
      };
      header.addEventListener("pointerup", end);
      header.addEventListener("pointercancel", end);
    }

    // ---------- Mount / unmount ----------
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (clockTimer !== null) clearInterval(clockTimer);
      if (pollTimer !== null) clearInterval(pollTimer);
      if (localeRetry !== null) clearInterval(localeRetry);
      clockTimer = null;
      pollTimer = null;
      localeRetry = null;
      if (styleTag !== null && styleTag.parentNode) styleTag.parentNode.removeChild(styleTag);
      if (host !== null && host.parentNode) host.parentNode.removeChild(host);
      styleTag = null;
      host = null;
      lastLegend = null;
    }

    // ---------- Official locale service wiring ----------
    // locale may only be provided after apply (client plugin load order), so here we "wire it up as soon as it is available":
    // while absent, render using the browser language and retry briefly, so that "switching the UI language has no effect on the widget" never happens.
    function readLocale() {
      if (clientCtx === null) return null;
      try {
        var svc = clientCtx.locale;
        return (svc && typeof svc.register === "function") ? svc : null;
      } catch (err) {
        return null; // the cordis proxy may throw while the service is not yet provided
      }
    }
    function syncLang(svc) {
      try {
        var snap = svc.getSnapshot();
        if (snap && typeof snap.active === "string" && snap.active.length > 0) lang = snap.active;
      } catch (err) { /* keep the current language */ }
    }
    /** Wire up the official locale service: register dictionaries, bind t, obtain the switch write surface, subscribe to changes. @returns whether it was wired up */
    function adoptLocale() {
      var svc = readLocale();
      if (svc === null) return false;
      localeRef = svc;
      if (!dictRegistered) {
        dictRegistered = true;
        try {
          var register = function () { return svc.register(LOCALE_NS, { zh: ZH, en: EN }); };
          if (clientCtx !== null && typeof clientCtx.effect === "function") {
            clientCtx.effect(register, "quota-clock: locale dictionaries");
          } else {
            register();
          }
        } catch (err) {
          console.warn("[quota-clock] locale dictionary registration failed; falling back to the built-in dictionaries", err);
        }
      }
      if (t === null && typeof svc.bind === "function") {
        try { t = svc.bind(LOCALE_NS); } catch (err) { t = null; }
      }
      if (typeof svc.setLocale === "function") {
        setLocale = function (id) { return svc.setLocale(id); };
      }
      syncLang(svc);
      if (!localeSubscribed && typeof svc.subscribe === "function") {
        localeSubscribed = true;
        try {
          var unsubscribe = svc.subscribe(function () {
            syncLang(svc);
            applyLabels();
            renderQuota();
            if (!disposed && host !== null) tick(Date.now());
          });
          if (clientCtx !== null && typeof clientCtx.effect === "function") {
            clientCtx.effect(function () { return unsubscribe; }, "quota-clock: locale re-render");
          }
        } catch (err) {
          localeSubscribed = false;
        }
      }
      return true;
    }
    /** Local language override for this widget only (fallback when the official write surface is unavailable or does not really take effect). */
    function applyLocalLang(next) {
      manualLang = next;
      try { localStorage.setItem(LANG_KEY, next); } catch (err) { /* ignored */ }
      applyLabels();
      renderQuota();
      if (!disposed && host !== null) tick(Date.now());
    }
    /**
     * Widget language button: switch to next.
     * Prefer writing the official locale preference (switches the whole UI + widget together, the same write surface as the language row in Settings);
     * when the write is rejected or the service misbehaves (so it does not really take effect), fall back to a local override — so the button "always switches".
     */
    function switchLang(next) {
      if (typeof setLocale === "function") {
        var requested = false;
        try { setLocale(next); requested = true; } catch (err) { requested = false; }
        if (requested) {
          setTimeout(function () {
            if (disposed) return;
            var active = null;
            try {
              if (localeRef !== null) {
                var snap = localeRef.getSnapshot();
                active = snap ? snap.active : null;
              }
            } catch (err) { active = null; }
            if (active === next) {
              // official preference took effect: hand control back to the service as the single source of truth (clear any leftover local override)
              manualLang = null;
              try { localStorage.removeItem(LANG_KEY); } catch (err) { /* ignored */ }
              syncLang(localeRef);
            } else {
              // no effect (write rejected / service error) → local override, so at least the widget switches
              manualLang = next;
              try { localStorage.setItem(LANG_KEY, next); } catch (err) { /* ignored */ }
            }
            applyLabels();
            renderQuota();
            if (host !== null) tick(Date.now());
          }, 150);
          return;
        }
      }
      applyLocalLang(next);
    }

    function apply(ctx) {
      if (document.querySelector("[data-quota-clock]") !== null) {
        console.warn("[quota-clock] apply found an existing instance; skipping the duplicate mount");
        return function () {};
      }
      clientCtx = ctx && typeof ctx === "object" ? ctx : {};
      if (!adoptLocale()) {
        // Service not yet provided (plugin load order): render with the browser language first and retry briefly,
        // then automatically wire up "follow the UI language + widget switching" once it is available.
        lang = detectLang();
        var attempts = 0;
        localeRetry = setInterval(function () {
          attempts += 1;
          if (adoptLocale()) {
            clearInterval(localeRetry);
            localeRetry = null;
            applyLabels();
            renderQuota();
            if (host !== null) tick(Date.now());
            return;
          }
          if (disposed || attempts >= 30) {
            clearInterval(localeRetry);
            localeRetry = null;
          }
        }, 500);
      }
      var build = function () {
        if (disposed || document.querySelector("[data-quota-clock]") !== null) return;
        styleTag = document.createElement("style");
        styleTag.textContent = CSS;
        document.head.appendChild(styleTag);
        host = document.createElement("div");
        host.setAttribute("data-quota-clock", "");
        host.setAttribute("role", "complementary");
        var body = document.createElement("div");
        body.className = "qc-body";
        body.innerHTML =
          '<div class="qc-clock-wrap">'
          + '<div class="qc-digital">'
          + '<div class="qc-local">--:--:--</div>'
          + '<div class="qc-local-sub"></div>'
          + '<div class="qc-bj-row"><span class="qc-bj">--:--:--</span><span class="qc-status qc-off"></span></div>'
          + '<div class="qc-next"></div>'
          + '<div class="qc-legend"></div>'
          + '</div>'
          + '</div>'
          + '<div class="qc-divider"></div>'
          + '<div class="qc-quota">'
          + '<div class="qc-quota-title"><b class="qc-quota-label"></b><button class="qc-refresh" type="button"></button></div>'
          + '<div class="qc-rows"></div>'
          + '<div class="qc-meta"></div>'
          + '</div>';
        var header = document.createElement("div");
        header.className = "qc-header";
        header.innerHTML =
          '<span class="qc-title"><span class="qc-dot qc-off"></span><span class="qc-title-text"></span></span>'
          + '<button class="qc-lang" type="button"></button>'
          + '<button class="qc-collapse" type="button">–</button>';
        host.appendChild(header);
        host.appendChild(body);
        var clockBox = body.querySelector(".qc-clock-wrap");
        clockBox.insertBefore(buildClock(), clockBox.firstChild);
        document.body.appendChild(host);
        els = {
          header: header,
          dot: header.querySelector(".qc-dot"),
          collapse: header.querySelector(".qc-collapse"),
          lang: header.querySelector(".qc-lang"),
          titleText: header.querySelector(".qc-title-text"),
          localTime: body.querySelector(".qc-local"),
          localSub: body.querySelector(".qc-local-sub"),
          bjTime: body.querySelector(".qc-bj"),
          status: body.querySelector(".qc-status"),
          next: body.querySelector(".qc-next"),
          legend: body.querySelector(".qc-legend"),
          quotaLabel: body.querySelector(".qc-quota-label"),
          refresh: body.querySelector(".qc-refresh"),
          rows: body.querySelector(".qc-rows"),
          meta: body.querySelector(".qc-meta"),
        };
        // Remember position / collapsed state
        try {
          var raw = JSON.parse(localStorage.getItem(POS_KEY) || "null");
          if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
            host.style.left = Math.max(4, Math.min(raw.x, window.innerWidth - host.offsetWidth - 4)) + "px";
            host.style.top = Math.max(4, Math.min(raw.y, window.innerHeight - host.offsetHeight - 4)) + "px";
            host.style.right = "auto";
            host.style.bottom = "auto";
          }
          if (localStorage.getItem(COLLAPSED_KEY) === "1") {
            body.style.display = "none";
            els.collapse.textContent = "+";
          }
        } catch (err) { /* ignored when localStorage is unavailable */ }
        els.collapse.addEventListener("click", function () {
          var hidden = body.style.display === "none";
          body.style.display = hidden ? "" : "none";
          els.collapse.textContent = hidden ? "–" : "+";
          try { localStorage.setItem(COLLAPSED_KEY, hidden ? "0" : "1"); } catch (err) { /* ignored */ }
        });
        // Language switching on the widget: the button shows "the language it will switch to when clicked" (a Chinese UI shows EN and vice versa).
        els.lang.addEventListener("click", function () {
          switchLang(displayLang() === "zh" ? "en" : "zh");
        });
        els.refresh.addEventListener("click", function () {
          refreshingNow = true;
          els.refresh.disabled = true;
          els.refresh.textContent = tt("refreshing");
          pollState(true).finally(function () {
            refreshingNow = false;
            els.refresh.disabled = false;
            els.refresh.textContent = tt("refresh");
          });
        });
        setupDrag();
        // Restore the local override only when there is no official language write surface (to avoid diverging from the service preference).
        if (setLocale === null) {
          try {
            var storedLang = localStorage.getItem(LANG_KEY);
            if (storedLang === "zh" || storedLang === "en") manualLang = storedLang;
          } catch (err) { /* ignored */ }
        }
        applyLabels();
        renderQuota();
        lastArcAt = 0;
        redrawArcs(Date.now());
        clockTimer = setInterval(function () { tick(Date.now()); }, TICK_MS);
        pollTimer = setInterval(pollState, cfg.pollMs);
        tick(Date.now());
        pollState(false);
      };
      if (document.body) build();
      else document.addEventListener("DOMContentLoaded", build, { once: true });
      return dispose;
    }

    exports.name = "quota-clock";
    exports.apply = apply;
    exports.inject = ["locale"];
    return module.exports;
  }
});
