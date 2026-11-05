"use strict";

// v2 新功能與防呆：時間格式、節奏、通知設定、損毀快取、並行小工具、錯誤防線、
// 大尺寸、捷徑、App 詳細頁與設定、示範畫面。

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createEnv, fakeClaude, collectTexts, collectImages, tableTitles, findRow, flush,
  presentedWidgets, Color
} = require("./scriptable-mock");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 19, 5, 0, 0); // 台灣時間 13:00（週一）
const KEY = "sk-ant-sid01-test-key-0000000000000000000000";
const KEYS = { session: "claude-usage-tw.sessionKey", org: "claude-usage-tw.orgId" };
const CACHE = "claude-usage-tw-cache.json";
const SETTINGS = "claude-usage-tw-settings.json";

let api;
test.before(async () => {
  api = await createEnv({ now: NOW }).ready;
});

function widgetEnv(family, extra = {}) {
  return createEnv({
    now: extra.now || NOW,
    keychain: { [KEYS.session]: KEY, ...(extra.keychain || {}) },
    files: extra.files,
    handler: extra.handler || fakeClaude(extra.server),
    config: { runsInWidget: true, runsInApp: false, widgetFamily: family },
    args: { widgetParameter: extra.param || null }
  });
}

async function run(env) {
  const a = await env.ready;
  env.setWidget = null;
  env.completed = false;
  await a.main();
  assert.equal(env.completed, true, "一定要呼叫 Script.complete()");
  return env.setWidget ? collectTexts(env.setWidget) : [];
}

// ---------------------------------------------------------------------------
// 純邏輯

test("ISO 時間：6 位小數秒、時區位移、沒有時區、空白分隔都能解析", () => {
  const base = Date.UTC(2026, 9, 19, 8, 0, 0);
  assert.equal(api.parseIsoTime("2026-10-19T08:00:00.123456+00:00"), base + 123);
  assert.equal(api.parseIsoTime("2026-10-19T16:00:00+08:00"), base);
  assert.equal(api.parseIsoTime("2026-10-19T03:30:00-0430"), base);
  assert.equal(api.parseIsoTime("2026-10-19T08:00:00Z"), base);
  assert.equal(api.parseIsoTime("2026-10-19 08:00:00"), base);
  assert.equal(api.parseIsoTime("2026-10-19T08:00"), base);
  assert.equal(api.parseIsoTime("亂七八糟"), null);
  assert.equal(api.parseTime(base / 1000), base);
  assert.equal(api.parseTime(base), base);
  assert.equal(api.parseTime(""), null);
  assert.equal(api.parseTime(null), null);
});

test("five_hour / seven_day 為 null（視窗還沒開始）視為 0%，不是格式錯誤", () => {
  const usage = api.normalizeUsage({ five_hour: null, seven_day: null, extra_usage: null });
  assert.equal(usage.fiveHour.percent, 0);
  assert.equal(usage.fiveHour.resetAt, null);
  assert.equal(usage.sevenDay.percent, 0);
  const view = api.buildView({ usage, fetchedAt: NOW }, NOW, null);
  assert.equal(view.hasData, true);
  assert.equal(view.fiveHour.countdown, "尚未開始計時");
  assert.equal(view.fiveHour.predictionShort, "");
});

test("解析模型別每週用量（Opus / Sonnet），沒有就略過", () => {
  const usage = api.normalizeUsage({
    five_hour: { utilization: 10, resets_at: "2026-10-19T08:00:00Z" },
    seven_day: { utilization: 20, resets_at: "2026-10-22T06:00:00Z" },
    seven_day_opus: { utilization: 33.3, resets_at: "2026-10-22T06:00:00Z" },
    seven_day_sonnet: null
  });
  assert.equal(usage.models.length, 1);
  assert.equal(usage.models[0].label, "Opus 每週");
  assert.equal(usage.models[0].percent, 33);
});

