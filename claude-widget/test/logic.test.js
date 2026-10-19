"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createEnv, fixture } = require("./scriptable-mock");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// 2026-10-19 05:00 UTC = 台灣時間 13:00（週一）
const NOW = Date.UTC(2026, 9, 19, 5, 0, 0);

let api;
test.before(async () => {
  api = await createEnv({ now: NOW }).ready;
});

test("解析正常的用量回應：百分比四捨五入、重置時間、額度（分 → 元）", () => {
  const usage = api.normalizeUsage(JSON.parse(fixture("usage-normal.json")));
  assert.equal(usage.fiveHour.percent, 42);
  assert.equal(usage.fiveHour.resetAt, Date.UTC(2026, 9, 19, 8, 0, 0));
  assert.equal(usage.sevenDay.percent, 18);
  assert.equal(usage.sevenDay.resetAt, Date.UTC(2026, 9, 22, 6, 0, 0));
  assert.equal(usage.extra.enabled, true);
  assert.equal(usage.extra.used, 3.2);
  assert.equal(usage.extra.limit, 50);
  assert.equal(usage.extra.percent, 6);
  assert.equal(api.extraText(usage.extra), "$3.20 / $50.00");
});

test("百分比會被限制在 0～100，字串數字也能解析", () => {
  assert.equal(api.parseWindow({ utilization: 123.7, resets_at: null }).percent, 100);
  assert.equal(api.parseWindow({ utilization: -5 }).percent, 0);
  assert.equal(api.parseWindow({ utilization: "55.5" }).percent, 56);
  assert.equal(api.parseWindow({ utilization: "abc" }), null);
});

test("額度未開啟時回傳 enabled:false，且不顯示金額", () => {
  const extra = api.parseExtra({ is_enabled: false, monthly_limit: null });
  assert.deepEqual({ ...extra }, { enabled: false });
  assert.equal(api.extraText(extra), null);
  assert.equal(api.extraText(null), null);
});

test("舊格式 current_spending / budget_limit（元）也能解析", () => {
  const extra = api.parseExtra({ current_spending: 12.5, budget_limit: 50 });
  assert.equal(extra.used, 12.5);
  assert.equal(extra.limit, 50);
  assert.equal(extra.percent, 25);
});

test("格式不符時回傳 null，不會丟出例外", () => {
  assert.equal(api.normalizeUsage(JSON.parse(fixture("usage-weird.json"))), null);
  assert.equal(api.normalizeUsage(null), null);
  assert.equal(api.normalizeUsage([1, 2]), null);
  assert.equal(api.normalizeUsage("hello"), null);
  assert.equal(api.normalizeUsage({ five_hour: "x", seven_day: 3 }), null);
});

test("自動挑選 Claude Pro 組織，而不是 API 組織", () => {
  const org = api.pickOrganization(JSON.parse(fixture("organizations.json")));
  assert.equal(org.id, "org-pro-1234");
  assert.equal(org.name, "我的 Claude");
  assert.equal(api.pickOrganization({ organizations: [{ id: "x1" }] }).id, "x1");
  assert.equal(api.pickOrganization([]), null);
  assert.equal(api.pickOrganization("bad"), null);
});

test("sessionKey 正規化：可貼整段 cookie、去掉引號", () => {
  const key = "sk-ant-sid01-abcdefghijklmnopqrstuvwxyz_0123";
  assert.equal(api.normalizeSessionKey(key), key);
  assert.equal(api.normalizeSessionKey(`  "${key}" `), key);
  assert.equal(api.normalizeSessionKey(`Cookie: foo=1; sessionKey=${key}; bar=2`), key);
  assert.equal(api.normalizeSessionKey("太短"), null);
  assert.equal(api.normalizeSessionKey(""), null);
  assert.equal(api.looksLikeSessionKey(key), true);
  assert.equal(api.looksLikeSessionKey("abcdefghijklmnopqrstuvwxyz"), false);
});

