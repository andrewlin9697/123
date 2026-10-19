// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: orange; icon-glyph: tachometer-alt;

// Claude 用量小工具（iOS Scriptable）
//
// 第一次請在 Scriptable App 內執行，依照精靈貼上 claude.ai 的 sessionKey。
// 金鑰只會存在本機的 Scriptable Keychain，並且只會送到 claude.ai。
//
// 小工具參數：
//   （空白）或 5h  → 主要顯示 5 小時用量
//   7d             → 主要顯示每週用量
//
// 資料來源是 claude.ai 用量頁使用的非官方介面，隨時可能改版失效。

const BASE_URL = "https://claude.ai";
const USAGE_PAGE = "https://claude.ai/settings/usage";
const KEY_SESSION = "claude-usage-tw.sessionKey";
const KEY_ORG = "claude-usage-tw.orgId";
const CACHE_FILE = "claude-usage-tw-cache.json";
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIVE_HOURS = 5 * HOUR;
const SEVEN_DAYS = 7 * DAY;
const REFRESH_MS = 5 * MINUTE;
const REQUEST_TIMEOUT_S = 15;
// 台灣時間 UTC+8，沒有日光節約，所以直接位移即可，不依賴裝置時區。
const TAIPEI_OFFSET_MS = 8 * HOUR;
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

// 顏色門檻：未滿 WARN 綠色，WARN～DANGER 橙色，DANGER 以上紅色。
const WARN_PCT = 60;
const DANGER_PCT = 80;
const ALERT_PCT = 80;

const NOTIFY_RESET_ID = "claude-usage-tw.reset";
const NOTIFY_HIGH_PREFIX = "claude-usage-tw.high.";

const ERRORS = {
  "no-key": { title: "尚未設定", hint: "點一下開始設定", short: "未設定" },
  auth: { title: "登入已失效", hint: "請重新貼上 sessionKey", short: "需登入" },
  blocked: { title: "被 Cloudflare 擋下", hint: "稍後會自動重試", short: "被阻擋" },
  network: { title: "無法連線", hint: "稍後會自動重試", short: "離線" },
  "rate-limited": { title: "請求太頻繁", hint: "稍後會自動重試", short: "限流" },
  "no-org": { title: "找不到 Claude 組織", hint: "請確認帳號方案", short: "無組織" },
  "not-found": { title: "找不到組織", hint: "會重新查詢組織 ID", short: "錯誤" },
  http: { title: "伺服器錯誤", hint: "稍後會自動重試", short: "錯誤" },
  parse: { title: "回應格式不符", hint: "介面可能已改版，請更新腳本", short: "格式錯" }
};

class UsageError extends Error {
  constructor(kind, detail) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.kind = ERRORS[kind] ? kind : "http";
    this.detail = detail || "";
  }
}

function errorInfo(kind) {
  return ERRORS[kind] || ERRORS.http;
}

// ---------------------------------------------------------------------------
// 純邏輯（不碰 Scriptable API，方便測試）

