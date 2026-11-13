const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");

const loadPopup = async (task, sendMessage) => {
  const elements = new Map(["#business", "#start", "#stop", "#retry", "#export-logs", "#status",
    "#progress", "#completion", "#error", "#interruption", "#logs", "#copy-logs", "#copy-status",
    "#progress-percent", "#progress-bar-fill"].map(selector => [selector, {
    hidden: false, disabled: false, textContent: "", value: "", dataset: {}, scrollHeight: 0,
    listeners: {}, addEventListener(event, listener) { this.listeners[event] = listener; }, focus() {}, select() {}
  }]));
  const sandbox = {
    document: { querySelector: selector => elements.get(selector), execCommand: () => true },
    chrome: { runtime: { sendMessage: sendMessage || (async () => ({ ok: true, task })) }, tabs: { query: async () => [] } },
    location: { search: "", href: "https://fixture.test/popup.html" }, URLSearchParams, URL, history: { replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    window: { addEventListener() {} },
    setInterval: () => 1, clearInterval() {}, Date, console
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../popup.js"), "utf8"), sandbox);
  await new Promise(setImmediate);
  return elements;
};

test("popup shows a persisted completion summary after reopening", async () => {
  const elements = await loadPopup({ status: "completed", page: 2, scanned: 10, completed: 8, skipped: 1, failed: 1,
    total: 10, manifestDownloadId: 12, logs: [] });
  const notice = elements.get("#completion");
  assert.equal(notice.hidden, false);
  assert.equal(notice.dataset.status, "failed");
  assert.match(notice.textContent, /处理结束，存在失败订单。已处理 10\/10，成功 8，跳过 1，失败 1。清单已下载/);
  assert.equal(elements.get("#status").textContent, "处理结束，存在失败订单");
  assert.equal(elements.get("#status").dataset.status, "failed");
  assert.equal(elements.get("#interruption").hidden, true);
});

test("an interrupted task shows its termination, processed percentage and failures without continuation", async () => {
  const elements = await loadPopup({ status: "failed", total: 696, scanned: 696, completed: 695, skipped: 0, failed: 1,
    error: "来源网站标签页已关闭，任务已终止。", logs: [] });
  assert.equal(elements.get("#status").textContent, "已停止");
  assert.equal(elements.get("#progress-percent").textContent, "已处理 100% · 失败 1");
  assert.equal(elements.get("#progress").textContent, "订单总数 696 · 已处理 696 · 成功 695 · 跳过 0 · 失败 1");
  assert.match(elements.get("#completion").textContent, /^任务已停止，已完整下载的订单文件保留。已处理 696\/696，.*\n来源网站标签页已关闭/);
  assert.equal(elements.get("#interruption").hidden, true);
  assert.equal(elements.get("#error").textContent, "");
  assert.doesNotMatch(elements.get("#completion").textContent, /继续|恢复|重试/);
  assert.equal(elements.get("#start").disabled, false);
  assert.equal(elements.get("#stop").hidden, true);
});

test("popup reports failed tasks and manifest errors", async () => {
  const elements = await loadPopup({ status: "failed", scanned: 3, completed: 1, skipped: 1, failed: 1,
    error: "API timeout", manifestError: "清单下载失败：network", logs: [] });
  const notice = elements.get("#completion");
  assert.equal(notice.hidden, false);
  assert.equal(notice.dataset.status, "failed");
  assert.match(notice.textContent, /任务已停止，已完整下载的订单文件保留。已处理 3\/未知，成功 1，跳过 1，失败 1。清单下载失败/);
  assert.doesNotMatch(elements.get("#error").textContent, /API timeout/);
  assert.match(notice.textContent, /\nAPI timeout$/);
  assert.match(elements.get("#error").textContent, /清单下载失败：network/);
});

test("popup hides the end notice while the task is running", async () => {
  const elements = await loadPopup({ status: "running", scanned: 1, completed: 0, skipped: 0, failed: 0, logs: [] });
  assert.equal(elements.get("#completion").hidden, true);
});

test("popup distinguishes list reading from material processing and explains an ongoing interruption", async () => {
  const listing = await loadPopup({ status: "running", phase: "listing", listed: 10, total: 20, logs: [] });
  assert.equal(listing.get("#status").textContent, "正在读取完整订单列表");
  assert.equal(listing.get("#progress").textContent, "订单总数 20 · 列表已读取 10");
  const stopping = await loadPopup({ status: "stopping", error: "登录状态已失效", logs: [] });
  assert.equal(stopping.get("#stop").hidden, false);
  assert.equal(stopping.get("#start").disabled, true);
  assert.match(stopping.get("#interruption").textContent, /正在整理未完成订单。\n登录状态已失效/);
});

test("popup displays confirmed totals and all in-flight orders, including a zero total", async () => {
  const active = await loadPopup({ status: "running", total: 10, page: 1, scanned: 2, completed: 1, skipped: 1, failed: 0,
    currentRows: [{}, {}, {}], logs: [] });
  assert.equal(active.get("#progress").textContent, "订单总数 10 · 第 1 页 · 已处理 2 · 正在处理 3 · 成功 1 · 跳过 1 · 失败 0");
  const empty = await loadPopup({ status: "running", total: 0, currentRows: [], logs: [] });
  assert.match(empty.get("#progress").textContent, /^订单总数 0 /);
});

for (const [button, message] of [["#stop", "PIC_EXPERT_TASK_STOP"], ["#retry", "PIC_EXPERT_MANIFEST_RETRY"]]) {
  test(button + " response does not overwrite a newly selected business", async () => {
    let finish;
    const original = { status: "running", completed: 3, logs: [] };
    const selected = { status: "failed", completed: 8, logs: [] };
    const elements = await loadPopup(original, request => request.type === message ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, task: request.business === "digital" ? selected : original }));
    const pending = elements.get(button).listeners.click();
    elements.get("#business").value = "digital";
    elements.get("#business").listeners.change();
    await new Promise(setImmediate);
    finish({ ok: true, task: { ...original, status: "stopping" } });
    await pending;
    assert.equal(elements.get("#status").textContent, "已停止");
    assert.match(elements.get("#progress").textContent, /成功 8/);
    assert.equal(elements.get("#stop").hidden, true);
  });
}