test("顏色門檻：<60 綠、60～79 橙、>=80 紅", () => {
  assert.equal(api.levelFor(0), "green");
  assert.equal(api.levelFor(59), "green");
  assert.equal(api.levelFor(60), "orange");
  assert.equal(api.levelFor(79), "orange");
  assert.equal(api.levelFor(80), "red");
  assert.equal(api.levelFor(100), "red");
  assert.equal(api.levelFor(null), "none");
});

test("台灣時間格式：時鐘、明天、週幾、日期", () => {
  assert.equal(api.fmtClock(NOW), "13:00");
  // 16:00 UTC = 隔天 00:00 台灣時間
  assert.equal(api.fmtWhen(Date.UTC(2026, 9, 19, 15, 59), NOW), "23:59");
  assert.equal(api.fmtWhen(Date.UTC(2026, 9, 19, 16, 0), NOW), "明天 00:00");
  assert.equal(api.fmtWhen(Date.UTC(2026, 9, 22, 6, 0), NOW), "週四 14:00");
  assert.equal(api.fmtWhen(Date.UTC(2026, 10, 2, 1, 5), NOW), "11/2 09:05");
});

test("倒數與「X 分鐘前」", () => {
  assert.equal(api.fmtCountdown(NOW + 3 * HOUR, NOW), "3 小時後重置");
  assert.equal(api.fmtCountdown(NOW + 2 * HOUR + 13 * MIN, NOW), "2 小時 13 分後重置");
  assert.equal(api.fmtCountdown(NOW + 37 * MIN + 10 * 1000, NOW), "38 分後重置");
  assert.equal(api.fmtCountdown(NOW + 3 * 24 * HOUR + 4 * HOUR, NOW), "3 天 4 小時後重置");
  assert.equal(api.fmtCountdown(NOW - 1, NOW), "即將重置");
  assert.equal(api.fmtCountdown(null, NOW), "尚未開始計時");
  assert.equal(api.fmtDurationShort(2 * HOUR + 5 * MIN), "2時05分");
  assert.equal(api.fmtAgo(NOW - 20 * 1000, NOW), "剛剛");
  assert.equal(api.fmtAgo(NOW - 7 * MIN, NOW), "7 分鐘前");
  assert.equal(api.fmtAgo(NOW - 3 * HOUR, NOW), "3 小時前");
  assert.equal(api.fmtAgo(NOW - 50 * HOUR, NOW), "2 天前");
});

test("重置時間已過的視窗（快取）視為 0%", () => {
  const win = { percent: 90, resetAt: NOW - MIN };
  assert.equal(api.currentWindow(win, NOW).percent, 0);
  assert.equal(api.currentWindow({ percent: 90, resetAt: NOW + MIN }, NOW).percent, 90);
  assert.equal(api.currentWindow(null, NOW), null);
});

test("速度預估：沒有樣本時用視窗平均速度", () => {
  // 視窗 03:00 開始、08:00 重置，2 小時用了 42% → 約 15:45 用完（台灣時間）
  const win = { percent: 42, resetAt: Date.UTC(2026, 9, 19, 8, 0) };
  const pred = api.predictExhaust(win, api.constants.FIVE_HOURS, [], NOW);
  assert.equal(pred.kind, "at");
  assert.equal(api.fmtClock(pred.at), "15:45");
  assert.equal(api.predictionText(pred, NOW), "照目前速度，約 15:45 用完");
});

test("速度預估：速度慢時「重置前用不完」", () => {
  const win = { percent: 10, resetAt: Date.UTC(2026, 9, 19, 8, 0) };
  const pred = api.predictExhaust(win, api.constants.FIVE_HOURS, [], NOW);
  assert.equal(pred.kind, "never");
  assert.equal(api.predictionText(pred, NOW), "照目前速度，重置前用不完");
});