test("用量節奏：比時間進度快／剛好／從容", () => {
  // 每週視窗還剩 3.5 天 → 時間過了 50%
  const resetAt = NOW + 3.5 * DAY;
  const fast = api.paceFor({ percent: 70, resetAt }, api.constants.SEVEN_DAYS, NOW);
  assert.equal(fast.expected, 50);
  assert.equal(fast.kind, "fast");
  assert.equal(fast.level, "orange");
  assert.equal(fast.text, "偏快（時間過了 50%，用了 70%）");
  assert.equal(api.paceFor({ percent: 80, resetAt }, api.constants.SEVEN_DAYS, NOW).level, "red");
  assert.equal(api.paceFor({ percent: 55, resetAt }, api.constants.SEVEN_DAYS, NOW).kind, "even");
  assert.equal(api.paceFor({ percent: 30, resetAt }, api.constants.SEVEN_DAYS, NOW).label, "從容");
  assert.equal(api.paceFor({ percent: 30, resetAt: null }, api.constants.SEVEN_DAYS, NOW), null);
});

test("通知設定：重置提醒門檻與關閉後取消已預約的通知", () => {
  const resetAt = NOW + 2 * HOUR;
  const usage = (p) => ({ fiveHour: { percent: p, resetAt }, sevenDay: null });
  const s50 = { resetMinPct: 50 };
  assert.equal(api.planNotifications({}, usage(30), NOW, s50).schedule.length, 0);
  const a = api.planNotifications({}, usage(55), NOW, s50);
  assert.equal(a.schedule.length, 1);

  // 改成關閉 → 取消還沒響的提醒
  const off = api.planNotifications(a.state, usage(60), NOW + MIN, { resetMinPct: 0 });
  assert.deepEqual([...off.cancel], ["claude-usage-tw.reset"]);
  assert.equal(off.state.resetFor, null);
  // 已經響過的不用取消
  const past = api.planNotifications(a.state, usage(60), resetAt + MIN, { resetMinPct: 0 });
  assert.equal(past.cancel.length, 0);
});

test("通知設定：高用量門檻、關閉、每週不提醒", () => {
  const usage = { fiveHour: { percent: 85, resetAt: NOW + HOUR }, sevenDay: { percent: 95, resetAt: NOW + DAY } };
  assert.equal(api.planNotifications({}, usage, NOW, { alertPct: 90 }).immediate.length, 1);
  assert.equal(api.planNotifications({}, usage, NOW, { alertPct: 0 }).immediate.length, 0);
  const noWeekly = api.planNotifications({}, usage, NOW, { notifyWeekly: false });
  assert.deepEqual([...noWeekly.immediate.map((n) => n.id)], ["claude-usage-tw.high.fiveHour"]);
});

test("登入失效通知只發一次，成功後才會重新計算", () => {
  const auth = new api.UsageError("auth");
  const a = api.planNotifications({}, null, NOW, {}, auth);
  assert.equal(a.immediate.length, 1);
  assert.equal(a.immediate[0].title, "Claude 小工具需要重新登入");
  const b = api.planNotifications(a.state, null, NOW + MIN, {}, auth);
  assert.equal(b.immediate.length, 0);
  // 斷線不會重置狀態
  const c = api.planNotifications(b.state, null, NOW + 2 * MIN, {}, new api.UsageError("network"));
  assert.equal(c.state.authNotified, true);
  // 成功一次之後，下次失效會再通知
  const d = api.planNotifications(c.state, null, NOW + 3 * MIN, {}, null);
  assert.equal(d.state.authNotified, false);
  assert.equal(api.planNotifications(d.state, null, NOW + 4 * MIN, {}, auth).immediate.length, 1);
  // 關閉後不通知
  assert.equal(api.planNotifications({}, null, NOW, { notifyAuth: false }, auth).immediate.length, 0);
});