test("popup updates the current step and progress bar", async () => {
  const elements = new Map(["#business", "#start", "#stop", "#retry", "#export-logs", "#status",
    "#progress", "#completion", "#error", "#interruption", "#logs", "#copy-logs", "#copy-status",
    "#progress-bar-fill", "#progress-percent"].map(selector => [selector, {
    hidden: false, disabled: false, textContent: "", value: "", dataset: {}, style: {}, scrollHeight: 0,
    listeners: {}, addEventListener(event, listener) { this.listeners[event] = listener; }, focus() {}, select() {}
  }]));
  const sandbox = {
    document: { querySelector: selector => elements.get(selector), execCommand: () => true },
    chrome: { runtime: { sendMessage: async () => ({ ok: true, task: { status: "running", phase: "processing", total: 10, page: 1, scanned: 4, completed: 3, skipped: 1, failed: 0, currentRows: [{}], logs: [] } }) }, tabs: { query: async () => [] } },
    location: { search: "", href: "https://fixture.test/popup.html" }, URLSearchParams, URL, history: { replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    window: { addEventListener() {} },
    setInterval: () => 1, clearInterval() {}, Date, console
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../popup.js"), "utf8"), sandbox);
  await new Promise(setImmediate);
  assert.equal(elements.get("#progress").textContent, "订单总数 10 · 第 1 页 · 已处理 4 · 正在处理 1 · 成功 3 · 跳过 1 · 失败 0");
  assert.equal(elements.get("#progress-bar-fill").style.width, "40%");
  assert.equal(elements.get("#progress-percent").textContent, "已处理 40%");
  assert.equal(elements.get("#status").dataset.status, "running");
});
