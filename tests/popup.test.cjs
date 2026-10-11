const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");

const loadPopup = async (task, sendMessage) => {
  const elements = new Map(["#business", "#start", "#stop", "#retry", "#pause", "#resume", "#export-logs", "#status",
    "#progress", "#completion", "#error", "#interruption", "#logs", "#copy-logs", "#copy-status"].map(selector => [selector, {
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
    checkpoint: { total: 10 }, manifestDownloadId: 12, logs: [] });
  const notice = elements.get("#completion");
  assert.equal(notice.hidden, false);
  assert.equal(notice.dataset.status, "completed");
  assert.match(notice.textContent, /任务已完成。成功 8，跳过 1，失败 1。清单已下载/);
});

test("popup reports failed tasks and manifest errors", async () => {
  const elements = await loadPopup({ status: "failed", scanned: 3, completed: 1, skipped: 1, failed: 1,
    error: "API timeout", manifestError: "清单下载失败：network", logs: [] });
  const notice = elements.get("#completion");
  assert.equal(notice.hidden, false);
  assert.equal(notice.dataset.status, "failed");
  assert.match(notice.textContent, /任务已停止。成功 1，跳过 1，失败 1。清单下载失败/);
  assert.match(elements.get("#error").textContent, /API timeout/);
  assert.match(elements.get("#error").textContent, /清单下载失败：network/);
});

test("popup hides the end notice while the task is running", async () => {
  const elements = await loadPopup({ status: "running", scanned: 1, completed: 0, skipped: 0, failed: 0, logs: [] });
  assert.equal(elements.get("#completion").hidden, true);
});

test("popup distinguishes list reading from material processing and explains auto pause", async () => {
  const listing = await loadPopup({ status: "running", phase: "listing", listed: 10, total: 20, logs: [] });
  assert.equal(listing.get("#status").textContent, "正在读取完整订单列表");
  assert.match(listing.get("#progress").textContent, /列表已读取 10/);
  const paused = await loadPopup({ status: "paused", error: "登录状态已失效", checkpoint: {}, logs: [] });
  assert.equal(paused.get("#resume").hidden, false);
  assert.match(paused.get("#error").textContent, /登录/);
});

test("completed tasks expose continuation only when orders failed and a checkpoint exists", async () => {
  for (const [failed, checkpoint, hidden] of [[1, { total: 2 }, false], [0, { total: 2 }, true], [1, null, true]]) {
    const elements = await loadPopup({ status: "completed", failed, checkpoint, logs: [] });
    assert.equal(elements.get("#resume").hidden, hidden);
  }
});

test("popup displays confirmed totals and all in-flight orders, including a zero total", async () => {
  const active = await loadPopup({ status: "running", total: 10, page: 1, scanned: 2, completed: 1, skipped: 1, failed: 0,
    currentRows: [{}, {}, {}], logs: [] });
  assert.equal(active.get("#progress").textContent, "订单总数 10 · 页 1 · 已处理 2 · 正在处理 3 · 成功 1 · 跳过 1 · 失败 0");
  const empty = await loadPopup({ status: "running", total: 0, currentRows: [], logs: [] });
  assert.match(empty.get("#progress").textContent, /^订单总数 0 /);
});

for (const [button, message] of [["#pause", "PIC_EXPERT_TASK_PAUSE"], ["#stop", "PIC_EXPERT_TASK_STOP"], ["#retry", "PIC_EXPERT_MANIFEST_RETRY"]]) {
  test(button + " response does not overwrite a newly selected business", async () => {
    let finish;
    const original = { status: "running", completed: 3, logs: [] };
    const selected = { status: "paused", completed: 8, checkpoint: {}, logs: [] };
    const elements = await loadPopup(original, request => request.type === message ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, task: request.business === "digital" ? selected : original }));
    const pending = elements.get(button).listeners.click();
    elements.get("#business").value = "digital";
    elements.get("#business").listeners.change();
    await new Promise(setImmediate);
    finish({ ok: true, task: { ...original, status: "pausing" } });
    await pending;
    assert.equal(elements.get("#status").textContent, "已暂停");
    assert.match(elements.get("#progress").textContent, /成功 8/);
    assert.equal(elements.get("#pause").hidden, true);
  });
}

test("popup updates dashboard metrics and progress bar when elements exist", async () => {
  const elements = new Map(["#business", "#start", "#stop", "#retry", "#pause", "#resume", "#export-logs", "#status",
    "#progress", "#completion", "#error", "#interruption", "#logs", "#copy-logs", "#copy-status",
    "#status-badge", "#stat-total", "#stat-completed", "#stat-skipped", "#stat-failed", "#progress-bar-fill", "#progress-percent"].map(selector => [selector, {
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
  assert.equal(elements.get("#stat-total").textContent, "10");
  assert.equal(elements.get("#stat-completed").textContent, "3");
  assert.equal(elements.get("#stat-skipped").textContent, "1");
  assert.equal(elements.get("#stat-failed").textContent, "0");
  assert.equal(elements.get("#progress-bar-fill").style.width, "40%");
  assert.equal(elements.get("#progress-percent").textContent, "40%");
  assert.equal(elements.get("#status-badge").textContent, "正在处理订单资料");
  assert.equal(elements.get("#status-badge").dataset.status, "running");
});