test("設定檔損毀或值不合法時用預設值", () => {
  const d = api.constants.DEFAULT_SETTINGS;
  assert.deepEqual({ ...api.cleanSettings(null) }, { ...d });
  assert.deepEqual({ ...api.cleanSettings("x") }, { ...d });
  assert.deepEqual({ ...api.cleanSettings({ alertPct: 55, resetMinPct: "50", notifyWeekly: 1 }) }, { ...d });
  const ok = api.cleanSettings({ alertPct: 90, resetMinPct: 50, notifyWeekly: false, notifyAuth: false });
  assert.equal(ok.alertPct, 90);
  assert.equal(ok.resetMinPct, 50);
  assert.equal(ok.notifyWeekly, false);
  assert.equal(ok.notifyAuth, false);
});

test("快取損毀或來自舊版：清理後不會讓畫面出錯", () => {
  const garbage = [
    null, undefined, "x", 42, [], [1, 2],
    { usage: "x" },
    { usage: { fiveHour: { percent: "50", resetAt: "明天" }, sevenDay: 3 } },
    { usage: { fiveHour: { percent: 50, resetAt: "abc" }, extra: { enabled: true, used: "x" }, models: "x" } },
    { usage: { fiveHour: { percent: 500 }, models: [{ label: 1, percent: 2 }, null] }, samples5h: "zzz" },
    { samples5h: [null, { t: "a", p: 1 }, { t: 1, p: 2 }], notify: [], lastError: { kind: 1 } },
    { fetchedAt: "昨天", orgName: 5, lockUntil: "x" }
  ];
  for (const g of garbage) {
    const s = api.sanitizeState(g);
    assert.ok(Array.isArray(s.samples5h));
    const view = api.buildView(g, NOW, null);
    assert.equal(typeof view.hasData, "boolean");
    api.buildWidget(view, "medium", null, NOW, s.usage);
    api.buildWidget(view, "large", null, NOW, s.usage);
  }
  const fixed = api.sanitizeState({ usage: { fiveHour: { percent: 500, resetAt: "abc" } } });
  assert.equal(fixed.usage.fiveHour.percent, 100);
  assert.equal(fixed.usage.fiveHour.resetAt, null);
});

test("上次更新：附上絕對時間；離線時標示資料多舊", () => {
  const usage = api.normalizeUsage({ five_hour: { utilization: 1 }, seven_day: { utilization: 2 } });
  const fresh = api.buildView({ usage, fetchedAt: NOW }, NOW, null);
  assert.equal(api.statusLine(fresh, NOW), "上次更新 13:00");
  const later = api.buildView({ usage, fetchedAt: NOW - 7 * MIN }, NOW, null);
  assert.equal(api.statusLine(later, NOW), "上次更新 12:53・7 分鐘前");
  const stale = api.buildView({ usage, fetchedAt: NOW - 7 * MIN }, NOW, new api.UsageError("network"));
  assert.equal(api.statusLine(stale, NOW), "⚠️ 離線・7 分鐘前資料");
});

test("趨勢圖：資料點不足時不畫，足夠時畫出折線", () => {
  assert.equal(api.sparkImage([], NOW, api.constants.FIVE_HOURS, 100, 20, "#34A85A"), null);
  assert.equal(api.sparkImage([{ t: NOW, p: 5 }], NOW, api.constants.FIVE_HOURS, 100, 20, "#34A85A"), null);
  // 範圍外的點不算
  const old = [{ t: NOW - 6 * HOUR, p: 1 }, { t: NOW, p: 5 }];
  assert.equal(api.sparkImage(old, NOW, api.constants.FIVE_HOURS, 100, 20, "#34A85A"), null);
  const img = api.sparkImage([{ t: NOW - HOUR, p: 5 }, { t: NOW, p: 30 }], NOW, api.constants.FIVE_HOURS, 100, 20, "#34A85A");
  assert.equal(img.kind, "image");
});

test("被限流時延後下次更新", () => {
  assert.equal(api.nextRefreshAt(null, NOW, new api.UsageError("rate-limited")), NOW + 15 * MIN);
  assert.equal(api.nextRefreshAt(null, NOW, new api.UsageError("network")), NOW + 5 * MIN);
});