test("速度預估：有近期樣本時用近期速度", () => {
  const resetAt = Date.UTC(2026, 9, 19, 8, 0);
  // 30 分鐘前 30%，現在 60% → 每分鐘 1%，40 分鐘後用完 → 13:40
  const samples = [{ t: NOW - 30 * MIN, p: 30, r: resetAt }];
  const pred = api.predictExhaust({ percent: 60, resetAt }, api.constants.FIVE_HOURS, samples, NOW);
  assert.equal(pred.kind, "at");
  assert.equal(api.fmtClock(pred.at), "13:40");

  // 近期完全沒用 → 重置前用不完
  const idle = [{ t: NOW - 30 * MIN, p: 60, r: resetAt }];
  assert.equal(api.predictExhaust({ percent: 60, resetAt }, api.constants.FIVE_HOURS, idle, NOW).kind, "never");

  // 不同視窗的樣本會被忽略，退回平均速度
  const other = [{ t: NOW - 30 * MIN, p: 0, r: resetAt - 5 * HOUR }];
  const avg = api.predictExhaust({ percent: 42, resetAt }, api.constants.FIVE_HOURS, other, NOW);
  assert.equal(api.fmtClock(avg.at), "15:45");
});

test("速度預估：已用完、資料不足", () => {
  const resetAt = Date.UTC(2026, 9, 19, 8, 0);
  const full = api.predictExhaust({ percent: 100, resetAt }, api.constants.FIVE_HOURS, [], NOW);
  assert.equal(full.kind, "full");
  assert.equal(api.predictionText(full, NOW), "已用完，16:00 恢復");
  // 視窗剛開始 1 分鐘，資料不足
  const fresh = api.predictExhaust({ percent: 5, resetAt: NOW + 5 * HOUR - MIN }, api.constants.FIVE_HOURS, [], NOW);
  assert.equal(fresh.kind, "unknown");
  assert.equal(api.predictExhaust({ percent: 0, resetAt: null }, api.constants.FIVE_HOURS, [], NOW).kind, "unknown");
});

test("記錄樣本：去掉過舊的、一分鐘內只留一筆", () => {
  const win = { percent: 20, resetAt: NOW + HOUR };
  let s = api.recordSample([{ t: NOW - 7 * HOUR, p: 1, r: 1 }], win, NOW, 6 * HOUR);
  assert.equal(s.length, 1);
  s = api.recordSample(s, { percent: 21, resetAt: NOW + HOUR }, NOW + 30 * 1000, 6 * HOUR);
  assert.equal(s.length, 1);
  assert.equal(s[0].p, 21);
  s = api.recordSample(s, { percent: 25, resetAt: NOW + HOUR }, NOW + 5 * MIN, 6 * HOUR);
  assert.equal(s.length, 2);
});

test("小工具參數：7d 切到每週", () => {
  assert.equal(api.parseParam("7d"), "7d");
  assert.equal(api.parseParam(" 7D "), "7d");
  assert.equal(api.parseParam("每週"), "7d");
  assert.equal(api.parseParam(""), "5h");
  assert.equal(api.parseParam(null), "5h");
  assert.equal(api.parseParam("5h"), "5h");
});

test("下次更新：5 分鐘後，或重置後 1 分鐘（較早者）", () => {
  const usage = { fiveHour: { percent: 50, resetAt: NOW + 2 * MIN }, sevenDay: null };
  assert.equal(api.nextRefreshAt(usage, NOW), NOW + 3 * MIN);
  const later = { fiveHour: { percent: 50, resetAt: NOW + HOUR }, sevenDay: null };
  assert.equal(api.nextRefreshAt(later, NOW), NOW + 5 * MIN);
  assert.equal(api.nextRefreshAt(null, NOW), NOW + 5 * MIN);
});

