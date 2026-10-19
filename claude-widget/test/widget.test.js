"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createEnv, fakeClaude, collectTexts, collectImages } = require("./scriptable-mock");

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 9, 19, 5, 0, 0); // 台灣時間 13:00
const KEY = "sk-ant-sid01-test-key-0000000000000000000000";
const KEYS = { session: "claude-usage-tw.sessionKey", org: "claude-usage-tw.orgId" };
const CACHE = "claude-usage-tw-cache.json";

function widgetEnv(family, extra = {}) {
  return createEnv({
    now: NOW,
    keychain: { [KEYS.session]: KEY, ...(extra.keychain || {}) },
    files: extra.files,
    handler: extra.handler || fakeClaude(extra.server),
    config: { runsInWidget: true, runsInApp: false, widgetFamily: family },
    args: { widgetParameter: extra.param || null }
  });
}

async function runWidget(env) {
  const api = await env.ready;
  await api.main();
  assert.ok(env.setWidget, "應該要呼叫 Script.setWidget");
  assert.equal(env.completed, true);
  return { api, widget: env.setWidget, texts: collectTexts(env.setWidget) };
}

test("中尺寸：顯示 5 小時、每週、額度與上次更新", async () => {
  const env = widgetEnv("medium");
  const { texts, widget } = await runWidget(env);
  assert.ok(texts.includes("42%"));
  assert.ok(texts.includes("18%"));
  assert.ok(texts.includes("3 小時後重置"));
  assert.ok(texts.includes("週四 14:00 重置"));
  assert.ok(texts.includes("約 15:45 用完"));
  assert.ok(texts.includes("重置前用不完"));
  assert.ok(texts.includes("使用量額度"));
  assert.ok(texts.includes("$3.20 / $50.00（6%）"));
  assert.ok(texts.includes("上次更新 剛剛"));
  // 每 5 分鐘更新
  assert.equal(widget.refreshAfterDate.getTime(), NOW + 5 * MIN);
  // 深淺色：背景是動態顏色
  assert.ok(widget.backgroundColor.light && widget.backgroundColor.dark);
});

test("請求帶上 sessionKey cookie 與瀏覽器 header，並自動抓組織 ID 存進 Keychain", async () => {
  const env = widgetEnv("small");
  await runWidget(env);
  assert.equal(env.requests[0].url, "https://claude.ai/api/organizations");
  assert.equal(env.requests[1].url, "https://claude.ai/api/organizations/org-pro-1234/usage");
  assert.equal(env.requests[1].headers.Cookie, `sessionKey=${KEY}`);
  assert.match(env.requests[1].headers["User-Agent"], /iPhone/);
  assert.equal(env.requests[1].headers.Accept, "application/json");
  assert.equal(env.keychain.get(KEYS.org), "org-pro-1234");
  // 快取裡不能有金鑰
  assert.ok(!env.files.get(CACHE).includes(KEY));
});

test("已存組織 ID 時只打一次 usage", async () => {
  const env = widgetEnv("small", { keychain: { [KEYS.org]: "org-pro-1234" } });
  await runWidget(env);
  assert.equal(env.requests.length, 1);
});

test("小尺寸＋參數 7d：主要顯示每週", async () => {
  const env = widgetEnv("small", { param: "7d" });
  const { texts } = await runWidget(env);
  assert.ok(texts.includes("每週"));
  assert.equal(texts[texts.indexOf("每週") + 1], "18%");
  assert.ok(texts.includes("5 小時 42%"));
});

test("鎖定畫面圓環：圖片中有百分比與標籤", async () => {
  const env = widgetEnv("accessoryCircular");
  const { widget } = await runWidget(env);
  const [img] = collectImages(widget);
  assert.deepEqual([...img.texts], ["42", "5h"]);
  assert.equal(widget.addAccessoryWidgetBackground, true);

  const env7 = widgetEnv("accessoryCircular", { param: "7d" });
  const r7 = await runWidget(env7);
  assert.deepEqual([...collectImages(r7.widget)[0].texts], ["18", "週"]);
});

test("鎖定畫面長條與單行", async () => {
  const rect = await runWidget(widgetEnv("accessoryRectangular"));
  assert.ok(rect.texts.includes("Claude 5 小時 42%"));
  assert.ok(rect.texts.includes("3時00分後重置・約 15:45 用完"));
  assert.ok(rect.texts.includes("每週 18%"));

  const inline = await runWidget(widgetEnv("accessoryInline"));
  assert.deepEqual([...inline.texts], ["Claude 5h 42%・3時00分後重置"]);

  const inline7 = await runWidget(widgetEnv("accessoryInline", { param: "7d" }));
  assert.deepEqual([...inline7.texts], ["Claude 週 18%・週四 14:00重置"]);
});

