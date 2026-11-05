// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: orange; icon-glyph: tachometer-alt;

// Claude 用量小工具（iOS Scriptable）v2
//
// 第一次請在 Scriptable App 內執行，依照精靈貼上 claude.ai 的 sessionKey。
// 金鑰只會存在本機的 Scriptable Keychain，並且只會送到 claude.ai。
//
// 小工具參數：
//   （空白）或 5h  → 主要顯示 5 小時用量
//   7d             → 主要顯示每週用量
//
// 支援尺寸：主畫面小／中／大，鎖定畫面圓環／長條／單行；也可從「捷徑」執行取得文字摘要。
// 資料來源是 claude.ai 用量頁使用的非官方介面，隨時可能改版失效。

const VERSION = "2.0.0";
const BASE_URL = "https://claude.ai";
const USAGE_PAGE = "https://claude.ai/settings/usage";
const KEY_SESSION = "claude-usage-tw.sessionKey";
const KEY_ORG = "claude-usage-tw.orgId";
const CACHE_FILE = "claude-usage-tw-cache.json";
const SETTINGS_FILE = "claude-usage-tw-settings.json";
const STATE_VERSION = 2;
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIVE_HOURS = 5 * HOUR;
const SEVEN_DAYS = 7 * DAY;
const REFRESH_MS = 5 * MINUTE;
const BACKOFF_MS = 15 * MINUTE;
// 小工具執行時間有限，兩次請求加起來要留餘裕。
const REQUEST_TIMEOUT_S = 10;
// 同時放好幾個小工具時，一分鐘內只打一次 API，其餘共用快取。
const MIN_FETCH_MS = MINUTE;
const LOCK_MS = 25 * 1000;
// 台灣時間 UTC+8，沒有日光節約，所以直接位移即可，不依賴裝置時區。
const TAIPEI_OFFSET_MS = 8 * HOUR;
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

// 顏色門檻：未滿 WARN 綠色，WARN～DANGER 橙色，DANGER 以上紅色。
const WARN_PCT = 60;
const DANGER_PCT = 80;
// 用量節奏：比「時間進度」多或少超過這個百分點才算偏快／從容。
const PACE_MARGIN = 10;

const NOTIFY_RESET_ID = "claude-usage-tw.reset";
const NOTIFY_HIGH_PREFIX = "claude-usage-tw.high.";
const NOTIFY_AUTH_ID = "claude-usage-tw.auth";
const NOTIFY_THREAD = "claude-usage-tw";

// resetMinPct：5 小時用量至少到幾 % 才預約「額度回來了」（0 = 關閉）。
// alertPct：用量超過幾 % 提醒一次（0 = 關閉）。
const DEFAULT_SETTINGS = {
  resetMinPct: 1,
  alertPct: 80,
  notifyWeekly: true,
  notifyAuth: true
};
const RESET_CHOICES = [1, 50, 80, 0];
const ALERT_CHOICES = [70, 80, 90, 0];

const MODEL_WINDOWS = [
  ["seven_day_opus", "Opus 每週"],
  ["seven_day_sonnet", "Sonnet 每週"]
];

const ERRORS = {
  "no-key": { title: "尚未設定", hint: "點一下開始設定", short: "未設定" },
  auth: { title: "登入已失效", hint: "請重新貼上 sessionKey", short: "需登入" },
  blocked: { title: "被 Cloudflare 擋下", hint: "稍後會自動重試", short: "被阻擋" },
  network: { title: "無法連線", hint: "稍後會自動重試", short: "離線" },
  "rate-limited": { title: "請求太頻繁", hint: "稍後會自動重試", short: "限流" },
  "no-org": { title: "找不到 Claude 組織", hint: "請確認帳號方案", short: "無組織" },
  "not-found": { title: "找不到組織", hint: "會重新查詢組織 ID", short: "錯誤" },
  http: { title: "伺服器錯誤", hint: "稍後會自動重試", short: "錯誤" },
  parse: { title: "回應格式不符", hint: "介面可能已改版，請更新腳本", short: "格式錯" },
  loading: { title: "讀取中…", hint: "稍後會自動更新", short: "讀取中" },
  unexpected: { title: "發生未預期的錯誤", hint: "請在 App 內執行查看詳情", short: "錯誤" }
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

function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// 合理的時間戳（2000～2100 年），擋掉 1e20 之類會讓日期變成 NaN 的值。
const MIN_TIME = Date.UTC(2000, 0, 1);
const MAX_TIME = Date.UTC(2100, 0, 1);
function isTime(value) {
  return isNum(value) && value >= MIN_TIME && value <= MAX_TIME;
}

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
  if (isNum(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clampPct(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

// 自己解析 ISO 8601：claude.ai 會回傳 6 位小數秒（.123456+00:00），
// 部分 JavaScriptCore 版本的 Date.parse 不吃這種格式。沒有時區時視為 UTC。
function parseIsoTime(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i
    .exec(String(text).trim());
  if (!m) {
    const t = Date.parse(text);
    return Number.isFinite(t) ? t : null;
  }
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), ms);
  if (m[8] && m[8].toUpperCase() !== "Z") {
    const sign = m[8][0] === "-" ? -1 : 1;
    const digits = m[8].slice(1).replace(":", "");
    const offsetMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0);
    t -= sign * offsetMin * MINUTE;
  }
  return Number.isFinite(t) ? t : null;
}

function parseTime(value) {
  let t = null;
  if (typeof value === "string" && value.trim() !== "") t = parseIsoTime(value);
  // 秒或毫秒都接受
  else if (isNum(value)) t = value < 1e12 ? value * 1000 : value;
  return isTime(t) ? t : null;
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
    currency: typeof src.currency === "string" && src.currency ? src.currency.toUpperCase() : "USD"
  };
}

function normalizeUsage(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  // 欄位存在但是 null 代表這個視窗還沒開始，視為 0%。
  const readMain = (key) => (data[key] === null ? { percent: 0, resetAt: null } : parseWindow(data[key]));
  const fiveHour = readMain("five_hour");
  const sevenDay = readMain("seven_day");
  if (!fiveHour && !sevenDay) {
    return null;
  }
  const models = [];
  for (const [key, label] of MODEL_WINDOWS) {
    const win = parseWindow(data[key]);
    if (win) models.push({ label, percent: win.percent, resetAt: win.resetAt });
  }
  return { fiveHour, sevenDay, extra: parseExtra(data.extra_usage), models };
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
  if (!isNum(percent)) return "none";
  if (percent >= DANGER_PCT) return "red";
  if (percent >= WARN_PCT) return "orange";
  return "green";
}

// 重置時間已過的視窗視為歸零（快取資料也一樣）。
function currentWindow(win, now) {
  if (!win || !isNum(win.percent)) return null;
  if (win.resetAt && now >= win.resetAt) {
    return { percent: 0, resetAt: null, expired: true };
  }
  return win;
}

function sameWindow(a, b) {
  return isNum(a) && isNum(b) && Math.abs(a - b) < 15 * MINUTE;
}

