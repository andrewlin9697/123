// 模擬 Scriptable 的執行環境，讓 ClaudeUsage.js 能在 Node 裡跑。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPT_PATH = path.join(__dirname, "..", "ClaudeUsage.js");
const FIXTURES = path.join(__dirname, "fixtures");

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

// ---- 小工具元件 ----

class WidgetText {
  constructor(text) {
    this.text = text;
  }
  centerAlignText() {}
  leftAlignText() {}
  rightAlignText() {}
}

class WidgetImage {
  constructor(image) {
    this.image = image;
  }
  centerAlignImage() {}
  leftAlignImage() {}
  rightAlignImage() {}
}

class WidgetStack {
  constructor() {
    this.children = [];
  }
  addText(text) {
    const t = new WidgetText(text);
    this.children.push(t);
    return t;
  }
  addImage(image) {
    const i = new WidgetImage(image);
    this.children.push(i);
    return i;
  }
  addStack() {
    const s = new WidgetStack();
    this.children.push(s);
    return s;
  }
  addSpacer(n) {
    this.children.push({ spacer: n === undefined ? null : n });
  }
  layoutHorizontally() {}
  layoutVertically() {}
  centerAlignContent() {}
  topAlignContent() {}
  setPadding() {}
}

class ListWidget extends WidgetStack {
  constructor() {
    super();
    this.presented = null;
  }
  async presentSmall() { this.presented = "small"; }
  async presentMedium() { this.presented = "medium"; }
  async presentAccessoryCircular() { this.presented = "accessoryCircular"; }
  async presentAccessoryRectangular() { this.presented = "accessoryRectangular"; }
  async presentAccessoryInline() { this.presented = "accessoryInline"; }
}

function collectTexts(node, out = []) {
  if (node instanceof WidgetText) out.push(node.text);
  if (node && node.children) node.children.forEach((c) => collectTexts(c, out));
  return out;
}

function collectImages(node, out = []) {
  if (node instanceof WidgetImage) out.push(node.image);
  if (node && node.children) node.children.forEach((c) => collectImages(c, out));
  return out;
}

// ---- 繪圖 ----

class Color {
  constructor(hex, alpha) {
    this.hex = hex;
    this.alpha = alpha === undefined ? 1 : alpha;
  }
  static dynamic(light, dark) {
    const c = new Color(light.hex, light.alpha);
    c.light = light;
    c.dark = dark;
    return c;
  }
}

class Font {
  constructor(name, size) {
    this.name = name;
    this.size = size;
  }
}
for (const name of [
  "systemFont", "regularSystemFont", "mediumSystemFont", "semiboldSystemFont",
  "boldSystemFont", "heavySystemFont", "boldRoundedSystemFont"
]) {
  Font[name] = (size) => new Font(name, size);
}

class Size { constructor(w, h) { this.width = w; this.height = h; } }
class Point { constructor(x, y) { this.x = x; this.y = y; } }
class Rect { constructor(x, y, w, h) { Object.assign(this, { x, y, width: w, height: h }); } }

class Path {
  constructor() { this.ops = []; }
  addRoundedRect(rect, rx, ry) { this.ops.push(["roundedRect", rect, rx, ry]); }
  addLines(points) { this.ops.push(["lines", points.length]); }
  addRect(rect) { this.ops.push(["rect", rect]); }
}

class DrawContext {
  constructor() { this.ops = []; this.texts = []; }
  addPath(p) { this.ops.push(["path", p]); }
  setFillColor(c) { this.ops.push(["fill", c]); }
  setStrokeColor(c) { this.ops.push(["stroke", c]); }
  setLineWidth(w) { this.ops.push(["lineWidth", w]); }
  fillPath() { this.ops.push(["fillPath"]); }
  strokePath() { this.ops.push(["strokePath"]); }
  setTextAlignedCenter() {}
  setTextColor() {}
  setFont() {}
  drawTextInRect(text) { this.texts.push(text); }
  getImage() { return { kind: "image", texts: this.texts.slice(), ops: this.ops.length }; }
}

// ---- 建立沙箱 ----

/**
 * @param {object} opts
 * @param {number} opts.now 固定的現在時間（毫秒）
 * @param {object} [opts.keychain] 預先放入的 Keychain 內容
 * @param {object} [opts.files] 預先放入的檔案（檔名 → 內容）
 * @param {function} [opts.handler] (url, headers) => { status, body } | throw
 * @param {object} [opts.config] Scriptable config
 * @param {object} [opts.args] Scriptable args
 */