test("顏色依用量變化：高用量為紅色並發出一次 80% 通知", async () => {
  const env = widgetEnv("medium", { server: { usage: "usage-high.json" } });
  const { texts } = await runWidget(env);
  assert.ok(texts.includes("86%"));
  // 額度未開啟就不顯示
  assert.ok(!texts.includes("使用量額度"));
  const titles = env.scheduled.map((n) => n.title);
  assert.ok(titles.includes("Claude 5 小時用量已達 86%"));
  assert.ok(titles.includes("Claude 每週用量已達 81%"));
  assert.ok(titles.includes("Claude 額度回來了 🎉"));
  const reset = env.scheduled.find((n) => n.title.startsWith("Claude 額度回來了"));
  assert.equal(reset.at, Date.UTC(2026, 9, 19, 8, 0, 30));
  assert.ok(env.removedPending.includes("claude-usage-tw.reset"));

  // 5 分鐘後再跑一次：不重複通知
  env.scheduled.length = 0;
  env.setNow(NOW + 5 * MIN);
  await env.sandbox.__CLAUDE_USAGE_TEST__.api.main();
  assert.equal(env.scheduled.length, 0);
});

test("顏色門檻實際套用到文字顏色", async () => {
  const env = widgetEnv("small", { server: { usage: "usage-high.json" } });
  const { widget } = await runWidget(env);
  const find = (node, text) => {
    if (node.text === text) return node;
    for (const c of node.children || []) {
      const r = find(c, text);
      if (r) return r;
    }
    return null;
  };
  assert.equal(find(widget, "86%").textColor.light.hex, "#D64545");
  const normal = await runWidget(widgetEnv("small"));
  assert.equal(find(normal.widget, "42%").textColor.light.hex, "#2E9E5B");
});

test("斷線時保留並顯示上次成功的資料", async () => {
  const env = widgetEnv("medium");
  await runWidget(env);
  const cache = env.files.get(CACHE);

  const offline = widgetEnv("medium", {
    files: { [CACHE]: cache },
    keychain: { [KEYS.org]: "org-pro-1234" },
    handler: () => { throw new Error("The Internet connection appears to be offline."); }
  });
  offline.setNow(NOW + 12 * MIN);
  const { texts } = await runWidget(offline);
  assert.ok(texts.includes("42%"));
  assert.ok(texts.includes("⚠️ 離線・12 分鐘前資料"));
  const saved = JSON.parse(offline.files.get(CACHE));
  assert.equal(saved.lastError.kind, "network");
  assert.equal(saved.fetchedAt, NOW);
});

test("快取的視窗已過重置時間時顯示 0%", async () => {
  const env = widgetEnv("small");
  await runWidget(env);
  const offline = widgetEnv("small", {
    files: { [CACHE]: env.files.get(CACHE) },
    keychain: { [KEYS.org]: "org-pro-1234" },
    handler: () => ({ status: 503, body: "busy" })
  });
  offline.setNow(Date.UTC(2026, 9, 19, 8, 1));
  const { texts } = await runWidget(offline);
  assert.ok(texts.includes("0%"));
  assert.ok(texts.includes("尚未開始計時"));
});

test("介面格式不符：友善顯示錯誤，不會當機", async () => {
  const env = widgetEnv("medium", { server: { usage: "usage-weird.json" } });
  const { texts } = await runWidget(env);
  assert.ok(texts.includes("回應格式不符"));
  assert.ok(texts.includes("介面可能已改版，請更新腳本"));
});

test("回應不是 JSON / Cloudflare 頁面", async () => {
  const html = await runWidget(widgetEnv("small", { server: { usage: "<html>oops</html>" } }));
  assert.ok(html.texts.includes("回應格式不符"));
  const cf = await runWidget(widgetEnv("small", {
    server: { usage: "<html><title>Just a moment...</title></html>", status: 403 }
  }));
  assert.ok(cf.texts.includes("被 Cloudflare 擋下"));
});