test("記錄每週樣本約每 30 分鐘一筆，8 天內不會超過上限", () => {
  let s = [];
  for (let t = NOW; t < NOW + 8 * DAY; t += 5 * MIN) {
    s = api.recordSample(s, { percent: 10, resetAt: NOW + 9 * DAY }, t, 8 * DAY, 30 * MIN);
  }
  assert.ok(s.length > 300 && s.length <= 600, `樣本數 ${s.length}`);
  for (let i = 1; i < s.length - 1; i++) {
    assert.ok(s[i].t - s[i - 1].t >= 25 * MIN);
  }
});

// ---------------------------------------------------------------------------
// 整合

test("API 回傳 6 位小數秒時倒數一樣正確", async () => {
  const body = JSON.stringify({
    five_hour: { utilization: 42, resets_at: "2026-10-19T08:00:00.654321+00:00" },
    seven_day: { utilization: 18, resets_at: "2026-10-22T06:00:00.000001+00:00" }
  });
  const texts = await run(widgetEnv("small", { server: { usage: body } }));
  // 08:00:00.654 距離 05:00 是 3 小時又 0.654 秒，分鐘無條件進位
  assert.ok(texts.includes("3 小時 1 分後重置"));
});

test("多個小工具：一分鐘內共用快取，不重複打 API、不重複通知", async () => {
  const env = widgetEnv("small", { server: { usage: "usage-high.json" } });
  await run(env);
  const requests = env.requests.length;
  const notes = env.scheduled.length;
  assert.ok(notes > 0);

  env.setNow(NOW + 30 * 1000);
  env.sandbox.config.widgetFamily = "accessoryCircular";
  await run(env);
  assert.equal(env.requests.length, requests);
  assert.equal(env.scheduled.length, notes);
  assert.ok(collectImages(env.setWidget).length > 0);

  // 超過一分鐘就重新抓
  env.setNow(NOW + 2 * MIN);
  await run(env);
  assert.equal(env.requests.length, requests + 1);
  assert.equal(env.scheduled.length, notes);
});

test("另一個小工具正在抓資料時：顯示「讀取中」，不另外打 API", async () => {
  const files = { [CACHE]: JSON.stringify({ v: 2, lockUntil: NOW + 10 * 1000 }) };
  const env = widgetEnv("medium", { files });
  const texts = await run(env);
  assert.equal(env.requests.length, 0);
  assert.ok(texts.includes("讀取中…"));

  // 過期很久或時間錯亂的鎖會被忽略
  const stuck = widgetEnv("medium", { files: { [CACHE]: JSON.stringify({ lockUntil: NOW + 10 * HOUR }) } });
  const t2 = await run(stuck);
  assert.ok(stuck.requests.length > 0);
  assert.ok(t2.includes("42%"));
});

test("快取檔損毀：照常抓資料；抓不到時顯示連線錯誤而不是當機", async () => {
  const broken = widgetEnv("medium", { files: { [CACHE]: "{不是 JSON" } });
  assert.ok((await run(broken)).includes("42%"));

  const garbage = JSON.stringify({ usage: { fiveHour: { percent: "abc" } }, samples5h: "zzz", notify: [] });
  const offline = widgetEnv("medium", {
    files: { [CACHE]: garbage },
    handler: () => { throw new Error("offline"); }
  });
  const texts = await run(offline);
  assert.ok(texts.includes("無法連線"));
  assert.ok(!texts.includes("發生未預期的錯誤"));
});

test("錯誤防線：繪圖時發生例外，也會顯示友善的錯誤小工具並結束腳本", async () => {
  const orig = Color.dynamic;
  let calls = 0;
  Color.dynamic = (...a) => {
    if (calls++ === 0) throw new Error("boom");
    return orig(...a);
  };
  try {
    const env = widgetEnv("medium");
    const texts = await run(env);
    assert.ok(texts.includes("發生未預期的錯誤"));
    assert.ok(texts.includes("請在 App 內執行查看詳情"));
  } finally {
    Color.dynamic = orig;
  }
});

