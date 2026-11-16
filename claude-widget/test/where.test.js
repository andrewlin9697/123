"use strict";

// 「用量花在哪」：每日用量、時段分布、分類用量，以及參數「明細」的各種版面。

const test = require("node:test");
const assert = require("node:assert/strict");
const { createEnv, fakeClaude, collectTexts, collectImages, tableTitles } = require("./scriptable-mock");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// 2026-10-19 05:00 UTC = 台灣時間 13:00（週一）
const NOW = Date.UTC(2026, 9, 19, 5, 0, 0);
const KEY = "sk-ant-sid01-test-key-0000000000000000000000";
const KEYS = { session: "claude-usage-tw.sessionKey", org: "claude-usage-tw.orgId" };
const CACHE = "claude-usage-tw-cache.json";
const RESET = Date.UTC(2026, 9, 22, 6, 0, 0); // 與 usage-normal.json 的每週重置時間相同

// 台灣時間 → 時間戳（daysAgo：幾天前，hour：台灣時間幾點）
const at = (daysAgo, hour, minute = 0) =>
  Date.UTC(2026, 9, 19 - daysAgo, hour - 8, minute, 0);

// 一段有代表性的紀錄：週六下午 +4、週日晚上 +6、今天上午 +3、今天中午 +5 → 共 18%
const HISTORY = [
  { t: at(2, 10), p: 0, r: RESET },
  { t: at(2, 14), p: 2, r: RESET },
  { t: at(2, 17), p: 4, r: RESET },
  { t: at(1, 9), p: 4, r: RESET },
  { t: at(1, 20), p: 7, r: RESET },
  { t: at(1, 23), p: 10, r: RESET },
  { t: at(0, 8), p: 10, r: RESET },
  { t: at(0, 10), p: 13, r: RESET },
  { t: at(0, 12, 30), p: 18, r: RESET }
];

let api;
test.before(async () => {
  api = await createEnv({ now: NOW }).ready;
});

function widgetEnv(family, param, extra = {}) {
  return createEnv({
    now: NOW,
    keychain: { [KEYS.session]: KEY, [KEYS.org]: "org-pro-1234" },
    files: { [CACHE]: JSON.stringify({ samples7d: HISTORY }) },
    handler: fakeClaude(extra.server),
    config: { runsInWidget: true, runsInApp: false, widgetFamily: family, ...(extra.config || {}) },
    args: { widgetParameter: param }
  });
}

async function run(env) {
  const a = await env.ready;
  await a.main();
  return collectTexts(env.setWidget);
}

// ---------------------------------------------------------------------------
// 純邏輯

test("每日用量：依台灣時間分到各天，沒有紀錄的日子是 null", () => {
  const d = api.dailyBreakdown(HISTORY, NOW);
  assert.deepEqual([...d.days.map((x) => x.label)], ["二", "三", "四", "五", "六", "日", "一"]);
  assert.deepEqual([...d.days.map((x) => x.pct)], [null, null, null, null, 4, 6, 8]);
  assert.equal(d.days[6].isToday, true);
  assert.equal(d.today, 8);
  assert.equal(d.total, 18);
  assert.equal(d.max, 8);
  assert.equal(d.avg, 6);
  assert.equal(d.busiest.label, "一");
  assert.equal(d.hasData, true);
  assert.equal(api.dailyBreakdown(HISTORY, NOW).periodsText, "上午 17%・下午 50%・晚上 33%");
});

test("每日用量：午夜前後用台灣時間切日，不是 UTC", () => {
  // 台灣時間 23:50（+3）與隔天 00:10（+2）
  const samples = [
    { t: at(1, 23, 30), p: 0, r: RESET },
    { t: at(1, 23, 50), p: 3, r: RESET },
    { t: at(0, 0, 10), p: 5, r: RESET }
  ];
  const d = api.dailyBreakdown(samples, NOW);
  assert.equal(d.days[5].pct, 3);
  assert.equal(d.days[6].pct, 2);
  assert.equal(d.periodsText, "凌晨 40%・晚上 60%");
});