test("sessionKey 失效：提示重新登入", async () => {
  const env = createEnv({
    now: NOW,
    keychain: { [KEYS.session]: "bad-key-000000000000000000000" },
    handler: fakeClaude(),
    config: { runsInWidget: true, runsInApp: false, widgetFamily: "accessoryRectangular" }
  });
  const { texts } = await runWidget(env);
  assert.ok(texts.includes("登入已失效"));
  assert.ok(texts.includes("請重新貼上 sessionKey"));
});

test("尚未設定：顯示設定提示，且不發出任何請求", async () => {
  const env = createEnv({
    now: NOW,
    handler: fakeClaude(),
    config: { runsInWidget: true, runsInApp: false, widgetFamily: "small" }
  });
  const { texts } = await runWidget(env);
  assert.ok(texts.includes("尚未設定"));
  assert.ok(texts.includes("點一下開始設定"));
  assert.equal(env.requests.length, 0);
});

test("重置後立刻更新：refreshAfterDate 設在重置後 1 分鐘", async () => {
  const env = widgetEnv("small");
  env.setNow(Date.UTC(2026, 9, 19, 7, 58));
  const { widget } = await runWidget(env);
  assert.equal(widget.refreshAfterDate.getTime(), Date.UTC(2026, 9, 19, 8, 1));
});

test("首次設定精靈：貼上整段 cookie、自動抓組織、存進 Keychain", async () => {
  const env = createEnv({
    now: NOW,
    handler: fakeClaude(),
    alerts: [
      { index: 0 }, // 介紹 → 開始貼上
      { index: 0, text: `foo=1; sessionKey=${KEY}; bar=2` }, // 貼上
      { index: 0 } // 設定完成
    ]
  });
  const api = await env.ready;
  const ok = await api.setupWizard();
  assert.equal(ok, true);
  assert.equal(env.keychain.get(KEYS.session), KEY);
  assert.equal(env.keychain.get(KEYS.org), "org-pro-1234");
  assert.equal(env.alerts[2].title, "設定完成 ✅");
});

test("首次設定精靈：格式錯誤會要求重新輸入，取消則不儲存", async () => {
  const env = createEnv({
    now: NOW,
    handler: fakeClaude(),
    alerts: [
      { index: 0 },
      { index: 0, text: "亂打" },
      { index: 0 }, // 格式不正確 → 重新輸入
      { index: -1 } // 取消
    ]
  });
  const api = await env.ready;
  assert.equal(await api.setupWizard(), false);
  assert.equal(env.alerts[2].title, "格式不正確");
  assert.equal(env.keychain.size, 0);
});

test("首次設定精靈：金鑰錯誤顯示驗證失敗", async () => {
  const env = createEnv({
    now: NOW,
    handler: fakeClaude(),
    alerts: [
      { index: 0 },
      { index: 0, text: "sk-ant-sid99-wrong-but-long-enough-000000" },
      { index: 1 } // 驗證失敗 → 取消
    ]
  });
  const api = await env.ready;
  assert.equal(await api.setupWizard(), false);
  assert.equal(env.alerts[2].title, "驗證失敗：登入已失效");
  assert.equal(env.keychain.size, 0);
});

test("重設登入資料：清除 Keychain 與快取", async () => {
  const env = widgetEnv("small");
  const { api } = await runWidget(env);
  assert.ok(env.files.has(CACHE));
  api.resetCredentials();
  assert.equal(env.keychain.size, 0);
  assert.ok(!env.files.has(CACHE));
});

test("組織 ID 失效時自動重新查詢", async () => {
  const base = fakeClaude();
  const env = widgetEnv("small", {
    keychain: { [KEYS.org]: "org-gone" },
    handler: (url, headers) =>
      url.includes("org-gone") ? { status: 404, body: "{}" } : base(url, headers)
  });
  const { texts } = await runWidget(env);
  assert.ok(texts.includes("42%"));
  assert.equal(env.keychain.get(KEYS.org), "org-pro-1234");
});

test("App 內執行：已設定時直接開啟詳細頁並完成", async () => {
  const env = createEnv({
    now: NOW,
    keychain: { [KEYS.session]: KEY },
    handler: fakeClaude()
  });
  const api = await env.ready;
  await api.main();
  assert.equal(env.completed, true);
  assert.equal(env.requests.length, 2);
});

test("所有尺寸在深色模式下都能正常產生", async () => {
  for (const family of ["small", "medium", "large", "accessoryCircular", "accessoryRectangular", "accessoryInline"]) {
    const env = widgetEnv(family);
    env.dark = true;
    const { texts } = await runWidget(env);
    assert.ok(texts.length > 0 || collectImages(env.setWidget).length > 0, family);
  }
});