function normalizeSessionKey(raw) {
  let key = String(raw || "").trim().replace(/^cookie:\s*/i, "");
  const fromCookie = key.match(/(?:^|;\s*)sessionKey=([^;\s]+)/);
  if (fromCookie) {
    key = fromCookie[1];
  }
  key = key.replace(/^["']+|["']+$/g, "");
  return /^[A-Za-z0-9_-]{20,}$/.test(key) ? key : null;
}

function looksLikeSessionKey(key) {
  return /^sk-ant-sid\d*-/.test(key || "");
}

function isCloudflarePage(body) {
  return /just a moment|cf-chl|challenge-platform|cf-ray|cloudflare/i.test(body || "");
}

function toNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clampPct(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseTime(value) {
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // 秒或毫秒都接受
    return value < 1e12 ? value * 1000 : value;
  }
  return null;
}

function parseWindow(src) {
  if (!src || typeof src !== "object") {
    return null;
  }
  const raw = toNumber(src.utilization ?? src.utilization_pct ?? src.used_pct);
  const resetAt = parseTime(src.resets_at ?? src.reset_at ?? src.resetAt);
  if (raw === null) {
    return null;
  }
  return { percent: clampPct(raw), resetAt };
}

// extra_usage：monthly_limit / used_credits 以「分」為單位（2000 = $20.00），
// 舊格式 budget_limit / current_spending 以「元」為單位。
function parseExtra(src) {
  if (!src || typeof src !== "object") {
    return null;
  }
  const enabled = src.is_enabled ?? src.enabled;
  if (enabled === false) {
    return { enabled: false };
  }
  let limit = toNumber(src.monthly_limit);
  let used = toNumber(src.used_credits);
  if (limit !== null) limit /= 100;
  if (used !== null) used /= 100;
  if (limit === null) limit = toNumber(src.budget_limit);
  if (used === null) used = toNumber(src.current_spending);
  if (used === null && limit === null) {
    return null;
  }
  let percent = toNumber(src.utilization);
  if (percent === null && used !== null && limit) {
    percent = (used / limit) * 100;
  }
  return {
    enabled: true,
    used: used ?? 0,
    limit,
    percent: percent === null ? null : clampPct(percent),
    currency: typeof src.currency === "string" ? src.currency.toUpperCase() : "USD"
  };
}

function normalizeUsage(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const fiveHour = parseWindow(data.five_hour);
  const sevenDay = parseWindow(data.seven_day);
  if (!fiveHour && !sevenDay) {
    return null;
  }
  return { fiveHour, sevenDay, extra: parseExtra(data.extra_usage) };
}

// 帳號可能同時屬於 API 組織，優先選有 claude_max / claude_pro / chat 的。
function pickOrganization(data) {
  const list = Array.isArray(data)
    ? data
    : data && Array.isArray(data.organizations) ? data.organizations : [];
  let best = null;
  let bestScore = -1;
  for (const org of list) {
    if (!org || typeof org !== "object") continue;
    const id = org.uuid || org.id;
    if (typeof id !== "string" || !id) continue;
    const caps = Array.isArray(org.capabilities) ? org.capabilities : [];
    const score = caps.includes("claude_max") ? 3
      : caps.includes("claude_pro") ? 2
      : caps.includes("chat") ? 1
      : 0;
    if (score > bestScore) {
      best = { id, name: typeof org.name === "string" ? org.name : "" };
      bestScore = score;
    }
  }
  return best;
}

function levelFor(percent) {
  if (percent === null || percent === undefined) return "none";
  if (percent >= DANGER_PCT) return "red";
  if (percent >= WARN_PCT) return "orange";
  return "green";
}

// 重置時間已過的視窗視為歸零（快取資料也一樣）。
function currentWindow(win, now) {
  if (!win || win.percent === null) return null;
  if (win.resetAt && now >= win.resetAt) {
    return { percent: 0, resetAt: null, expired: true };
  }
  return win;
}

function sameWindow(a, b) {
  return typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 15 * MINUTE;
}

function recordSample(samples, win, now, keepMs) {
  const list = (Array.isArray(samples) ? samples : []).filter(
    (s) => s && typeof s.t === "number" && now - s.t <= keepMs && s.t <= now
  );
  if (!win || win.percent === null) return list;
  const last = list[list.length - 1];
  if (last && now - last.t < MINUTE) list.pop();
  list.push({ t: now, p: win.percent, r: win.resetAt });
  return list.slice(-500);
}

// 依目前消耗速度預估用完時間。
// 有足夠的近期樣本就用近期速度，否則用「視窗開始到現在」的平均速度。
function predictExhaust(win, lengthMs, samples, now) {
  if (!win || win.percent === null) return { kind: "unknown" };
  const p = win.percent;
  if (p >= 100) return { kind: "full", at: win.resetAt };

  const recentMs = lengthMs / 5;
  const minSpan = recentMs / 6;
  let rate = null; // 每毫秒增加幾 %

  const recent = (samples || [])
    .filter((s) => s && sameWindow(s.r, win.resetAt) && s.t < now && now - s.t <= recentMs)
    .sort((a, b) => a.t - b.t);
  if (recent.length) {
    const first = recent[0];
    const span = now - first.t;
    if (span >= minSpan) {
      rate = Math.max(0, (p - first.p) / span);
    }
  }
  if (rate === null && win.resetAt) {
    const elapsed = now - (win.resetAt - lengthMs);
    if (elapsed >= 5 * MINUTE) {
      rate = p / elapsed;
    }
  }
  if (rate === null) return { kind: "unknown" };
  if (rate <= 0) return { kind: "never" };
  const at = now + (100 - p) / rate;
  if (win.resetAt && at >= win.resetAt) return { kind: "never" };
  return { kind: "at", at };
}

// ---- 時間格式（Asia/Taipei） ----

function taipeiParts(ts) {
  const d = new Date(ts + TAIPEI_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay()
  };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtClock(ts) {
  const p = taipeiParts(ts);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

function taipeiDayIndex(ts) {
  return Math.floor((ts + TAIPEI_OFFSET_MS) / DAY);
}

// 今天 → 14:05；明天 → 明天 14:05；一週內 → 週三 14:05；更久 → 10/23 14:05
function fmtWhen(ts, now) {
  const diff = taipeiDayIndex(ts) - taipeiDayIndex(now);
  const clock = fmtClock(ts);
  if (diff === 0) return clock;
  if (diff === 1) return `明天 ${clock}`;
  const p = taipeiParts(ts);
  if (diff > 1 && diff < 7) return `週${WEEKDAYS[p.weekday]} ${clock}`;
  return `${p.month}/${p.day} ${clock}`;
}

function fmtDuration(ms) {
  if (ms <= 0) return "即將";
  const totalMin = Math.ceil(ms / MINUTE);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小時` : `${days} 天`;
  if (hours > 0) return mins > 0 ? `${hours} 小時 ${mins} 分` : `${hours} 小時`;
  return `${mins} 分`;
}

function fmtDurationShort(ms) {
  if (ms <= 0) return "即將";
  const totalMin = Math.ceil(ms / MINUTE);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}天${hours}時`;
  if (hours > 0) return `${hours}時${pad2(mins)}分`;
  return `${mins}分`;
}

function fmtCountdown(resetAt, now) {
  if (!resetAt) return "尚未開始計時";
  const ms = resetAt - now;
  return ms <= 0 ? "即將重置" : `${fmtDuration(ms)}後重置`;
}

function fmtAgo(ts, now) {
  const ms = Math.max(0, now - ts);
  if (ms < MINUTE) return "剛剛";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} 分鐘前`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} 小時前`;
  return `${Math.floor(ms / DAY)} 天前`;
}

function fmtMoney(amount, currency) {
  const symbols = { USD: "$", TWD: "NT$", EUR: "€", GBP: "£", JPY: "¥" };
  const sym = symbols[currency] || `${currency || ""} `;
  return `${sym}${Number(amount || 0).toFixed(2)}`;
}

function predictionText(pred, now) {
  switch (pred.kind) {
    case "full":
      return pred.at ? `已用完，${fmtWhen(pred.at, now)} 恢復` : "已用完";
    case "never":
      return "照目前速度，重置前用不完";
    case "at":
      return `照目前速度，約 ${fmtWhen(pred.at, now)} 用完`;
    default:
      return "資料不足，暫無預估";
  }
}

function predictionShort(pred, now) {
  switch (pred.kind) {
    case "full": return "已用完";
    case "never": return "重置前用不完";
    case "at": return `約 ${fmtWhen(pred.at, now)} 用完`;
    default: return "";
  }
}

function extraText(extra) {
  if (!extra || !extra.enabled) return null;
  const used = fmtMoney(extra.used, extra.currency);
  if (extra.limit === null || extra.limit === undefined) return `已花 ${used}`;
  return `${used} / ${fmtMoney(extra.limit, extra.currency)}`;
}

function parseParam(raw) {
  const p = String(raw || "").trim().toLowerCase();
  if (["7d", "7", "week", "weekly", "w", "週", "每週", "一週"].includes(p)) return "7d";
  return "5h";
}

// 下次更新：5 分鐘後，或任一視窗重置後 1 分鐘（取較早者）。
function nextRefreshAt(usage, now) {
  let next = now + REFRESH_MS;
  for (const win of [usage && usage.fiveHour, usage && usage.sevenDay]) {
    if (win && win.resetAt && win.resetAt > now) {
      next = Math.min(next, win.resetAt + MINUTE);
    }
  }
  return next;
}

// 計算這次要預約 / 立即送出的通知（純函式，回傳新的通知狀態）。
function planNotifications(notifyState, usage, now) {
  const state = {
    resetFor: null,
    alerted: {},
    ...(notifyState || {}),
  };
  state.alerted = { ...(state.alerted || {}) };
  const schedule = [];
  const immediate = [];
  if (!usage) return { schedule, immediate, state };

  const fh = currentWindow(usage.fiveHour, now);
  if (fh && fh.resetAt && fh.resetAt > now && fh.percent > 0 && !sameWindow(state.resetFor, fh.resetAt)) {
    schedule.push({
      id: NOTIFY_RESET_ID,
      title: "Claude 額度回來了 🎉",
      body: "5 小時用量已重置，可以繼續使用 Claude 了。",
      at: fh.resetAt + 30 * 1000
    });
    state.resetFor = fh.resetAt;
  }

  const windows = [
    ["fiveHour", "5 小時"],
    ["sevenDay", "每週"]
  ];
  for (const [name, label] of windows) {
    const win = currentWindow(usage[name], now);
    if (!win || !win.resetAt || win.percent < ALERT_PCT) continue;
    if (sameWindow(state.alerted[name], win.resetAt)) continue;
    immediate.push({
      id: NOTIFY_HIGH_PREFIX + name,
      title: `Claude ${label}用量已達 ${win.percent}%`,
      body: `${fmtCountdown(win.resetAt, now)}（${fmtWhen(win.resetAt, now)}），請斟酌使用。`
    });
    state.alerted[name] = win.resetAt;
  }
  return { schedule, immediate, state };
}

// 把 API 結果合併進快取狀態。
function applySuccess(state, result, now) {
  const next = { ...(state || {}) };
  next.usage = result.usage;
  next.fetchedAt = now;
  next.orgName = result.orgName || next.orgName || "";
  next.lastError = null;
  next.samples5h = recordSample(next.samples5h, result.usage.fiveHour, now, 6 * HOUR);
  next.samples7d = recordSample(next.samples7d, result.usage.sevenDay, now, 8 * DAY);
  return next;
}

// 依快取狀態整理出畫面要用的資料。
function buildView(state, now, error) {
  const usage = state && state.usage;
  const fh = usage ? currentWindow(usage.fiveHour, now) : null;
  const sd = usage ? currentWindow(usage.sevenDay, now) : null;
  const make = (win, lengthMs, samples, label) => {
    if (!win) return null;
    const pred = predictExhaust(win, lengthMs, samples, now);
    return {
      label,
      percent: win.percent,
      resetAt: win.resetAt,
      level: levelFor(win.percent),
      countdown: fmtCountdown(win.resetAt, now),
      countdownShort: win.resetAt ? `${fmtDurationShort(win.resetAt - now)}後重置` : "未計時",
      resetWhen: win.resetAt ? fmtWhen(win.resetAt, now) : null,
      prediction: pred,
      predictionText: predictionText(pred, now),
      predictionShort: predictionShort(pred, now)
    };
  };
  return {
    hasData: !!(fh || sd),
    fiveHour: make(fh, FIVE_HOURS, state && state.samples5h, "5 小時"),
    sevenDay: make(sd, SEVEN_DAYS, state && state.samples7d, "每週"),
    extra: usage ? usage.extra : null,
    extraText: usage ? extraText(usage.extra) : null,
    fetchedAt: state && state.fetchedAt,
    updatedText: state && state.fetchedAt ? `上次更新 ${fmtAgo(state.fetchedAt, now)}` : "尚未更新",
    error: error || null,
    stale: !!error && !!(state && state.fetchedAt)
  };
}

// ---------------------------------------------------------------------------
// claude.ai 非官方介面

async function apiGet(path, sessionKey) {
  const req = new Request(BASE_URL + path);
  req.method = "GET";
  req.timeoutInterval = REQUEST_TIMEOUT_S;
  req.headers = {
    Cookie: `sessionKey=${sessionKey}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    Referer: `${BASE_URL}/settings/usage`,
    Origin: BASE_URL
  };

  let body;
  try {
    body = await req.loadString();
  } catch (e) {
    throw new UsageError("network", e && e.message);
  }

  const status = req.response && req.response.statusCode ? req.response.statusCode : 0;
  if (status === 401) throw new UsageError("auth", "HTTP 401");
  if (status === 403) throw new UsageError(isCloudflarePage(body) ? "blocked" : "auth", "HTTP 403");
  if (status === 404) throw new UsageError("not-found", "HTTP 404");
  if (status === 429) throw new UsageError("rate-limited", "HTTP 429");
  if (status < 200 || status >= 300) {
    throw new UsageError(status === 0 ? "network" : "http", `HTTP ${status}`);
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new UsageError(isCloudflarePage(body) ? "blocked" : "parse", "回應不是 JSON");
  }
}

async function resolveOrganization(sessionKey) {
  const org = pickOrganization(await apiGet("/api/organizations", sessionKey));
  if (!org) throw new UsageError("no-org");
  return org;
}

async function fetchUsageFor(orgId, sessionKey) {
  const usage = normalizeUsage(
    await apiGet(`/api/organizations/${encodeURIComponent(orgId)}/usage`, sessionKey)
  );
  if (!usage) throw new UsageError("parse", "找不到 five_hour / seven_day 欄位");
  return usage;
}

async function fetchUsage(sessionKey, orgId) {
  if (orgId) {
    try {
      return { orgId, usage: await fetchUsageFor(orgId, sessionKey) };
    } catch (e) {
      // 快取的組織可能已失效（換帳號、離開團隊），重新查一次。
      if (e.kind !== "not-found" && e.kind !== "auth") throw e;
    }
  }
  const org = await resolveOrganization(sessionKey);
  return { orgId: org.id, orgName: org.name, usage: await fetchUsageFor(org.id, sessionKey) };
}

// ---------------------------------------------------------------------------
// 儲存（Keychain 存金鑰，檔案存非機密的快取）

function readSecret(key) {
  try {
    return Keychain.contains(key) ? Keychain.get(key) : null;
  } catch (e) {
    return null;
  }
}

function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.documentsDirectory(), CACHE_FILE) };
}

function loadState() {
  try {
    const { fm, path } = cachePath();
    if (!fm.fileExists(path)) return {};
    const data = JSON.parse(fm.readString(path));
    return data && typeof data === "object" ? data : {};
  } catch (e) {
    return {};
  }
}

function saveState(state) {
  try {
    const { fm, path } = cachePath();
    fm.writeString(path, JSON.stringify(state));
  } catch (e) {
    // 快取寫不進去不影響顯示
  }
}

function resetCredentials() {
  for (const key of [KEY_SESSION, KEY_ORG]) {
    try {
      if (Keychain.contains(key)) Keychain.remove(key);
    } catch (e) {
      // 忽略
    }
  }
  try {
    const { fm, path } = cachePath();
    if (fm.fileExists(path)) fm.remove(path);
  } catch (e) {
    // 忽略
  }
}

// 抓最新資料；失敗時保留上次成功的資料並記錄錯誤。
async function refresh(now) {
  let state = loadState();
  const sessionKey = readSecret(KEY_SESSION);
  if (!sessionKey) {
    return { state, error: new UsageError("no-key") };
  }
  let error = null;
  try {
    const result = await fetchUsage(sessionKey, readSecret(KEY_ORG));
    if (result.orgId && result.orgId !== readSecret(KEY_ORG)) {
      Keychain.set(KEY_ORG, result.orgId);
    }
    state = applySuccess(state, result, now);
  } catch (e) {
    error = e instanceof UsageError ? e : new UsageError("network", e && e.message);
    state.lastError = { kind: error.kind, at: now };
  }
  await applyNotifications(state, now);
  saveState(state);
  return { state, error };
}

async function applyNotifications(state, now) {
  const plan = planNotifications(state.notify, state.usage, now);
  for (const item of plan.schedule) {
    try {
      await Notification.removePending([item.id]);
      const n = new Notification();
      n.identifier = item.id;
      n.title = item.title;
      n.body = item.body;
      n.sound = "default";
      n.setTriggerDate(new Date(item.at));
      await n.schedule();
    } catch (e) {
      // 通知失敗不影響小工具
    }
  }
  for (const item of plan.immediate) {
    try {
      const n = new Notification();
      n.identifier = item.id;
      n.title = item.title;
      n.body = item.body;
      n.sound = "default";
      await n.schedule();
    } catch (e) {
      // 通知失敗不影響小工具
    }
  }
  state.notify = plan.state;
  return plan;
}

// ---------------------------------------------------------------------------
// 繪圖

const PALETTE = {
  bg: () => Color.dynamic(new Color("#FAF9F5"), new Color("#1F1E1D")),
  text: () => Color.dynamic(new Color("#1F1E1D"), new Color("#F5F4EF")),
  dim: () => Color.dynamic(new Color("#6B6A64"), new Color("#A3A29C")),
  track: () => Color.dynamic(new Color("#E6E4DC"), new Color("#3A3936")),
  accent: () => new Color("#D97757"),
  green: () => Color.dynamic(new Color("#2E9E5B"), new Color("#4CC27A")),
  orange: () => Color.dynamic(new Color("#E08A00"), new Color("#FFB23F")),
  red: () => Color.dynamic(new Color("#D64545"), new Color("#FF6B6B"))
};

function levelColor(level) {
  if (level === "red") return PALETTE.red();
  if (level === "orange") return PALETTE.orange();
  if (level === "green") return PALETTE.green();
  return PALETTE.dim();
}

// 進度條圖片。DrawContext 不支援動態色，所以依目前外觀選色。
function barImage(percent, width, height, level, accessory) {
  const dark = isDark();
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const track = accessory ? new Color("#FFFFFF", 0.3) : new Color(dark ? "#3A3936" : "#E6E4DC");
  const fill = accessory ? new Color("#FFFFFF") : new Color(staticLevelHex(level, dark));
  const r = height / 2;
  const trackPath = new Path();
  trackPath.addRoundedRect(new Rect(0, 0, width, height), r, r);
  ctx.addPath(trackPath);
  ctx.setFillColor(track);
  ctx.fillPath();
  const p = Math.max(0, Math.min(100, percent || 0));
  if (p > 0) {
    const w = Math.max(height, (width * p) / 100);
    const fillPath = new Path();
    fillPath.addRoundedRect(new Rect(0, 0, w, height), r, r);
    ctx.addPath(fillPath);
    ctx.setFillColor(fill);
    ctx.fillPath();
  }
  return ctx.getImage();
}

function staticLevelHex(level, dark) {
  const map = {
    green: dark ? "#4CC27A" : "#2E9E5B",
    orange: dark ? "#FFB23F" : "#E08A00",
    red: dark ? "#FF6B6B" : "#D64545"
  };
  return map[level] || (dark ? "#A3A29C" : "#6B6A64");
}

function isDark() {
  try {
    return Device.isUsingDarkAppearance();
  } catch (e) {
    return false;
  }
}

// 鎖定畫面圓環：外圈進度＋中間百分比與標籤。
function ringImage(percent, label) {
  const size = 120;
  const line = 12;
  const ctx = new DrawContext();
  ctx.size = new Size(size, size);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const c = size / 2;
  const radius = c - line / 2 - 2;
  const arc = (from, to) => {
    const path = new Path();
    const pts = [];
    const steps = Math.max(2, Math.ceil((to - from) / 3));
    for (let i = 0; i <= steps; i++) {
      const deg = from + ((to - from) * i) / steps;
      const rad = ((deg - 90) * Math.PI) / 180;
      pts.push(new Point(c + radius * Math.cos(rad), c + radius * Math.sin(rad)));
    }
    path.addLines(pts);
    return path;
  };
  ctx.setLineWidth(line);
  ctx.addPath(arc(0, 360));
  ctx.setStrokeColor(new Color("#FFFFFF", 0.3));
  ctx.strokePath();
  const p = Math.max(0, Math.min(100, percent || 0));
  if (p > 0) {
    ctx.addPath(arc(0, (360 * p) / 100));
    ctx.setStrokeColor(new Color("#FFFFFF"));
    ctx.strokePath();
  }
  ctx.setTextAlignedCenter();
  ctx.setTextColor(new Color("#FFFFFF"));
  ctx.setFont(Font.boldRoundedSystemFont(34));
  ctx.drawTextInRect(percent === null ? "--" : `${percent}`, new Rect(0, 32, size, 42));
  ctx.setFont(Font.semiboldSystemFont(17));
  ctx.drawTextInRect(label, new Rect(0, 72, size, 22));
  return ctx.getImage();
}

function addText(stack, text, font, color, opts) {
  const t = stack.addText(text);
  t.font = font;
  if (color) t.textColor = color;
  t.lineLimit = (opts && opts.lines) || 1;
  t.minimumScaleFactor = (opts && opts.scale) || 0.7;
  return t;
}

function statusLine(view, now) {
  if (view.stale) {
    const info = errorInfo(view.error.kind);
    return `⚠️ ${info.short}・${fmtAgo(view.fetchedAt, now)}資料`;
  }
  return view.updatedText;
}

function buildErrorWidget(widget, error, family) {
  const info = errorInfo(error ? error.kind : "http");
  if (family === "accessoryInline") {
    widget.addText(`Claude：${info.short}`);
    return widget;
  }
  if (family === "accessoryCircular" || family === "accessoryRectangular") {
    widget.addAccessoryWidgetBackground = family === "accessoryCircular";
    addText(widget, "Claude", Font.boldSystemFont(12));
    addText(widget, family === "accessoryCircular" ? info.short : info.title, Font.systemFont(12));
    if (family === "accessoryRectangular") addText(widget, info.hint, Font.systemFont(11));
    return widget;
  }
  widget.backgroundColor = PALETTE.bg();
  addText(widget, "Claude 用量", Font.boldSystemFont(14), PALETTE.accent());
  widget.addSpacer(6);
  addText(widget, info.title, Font.semiboldSystemFont(15), PALETTE.text(), { lines: 2 });
  widget.addSpacer(2);
  addText(widget, info.hint, Font.systemFont(12), PALETTE.dim(), { lines: 2 });
  widget.addSpacer();
  return widget;
}

function addWindowBlock(stack, win, opts) {
  const head = stack.addStack();
  head.layoutHorizontally();
  head.centerAlignContent();
  addText(head, win.label, Font.semiboldSystemFont(opts.labelSize), PALETTE.dim());
  head.addSpacer();
  stack.addSpacer(2);
  addText(stack, `${win.percent}%`, Font.boldRoundedSystemFont(opts.pctSize), levelColor(win.level));
  stack.addSpacer(3);
  const bar = stack.addImage(barImage(win.percent, opts.barWidth, 6, win.level, false));
  bar.imageSize = new Size(opts.barWidth, 6);
  stack.addSpacer(4);
  const resetText = opts.weekly && win.resetWhen ? `${win.resetWhen} 重置` : win.countdown;
  addText(stack, resetText, Font.mediumSystemFont(opts.infoSize), PALETTE.text());
  if (win.predictionShort) {
    addText(stack, win.predictionShort, Font.systemFont(opts.infoSize - 1), levelColor(win.level));
  }
}

function buildSmall(widget, view, primaryKey, now) {
  widget.backgroundColor = PALETTE.bg();
  widget.setPadding(12, 14, 12, 14);
  const primary = view[primaryKey] || view.fiveHour || view.sevenDay;
  const secondary = primary === view.fiveHour ? view.sevenDay : view.fiveHour;
  const title = widget.addStack();
  title.layoutHorizontally();
  addText(title, "Claude", Font.boldSystemFont(13), PALETTE.accent());
  title.addSpacer();
  addText(title, primary.label, Font.semiboldSystemFont(11), PALETTE.dim());
  widget.addSpacer(4);
  addText(widget, `${primary.percent}%`, Font.boldRoundedSystemFont(30), levelColor(primary.level));
  widget.addSpacer(2);
  const bar = widget.addImage(barImage(primary.percent, 120, 6, primary.level, false));
  bar.imageSize = new Size(120, 6);
  widget.addSpacer(4);
  const resetText = primary === view.sevenDay && primary.resetWhen ? `${primary.resetWhen} 重置` : primary.countdown;
  addText(widget, resetText, Font.mediumSystemFont(11), PALETTE.text());
  if (primary.predictionShort) {
    addText(widget, primary.predictionShort, Font.systemFont(10), levelColor(primary.level));
  }
  widget.addSpacer();
  if (secondary) {
    addText(widget, `${secondary.label} ${secondary.percent}%`, Font.mediumSystemFont(10), levelColor(secondary.level));
  }
  addText(widget, statusLine(view, now), Font.systemFont(9), PALETTE.dim());
}

function buildMedium(widget, view, now) {
  widget.backgroundColor = PALETTE.bg();
  widget.setPadding(12, 14, 12, 14);
  const title = widget.addStack();
  title.layoutHorizontally();
  title.centerAlignContent();
  addText(title, "Claude 用量", Font.boldSystemFont(13), PALETTE.accent());
  title.addSpacer();
  addText(title, statusLine(view, now), Font.systemFont(10), PALETTE.dim());
  widget.addSpacer(6);

  const row = widget.addStack();
  row.layoutHorizontally();
  const blocks = [view.fiveHour, view.sevenDay];
  blocks.forEach((win, i) => {
    const col = row.addStack();
    col.layoutVertically();
    if (win) {
      addWindowBlock(col, win, {
        labelSize: 11, pctSize: 26, infoSize: 11, barWidth: 135, weekly: win === view.sevenDay
      });
    } else {
      addText(col, i === 0 ? "5 小時" : "每週", Font.semiboldSystemFont(11), PALETTE.dim());
      addText(col, "無資料", Font.systemFont(12), PALETTE.dim());
    }
    if (i === 0) row.addSpacer(14);
  });
  widget.addSpacer();
  if (view.extraText) {
    const ex = widget.addStack();
    ex.layoutHorizontally();
    addText(ex, "使用量額度", Font.semiboldSystemFont(10), PALETTE.dim());
    ex.addSpacer(6);
    const pct = view.extra.percent !== null ? `（${view.extra.percent}%）` : "";
    addText(ex, `${view.extraText}${pct}`, Font.mediumSystemFont(10), levelColor(levelFor(view.extra.percent)));
    ex.addSpacer();
  }
}

function buildCircular(widget, view, primaryKey) {
  widget.addAccessoryWidgetBackground = true;
  const win = view[primaryKey] || view.fiveHour || view.sevenDay;
  const label = win === view.sevenDay ? "週" : "5h";
  const img = widget.addImage(ringImage(win.percent, label));
  img.imageSize = new Size(60, 60);
  img.centerAlignImage();
}

function buildRectangular(widget, view, primaryKey, now) {
  const primary = view[primaryKey] || view.fiveHour || view.sevenDay;
  const secondary = primary === view.fiveHour ? view.sevenDay : view.fiveHour;
  const head = widget.addStack();
  head.layoutHorizontally();
  addText(head, `Claude ${primary.label} ${primary.percent}%`, Font.boldSystemFont(13));
  widget.addSpacer(2);
  const bar = widget.addImage(barImage(primary.percent, 140, 5, primary.level, true));
  bar.imageSize = new Size(140, 5);
  widget.addSpacer(2);
  const reset = primary === view.sevenDay && primary.resetWhen ? `${primary.resetWhen} 重置` : primary.countdownShort;
  addText(widget, primary.predictionShort ? `${reset}・${primary.predictionShort}` : reset, Font.systemFont(11));
  if (view.stale) {
    addText(widget, statusLine(view, now), Font.systemFont(10));
  } else if (secondary) {
    addText(widget, `${secondary.label} ${secondary.percent}%`, Font.systemFont(11));
  }
}

function buildInline(widget, view, primaryKey) {
  const win = view[primaryKey] || view.fiveHour || view.sevenDay;
  const tag = win === view.sevenDay ? "週" : "5h";
  const tail = win === view.sevenDay && win.resetWhen ? `${win.resetWhen}重置` : win.countdownShort;
  widget.addText(`Claude ${tag} ${win.percent}%・${tail}${view.stale ? "・離線" : ""}`);
}

function buildWidget(view, family, param, now, usage) {
  const widget = new ListWidget();
  widget.refreshAfterDate = new Date(nextRefreshAt(usage, now));
  const primaryKey = parseParam(param) === "7d" ? "sevenDay" : "fiveHour";
  if (!view.hasData) {
    return buildErrorWidget(widget, view.error || new UsageError("parse"), family);
  }
  switch (family) {
    case "accessoryCircular":
      buildCircular(widget, view, primaryKey);
      break;
    case "accessoryRectangular":
      buildRectangular(widget, view, primaryKey, now);
      break;
    case "accessoryInline":
      buildInline(widget, view, primaryKey);
      break;
    case "small":
      buildSmall(widget, view, primaryKey, now);
      break;
    default:
      buildMedium(widget, view, now);
  }
  return widget;
}

// ---------------------------------------------------------------------------
// App 內畫面

async function showAlert(title, message, actions) {
  const a = new Alert();
  a.title = title;
  a.message = message || "";
  for (const act of actions || ["好"]) a.addAction(act);
  return await a.present();
}

async function setupWizard() {
  const intro = new Alert();
  intro.title = "Claude 用量小工具設定";
  intro.message =
    "需要你 claude.ai 的 sessionKey（登入 cookie）。\n\n" +
    "1. 用電腦瀏覽器登入 claude.ai\n" +
    "2. 開發者工具 → Application（應用程式）→ Cookies → https://claude.ai\n" +
    "3. 複製 sessionKey 的值（sk-ant-sid… 開頭）\n\n" +
    "⚠️ sessionKey 等於你的帳號鑰匙，只會存在這支手機的 Keychain，請勿外流。";
  intro.addAction("我已複製，開始貼上");
  intro.addCancelAction("取消");
  if ((await intro.present()) === -1) return false;

  let prefill = "";
  try {
    const clip = Pasteboard.paste();
    const k = normalizeSessionKey(clip);
    if (k && looksLikeSessionKey(k)) prefill = k;
  } catch (e) {
    // 讀不到剪貼簿就不預填
  }

  for (;;) {
    const a = new Alert();
    a.title = "貼上 sessionKey";
    a.message = "可直接貼上整段 Cookie，程式會自動擷取 sessionKey。";
    a.addSecureTextField("sk-ant-sid01-…", prefill);
    a.addAction("驗證並儲存");
    a.addCancelAction("取消");
    if ((await a.present()) === -1) return false;
    prefill = "";
    const key = normalizeSessionKey(a.textFieldValue(0));
    if (!key) {
      await showAlert("格式不正確", "看起來不像 sessionKey，請確認複製的是 sessionKey 這個 cookie 的值。", ["重新輸入"]);
      continue;
    }
    if (!looksLikeSessionKey(key)) {
      const idx = await showAlert(
        "確定是 sessionKey 嗎？",
        "一般 sessionKey 以 sk-ant-sid 開頭，你貼上的不是。仍要試試看嗎？",
        ["仍要驗證", "重新輸入"]
      );
      if (idx !== 0) continue;
    }
    try {
      const org = await resolveOrganization(key);
      Keychain.set(KEY_SESSION, key);
      Keychain.set(KEY_ORG, org.id);
      const state = loadState();
      state.orgName = org.name;
      saveState(state);
      await showAlert(
        "設定完成 ✅",
        `已找到組織「${org.name || org.id}」。\n接著到主畫面或鎖定畫面加入 Scriptable 小工具，並選擇這個腳本。`
      );
      return true;
    } catch (e) {
      const info = errorInfo(e && e.kind);
      const idx = await showAlert(`驗證失敗：${info.title}`, `${info.hint}\n（${(e && e.message) || "未知錯誤"}）`, ["重新輸入", "取消"]);
      if (idx !== 0) return false;
    }
  }
}

function detailRows(table, view, state, now, handlers) {
  table.removeAllRows();
  const header = new UITableRow();
  header.isHeader = true;
  header.height = 60;
  const h = header.addText("Claude 用量", state.orgName ? `組織：${state.orgName}` : "Claude Pro");
  h.titleFont = Font.boldSystemFont(22);
  table.addRow(header);

  if (view.error) {
    const info = errorInfo(view.error.kind);
    const r = new UITableRow();
    r.height = 64;
    const c = r.addText(`⚠️ ${info.title}`, view.stale ? `${info.hint}，目前顯示上次成功的資料` : info.hint);
    c.titleColor = PALETTE.red();
    table.addRow(r);
  }

  const addInfo = (title, subtitle, color) => {
    const r = new UITableRow();
    r.height = 64;
    const c = r.addText(title, subtitle);
    c.subtitleFont = Font.systemFont(13);
    if (color) c.titleColor = color;
    table.addRow(r);
  };

  if (view.fiveHour) {
    const w = view.fiveHour;
    addInfo(
      `5 小時用量：${w.percent}%`,
      `${w.countdown}${w.resetWhen ? `（${w.resetWhen}）` : ""}\n${w.predictionText}`,
      levelColor(w.level)
    );
  }
  if (view.sevenDay) {
    const w = view.sevenDay;
    addInfo(
      `每週用量：${w.percent}%`,
      `${w.resetWhen ? `${w.resetWhen} 重置（${w.countdown}）` : w.countdown}\n${w.predictionText}`,
      levelColor(w.level)
    );
  }
  if (view.extra && view.extra.enabled) {
    const pct = view.extra.percent !== null ? `（${view.extra.percent}%）` : "";
    addInfo(`使用量額度：${view.extraText}${pct}`, "已花 / 每月上限", levelColor(levelFor(view.extra.percent)));
  } else if (view.extra && !view.extra.enabled) {
    addInfo("使用量額度：未開啟", "可在 claude.ai 設定中開啟");
  }
  addInfo(
    view.updatedText,
    view.fetchedAt ? `資料時間 ${fmtWhen(view.fetchedAt, now)}（台灣時間）` : "尚無成功的資料"
  );

  const action = (title, fn) => {
    const r = new UITableRow();
    r.height = 50;
    const c = r.addText(title);
    c.titleColor = PALETTE.accent();
    r.dismissOnSelect = false;
    r.onSelect = () => { fn(); };
    table.addRow(r);
  };
  action("🔄 立即更新", handlers.refresh);
  action("🌐 打開 claude.ai 用量頁", handlers.openPage);
  action("👀 預覽小工具", handlers.preview);
  action("🔑 重設登入資料", handlers.reset);
}

async function previewWidget(state, error) {
  const a = new Alert();
  a.title = "預覽哪一種？";
  const options = [
    ["主畫面・小", "small", "presentSmall"],
    ["主畫面・中", "medium", "presentMedium"],
    ["鎖定畫面・圓環", "accessoryCircular", "presentAccessoryCircular"],
    ["鎖定畫面・長條", "accessoryRectangular", "presentAccessoryRectangular"],
    ["鎖定畫面・單行", "accessoryInline", "presentAccessoryInline"]
  ];
  for (const [label] of options) a.addAction(label);
  a.addCancelAction("取消");
  const idx = await a.present();
  if (idx < 0) return;
  const now = Date.now();
  const [, family, method] = options[idx];
  const widget = buildWidget(buildView(state, now, error), family, args.widgetParameter, now, state.usage);
  if (typeof widget[method] === "function") await widget[method]();
}

async function showDetail(initial) {
  let { state, error } = initial;
  const table = new UITable();
  table.showSeparators = true;
  const render = () => {
    const now = Date.now();
    detailRows(table, buildView(state, now, error), state, now, handlers);
    table.reload();
  };
  const handlers = {
    refresh: async () => {
      ({ state, error } = await refresh(Date.now()));
      render();
      if (!error) {
        await showAlert("已更新", `資料時間 ${fmtClock(state.fetchedAt)}`);
      }
    },
    openPage: () => Safari.open(USAGE_PAGE),
    preview: () => previewWidget(state, error),
    reset: async () => {
      const idx = await showAlert(
        "重設登入資料？",
        "會刪除 Keychain 內的 sessionKey 與組織 ID，以及本機快取。",
        ["重設", "取消"]
      );
      if (idx !== 0) return;
      resetCredentials();
      state = {};
      error = new UsageError("no-key");
      render();
      if (await setupWizard()) {
        ({ state, error } = await refresh(Date.now()));
      }
      render();
    }
  };
  render();
  await table.present(false);
}

// ---------------------------------------------------------------------------
// 進入點

async function main() {
  const now = Date.now();
  if (config.runsInWidget) {
    const { state, error } = await refresh(now);
    const view = buildView(state, now, error);
    const widget = buildWidget(view, config.widgetFamily, args.widgetParameter, now, state.usage);
    Script.setWidget(widget);
    Script.complete();
    return;
  }

  if (!readSecret(KEY_SESSION)) {
    const ok = await setupWizard();
    if (!ok) {
      Script.complete();
      return;
    }
  }
  const result = await refresh(Date.now());
  await showDetail(result);
  Script.complete();
}

const __api = {
  UsageError, errorInfo, normalizeSessionKey, looksLikeSessionKey, isCloudflarePage,
  parseWindow, parseExtra, normalizeUsage, pickOrganization, levelFor, currentWindow,
  sameWindow, recordSample, predictExhaust, taipeiParts, fmtClock, fmtWhen, fmtDuration,
  fmtDurationShort, fmtCountdown, fmtAgo, fmtMoney, predictionText, predictionShort,
  extraText, parseParam, nextRefreshAt, planNotifications, applySuccess, buildView,
  apiGet, fetchUsage, refresh, applyNotifications, buildWidget, loadState, saveState,
  resetCredentials, setupWizard, main,
  constants: { KEY_SESSION, KEY_ORG, CACHE_FILE, USAGE_PAGE, WARN_PCT, DANGER_PCT, ALERT_PCT,
    FIVE_HOURS, SEVEN_DAYS, REFRESH_MS, NOTIFY_RESET_ID, NOTIFY_HIGH_PREFIX }
};

if (typeof __CLAUDE_USAGE_TEST__ === "object" && __CLAUDE_USAGE_TEST__) {
  __CLAUDE_USAGE_TEST__.api = __api;
} else {
  await main();
}