function createEnv(opts = {}) {
  const env = {
    now: opts.now || Date.UTC(2026, 9, 19, 5, 0, 0),
    keychain: new Map(Object.entries(opts.keychain || {})),
    files: new Map(Object.entries(opts.files || {})),
    requests: [],
    scheduled: [],
    removedPending: [],
    setWidget: null,
    completed: false,
    dark: !!opts.dark,
    handler: opts.handler || (() => ({ status: 500, body: "no handler" })),
    alerts: [],
    alertScript: opts.alerts || []
  };

  class Request {
    constructor(url) {
      this.url = url;
      this.method = "GET";
      this.headers = {};
      this.response = null;
    }
    async loadString() {
      env.requests.push({ url: this.url, headers: { ...this.headers } });
      const res = await env.handler(this.url, this.headers);
      this.response = { statusCode: res.status };
      return res.body;
    }
  }

  const Keychain = {
    contains: (k) => env.keychain.has(k),
    get: (k) => {
      if (!env.keychain.has(k)) throw new Error("not found");
      return env.keychain.get(k);
    },
    set: (k, v) => { env.keychain.set(k, v); },
    remove: (k) => { env.keychain.delete(k); }
  };

  const fileManager = {
    documentsDirectory: () => "/docs",
    joinPath: (a, b) => `${a}/${b}`,
    fileExists: (p) => env.files.has(p.replace("/docs/", "")),
    readString: (p) => env.files.get(p.replace("/docs/", "")),
    writeString: (p, s) => { env.files.set(p.replace("/docs/", ""), s); },
    remove: (p) => { env.files.delete(p.replace("/docs/", "")); }
  };
  const FileManager = { local: () => fileManager, iCloud: () => fileManager };

  class Notification {
    constructor() {
      this.identifier = null;
      this.title = "";
      this.body = "";
      this.triggerDate = null;
    }
    setTriggerDate(d) { this.triggerDate = d; }
    async schedule() {
      env.scheduled.push({
        id: this.identifier,
        title: this.title,
        body: this.body,
        at: this.triggerDate ? this.triggerDate.getTime() : null
      });
    }
    static async removePending(ids) { env.removedPending.push(...ids); }
  }

  // Alert：依 opts.alerts 的劇本回答（{ index, text }），沒有劇本就按取消。
  class Alert {
    constructor() { this.actions = []; this.fields = []; this.answer = null; }
    addAction(t) { this.actions.push(t); }
    addCancelAction(t) { this.cancel = t; }
    addDestructiveAction(t) { this.actions.push(t); }
    addTextField(p, v) { this.fields.push(v || ""); }
    addSecureTextField(p, v) { this.fields.push(v || ""); }
    textFieldValue(i) { return this.answer && this.answer.text !== undefined ? this.answer.text : this.fields[i]; }
    async present() {
      this.answer = env.alertScript.shift() || { index: -1 };
      env.alerts.push({ title: this.title, message: this.message, answer: this.answer });
      return this.answer.index;
    }
    async presentAlert() { return this.present(); }
  }

  const sandbox = {
    console,
    ListWidget, Color, Font, Size, Point, Rect, Path, DrawContext,
    Request, Keychain, FileManager, Notification, Alert,
    UITable: class { addRow() {} removeAllRows() {} reload() {} async present() {} },
    UITableRow: class { addText() { return {}; } },
    Safari: { open: (u) => { env.openedUrl = u; } },
    Pasteboard: { paste: () => opts.clipboard || "" },
    Device: { isUsingDarkAppearance: () => env.dark },
    Script: {
      setWidget: (w) => { env.setWidget = w; },
      complete: () => { env.completed = true; }
    },
    config: { runsInWidget: false, runsInApp: true, widgetFamily: null, ...(opts.config || {}) },
    args: { widgetParameter: null, queryParameters: {}, ...(opts.args || {}) },
    __CLAUDE_USAGE_TEST__: {}
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(`Date.now = () => ${env.now};`, context);
  env.setNow = (t) => {
    env.now = t;
    vm.runInContext(`Date.now = () => ${t};`, context);
  };
  const src = fs.readFileSync(SCRIPT_PATH, "utf8");
  const ready = vm.runInContext(`(async () => {\n${src}\n})()`, context, { filename: "ClaudeUsage.js" });
  env.ready = ready.then(() => sandbox.__CLAUDE_USAGE_TEST__.api);
  env.sandbox = sandbox;
  return env;
}

// claude.ai 假伺服器：依路徑回傳 fixture。
function fakeClaude({ usage = "usage-normal.json", orgs = "organizations.json", status = 200, fail } = {}) {
  return (url, headers) => {
    if (fail) return fail(url, headers);
    if (!/sessionKey=sk-ant-sid01-/.test(headers.Cookie || "")) {
      return { status: 401, body: '{"error":"unauthorized"}' };
    }
    if (url.endsWith("/api/organizations")) return { status: 200, body: fixture(orgs) };
    if (/\/api\/organizations\/[^/]+\/usage$/.test(url)) {
      return { status, body: typeof usage === "string" && usage.endsWith(".json") ? fixture(usage) : usage };
    }
    return { status: 404, body: "not found" };
  };
}

module.exports = { createEnv, fakeClaude, fixture, collectTexts, collectImages };