// 記錄用量樣本。相鄰兩筆至少間隔 minGapMs（最後一筆會一直更新成最新值）。
function recordSample(samples, win, now, keepMs, minGapMs) {
  const gap = minGapMs || MINUTE;
  const list = cleanSamples(samples).filter((s) => now - s.t <= keepMs && s.t <= now);
  if (!win || !isNum(win.percent)) return list;
  const last = list[list.length - 1];
  const prev = list[list.length - 2];
  if ((last && now - last.t < MINUTE) || (prev && now - prev.t < gap)) list.pop();
  list.push({ t: now, p: win.percent, r: isNum(win.resetAt) ? win.resetAt : null });
  return list.slice(-600);
}

// 依目前消耗速度預估用完時間。
// 有足夠的近期樣本就用近期速度，否則用「視窗開始到現在」的平均速度。
function predictExhaust(win, lengthMs, samples, now) {
  if (!win || !isNum(win.percent)) return { kind: "unknown" };
  const p = win.percent;
  if (p >= 100) return { kind: "full", at: win.resetAt };

  const recentMs = lengthMs / 5;
  const minSpan = recentMs / 6;
  let rate = null; // 每毫秒增加幾 %

  const recent = cleanSamples(samples)
    .filter((s) => sameWindow(s.r, win.resetAt) && s.t < now && now - s.t <= recentMs)
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

// 用量節奏：把「用了幾 %」跟「視窗時間過了幾 %」比較。
function paceFor(win, lengthMs, now) {
  if (!win || !isNum(win.percent) || !win.resetAt) return null;
  const frac = Math.max(0, Math.min(1, (now - (win.resetAt - lengthMs)) / lengthMs));
  const expected = Math.round(frac * 100);
  const diff = win.percent - expected;
  const kind = diff > PACE_MARGIN ? "fast" : diff < -PACE_MARGIN ? "slow" : "even";
  const label = kind === "fast" ? "偏快" : kind === "slow" ? "從容" : "剛好";
  return {
    expected,
    diff,
    kind,
    label,
    level: kind === "fast" ? (diff > 25 ? "red" : "orange") : "green",
    text: `${label}（時間過了 ${expected}%，用了 ${win.percent}%）`
  };
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

function splitDuration(ms) {
  const totalMin = Math.ceil(ms / MINUTE);
  return {
    days: Math.floor(totalMin / 1440),
    hours: Math.floor((totalMin % 1440) / 60),
    mins: totalMin % 60
  };
}

function fmtDuration(ms) {
  if (!(ms > 0)) return "即將";
  const { days, hours, mins } = splitDuration(ms);
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小時` : `${days} 天`;
  if (hours > 0) return mins > 0 ? `${hours} 小時 ${mins} 分` : `${hours} 小時`;
  return `${mins} 分`;
}

function fmtDurationShort(ms) {
  if (!(ms > 0)) return "即將";
  const { days, hours, mins } = splitDuration(ms);
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
    case "full": return pred.at ? `已用完，${fmtWhen(pred.at, now)} 恢復` : "已用完";
    case "never": return "重置前用不完";
    case "at": return `約 ${fmtWhen(pred.at, now)} 用完`;
    default: return "";
  }
}

function extraText(extra) {
  if (!extra || !extra.enabled) return null;
  const used = fmtMoney(extra.used, extra.currency);
  if (!isNum(extra.limit)) return `已花 ${used}`;
  return `${used} / ${fmtMoney(extra.limit, extra.currency)}`;
}

function parseParam(raw) {
  const p = String(raw || "").trim().toLowerCase();
  if (["7d", "7", "week", "weekly", "w", "週", "每週", "一週"].includes(p)) return "7d";
  return "5h";
}

// 下次更新：5 分鐘後，或任一視窗重置後 1 分鐘（取較早者）。被限流時拉長。
function nextRefreshAt(usage, now, error) {
  const slow = error && (error.kind === "rate-limited" || error.kind === "blocked");
  let next = now + (slow ? BACKOFF_MS : REFRESH_MS);
  for (const win of [usage && usage.fiveHour, usage && usage.sevenDay]) {
    if (win && isNum(win.resetAt) && win.resetAt > now) {
      next = Math.min(next, win.resetAt + MINUTE);
    }
  }
  return next;
}

// ---- 設定與快取的驗證（檔案可能損毀或來自舊版） ----

function cleanSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return s;
  if (RESET_CHOICES.includes(raw.resetMinPct)) s.resetMinPct = raw.resetMinPct;
  if (ALERT_CHOICES.includes(raw.alertPct)) s.alertPct = raw.alertPct;
  if (typeof raw.notifyWeekly === "boolean") s.notifyWeekly = raw.notifyWeekly;
  if (typeof raw.notifyAuth === "boolean") s.notifyAuth = raw.notifyAuth;
  return s;
}

function cleanWindow(w) {
  if (!w || typeof w !== "object" || !isNum(w.percent)) return null;
  return {
    percent: clampPct(w.percent),
    resetAt: isTime(w.resetAt) ? w.resetAt : null
  };
}

function cleanExtra(e) {
  if (!e || typeof e !== "object") return null;
  if (e.enabled === false) return { enabled: false };
  if (e.enabled !== true || !isNum(e.used)) return null;
  return {
    enabled: true,
    used: e.used,
    limit: isNum(e.limit) ? e.limit : null,
    percent: isNum(e.percent) ? clampPct(e.percent) : null,
    currency: typeof e.currency === "string" && e.currency ? e.currency : "USD"
  };
}

function cleanSamples(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && isTime(s.t) && isNum(s.p))
    .map((s) => ({ t: s.t, p: clampPct(s.p), r: isTime(s.r) ? s.r : null }));
}

function cleanNotify(raw) {
  const n = { resetFor: null, alerted: {}, authNotified: false };
  if (!raw || typeof raw !== "object") return n;
  if (isNum(raw.resetFor)) n.resetFor = raw.resetFor;
  if (raw.alerted && typeof raw.alerted === "object") {
    for (const key of ["fiveHour", "sevenDay"]) {
      if (isNum(raw.alerted[key])) n.alerted[key] = raw.alerted[key];
    }
  }
  n.authNotified = raw.authNotified === true;
  return n;
}

function sanitizeState(raw) {
  const s = { v: STATE_VERSION, samples5h: [], samples7d: [], notify: cleanNotify(null) };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return s;
  const u = raw.usage;
  if (u && typeof u === "object") {
    const fiveHour = cleanWindow(u.fiveHour);
    const sevenDay = cleanWindow(u.sevenDay);
    if (fiveHour || sevenDay) {
      const models = Array.isArray(u.models)
        ? u.models
          .map((m) => {
            const w = cleanWindow(m);
            return w && m && typeof m.label === "string" ? { label: m.label, ...w } : null;
          })
          .filter(Boolean)
        : [];
      s.usage = { fiveHour, sevenDay, extra: cleanExtra(u.extra), models };
    }
  }
  if (isTime(raw.fetchedAt)) s.fetchedAt = raw.fetchedAt;
  if (typeof raw.orgName === "string") s.orgName = raw.orgName;
  s.samples5h = cleanSamples(raw.samples5h);
  s.samples7d = cleanSamples(raw.samples7d);
  s.notify = cleanNotify(raw.notify);
  if (raw.lastError && typeof raw.lastError.kind === "string" && isNum(raw.lastError.at)) {
    s.lastError = { kind: raw.lastError.kind, at: raw.lastError.at };
  }
  if (isNum(raw.lockUntil)) s.lockUntil = raw.lockUntil;
  return s;
}

// 計算這次要預約／立即送出／取消的通知（純函式，回傳新的通知狀態）。
function planNotifications(notifyState, usage, now, settings, error) {
  const s = cleanSettings(settings);
  const state = cleanNotify(notifyState);
  const schedule = [];
  const immediate = [];
  const cancel = [];

  if (error && error.kind === "auth") {
    if (s.notifyAuth && !state.authNotified) {
      immediate.push({
        id: NOTIFY_AUTH_ID,
        title: "Claude 小工具需要重新登入",
        body: "sessionKey 已失效，點這裡重新設定。"
      });
      state.authNotified = true;
    }
  } else if (!error) {
    state.authNotified = false;
  }
  if (!usage) return { schedule, immediate, cancel, state };

  const fh = currentWindow(usage.fiveHour, now);
  const wantReset = s.resetMinPct > 0 && fh && isNum(fh.resetAt) && fh.resetAt > now &&
    fh.percent >= s.resetMinPct;
  if (wantReset) {
    if (!sameWindow(state.resetFor, fh.resetAt)) {
      schedule.push({
        id: NOTIFY_RESET_ID,
        title: "Claude 額度回來了 🎉",
        body: "5 小時用量已重置，可以繼續使用 Claude 了。",
        at: fh.resetAt + 30 * 1000
      });
      state.resetFor = fh.resetAt;
    }
  } else if (state.resetFor && state.resetFor > now) {
    // 設定改成不提醒：把還沒響的通知取消掉。
    cancel.push(NOTIFY_RESET_ID);
    state.resetFor = null;
  }

  const windows = [["fiveHour", "5 小時"]];
  if (s.notifyWeekly) windows.push(["sevenDay", "每週"]);
  if (s.alertPct > 0) {
    for (const [name, label] of windows) {
      const win = currentWindow(usage[name], now);
      if (!win || !isNum(win.resetAt) || win.percent < s.alertPct) continue;
      if (sameWindow(state.alerted[name], win.resetAt)) continue;
      immediate.push({
        id: NOTIFY_HIGH_PREFIX + name,
        title: `Claude ${label}用量已達 ${win.percent}%`,
        body: `${fmtCountdown(win.resetAt, now)}（${fmtWhen(win.resetAt, now)}），請斟酌使用。`
      });
      state.alerted[name] = win.resetAt;
    }
  }
  return { schedule, immediate, cancel, state };
}

// 把 API 結果合併進快取狀態。
function applySuccess(state, result, now) {
  const next = sanitizeState(state);
  next.usage = result.usage;
  next.fetchedAt = now;
  next.orgName = result.orgName || next.orgName || "";
  delete next.lastError;
  next.samples5h = recordSample(next.samples5h, result.usage.fiveHour, now, 6 * HOUR, 2 * MINUTE);
  next.samples7d = recordSample(next.samples7d, result.usage.sevenDay, now, 8 * DAY, 30 * MINUTE);
  return next;
}

function storedError(state) {
  const e = state && state.lastError;
  if (!e) return null;
  if (state.fetchedAt && e.at < state.fetchedAt) return null;
  return new UsageError(e.kind);
}

// 依快取狀態整理出畫面要用的資料。
function buildView(rawState, now, error) {
  const state = sanitizeState(rawState);
  const usage = state.usage;
  const fh = usage ? currentWindow(usage.fiveHour, now) : null;
  const sd = usage ? currentWindow(usage.sevenDay, now) : null;
  const make = (win, lengthMs, samples, label, weekly) => {
    if (!win) return null;
    const pred = predictExhaust(win, lengthMs, samples, now);
    const resetWhen = win.resetAt ? fmtWhen(win.resetAt, now) : null;
    const countdown = fmtCountdown(win.resetAt, now);
    const countdownShort = win.resetAt ? `${fmtDurationShort(win.resetAt - now)}後重置` : "未計時";
    return {
      label,
      percent: win.percent,
      resetAt: win.resetAt,
      level: levelFor(win.percent),
      countdown,
      countdownShort,
      resetWhen,
      resetLabel: weekly && resetWhen ? `${resetWhen} 重置` : countdown,
      resetLabelShort: weekly && resetWhen ? `${resetWhen} 重置` : countdownShort,
      prediction: pred,
      predictionText: predictionText(pred, now),
      predictionShort: predictionShort(pred, now),
      pace: paceFor(win, lengthMs, now)
    };
  };
  const extra = usage ? usage.extra : null;
  const models = usage
    ? usage.models
      .map((m) => {
        const w = currentWindow(m, now);
        return w ? {
          label: m.label,
          percent: w.percent,
          level: levelFor(w.percent),
          resetWhen: w.resetAt ? fmtWhen(w.resetAt, now) : null
        } : null;
      })
      .filter(Boolean)
    : [];
  return {
    hasData: !!(fh || sd),
    fiveHour: make(fh, FIVE_HOURS, state.samples5h, "5 小時", false),
    sevenDay: make(sd, SEVEN_DAYS, state.samples7d, "每週", true),
    models,
    extra,
    extraText: extraText(extra),
    extraLevel: extra && extra.enabled ? levelFor(extra.percent) : "none",
    samples5h: state.samples5h,
    samples7d: state.samples7d,
    orgName: state.orgName || "",
    fetchedAt: state.fetchedAt || null,
    updatedText: state.fetchedAt ? `上次更新 ${fmtAgo(state.fetchedAt, now)}` : "尚未更新",
    error: error || null,
    stale: !!error && !!state.fetchedAt
  };
}

// 小工具上的「上次更新」：一定附上絕對時間，iOS 晚更新也不會誤導。
function statusLine(view, now) {
  if (!view.fetchedAt) return view.error ? errorInfo(view.error.kind).short : "尚未更新";
  if (view.stale) {
    return `⚠️ ${errorInfo(view.error.kind).short}・${fmtAgo(view.fetchedAt, now)}資料`;
  }
  const ago = now - view.fetchedAt >= MINUTE ? `・${fmtAgo(view.fetchedAt, now)}` : "";
  return `上次更新 ${fmtClock(view.fetchedAt)}${ago}`;
}

// 給「捷徑」用的一段文字摘要。
function summaryText(view, now) {
  if (!view.hasData) {
    const info = errorInfo(view.error ? view.error.kind : "loading");
    return `Claude 用量：${info.title}（${info.hint}）`;
  }
  const parts = [];
  if (view.fiveHour) {
    const w = view.fiveHour;
    const extra = w.predictionShort ? `，${w.predictionShort}` : "";
    parts.push(`5 小時 ${w.percent}%（${w.countdown}${extra}）`);
  }
  if (view.sevenDay) {
    parts.push(`每週 ${view.sevenDay.percent}%（${view.sevenDay.resetLabel}）`);
  }
  if (view.extraText) parts.push(`使用量額度 ${view.extraText}`);
  let text = `Claude 用量：${parts.join("；")}`;
  if (view.stale) {
    text += `（⚠️ ${errorInfo(view.error.kind).title}，資料為 ${fmtAgo(view.fetchedAt, now)}）`;
  }
  return text;
}

// 示範資料：還沒設定前可以先看看小工具長什麼樣子。
function demoState(now) {
  const resetAt = now + 3 * HOUR;
  const samples5h = [];
  for (let i = 24; i >= 0; i--) {
    samples5h.push({ t: now - i * 5 * MINUTE, p: Math.round(42 - i * 1.4), r: resetAt });
  }
  const weekReset = now + 3 * DAY;
  const samples7d = [];
  for (let i = 96; i >= 0; i--) {
    samples7d.push({ t: now - i * 30 * MINUTE, p: Math.max(0, Math.round(18 - i * 0.12)), r: weekReset });
  }
  return sanitizeState({
    usage: {
      fiveHour: { percent: 42, resetAt },
      sevenDay: { percent: 18, resetAt: weekReset },
      extra: { enabled: true, used: 3.2, limit: 50, percent: 6, currency: "USD" },
      models: []
    },
    fetchedAt: now,
    orgName: "示範資料",
    samples5h: samples5h.map((s) => ({ ...s, p: Math.max(0, s.p) })),
    samples7d
  });
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
// 儲存（Keychain 存金鑰，檔案存非機密的快取與設定）

function readSecret(key) {
  try {
    return Keychain.contains(key) ? Keychain.get(key) : null;
  } catch (e) {
    return null;
  }
}

function filePath(name) {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.documentsDirectory(), name) };
}

function readJson(name) {
  try {
    const { fm, path } = filePath(name);
    if (!fm.fileExists(path)) return null;
    return JSON.parse(fm.readString(path));
  } catch (e) {
    return null;
  }
}

function writeJson(name, data) {
  try {
    const { fm, path } = filePath(name);
    fm.writeString(path, JSON.stringify(data));
  } catch (e) {
    // 寫不進去不影響顯示
  }
}

function loadState() {
  return sanitizeState(readJson(CACHE_FILE));
}

function saveState(state) {
  writeJson(CACHE_FILE, state);
}

function loadSettings() {
  return cleanSettings(readJson(SETTINGS_FILE));
}

function saveSettings(settings) {
  writeJson(SETTINGS_FILE, cleanSettings(settings));
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
    const { fm, path } = filePath(CACHE_FILE);
    if (fm.fileExists(path)) fm.remove(path);
  } catch (e) {
    // 忽略
  }
  try {
    Promise.resolve(Notification.removePending([NOTIFY_RESET_ID])).catch(() => {});
  } catch (e) {
    // 忽略
  }
}

// 抓最新資料；失敗時保留上次成功的資料並記錄錯誤。
// 非 force 時，如果別的小工具剛抓過（或正在抓），就直接用快取。
async function refresh(now, opts) {
  const force = !!(opts && opts.force);
  let state = loadState();
  const settings = loadSettings();
  const sessionKey = readSecret(KEY_SESSION);
  if (!sessionKey) {
    return { state, settings, error: new UsageError("no-key") };
  }
  if (!force) {
    const fresh = state.fetchedAt && now >= state.fetchedAt && now - state.fetchedAt < MIN_FETCH_MS &&
      !storedError(state);
    const locked = state.lockUntil && state.lockUntil > now && state.lockUntil - now <= LOCK_MS;
    if (fresh || locked) {
      return { state, settings, error: storedError(state), cached: true };
    }
  }
  state.lockUntil = now + LOCK_MS;
  saveState(state);

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
  delete state.lockUntil;
  await applyNotifications(state, settings, now, error);
  saveState(state);
  return { state, settings, error };
}

async function sendNotification(item) {
  const n = new Notification();
  n.identifier = item.id;
  n.title = item.title;
  n.body = item.body;
  n.sound = "default";
  n.threadIdentifier = NOTIFY_THREAD;
  try {
    n.openURL = URLScheme.forRunningScript();
  } catch (e) {
    // 沒有 URLScheme 也能發通知
  }
  if (item.at) n.setTriggerDate(new Date(item.at));
  await n.schedule();
}

async function applyNotifications(state, settings, now, error) {
  const plan = planNotifications(state.notify, state.usage, now, settings, error);
  if (plan.cancel.length) {
    try {
      await Notification.removePending(plan.cancel);
    } catch (e) {
      // 忽略
    }
  }
  for (const item of plan.schedule) {
    try {
      await Notification.removePending([item.id]);
      await sendNotification(item);
    } catch (e) {
      // 通知失敗不影響小工具
    }
  }
  for (const item of plan.immediate) {
    try {
      await sendNotification(item);
    } catch (e) {
      // 通知失敗不影響小工具
    }
  }
  state.notify = plan.state;
  return plan;
}

// ---------------------------------------------------------------------------
// 繪圖

// 文字與底色用動態顏色，深淺色切換時 iOS 會自動換，不需要重新執行腳本。
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

// 圖片（圓環、趨勢圖）無法用動態顏色，所以挑深淺底色上都清楚的中間色，
// 不依賴 Device.isUsingDarkAppearance()（它在小工具裡不可靠）。
const IMAGE_COLORS = {
  green: "#34A85A",
  orange: "#F59E0B",
  red: "#E5484D",
  none: "#8E8E93",
  track: "#8E8E93"
};

function levelColor(level) {
  if (level === "red") return PALETTE.red();
  if (level === "orange") return PALETTE.orange();
  if (level === "green") return PALETTE.green();
  return PALETTE.dim();
}

function isDark() {
  try {
    return Device.isUsingDarkAppearance();
  } catch (e) {
    return false;
  }
}

function newContext(width, height) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  return ctx;
}

// 圓環：底圈用描邊，進度用一串圓點畫出來（兩端自然是圓角）。
function ringImage(o) {
  const size = o.size;
  const line = o.line;
  const ctx = newContext(size, size);
  const c = size / 2;
  const r = c - line / 2 - 1;
  ctx.setStrokeColor(new Color(o.trackHex || IMAGE_COLORS.track, o.trackAlpha ?? 0.25));
  ctx.setLineWidth(line);
  ctx.strokeEllipse(new Rect(c - r, c - r, 2 * r, 2 * r));
  const p = isNum(o.percent) ? Math.max(0, Math.min(100, o.percent)) : 0;
  if (p > 0) {
    ctx.setFillColor(new Color(o.colorHex));
    const sweep = (360 * p) / 100;
    const dot = (deg) => {
      const rad = ((deg - 90) * Math.PI) / 180;
      const x = c + r * Math.cos(rad);
      const y = c + r * Math.sin(rad);
      ctx.fillEllipse(new Rect(x - line / 2, y - line / 2, line, line));
    };
    for (let deg = 0; deg < sweep; deg += 1.5) dot(deg);
    dot(sweep);
  }
  if (o.text) {
    ctx.setTextAlignedCenter();
    ctx.setTextColor(new Color(o.textHex || "#FFFFFF"));
    const textSize = o.textSize || Math.round(size * 0.28);
    ctx.setFont(Font.boldRoundedSystemFont(textSize));
    if (o.sub) {
      ctx.drawTextInRect(o.text, new Rect(0, size * 0.27, size, textSize * 1.25));
      ctx.setTextColor(new Color(o.subHex || o.textHex || "#FFFFFF"));
      ctx.setFont(Font.semiboldSystemFont(Math.round(size * 0.14)));
      ctx.drawTextInRect(o.sub, new Rect(0, size * 0.6, size, size * 0.2));
    } else {
      ctx.drawTextInRect(o.text, new Rect(0, (size - textSize * 1.25) / 2, size, textSize * 1.25));
    }
  }
  return ctx.getImage();
}

// 趨勢折線圖；資料點不足兩個時回傳 null。
function sparkImage(samples, now, spanMs, width, height, colorHex) {
  const from = now - spanMs;
  const pts = cleanSamples(samples)
    .filter((s) => s.t >= from && s.t <= now)
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const ctx = newContext(width, height);
  const pad = 2;
  const x = (t) => pad + ((width - 2 * pad) * (t - from)) / spanMs;
  const y = (p) => pad + (height - 2 * pad) * (1 - p / 100);

  const guide = new Path();
  guide.move(new Point(0, y(DANGER_PCT)));
  guide.addLine(new Point(width, y(DANGER_PCT)));
  ctx.addPath(guide);
  ctx.setStrokeColor(new Color(IMAGE_COLORS.track, 0.35));
  ctx.setLineWidth(1);
  ctx.strokePath();

  const points = pts.map((s) => new Point(x(s.t), y(s.p)));
  const area = new Path();
  area.move(new Point(points[0].x, height));
  for (const pt of points) area.addLine(pt);
  area.addLine(new Point(points[points.length - 1].x, height));
  area.closeSubpath();
  ctx.addPath(area);
  ctx.setFillColor(new Color(colorHex, 0.18));
  ctx.fillPath();

  const line = new Path();
  line.move(points[0]);
  for (const pt of points.slice(1)) line.addLine(pt);
  ctx.addPath(line);
  ctx.setStrokeColor(new Color(colorHex));
  ctx.setLineWidth(1.5);
  ctx.strokePath();

  const last = points[points.length - 1];
  ctx.setFillColor(new Color(colorHex));
  ctx.fillEllipse(new Rect(last.x - 2.5, last.y - 2.5, 5, 5));
  return ctx.getImage();
}

// 鎖定畫面的進度條（鎖定畫面會統一染色，只看亮度）。
function accessoryBarImage(percent, width, height) {
  const ctx = newContext(width, height);
  const r = height / 2;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, width, height), r, r);
  ctx.addPath(track);
  ctx.setFillColor(new Color("#FFFFFF", 0.3));
  ctx.fillPath();
  const p = isNum(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  if (p > 0) {
    const fill = new Path();
    fill.addRoundedRect(new Rect(0, 0, Math.max(height, (width * p) / 100), height), r, r);
    ctx.addPath(fill);
    ctx.setFillColor(new Color("#FFFFFF"));
    ctx.fillPath();
  }
  return ctx.getImage();
}

function symbolImage(name, size) {
  try {
    const sym = SFSymbol.named(name);
    if (!sym) return null;
    sym.applyFont(Font.boldSystemFont(size));
    return sym.image;
  } catch (e) {
    return null;
  }
}

function addText(stack, text, font, color, opts) {
  const t = stack.addText(String(text));
  t.font = font;
  if (color) t.textColor = color;
  t.lineLimit = (opts && opts.lines) || 1;
  t.minimumScaleFactor = (opts && opts.scale) || 0.7;
  return t;
}

// 用 stack 疊出來的進度條，可以用動態顏色。
function addBar(parent, percent, width, height, level) {
  const track = parent.addStack();
  track.size = new Size(width, height);
  track.cornerRadius = height / 2;
  track.backgroundColor = PALETTE.track();
  track.layoutHorizontally();
  const p = isNum(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  if (p > 0) {
    const fill = track.addStack();
    fill.size = new Size(Math.max(height, Math.round((width * p) / 100)), height);
    fill.cornerRadius = height / 2;
    fill.backgroundColor = levelColor(level);
  }
  track.addSpacer();
  return track;
}

// 圓環儀表：圓環是背景圖，中間的百分比是文字（才能跟著深淺色變色）。
function addRing(parent, win, diameter, line, fontSize, caption) {
  const ring = parent.addStack();
  ring.size = new Size(diameter, diameter);
  ring.backgroundImage = ringImage({
    percent: win.percent,
    colorHex: IMAGE_COLORS[win.level] || IMAGE_COLORS.none,
    size: diameter,
    line
  });
  ring.layoutVertically();
  ring.addSpacer();
  const mid = ring.addStack();
  mid.layoutHorizontally();
  mid.addSpacer();
  addText(mid, isNum(win.percent) ? `${win.percent}%` : "--", Font.boldRoundedSystemFont(fontSize),
    levelColor(win.level), { scale: 0.5 });
  mid.addSpacer();
  if (caption) {
    const cap = ring.addStack();
    cap.layoutHorizontally();
    cap.addSpacer();
    addText(cap, caption, Font.mediumSystemFont(Math.max(8, Math.round(fontSize * 0.5))), PALETTE.dim());
    cap.addSpacer();
  }
  ring.addSpacer();
  return ring;
}

function addHeader(parent, title, rightText, rightColor) {
  const row = parent.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  const sym = symbolImage("sparkle", 11);
  if (sym) {
    const img = row.addImage(sym);
    img.imageSize = new Size(11, 11);
    img.tintColor = PALETTE.accent();
    row.addSpacer(4);
  }
  addText(row, title, Font.boldSystemFont(12), PALETTE.accent());
  row.addSpacer();
  if (rightText) addText(row, rightText, Font.semiboldSystemFont(10), rightColor || PALETTE.dim());
  return row;
}

function statusColor(view) {
  return view.stale ? PALETTE.orange() : PALETTE.dim();
}

function pickWindows(view, primaryKey) {
  const primary = view[primaryKey] || view.fiveHour || view.sevenDay;
  const secondary = primary === view.fiveHour ? view.sevenDay : view.fiveHour;
  return { primary, secondary };
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
  widget.setPadding(12, 14, 12, 14);
  addHeader(widget, "Claude 用量");
  widget.addSpacer(8);
  addText(widget, info.title, Font.semiboldSystemFont(15), PALETTE.text(), { lines: 2 });
  widget.addSpacer(2);
  addText(widget, info.hint, Font.systemFont(12), PALETTE.dim(), { lines: 2 });
  widget.addSpacer();
  return widget;
}

// 主畫面・小（寬度以最小的 148pt 設計，避免小螢幕被裁切）
function buildSmall(widget, view, primaryKey, now) {
  widget.backgroundColor = PALETTE.bg();
  widget.setPadding(12, 12, 10, 12);
  const { primary, secondary } = pickWindows(view, primaryKey);
  addHeader(widget, "Claude", primary.label);
  widget.addSpacer(6);

  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  addRing(row, primary, 54, 6, 15);
  row.addSpacer(8);
  const side = row.addStack();
  side.layoutVertically();
  if (secondary) {
    addText(side, secondary.label, Font.semiboldSystemFont(10), PALETTE.dim());
    addText(side, `${secondary.percent}%`, Font.boldRoundedSystemFont(16), levelColor(secondary.level));
    side.addSpacer(3);
    addBar(side, secondary.percent, 44, 4, secondary.level);
  }
  row.addSpacer();

  widget.addSpacer(6);
  addText(widget, primary.resetLabel, Font.semiboldSystemFont(11), PALETTE.text());
  if (primary.predictionShort) {
    addText(widget, primary.predictionShort, Font.mediumSystemFont(10), levelColor(primary.level));
  }
  widget.addSpacer();
  addText(widget, statusLine(view, now), Font.systemFont(9), statusColor(view));
}

// 主畫面・中（寬度以最小的 321pt 設計）
function buildMedium(widget, view, now) {
  widget.backgroundColor = PALETTE.bg();
  widget.setPadding(12, 14, 12, 14);
  addHeader(widget, "Claude 用量", statusLine(view, now), statusColor(view));
  widget.addSpacer(8);

  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  [view.fiveHour, view.sevenDay].forEach((win, i) => {
    const col = row.addStack();
    col.layoutHorizontally();
    col.centerAlignContent();
    if (win) {
      addRing(col, win, 52, 6, 14);
      col.addSpacer(7);
      const info = col.addStack();
      info.layoutVertically();
      addText(info, win.label, Font.semiboldSystemFont(11), PALETTE.dim());
      addText(info, win.resetLabelShort, Font.semiboldSystemFont(11), PALETTE.text());
      if (win.predictionShort) {
        addText(info, win.predictionShort, Font.mediumSystemFont(10), levelColor(win.level));
      }
    } else {
      const info = col.addStack();
      info.layoutVertically();
      addText(info, i === 0 ? "5 小時" : "每週", Font.semiboldSystemFont(11), PALETTE.dim());
      addText(info, "無資料", Font.systemFont(12), PALETTE.dim());
    }
    if (i === 0) row.addSpacer();
  });

  widget.addSpacer();
  const foot = widget.addStack();
  foot.layoutHorizontally();
  foot.centerAlignContent();
  const trendColor = IMAGE_COLORS[view.fiveHour ? view.fiveHour.level : "none"];
  const spark = sparkImage(view.samples5h, now, FIVE_HOURS, 96, 16, trendColor);
  if (spark) {
    addText(foot, "趨勢", Font.semiboldSystemFont(9), PALETTE.dim());
    foot.addSpacer(4);
    const img = foot.addImage(spark);
    img.imageSize = new Size(96, 16);
  }
  foot.addSpacer();
  if (view.extraText) {
    addText(foot, `使用量額度 ${view.extraText}`, Font.mediumSystemFont(10), levelColor(view.extraLevel));
  } else if (view.sevenDay && view.sevenDay.pace) {
    addText(foot, `本週節奏 ${view.sevenDay.pace.label}`, Font.mediumSystemFont(10),
      levelColor(view.sevenDay.pace.level));
  }
}

// 主畫面・大：雙圓環＋兩條趨勢圖＋額度
function buildLarge(widget, view, now) {
  const W = 288;
  widget.backgroundColor = PALETTE.bg();
  widget.setPadding(16, 16, 14, 16);
  addHeader(widget, "Claude 用量", statusLine(view, now), statusColor(view));
  widget.addSpacer(10);

  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  [view.fiveHour, view.sevenDay].forEach((win, i) => {
    const col = row.addStack();
    col.layoutHorizontally();
    col.centerAlignContent();
    if (win) {
      addRing(col, win, 64, 7, 16);
      col.addSpacer(8);
      const info = col.addStack();
      info.layoutVertically();
      addText(info, win.label, Font.semiboldSystemFont(12), PALETTE.dim());
      addText(info, win.resetLabelShort, Font.semiboldSystemFont(11), PALETTE.text());
      if (win.predictionShort) {
        addText(info, win.predictionShort, Font.mediumSystemFont(10), levelColor(win.level));
      }
      if (win.pace) {
        addText(info, `節奏${win.pace.label}`, Font.mediumSystemFont(10), levelColor(win.pace.level));
      }
    } else {
      addText(col, `${i === 0 ? "5 小時" : "每週"}：無資料`, Font.systemFont(12), PALETTE.dim());
    }
    if (i === 0) row.addSpacer();
  });

  const section = (title, samples, spanMs, height, win) => {
    widget.addSpacer(10);
    addText(widget, title, Font.semiboldSystemFont(10), PALETTE.dim());
    widget.addSpacer(3);
    const img = sparkImage(samples, now, spanMs, W, height, IMAGE_COLORS[win ? win.level : "none"]);
    if (img) {
      const el = widget.addImage(img);
      el.imageSize = new Size(W, height);
    } else {
      addText(widget, "累積資料中…（每次更新會記錄一筆）", Font.systemFont(10), PALETTE.dim());
    }
  };
  section("近 5 小時趨勢", view.samples5h, FIVE_HOURS, 36, view.fiveHour);
  section("近 7 天趨勢", view.samples7d, SEVEN_DAYS, 28, view.sevenDay);

  widget.addSpacer(10);
  const ex = widget.addStack();
  ex.layoutHorizontally();
  addText(ex, "使用量額度", Font.semiboldSystemFont(10), PALETTE.dim());
  ex.addSpacer();
  if (view.extraText) {
    const pct = isNum(view.extra.percent) ? `（${view.extra.percent}%）` : "";
    addText(ex, `${view.extraText}${pct}`, Font.mediumSystemFont(10), levelColor(view.extraLevel));
    widget.addSpacer(3);
    addBar(widget, view.extra.percent, W, 5, view.extraLevel);
  } else {
    addText(ex, "未開啟", Font.mediumSystemFont(10), PALETTE.dim());
  }
  for (const m of view.models) {
    widget.addSpacer(4);
    const r = widget.addStack();
    r.layoutHorizontally();
    addText(r, m.label, Font.semiboldSystemFont(10), PALETTE.dim());
    r.addSpacer();
    addText(r, `${m.percent}%`, Font.mediumSystemFont(10), levelColor(m.level));
  }
  widget.addSpacer();
}

function buildCircular(widget, view, primaryKey) {
  widget.addAccessoryWidgetBackground = true;
  const { primary } = pickWindows(view, primaryKey);
  const label = primary === view.sevenDay ? "週" : "5h";
  const img = widget.addImage(ringImage({
    percent: primary.percent,
    colorHex: "#FFFFFF",
    trackHex: "#FFFFFF",
    trackAlpha: 0.3,
    size: 120,
    line: 12,
    text: isNum(primary.percent) ? `${primary.percent}` : "--",
    sub: label,
    textSize: 34
  }));
  img.imageSize = new Size(60, 60);
  img.centerAlignImage();
}

function buildRectangular(widget, view, primaryKey, now) {
  const { primary, secondary } = pickWindows(view, primaryKey);
  addText(widget, `Claude ${primary.label} ${primary.percent}%`, Font.boldSystemFont(13));
  widget.addSpacer(2);
  const bar = widget.addImage(accessoryBarImage(primary.percent, 140, 5));
  bar.imageSize = new Size(140, 5);
  widget.addSpacer(2);
  const reset = primary.resetLabelShort;
  addText(widget, primary.predictionShort ? `${reset}・${primary.predictionShort}` : reset, Font.systemFont(11));
  if (view.stale) {
    addText(widget, statusLine(view, now), Font.systemFont(10));
  } else if (secondary) {
    addText(widget, `${secondary.label} ${secondary.percent}%`, Font.systemFont(11));
  }
}

function buildInline(widget, view, primaryKey) {
  const { primary } = pickWindows(view, primaryKey);
  const tag = primary === view.sevenDay ? "週" : "5h";
  const tail = primary === view.sevenDay && primary.resetWhen ? `${primary.resetWhen}重置` : primary.countdownShort;
  widget.addText(`Claude ${tag} ${primary.percent}%・${tail}${view.stale ? "・離線" : ""}`);
}

function newWidget(now, usage, error) {
  const widget = new ListWidget();
  widget.refreshAfterDate = new Date(nextRefreshAt(usage, now, error));
  // 點小工具一律執行這個腳本（打開詳細頁），不必另外設定「When Interacting」。
  try {
    widget.url = URLScheme.forRunningScript();
  } catch (e) {
    // 取不到就用小工具本身的設定
  }
  return widget;
}

function buildWidget(view, family, param, now, usage) {
  const widget = newWidget(now, usage, view.error);
  const primaryKey = parseParam(param) === "7d" ? "sevenDay" : "fiveHour";
  if (!view.hasData) {
    return buildErrorWidget(widget, view.error || new UsageError("loading"), family);
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
    case "large":
    case "extraLarge":
      buildLarge(widget, view, now);
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

async function previewWidget(state, error, presetFamily) {
  const options = [
    ["主畫面・小", "small", "presentSmall"],
    ["主畫面・中", "medium", "presentMedium"],
    ["主畫面・大", "large", "presentLarge"],
    ["鎖定畫面・圓環", "accessoryCircular", "presentAccessoryCircular"],
    ["鎖定畫面・長條", "accessoryRectangular", "presentAccessoryRectangular"],
    ["鎖定畫面・單行", "accessoryInline", "presentAccessoryInline"]
  ];
  let idx = options.findIndex((o) => o[1] === presetFamily);
  if (idx < 0) {
    const a = new Alert();
    a.title = "預覽哪一種？";
    for (const [label] of options) a.addAction(label);
    a.addCancelAction("取消");
    idx = await a.present();
  }
  if (idx < 0 || idx >= options.length) return;
  const now = Date.now();
  const [, family, method] = options[idx];
  const widget = buildWidget(buildView(state, now, error), family, args.widgetParameter, now, state.usage);
  if (typeof widget[method] === "function") await widget[method]();
}

async function setupWizard() {
  for (;;) {
    const intro = new Alert();
    intro.title = "Claude 用量小工具設定";
    intro.message =
      "需要你 claude.ai 的 sessionKey（登入 cookie）。\n\n" +
      "1. 用電腦瀏覽器登入 claude.ai\n" +
      "2. 開發者工具 → Application（應用程式）→ Cookies → https://claude.ai\n" +
      "3. 複製 sessionKey 的值（sk-ant-sid… 開頭）\n\n" +
      "⚠️ sessionKey 等於你的帳號鑰匙，只會存在這支手機的 Keychain，請勿外流。";
    intro.addAction("我已複製，開始貼上");
    intro.addAction("先看示範畫面");
    intro.addCancelAction("取消");
    const choice = await intro.present();
    if (choice === -1) return false;
    if (choice === 1) {
      await previewWidget(demoState(Date.now()), null);
      continue;
    }
    break;
  }

  let prefill = "";
  try {
    const k = normalizeSessionKey(Pasteboard.paste());
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

function resetChoiceLabel(v) {
  if (v === 0) return "關閉";
  if (v === 1) return "有使用就提醒";
  return `用量 ≥ ${v}% 才提醒`;
}

function nextChoice(list, current) {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length];
}

async function settingsMenu(settings) {
  const s = cleanSettings(settings);
  for (;;) {
    const a = new Alert();
    a.title = "通知設定";
    a.message = "點選項目可以切換；設定只存在這支手機。";
    a.addAction(`重置提醒：${resetChoiceLabel(s.resetMinPct)}`);
    a.addAction(`高用量提醒：${s.alertPct ? `${s.alertPct}%` : "關閉"}`);
    a.addAction(`每週用量也提醒：${s.notifyWeekly ? "開" : "關"}`);
    a.addAction(`登入失效提醒：${s.notifyAuth ? "開" : "關"}`);
    a.addCancelAction("完成");
    const idx = await a.present();
    if (idx === 0) s.resetMinPct = nextChoice(RESET_CHOICES, s.resetMinPct);
    else if (idx === 1) s.alertPct = nextChoice(ALERT_CHOICES, s.alertPct);
    else if (idx === 2) s.notifyWeekly = !s.notifyWeekly;
    else if (idx === 3) s.notifyAuth = !s.notifyAuth;
    else break;
    saveSettings(s);
  }
  return s;
}

function detailRows(table, view, settings, now, handlers) {
  table.removeAllRows();
  const dark = isDark();
  const textHex = dark ? "#F5F4EF" : "#1F1E1D";
  const dimHex = dark ? "#A3A29C" : "#6B6A64";

  const header = new UITableRow();
  header.isHeader = true;
  header.height = 60;
  const h = header.addText("Claude 用量", view.orgName ? `組織：${view.orgName}` : "Claude Pro");
  h.titleFont = Font.boldSystemFont(22);
  table.addRow(header);

  if (view.hasData) {
    const hero = new UITableRow();
    hero.height = 130;
    for (const win of [view.fiveHour, view.sevenDay]) {
      if (!win) continue;
      const cell = hero.addImage(ringImage({
        percent: win.percent,
        colorHex: IMAGE_COLORS[win.level] || IMAGE_COLORS.none,
        size: 120,
        line: 11,
        text: `${win.percent}%`,
        sub: win.label,
        textHex,
        subHex: dimHex,
        textSize: 28
      }));
      cell.centerAligned();
    }
    table.addRow(hero);
  }

  if (view.error) {
    const info = errorInfo(view.error.kind);
    const r = new UITableRow();
    r.height = 64;
    const c = r.addText(`⚠️ ${info.title}`, view.stale ? `${info.hint}，目前顯示上次成功的資料` : info.hint);
    c.titleColor = PALETTE.red();
    table.addRow(r);
  }

  const addInfo = (title, subtitle, color, height) => {
    const r = new UITableRow();
    r.height = height || 64;
    const c = r.addText(title, subtitle);
    c.subtitleFont = Font.systemFont(13);
    if (color) c.titleColor = color;
    table.addRow(r);
  };

  if (view.fiveHour) {
    const w = view.fiveHour;
    const pace = w.pace ? `\n用量節奏：${w.pace.text}` : "";
    addInfo(
      `5 小時用量：${w.percent}%`,
      `${w.countdown}${w.resetWhen ? `（${w.resetWhen}）` : ""}\n${w.predictionText}${pace}`,
      levelColor(w.level),
      w.pace ? 84 : 64
    );
  }
  const spark5 = sparkImage(view.samples5h, now, FIVE_HOURS, 300, 60,
    IMAGE_COLORS[view.fiveHour ? view.fiveHour.level : "none"]);
  if (spark5) {
    const r = new UITableRow();
    r.height = 80;
    const t = r.addText("近 5 小時", "趨勢");
    t.widthWeight = 25;
    const img = r.addImage(spark5);
    img.widthWeight = 75;
    table.addRow(r);
  }
  if (view.sevenDay) {
    const w = view.sevenDay;
    const pace = w.pace ? `\n用量節奏：${w.pace.text}` : "";
    addInfo(
      `每週用量：${w.percent}%`,
      `${w.resetWhen ? `${w.resetWhen} 重置（${w.countdown}）` : w.countdown}\n${w.predictionText}${pace}`,
      levelColor(w.level),
      w.pace ? 84 : 64
    );
  }
  for (const m of view.models) {
    addInfo(`${m.label}：${m.percent}%`, m.resetWhen ? `${m.resetWhen} 重置` : "", levelColor(m.level), 54);
  }
  if (view.extra && view.extra.enabled) {
    const pct = isNum(view.extra.percent) ? `（${view.extra.percent}%）` : "";
    addInfo(`使用量額度：${view.extraText}${pct}`, "已花 / 每月上限", levelColor(view.extraLevel));
  } else if (view.extra && !view.extra.enabled) {
    addInfo("使用量額度：未開啟", "可在 claude.ai 設定中開啟");
  }
  addInfo(
    view.updatedText,
    view.fetchedAt ? `資料時間 ${fmtWhen(view.fetchedAt, now)}（台灣時間）` : "尚無成功的資料"
  );

  const section = new UITableRow();
  section.isHeader = true;
  section.addText("操作");
  table.addRow(section);

  const action = (title, fn, color) => {
    const r = new UITableRow();
    r.height = 50;
    const c = r.addText(title);
    c.titleColor = color || PALETTE.accent();
    r.dismissOnSelect = false;
    r.onSelect = () => {
      Promise.resolve()
        .then(fn)
        .catch((e) => showAlert(errorInfo("unexpected").title, String((e && e.message) || e)));
    };
    table.addRow(r);
  };
  action("🔄 立即更新", handlers.refresh);
  action("🌐 打開 claude.ai 用量頁", handlers.openPage);
  action("👀 預覽小工具", handlers.preview);
  action(`🔔 通知設定（高用量 ${settings.alertPct ? `${settings.alertPct}%` : "關"}）`, handlers.settings);
  action("🔑 重設登入資料", handlers.reset, PALETTE.red());

  const foot = new UITableRow();
  foot.height = 44;
  const f = foot.addText(`v${VERSION}・非官方介面，可能隨 claude.ai 改版失效`);
  f.titleFont = Font.systemFont(11);
  f.titleColor = PALETTE.dim();
  table.addRow(foot);
}

async function showDetail(initial) {
  let { state, error } = initial;
  let settings = initial.settings || loadSettings();
  const table = new UITable();
  table.showSeparators = true;
  const handlers = {};
  const render = () => {
    const now = Date.now();
    detailRows(table, buildView(state, now, error), settings, now, handlers);
    table.reload();
  };
  handlers.refresh = async () => {
    ({ state, error } = await refresh(Date.now(), { force: true }));
    render();
    if (!error) {
      await showAlert("已更新", `資料時間 ${fmtClock(state.fetchedAt)}`);
    }
  };
  handlers.openPage = () => Safari.open(USAGE_PAGE);
  handlers.preview = () => previewWidget(state, error);
  handlers.settings = async () => {
    settings = await settingsMenu(settings);
    // 設定改了馬上套用（例如關掉重置提醒時取消已預約的通知）
    await applyNotifications(state, settings, Date.now(), error);
    saveState(state);
    render();
  };
  handlers.reset = async () => {
    const idx = await showAlert(
      "重設登入資料？",
      "會刪除 Keychain 內的 sessionKey 與組織 ID，以及本機快取。",
      ["重設", "取消"]
    );
    if (idx !== 0) return;
    resetCredentials();
    state = sanitizeState(null);
    error = new UsageError("no-key");
    render();
    if (await setupWizard()) {
      ({ state, error } = await refresh(Date.now(), { force: true }));
    }
    render();
  };
  render();
  await table.present(false);
}

// ---------------------------------------------------------------------------
// 進入點

async function runWidget(now) {
  const { state, error } = await refresh(now);
  const view = buildView(state, now, error);
  Script.setWidget(buildWidget(view, config.widgetFamily, args.widgetParameter, now, state.usage));
}

async function runApp() {
  if (!readSecret(KEY_SESSION)) {
    if (!(await setupWizard())) return;
  }
  const result = await refresh(Date.now(), { force: true });
  await showDetail(result);
}

// 從「捷徑」或 Siri 執行：輸出文字摘要，可以接著做自動化。
async function runShortcut(now) {
  const { state, error } = await refresh(now);
  const view = buildView(state, now, error);
  Script.setShortcutOutput(summaryText(view, now));
  if (config.runsWithSiri) {
    const widget = buildWidget(view, "medium", args.widgetParameter, now, state.usage);
    await widget.presentMedium();
  }
}

async function main() {
  const now = Date.now();
  try {
    if (config.runsInWidget) await runWidget(now);
    else if (config.runsInApp) await runApp();
    else await runShortcut(now);
  } catch (e) {
    // 最後一道防線：任何沒預料到的錯誤都顯示成友善訊息，而不是 Scriptable 的紅色錯誤畫面。
    const detail = String((e && e.message) || e);
    try {
      if (config.runsInWidget) {
        const widget = newWidget(now, null, null);
        Script.setWidget(buildErrorWidget(widget, new UsageError("unexpected", detail), config.widgetFamily));
      } else if (config.runsInApp) {
        await showAlert(errorInfo("unexpected").title, detail);
      } else {
        Script.setShortcutOutput(`Claude 用量：${errorInfo("unexpected").title}（${detail}）`);
      }
    } catch (ignored) {
      // 連錯誤畫面都畫不出來就放棄
    }
  } finally {
    Script.complete();
  }
}

const __api = {
  VERSION, UsageError, errorInfo, normalizeSessionKey, looksLikeSessionKey, isCloudflarePage,
  parseIsoTime, parseTime, parseWindow, parseExtra, normalizeUsage, pickOrganization, levelFor,
  currentWindow, sameWindow, recordSample, predictExhaust, paceFor, taipeiParts, fmtClock, fmtWhen,
  fmtDuration, fmtDurationShort, fmtCountdown, fmtAgo, fmtMoney, predictionText, predictionShort,
  extraText, parseParam, nextRefreshAt, cleanSettings, sanitizeState, planNotifications,
  applySuccess, buildView, statusLine, summaryText, demoState, sparkImage, ringImage,
  apiGet, fetchUsage, refresh, applyNotifications, buildWidget, loadState, saveState,
  loadSettings, saveSettings, resetCredentials, setupWizard, settingsMenu, showDetail, main,
  constants: { KEY_SESSION, KEY_ORG, CACHE_FILE, SETTINGS_FILE, USAGE_PAGE, WARN_PCT, DANGER_PCT,
    FIVE_HOURS, SEVEN_DAYS, REFRESH_MS, MIN_FETCH_MS, LOCK_MS, NOTIFY_RESET_ID, NOTIFY_HIGH_PREFIX,
    NOTIFY_AUTH_ID, DEFAULT_SETTINGS }
};

if (typeof __CLAUDE_USAGE_TEST__ === "object" && __CLAUDE_USAGE_TEST__) {
  __CLAUDE_USAGE_TEST__.api = __api;
} else {
  await main();
}