test("登入失效：發一次通知，之後不重複", async () => {
  const env = createEnv({
    now: NOW,
    keychain: { [KEYS.session]: "sk-ant-sid01-expired-0000000000000000" },
    handler: fakeClaude({ fail: () => ({ status: 401, body: "{}" }) }),
    config: { runsInWidget: true, runsInApp: false, widgetFamily: "small" }
  });
  await run(env);
  assert.deepEqual([...env.scheduled.map((n) => n.title)], ["Claude 小工具需要重新登入"]);
  env.setNow(NOW + 5 * MIN);
  await run(env);
  assert.equal(env.scheduled.length, 1);
});

test("大尺寸：雙圓環、兩條趨勢、額度條；資料累積後畫出趨勢圖", async () => {
  const env = widgetEnv("large");
  let texts = await run(env);
  assert.ok(texts.includes("近 5 小時趨勢"));
  assert.ok(texts.includes("近 7 天趨勢"));
  assert.ok(texts.includes("累積資料中…（每次更新會記錄一筆）"));
  assert.ok(texts.includes("$3.20 / $50.00（6%）"));
  assert.ok(texts.includes("節奏從容"));

  for (let i = 1; i <= 3; i++) {
    env.setNow(NOW + i * 10 * MIN);
    texts = await run(env);
  }
  // 5 小時與每週各累積了 3 筆以上，兩條趨勢圖都畫得出來
  assert.ok(!texts.includes("累積資料中…（每次更新會記錄一筆）"));
  const sparks = collectImages(env.setWidget).filter((img) => img && img.kind === "image");
  assert.equal(sparks.length, 2);
});

test("從捷徑執行：輸出文字摘要", async () => {
  const env = createEnv({
    now: NOW,
    keychain: { [KEYS.session]: KEY },
    handler: fakeClaude(),
    config: { runsInWidget: false, runsInApp: false }
  });
  await run(env);
  assert.equal(
    env.shortcutOutput,
    "Claude 用量：5 小時 42%（3 小時後重置，約 15:45 用完）；每週 18%（週四 14:00 重置）；使用量額度 $3.20 / $50.00"
  );
});

test("從捷徑執行但尚未設定：輸出設定提示", async () => {
  const env = createEnv({ now: NOW, handler: fakeClaude(), config: { runsInWidget: false, runsInApp: false } });
  await run(env);
  assert.equal(env.shortcutOutput, "Claude 用量：尚未設定（點一下開始設定）");
});

test("App 詳細頁：顯示用量、節奏、操作；「立即更新」會重新抓資料", async () => {
  const env = createEnv({ now: NOW, keychain: { [KEYS.session]: KEY }, handler: fakeClaude() });
  await run(env);
  const table = env.presentedTable;
  const titles = tableTitles(table);
  assert.ok(titles.includes("5 小時用量：42%"));
  assert.ok(titles.includes("每週用量：18%"));
  assert.ok(titles.includes("使用量額度：$3.20 / $50.00（6%）"));
  assert.ok(titles.includes("🔄 立即更新"));
  assert.ok(titles.includes("🌐 打開 claude.ai 用量頁"));
  assert.ok(titles.some((t) => t.startsWith("🔔 通知設定")));
  // 圓環圖片
  assert.ok(table.rows.some((r) => r.cells.filter((c) => c.type === "image").length === 2));

  const before = env.requests.length;
  env.setNow(NOW + 10 * 1000); // 就算剛抓過，手動更新也要重抓
  findRow(table, "🔄 立即更新").onSelect();
  await flush();
  assert.equal(env.requests.length, before + 1);
  assert.equal(env.alerts[env.alerts.length - 1].title, "已更新");

  findRow(table, "🌐 打開").onSelect();
  await flush();
  assert.equal(env.openedUrl, "https://claude.ai/settings/usage");
});