test("每日用量：每週重置後從 0 重新累計，不會算成負的或重複計算", () => {
  const next = RESET + 7 * DAY;
  const samples = [
    { t: at(1, 10), p: 90, r: RESET - 3 * DAY },
    { t: at(1, 12), p: 95, r: RESET - 3 * DAY }, // +5
    { t: at(1, 15), p: 0, r: null }, // 重置了，新視窗還沒開始
    { t: at(1, 18), p: 4, r: next }, // +4
    { t: at(0, 9), p: 9, r: next } // +5
  ];
  const d = api.dailyBreakdown(samples, NOW);
  assert.equal(d.days[5].pct, 9);
  assert.equal(d.days[6].pct, 5);

  // 兩筆之間直接跨到新視窗：新視窗的用量全算在後面那一筆
  const jump = [
    { t: at(1, 10), p: 95, r: RESET - 3 * DAY },
    { t: at(0, 9), p: 7, r: next }
  ];
  assert.equal(api.dailyBreakdown(jump, NOW).days[6].pct, 7);

  // 同一個視窗裡數字變小（四捨五入抖動）不會被當成用量
  const dip = [
    { t: at(0, 9), p: 10, r: RESET },
    { t: at(0, 10), p: 9, r: RESET },
    { t: at(0, 11), p: 12, r: RESET }
  ];
  assert.equal(api.dailyBreakdown(dip, NOW).today, 3);
});

test("每日用量：沒有資料、只有一筆、超過 7 天的舊資料", () => {
  const empty = api.dailyBreakdown([], NOW);
  assert.equal(empty.hasData, false);
  assert.equal(empty.today, null);
  assert.equal(empty.avg, null);
  assert.equal(empty.periodsText, "");

  const one = api.dailyBreakdown([{ t: at(0, 9), p: 30, r: RESET }], NOW);
  assert.equal(one.hasData, false);
  assert.equal(one.today, 0);

  const old = api.dailyBreakdown([
    { t: at(9, 9), p: 0, r: RESET - 7 * DAY },
    { t: at(9, 12), p: 50, r: RESET - 7 * DAY },
    { t: at(0, 9), p: 3, r: RESET }
  ], NOW);
  assert.equal(old.total, 3);
  assert.deepEqual([...old.days.map((x) => x.pct)], [0, 0, 0, 0, 0, 0, 3]);
});

test("參數：可以混寫「7d 明細」", () => {
  assert.equal(api.parseMode("明細"), "where");
  assert.equal(api.parseMode("7d 明細"), "where");
  assert.equal(api.parseMode("WHERE"), "where");
  assert.equal(api.parseMode("7d"), "usage");
  assert.equal(api.parseMode(null), "usage");
  assert.equal(api.parseParam("7d 明細"), "7d");
  assert.equal(api.parseParam("明細,7d"), "7d");
  assert.equal(api.parseParam("明細"), "5h");
  assert.equal(api.parseParam("where"), "5h");
  assert.equal(api.parseParam("weekly"), "7d");
});

test("分類用量：已知欄位用中文標籤，沒看過的欄位也會顯示", () => {
  const usage = api.normalizeUsage({
    five_hour: { utilization: 10 },
    seven_day: { utilization: 20 },
    seven_day_design_tools: { utilization: 7 },
    seven_day_sonnet: { utilization: 12 },
    seven_day_opus: { utilization: 30 },
    seven_day_oauth_apps: null,
    some_flag: true,
    extra_usage: null
  });
  assert.deepEqual([...usage.models.map((m) => `${m.label} ${m.percent}`)],
    ["Opus 每週 30", "Sonnet 每週 12", "design tools 每週 7"]);
  assert.deepEqual([...usage.fields],
    ["five_hour", "seven_day", "seven_day_design_tools", "seven_day_sonnet", "seven_day_opus", "some_flag"]);
  assert.equal(api.windowLabel("five_hour_opus"), "opus 5 小時");
});

// ---------------------------------------------------------------------------
// 小工具

test("中尺寸＋參數「明細」：每日長條、今天、日均、時段", async () => {
  const texts = await run(widgetEnv("medium", "明細"));
  assert.ok(texts.includes("Claude 用量去向"));
  assert.ok(texts.includes("今天用掉每週額度"));
  assert.ok(texts.includes("+8%"));
  assert.ok(texts.includes("近 7 天 +18%・日均 6%"));
  assert.ok(texts.includes("每週 18%・週四 14:00 重置"));
  assert.ok(texts.includes("時段　上午 17%・下午 50%・晚上 33%"));
  // 長條上方的數字：四天沒資料、4、6、8
  const values = texts.filter((t) => /^(–|\d+)$/.test(t));
  assert.deepEqual([...values], ["–", "–", "–", "–", "4", "6", "8"]);
});