test("通知：預約重置提醒，同一個視窗不重複預約", () => {
  const resetAt = NOW + 3 * HOUR;
  const usage = { fiveHour: { percent: 30, resetAt }, sevenDay: { percent: 10, resetAt: NOW + 48 * HOUR } };
  const first = api.planNotifications({}, usage, NOW);
  assert.equal(first.schedule.length, 1);
  assert.equal(first.schedule[0].title, "Claude 額度回來了 🎉");
  assert.equal(first.schedule[0].at, resetAt + 30 * 1000);
  assert.equal(first.immediate.length, 0);

  // resets_at 有幾秒抖動也算同一個視窗
  const jitter = { ...usage, fiveHour: { percent: 35, resetAt: resetAt + 2000 } };
  const second = api.planNotifications(first.state, jitter, NOW + 5 * MIN);
  assert.equal(second.schedule.length, 0);

  // 新視窗 → 再預約
  const nextWin = { ...usage, fiveHour: { percent: 5, resetAt: resetAt + 5 * HOUR } };
  const third = api.planNotifications(second.state, nextWin, resetAt + 10 * MIN);
  assert.equal(third.schedule.length, 1);
});

test("通知：用量 0% 不預約重置提醒", () => {
  const usage = { fiveHour: { percent: 0, resetAt: NOW + HOUR }, sevenDay: null };
  assert.equal(api.planNotifications({}, usage, NOW).schedule.length, 0);
});

test("通知：超過 80% 只提醒一次，新視窗才會再提醒", () => {
  const resetAt = NOW + HOUR;
  const usage = { fiveHour: { percent: 82, resetAt }, sevenDay: { percent: 50, resetAt: NOW + 48 * HOUR } };
  const a = api.planNotifications({}, usage, NOW);
  assert.equal(a.immediate.length, 1);
  assert.equal(a.immediate[0].title, "Claude 5 小時用量已達 82%");
  assert.match(a.immediate[0].body, /1 小時後重置（14:00）/);

  const b = api.planNotifications(a.state, { ...usage, fiveHour: { percent: 95, resetAt } }, NOW + 5 * MIN);
  assert.equal(b.immediate.length, 0);

  // 79% 不提醒
  const low = api.planNotifications({}, { fiveHour: { percent: 79, resetAt }, sevenDay: null }, NOW);
  assert.equal(low.immediate.length, 0);

  // 下一個視窗又超過 → 再提醒
  const next = { fiveHour: { percent: 90, resetAt: resetAt + 5 * HOUR }, sevenDay: usage.sevenDay };
  const c = api.planNotifications(b.state, next, resetAt + HOUR);
  assert.equal(c.immediate.length, 1);
});

test("通知：每週用量也各自只提醒一次", () => {
  const usage = { fiveHour: { percent: 85, resetAt: NOW + HOUR }, sevenDay: { percent: 81, resetAt: NOW + 48 * HOUR } };
  const a = api.planNotifications({}, usage, NOW);
  assert.deepEqual([...a.immediate.map((n) => n.title)], ["Claude 5 小時用量已達 85%", "Claude 每週用量已達 81%"]);
  const b = api.planNotifications(a.state, usage, NOW + MIN);
  assert.equal(b.immediate.length, 0);
});

test("buildView：組合畫面資料", () => {
  const usage = api.normalizeUsage(JSON.parse(fixture("usage-normal.json")));
  const state = api.applySuccess({}, { usage, orgName: "x" }, NOW - 3 * MIN);
  const view = api.buildView(state, NOW, null);
  assert.equal(view.hasData, true);
  assert.equal(view.fiveHour.percent, 42);
  assert.equal(view.fiveHour.level, "green");
  assert.equal(view.fiveHour.countdown, "3 小時後重置");
  assert.equal(view.sevenDay.resetWhen, "週四 14:00");
  assert.equal(view.updatedText, "上次更新 3 分鐘前");
  assert.equal(view.extraText, "$3.20 / $50.00");
  assert.equal(view.stale, false);
});