test("App 詳細頁：通知設定可切換、會存檔，關掉重置提醒會取消預約", async () => {
  const env = createEnv({
    now: NOW,
    keychain: { [KEYS.session]: KEY },
    handler: fakeClaude(),
    alerts: []
  });
  await run(env);
  const table = env.presentedTable;
  assert.ok(JSON.parse(env.files.get(CACHE)).notify.resetFor > NOW);
  const removedBefore = env.removedPending.length;

  env.alertScript.push(
    { index: 1 }, // 高用量 80% → 90%
    { index: 0 }, // 重置提醒：有使用就提醒 → ≥ 50%（目前 42%，所以要取消）
    { index: -1 } // 完成
  );
  findRow(table, "🔔 通知設定").onSelect();
  await flush();
  const saved = JSON.parse(env.files.get(SETTINGS));
  assert.equal(saved.alertPct, 90);
  assert.equal(saved.resetMinPct, 50);
  assert.ok(tableTitles(table).includes("🔔 通知設定（高用量 90%）"));
  assert.ok(env.removedPending.length > removedBefore);
  assert.equal(JSON.parse(env.files.get(CACHE)).notify.resetFor, null);
});

test("App 詳細頁：重設登入資料會清除金鑰、快取，並取消重置提醒", async () => {
  const env = createEnv({ now: NOW, keychain: { [KEYS.session]: KEY }, handler: fakeClaude() });
  await run(env);
  env.files.set(SETTINGS, JSON.stringify({ alertPct: 70 }));
  env.alertScript.push({ index: 0 }, { index: -1 }); // 確認重設 → 精靈取消
  findRow(env.presentedTable, "🔑 重設登入資料").onSelect();
  await flush();
  assert.equal(env.keychain.size, 0);
  assert.ok(!env.files.has(CACHE));
  assert.ok(env.files.has(SETTINGS), "通知設定是偏好，重設登入不會刪掉");
  assert.ok(env.removedPending.includes("claude-usage-tw.reset"));
  assert.ok(tableTitles(env.presentedTable).includes("⚠️ 尚未設定"));
});

test("首次設定精靈：可以先看示範畫面", async () => {
  const env = createEnv({
    now: NOW,
    handler: fakeClaude(),
    alerts: [
      { index: 1 }, // 先看示範畫面
      { index: 2 }, // 預覽：主畫面・大
      { index: -1 } // 回到介紹 → 取消
    ]
  });
  const a = await env.ready;
  const count = presentedWidgets.length;
  assert.equal(await a.setupWizard(), false);
  assert.equal(presentedWidgets.length, count + 1);
  const demo = presentedWidgets[presentedWidgets.length - 1];
  assert.equal(demo.presented, "large");
  const texts = collectTexts(demo);
  assert.ok(texts.includes("42%"));
  assert.ok(texts.includes("$3.20 / $50.00（6%）"));
  assert.equal(env.requests.length, 0);
  assert.equal(env.keychain.size, 0);
});

test("模型別用量出現在大尺寸與詳細頁", async () => {
  const body = JSON.stringify({
    five_hour: { utilization: 10, resets_at: "2026-10-19T08:00:00Z" },
    seven_day: { utilization: 20, resets_at: "2026-10-22T06:00:00Z" },
    seven_day_opus: { utilization: 64, resets_at: "2026-10-22T06:00:00Z" }
  });
  const texts = await run(widgetEnv("large", { server: { usage: body } }));
  assert.ok(texts.includes("Opus 每週"));
  assert.ok(texts.includes("64%"));
  assert.ok(texts.includes("未開啟"));
});

test("medium 在視窗都還沒開始時顯示 0% 與「未計時」", async () => {
  const body = JSON.stringify({ five_hour: null, seven_day: null });
  const texts = await run(widgetEnv("medium", { server: { usage: body } }));
  assert.ok(texts.includes("0%"));
  assert.ok(texts.includes("未計時"));
  assert.ok(!texts.includes("回應格式不符"));
});
