"use strict";

// 隨機亂數測試：餵各種奇怪的 API 回應與損毀的快取，
// 確認每種尺寸都畫得出來，而且從來不會走到「未預期的錯誤」。

const test = require("node:test");
const assert = require("node:assert/strict");
const { createEnv, collectTexts } = require("./scriptable-mock");

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 9, 19, 5, 0, 0);
const KEY = "sk-ant-sid01-test-key-0000000000000000000000";
const FAMILIES = ["small", "medium", "large", "accessoryCircular", "accessoryRectangular", "accessoryInline", undefined];

// 固定種子的亂數，失敗時可以重現
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function maker(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const time = () => pick([
    new Date(NOW + (rand() - 0.3) * 8 * 24 * 3600 * 1000).toISOString(),
    "2026-10-19T08:00:00.123456+00:00",
    "2026-10-19 16:00:00+08:00",
    "明天", "", null, 0, -1, 1760860800, 1e20, true, {}
  ]);
  const num = () => pick([0, 1, 42.4, 79.9, 80, 99.6, 100, 150, -20, "55", "abc", null, true, 1e308, [], {}]);
  const value = (depth) => {
    const kinds = ["null", "num", "str", "bool", "arr", "obj"];
    const k = depth > 2 ? pick(kinds.slice(0, 4)) : pick(kinds);
    if (k === "null") return null;
    if (k === "num") return num();
    if (k === "str") return pick(["", "x", "null", "50", "<html>"]);
    if (k === "bool") return rand() < 0.5;
    if (k === "arr") return [value(depth + 1), value(depth + 1)];
    return { utilization: value(depth + 1), resets_at: value(depth + 1) };
  };
  const windowLike = () => pick([
    { utilization: num(), resets_at: time() },
    { utilization: num() },
    { utilization_pct: num(), reset_at: time() },
    null, undefined, value(0)
  ]);
  const extraLike = () => pick([
    { is_enabled: true, monthly_limit: num(), used_credits: num(), utilization: num(), currency: pick(["USD", "TWD", "", 5, null]) },
    { is_enabled: false },
    { current_spending: num(), budget_limit: num() },
    null, value(0)
  ]);
  const usage = () => {
    if (rand() < 0.08) return value(0);
    const out = {};
    for (const key of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]) {
      const w = windowLike();
      if (w !== undefined) out[key] = w;
    }
    out.extra_usage = extraLike();
    return out;
  };
  const response = () => {
    const r = rand();
    if (r < 0.05) return { status: pick([0, 401, 403, 404, 429, 500, 503]), body: pick(["", "{}", "<html>Just a moment</html>"]) };
    if (r < 0.08) return { status: 200, body: pick(["", "not json", "<html></html>", "null", "[]", "42"]) };
    if (r < 0.1) return "throw";
    return { status: 200, body: JSON.stringify(usage()) };
  };
  const cache = () => pick([
    "{壞掉", "null", "[]", "42",
    JSON.stringify({ usage: value(0), samples5h: value(0), samples7d: [value(1)], notify: value(0), fetchedAt: num(), lockUntil: num() }),
    JSON.stringify({ usage: { fiveHour: { percent: num(), resetAt: num() }, sevenDay: value(0), extra: value(0), models: [value(0)] }, fetchedAt: NOW - 3 * MIN })
  ]);
  return { pick, usage, response, cache, value };
}

const ORGS = JSON.stringify([{ uuid: "org-1", name: "x", capabilities: ["chat", "claude_pro"] }]);

test("亂數 API 回應 × 所有尺寸：不會出現未預期的錯誤", async () => {
  const rand = rng(20261019);
  const m = maker(rand);
  let current = null;
  const env = createEnv({
    now: NOW,
    keychain: { "claude-usage-tw.sessionKey": KEY },
    handler: (url) => {
      if (url.endsWith("/api/organizations")) return { status: 200, body: ORGS };
      if (current === "throw") throw new Error("offline");
      return current;
    },
    config: { runsInWidget: true, runsInApp: false, widgetFamily: "small" }
  });
  const api = await env.ready;
  for (let i = 0; i < 400; i++) {
    current = m.response();
    env.setNow(NOW + i * 2 * MIN);
    env.sandbox.config.widgetFamily = FAMILIES[i % FAMILIES.length];
    env.sandbox.args.widgetParameter = m.pick([null, "7d", "5h", "亂打"]);
    env.setWidget = null;
    env.completed = false;
    await api.main();
    assert.ok(env.setWidget, `第 ${i} 次沒有產生小工具`);
    assert.equal(env.completed, true);
    const texts = collectTexts(env.setWidget);
    assert.ok(!texts.includes("發生未預期的錯誤"), `第 ${i} 次：${JSON.stringify(current).slice(0, 300)}`);
    for (const t of texts) assert.ok(!/NaN|undefined|null|\[object/.test(t), `第 ${i} 次出現奇怪文字：${t}`);
  }
});

test("亂數損毀快取 × 斷線：不會出現未預期的錯誤", async () => {
  const rand = rng(7);
  const m = maker(rand);
  for (let i = 0; i < 120; i++) {
    const env = createEnv({
      now: NOW,
      keychain: { "claude-usage-tw.sessionKey": KEY, "claude-usage-tw.orgId": "org-1" },
      files: { "claude-usage-tw-cache.json": m.cache(), "claude-usage-tw-settings.json": m.pick(["{", "[]", JSON.stringify({ alertPct: m.value(0) })]) },
      handler: () => { throw new Error("offline"); },
      config: { runsInWidget: true, runsInApp: false, widgetFamily: FAMILIES[i % FAMILIES.length] }
    });
    const api = await env.ready;
    await api.main();
    const texts = collectTexts(env.setWidget);
    assert.ok(!texts.includes("發生未預期的錯誤"), `第 ${i} 次`);
    for (const t of texts) assert.ok(!/NaN|undefined|\[object/.test(t), `第 ${i} 次出現奇怪文字：${t}`);
  }
});

test("亂數輸入丟給純函式：都不會丟出例外", async () => {
  const rand = rng(99);
  const m = maker(rand);
  const api = await createEnv({ now: NOW }).ready;
  for (let i = 0; i < 2000; i++) {
    const raw = m.usage();
    const usage = api.normalizeUsage(raw);
    const state = api.sanitizeState({ usage, fetchedAt: NOW - MIN, samples5h: [m.value(1)] });
    const view = api.buildView(state, NOW, rand() < 0.3 ? new api.UsageError("network") : null);
    api.summaryText(view, NOW);
    api.statusLine(view, NOW);
    api.planNotifications(m.value(0), usage, NOW, m.value(0), rand() < 0.2 ? new api.UsageError("auth") : null);
    api.parseExtra(m.value(0));
    api.parseTime(m.value(0));
  }
});
