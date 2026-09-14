# dsh_plugin_quota-clock

**English** | [中文](#中文)

A DSH Web GUI plugin: **remaining DeepSeek API balance** plus a **24-hour clock** whose dial marks the Beijing-time peak-pricing windows in red and converts them to your local time. Peak pricing applies on **Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing time**; off-peak costs half the peak price.

> Repository: <https://github.com/kevin-zhengzzh/quota-clock> · License: MIT · Scope: DSH Web (`dsh.client.platform = web`, verified on `@deepseek-ai/dsh@0.1.5-rc.2`)

## Features

- **💰 Remaining balance** — calls DeepSeek's official `GET /user/balance` (Bearer API key) and shows total, granted and topped-up amounts, account availability and the last update time; the **⟳ Refresh** button forces a re-fetch.
- **⏱ 24-hour clock** — three hands in local time, with a digital readout of your local time, the **Beijing weekday** and Beijing time. The dial maps the Beijing peak windows (default `09:00–12:00` and `14:00–18:00`, **weekdays only**) into **your local timezone** and paints them as **red arcs**; the green ring is off-peak and a Beijing weekend has no red arc at all.
- **Status line** — a live "Peak / Off-peak" badge (red/green) plus the countdown to the next change (e.g. "Peak ends in 47 min", "Next peak in 2 d 13 h" — weekends are skipped correctly).
- **Pricing legend** — one line describing the active rule, e.g. "Off-peak 50% · Peak Mon–Fri" (ratio and weekdays both come from configuration).
- **Bilingual UI (English / Chinese)** — a **language button** in the widget header shows the language a click will switch to (`EN` while the UI is Chinese, `中` while it is English); the widget also follows **Settings → General → Language** and re-renders instantly. If the locale service is missing or arrives late, the plugin falls back to the browser language and reconnects automatically.
- The floating widget sits in the top-right by default, is **draggable** (position remembered in localStorage) and **collapsible**.

### Pricing rules (current)

| Period | Time (**Beijing time**) | Price |
|---|---|---|
| Peak | **Mon–Fri** `09:00–12:00`, `14:00–18:00` | full price |
| Off-peak | everything else (the remaining weekday hours plus **all of Saturday and Sunday**) | peak price × `0.5` |

Every part of the rule is configurable (see below). The **peak day is decided by the Beijing weekday**: even when it is still Sunday locally, a Beijing Monday 09:00 counts as peak and the red arc is drawn — so cross-timezone results are never wrong.

### Timezone conversion

Beijing is fixed at UTC+8 (no daylight saving). The plugin uses `Intl.DateTimeFormat` with `Asia/Shanghai` to derive the Beijing wall clock and weekday, then maps them onto your browser's local timezone — local midnight crossings, DST boundaries and weekend boundaries are all handled. With a New York (EDT) browser, for example, Beijing Mon 09:00–12:00 / 14:00–18:00 appears as local `21:00–24:00` / `02:00–06:00` red arcs, while Beijing Saturday and Sunday have no red arc at all.

### Language switching

The **language button** at the right of the widget header shows the language a click will switch to — `EN` while the UI is Chinese and `中` while it is English; its tooltip reads "Switch to … (UI and widget)".

- It calls the official `locale.setLocale()` first — the same language preference as **Settings → General → Language** (same write path) — so **the whole UI and the widget switch together** and the choice is persisted (it survives a different browser or machine).
- Within 150 ms it **verifies the switch actually took effect**: if the official write was rejected or the service misbehaved (`active` unchanged) it falls back to a **widget-local override** stored in `localStorage` (`quota-clock:lang`), so the button always switches something. As soon as an official write does take effect, the local override is cleared and the service stays the single source of truth.
- If the plugin **loads before the locale service exists**, it renders with the browser language and retries briefly (every 500 ms, up to 30 times), then registers its dictionaries, binds `t` and subscribes — so "the UI language switch does nothing to the widget" cannot happen.
- All widget copy goes through the official client `locale` service (namespace `quota-clock`, `zh`/`en` dictionaries): `lib/client.js` exports `inject: ["locale"]` and `package.json` declares `dsh.client.inject: ["@deepseek-ai/dsh-client-locale"]`, then subscribes via `locale.subscribe` — switching from the widget or from Settings re-renders immediately (title, status, durations, weekdays, balance block, ARIA labels).
- With no locale service at all it falls back to `navigator.languages` (`zh*` → Chinese, otherwise English).

Node-half errors are delivered as structured codes (`missing_key` / `http` / `timeout` / `network`) and rendered by the client in the current language.

## Installation

### From GitHub (recommended)

```sh
dsh plugin --profile web add github:kevin-zhengzzh/quota-clock
# then restart DSH Web (Node-half loader entries are fixed at startup)
```

`dsh plugin` forwards to pnpm inside the profile directory: it installs the package and appends any dependency declaring `dsh.bundle` to the `dsh.profile.bundles` layer stack. pnpm also installs the plugin's own dependency (`schemastery`); this plugin has **no build step** (the client bundle is hand-written source), so no `allowBuilds` approval is required.

### Local development (directory link)

```sh
# 1. install the plugin's own dependency (schemastery)
cd <plugin dir>
pnpm install

# 2. add it to the web profile (equal to dsh plugin --profile web add <plugin dir>)
cd <DSH_HOME>/profiles/web          # e.g. ~/.dsh/profiles/web
pnpm install
```

The web profile's `package.json` must declare:

- `dependencies.dsh_plugin_quota-clock`: `link:<absolute path to the plugin>`
- `dsh.profile.bundles`: append `"quota-clock"`

How changes take effect is described under "Development notes" below (the client half hot-reloads; the Node half and `package.json` need a restart).

## Configuration

The plugin registers the `quota-clock` settings namespace (Settings → Plugins):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Render the widget (disabling it unmounts the component) |
| `pollMs` | `10000` | Client polling interval for `/quota-clock/state` (ms) |
| `quotaRefreshMs` | `60000` | TTL for re-fetching the balance API in the Node half (ms) |
| `peakHours` | `[{9,12},{14,18}]` | Peak windows in Beijing hours (`end` may be 24 for a window crossing midnight) |
| `peakWeekdays` | `[1,2,3,4,5]` | Beijing weekdays the peak applies to (ISO: 1=Mon … 7=Sun); an empty array means off-peak all the time |
| `offPeakRatio` | `0.5` | Off-peak price / peak price (`0.5` renders as "5 折" / "50%") |

The API key and gateway URL are reused from `llm-deepseek` (`DEEPSEEK_API_KEY` set on the **Settings → Models** page or in `.credentials.yaml`; `$DEEPSEEK_BASE_URL` can override the endpoint). Without a configured key the plugin still runs and the balance block shows a hint instead.

## Layout

```
lib/index.mjs             Node half: balance fetching (credential resolution, TTL cache, single-flight) + the /quota-clock/state route + settings registration
lib/client.js             Browser bundle (hand-written source, zero dependencies): 24-hour clock with weekday peak arcs + balance widget + zh/en dictionaries + language button
cordis.patch.yml          Bundle mount patch (inserts itself into the web composition)
scripts/smoke-test.mjs    Node-half smoke test (schema / validation / rule defaults)
scripts/verify-i18n.mjs   Dictionary completeness + bundle contract + locale wiring + language button
scripts/verify-time.mjs   Pricing rules and timezone conversion (weekdays, weekends, across weekends, cross-timezone)
LICENSE / .gitignore / .gitattributes
```

Tests:

```sh
npm test                                # runs all three scripts in order
npm run test:time                       # pricing rules only
TZ=America/New_York npm run test:time   # verify the conversion under another local timezone
```

## Development notes

- API contract: `GET /quota-clock/state` → `{ quota: { isAvailable, balances[], fetchedAt, error, stale }, config: { enabled, pollMs, quotaRefreshMs, peakHours, peakWeekdays, offPeakRatio, revision } }`; `?refresh=1` forces a balance re-fetch.
- `quota.error` is a structured object `{ code, status, detail }` or `null`; the client also tolerates the legacy plain-string form.
- Balance data never contains the API key; `/state` is read-only and exposes no write surface.
- `lib/client.js` is **hand-written source** (not a build artifact): plain browser JS with zero imports, effective as soon as it is saved, with no build step.
- Effectiveness: the client bundle is hot-reloaded by the official `client-hmr` (editing `lib/client.js` needs **no restart**, a `Ctrl+F5` at most); editing the Node half (`lib/index.mjs`) or `package.json` requires a **DSH Web restart**.
- With a local `link:` install, the plugin's own dependency (`schemastery`) must be installed in this directory via `pnpm install`; a GitHub install gets it installed automatically.

---

<a id="中文"></a>

# 中文文档

DSH Web GUI 插件：**DeepSeek API 剩余额度** + **24 小时时钟**（表盘用红色标出北京时间的收费高峰时段，自动换算成你的本地时间；高峰为北京时间周一至周五 `09:00–12:00`、`14:00–18:00`，空闲价为高峰价的一半）。

> 仓库：<https://github.com/kevin-zhengzzh/quota-clock> · 许可：MIT · 适用：DSH Web（`dsh.client.platform = web`，在 `@deepseek-ai/dsh@0.1.5-rc.2` 上验证）

## 功能

- **💰 剩余额度**：调用 DeepSeek 官方 `GET /user/balance` 接口（Bearer API key），显示总余额、赠送额度、充值额度、账户可用状态与更新时间；右上角「⟳ 刷新」可强制重拉。
- **⏱ 24 小时时钟**：本地时间三针（时/分/秒），数字显示本地时间、**北京星期**与北京时间；表盘按**北京时间高峰时段**（默认 `09:00–12:00`、`14:00–18:00`，**仅周一至周五**，其余为空闲）换算成**你所在时区的本地时间**后，用**红色弧段**标出高峰收费区间，绿色环为空闲时段；**北京周末全天无红弧**。
- **状态提示**：实时显示「高峰中 / 空闲」（红/绿徽章）+ 距下次切换的时长（如「距高峰结束 47 分钟」「距下次高峰 2 天 13 小时」——跨周末会正确跳到下一个工作日）。
- **计费图例**：浮窗底部一行说明当前规则，如「空闲价 5 折 · 高峰限周一至周五」（比例与星期都来自配置）。
- **多语言（中文 / English）**：浮窗标题栏有**语言按钮**（显示点击后切到的语言：中文界面显示 `EN`，英文界面显示 `中`）；也跟随 **设置 → 通用 → 语言** 的切换**实时**重渲染（无需刷新页面）；locale 服务缺席或晚到时自动兜底/接上。
- 浮窗默认在右上角，可**拖拽**（位置记忆在 localStorage）、可**折叠**。

### 计费规则（当前）

| 时段 | 时间（**北京时间**） | 价格 |
|---|---|---|
| 高峰 | **周一至周五** `09:00–12:00`、`14:00–18:00` | 原价 |
| 空闲 | 其余全部时间（含工作日其余时段 + **周六、周日全天**） | 高峰价 × `0.5`（5 折） |

规则全部可配（见下表）；「高峰日」按**北京星期**判定——即使本地是周日，只要北京是周一 09:00 就算高峰（红弧照常出现），跨时区不会判错。

### 时区换算说明

北京固定为 UTC+8（无夏令时）。插件用 `Intl.DateTimeFormat` + `Asia/Shanghai` 计算北京墙钟时间与星期，再映射到你浏览器所在的本地时区——跨本地午夜、夏令时边界、周末边界均正确处理。例如本地为纽约（EDT）时，北京周一 09:00–12:00 / 14:00–18:00 会显示为本地 `21:00–24:00` / `02:00–06:00` 的红弧，而北京周六、周日整圈无红弧。

### 语言切换

浮窗标题栏右侧有一个 **语言按钮**，显示的是**点击后会切换到的语言**——中文界面显示 `EN`，英文界面显示 `中`；悬停提示「切换到 …（界面与浮窗）」。

- 优先调用官方 `locale.setLocale()` —— 与 **设置 → 通用 → 语言** 是同一个语言偏好（同一写入面），因此**整个界面与浮窗一起切换**，选择持久化保存（换浏览器/设备也生效）；
- 调用后会在 150ms 内**校验是否真的生效**：若官方写入被拒或服务异常（active 未变），自动退回**仅本浮窗**的本地覆盖并把选择存进 `localStorage`（`quota-clock:lang`）——保证按钮**总能切动**；一旦官方写入生效，本地覆盖会被清除，交回服务作为唯一真值；
- 插件**晚于 locale 服务加载**时会先用浏览器语言渲染并短暂重试（每 500ms，最多 30 次），拿到服务后自动接上「跟随界面语言 + 浮窗切换」——不会出现「界面语言切换对浮窗无效」；
- 浮窗全部文案走官方 client `locale` 服务（namespace `quota-clock`，注册 `zh`/`en` 词典）：`lib/client.js` 导出 `inject: ["locale"]`，`package.json` 声明 `dsh.client.inject: ["@deepseek-ai/dsh-client-locale"]`，并订阅 `locale.subscribe` —— 无论从浮窗还是设置页切换，文案都立即重渲染（标题、状态、时长、星期、额度区、aria 标签）；
- 完全无 locale 服务时按 `navigator.languages` 本地探测（zh* → 中文，否则英文）。

Node half 的错误经结构化错误码（`missing_key` / `http` / `timeout` / `network`）下发，由 client 按当前语言渲染。

## 安装

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:kevin-zhengzzh/quota-clock
# 然后重启 DSH Web（Node half 的 loader 条目在启动时固定）
```

`dsh plugin` 把参数转发给 profile 目录里的 pnpm：安装依赖，并把声明了 `dsh.bundle` 的依赖自动加入 `dsh.profile.bundles` 层栈；pnpm 会同时安装本插件自身的依赖（`schemastery`）——本插件**没有构建脚本**（client bundle 是手写源码），因此不需要 `allowBuilds` 授权。

### 本地开发（目录 link 方式）

```sh
# 1. 安装插件自身依赖（schemastery）
cd <插件目录>
pnpm install

# 2. 加入 web profile（等价于 dsh plugin --profile web add <插件目录>）
cd <DSH_HOME>/profiles/web          # 例如 ~/.dsh/profiles/web
pnpm install
```

web profile 的 `package.json` 需声明：

- `dependencies.dsh_plugin_quota-clock`: `link:<插件目录绝对路径>`
- `dsh.profile.bundles`: 追加 `"quota-clock"`

改动生效方式见文末「开发备注」（client half 热重载、Node half / package.json 需重启）。

## 配置（可选）

插件注册 `quota-clock` 设置命名空间（设置 → 插件），可调整：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 浮窗渲染开关（关掉即卸载组件） |
| `pollMs` | `10000` | 客户端轮询 `/quota-clock/state` 间隔（ms） |
| `quotaRefreshMs` | `60000` | Node half 重拉余额接口的 TTL（ms） |
| `peakHours` | `[{9,12},{14,18}]` | 北京时间高峰时段（`start`/`end` 为北京小时，`end` 可到 24 表示跨午夜） |
| `peakWeekdays` | `[1,2,3,4,5]` | 高峰生效的北京星期（ISO：1=周一 … 7=周日）；空数组 = 全时段空闲 |
| `offPeakRatio` | `0.5` | 空闲价 / 高峰价（0.5 = 半价；图例显示为「5 折」/「50%」） |

API Key 与网关地址复用 llm-deepseek 的配置（`设置 → 模型` 页或 `.credentials.yaml` 中的 `DEEPSEEK_API_KEY`，`$DEEPSEEK_BASE_URL` 可覆盖端点）；未配置时插件照常运行，额度区显示配置提示。

## 结构

```
lib/index.mjs             Node half：余额抓取（credentials 解析 key + 缓存/单飞）+ /quota-clock/state 路由 + 设置注册
lib/client.js             浏览器 bundle（手写即源码，零依赖）：24h 时钟（工作日红弧）+ 额度浮窗 + zh/en 词典 + 语言按钮
cordis.patch.yml          bundle 挂载补丁（insert 自身进 web 组合）
scripts/smoke-test.mjs    Node half 冒烟测试（schema/校验/新规则默认值）
scripts/verify-i18n.mjs   词典键集完整 + bundle 契约 + locale 接线 + 语言按钮接线
scripts/verify-time.mjs   计费规则与时区换算（工作日/周末/跨周末/跨时区）
LICENSE / .gitignore / .gitattributes
```

测试：

```sh
npm test                                # 三个脚本依次跑
npm run test:time                       # 单独跑计费规则
TZ=America/New_York npm run test:time   # 换本地时区验证换算（跨时区断言）
```

## 开发备注

- 接口契约：`GET /quota-clock/state` → `{ quota: { isAvailable, balances[], fetchedAt, error, stale }, config: { enabled, pollMs, quotaRefreshMs, peakHours, peakWeekdays, offPeakRatio, revision } }`；`?refresh=1` 强制重拉余额。
- `quota.error` 为结构化错误对象 `{ code, status, detail }`（或 `null`）；client 兼容旧版纯字符串错误。
- 余额数据绝不含 API key；`/state` 只读、无写面。
- `lib/client.js` 是**手写源码**（不是构建产物）：纯浏览器 JS、零 import，改完即生效，无构建步骤。
- 生效方式：client bundle 由官方 `client-hmr` 轮询热重载（改 `lib/client.js` **无需重启**，必要时 `Ctrl+F5`）；改 Node half（`lib/index.mjs`）或 `package.json` 需**重启 DSH Web**。
- 本地 link 安装时，插件自身依赖（`schemastery`）需在本目录 `pnpm install`；从 GitHub 安装时由 pnpm 自动装好。