test("中尺寸＋「明細」：有分類用量時，最下面改顯示分類", async () => {
  const body = JSON.stringify({
    five_hour: { utilization: 10, resets_at: "2026-10-19T08:00:00Z" },
    seven_day: { utilization: 18, resets_at: "2026-10-22T06:00:00Z" },
    seven_day_opus: { utilization: 11, resets_at: "2026-10-22T06:00:00Z" },
    seven_day_sonnet: { utilization: 5, resets_at: "2026-10-22T06:00:00Z" }
  });
  const texts = await run(widgetEnv("medium", "明細", { server: { usage: body } }));
  assert.ok(texts.includes("Opus 每週 11%・Sonnet 每週 5%"));
});

test("小尺寸＋「明細」：今天用了多少與七天長條", async () => {
  const texts = await run(widgetEnv("small", "明細"));
  assert.equal(texts[1], "今天");
  assert.equal(texts[2], "+8%");
  assert.equal(texts[3], "佔每週額度");
  assert.deepEqual([...texts.slice(4, 11)], ["二", "三", "四", "五", "六", "日", "一"]);
});

test("中尺寸（預設）：沒開使用量額度時，底部顯示今天用了多少與節奏", async () => {
  const body = JSON.stringify({
    five_hour: { utilization: 42, resets_at: "2026-10-19T08:00:00Z" },
    seven_day: { utilization: 18, resets_at: "2026-10-22T06:00:00Z" },
    extra_usage: { is_enabled: false }
  });
  const texts = await run(widgetEnv("medium", null, { server: { usage: body } }));
  assert.ok(texts.includes("今天 +8%・節奏從容"));
});

test("大尺寸：直接顯示每日用量與時段，不用加參數", async () => {
  const texts = await run(widgetEnv("large", null));
  assert.ok(texts.includes("每日用量（佔每週額度）"));
  assert.ok(texts.includes("今天 +8%・日均 6%"));
  assert.ok(texts.includes("時段　上午 17%・下午 50%・晚上 33%"));
});

test("鎖定畫面＋「明細」：長條與單行", async () => {
  const rectEnv = widgetEnv("accessoryRectangular", "明細");
  const rect = await run(rectEnv);
  assert.deepEqual([...rect], ["Claude 今天 +8%", "近 7 天 +18%・每週 18%"]);
  assert.equal(collectImages(rectEnv.setWidget).length, 1);

  const inline = await run(widgetEnv("accessoryInline", "明細"));
  assert.deepEqual([...inline], ["Claude 今天 +8%・週 18%"]);

  // 圓環沒有明細版面，照常顯示
  const ringEnv = widgetEnv("accessoryCircular", "明細");
  await run(ringEnv);
  assert.deepEqual([...collectImages(ringEnv.setWidget)[0].texts], ["42", "5h"]);
});

test("「明細」剛安裝還沒有紀錄：顯示累積資料中，不會出錯", async () => {
  const env = createEnv({
    now: NOW,
    keychain: { [KEYS.session]: KEY },
    handler: fakeClaude(),
    config: { runsInWidget: true, runsInApp: false, widgetFamily: "medium" },
    args: { widgetParameter: "明細" }
  });
  const texts = await run(env);
  assert.ok(texts.includes("+0%"));
  assert.ok(texts.includes("累積資料中…（每次更新會記錄一筆）"));
});

test("App 詳細頁：有「用量花在哪」區塊與 claude.ai 提供的欄位", async () => {
  const env = createEnv({
    now: NOW,
    keychain: { [KEYS.session]: KEY },
    files: { [CACHE]: JSON.stringify({ samples7d: HISTORY }) },
    handler: fakeClaude()
  });
  const a = await env.ready;
  await a.main();
  const table = env.presentedTable;
  const titles = tableTitles(table);
  assert.ok(titles.includes("用量花在哪"));
  assert.ok(titles.includes("今天用掉每週額度：+8%"));
  assert.ok(titles.includes("時段分布"));
  const cells = table.rows.flatMap((r) => r.cells).filter((c) => c.type === "text");
  const daily = cells.find((c) => c.title === "每日明細");
  assert.equal(daily.subtitle, "二 –・三 –・四 –・五 –・六 4%・日 6%・今天 8%");
  const today = cells.find((c) => c.title === "今天用掉每週額度：+8%");
  assert.equal(today.subtitle, "近 7 天共 +18%，平均每天 6%\n最多的一天：今天 +8%");
  const fields = cells.find((c) => c.title === "claude.ai 提供的欄位");
  assert.ok(fields.subtitle.startsWith("five_hour、seven_day、extra_usage"));
});

test("捷徑摘要也包含今天用了多少", async () => {
  const env = widgetEnv(null, null, { config: { runsInWidget: false, runsInApp: false } });
  const a = await env.ready;
  await a.main();
  assert.ok(env.shortcutOutput.endsWith("；今天用掉每週額度 8%"));
});
