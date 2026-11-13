const test = require("node:test");
const assert = require("node:assert/strict");
require("fake-indexeddb/auto");
const { TaskStore } = require("../store.js");
const { harness: background, assets } = require("./background-harness.cjs");
const { harness: content, row } = require("./content-harness.cjs");
const { MAX_ORDERS } = require("../core.js");
// One order more than the limit, so the last order must wait for a free slot.
const extra = "R" + (MAX_ORDERS + 1);
const rows = count => Array.from({ length: count }, (_, i) => row("O" + (i + 1), "R" + (i + 1)));
let sequence = 0;
const tick = () => new Promise(setImmediate);
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() >= end) throw new Error("Expected flow did not complete within 5 seconds");
    await tick();
  }
}
const image = (source = "") => ({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff]), source]) });
function imageGate() {
  const pending = new Map(), starts = [];
  let live = 0, peak = 0, held = true;
  const fetch = async (url, { signal }) => {
    signal.throwIfAborted();
    starts.push(url);
    if (!held) return image(url);
    live++; peak = Math.max(peak, live);
    return new Promise((resolve, reject) => {
      const done = () => { live--; pending.delete(url); signal.removeEventListener("abort", aborted); };
      const aborted = () => { done(); reject(signal.reason); };
      pending.set(url, () => { done(); resolve(image(url)); });
      signal.addEventListener("abort", aborted, { once: true });
    });
  };
  return { fetch, starts, pending, live: () => live, peak: () => peak,
    release: reference => { for (const [url, finish] of [...pending]) if (url.includes("/" + reference + "/")) finish(); },
    releaseAll: () => { held = false; for (const finish of [...pending.values()]) finish(); }
  };
}
async function flow(t, pages, options = {}) {
  let pointer;
  const store = new TaskStore({ get: async () => ({ picExpertTask: pointer }), set: async value => { pointer = value.picExpertTask; } },
    "concurrent-flow-" + process.pid + "-" + sequence++);
  const downloadOptions = { ...options.downloads, store };
  const backend = background(downloadOptions);
  const { task } = await backend.begin();
  const page = content(pages, { size: options.size || pages[0].length || 3, ...options.content, sendMessage: backend.send });
  downloadOptions.pageMessage = page.pageMessage;
  const runs = [], run = page.run;
  page.run = (...args) => { const promise = run(...args); runs.push(promise); return promise; };
  t.after(async () => {
    await backend.send({ type: "PIC_EXPERT_TASK_STOP" }, {});
    await Promise.allSettled(runs);
    (await store.open()).close();
  });
  return { backend, page, store, task, downloadOptions };
}
async function finishOrder(backend, reference) {
  for (const kind of ["SN图片", "发票"]) {
    let item;
    await until(() => {
      item = [...backend.items.values()].find(item => item.filename.includes("/" + reference + "/" + kind));
      return item;
    });
    if (item.state === "in_progress") backend.notify(item.id, "complete");
  }
}

test("every list page is read before any detail or image, and list failure stops without downloads", async t => {
  for (const fail of [false, true]) {
    const pages = [[row("O1", "R1")], [row("O2", "R2")]];
    let reads = 0, details = 0;
    const f = await flow(t, pages, { content: {
      list: async (_filters, page) => {
        reads++;
        if (fail && page === 1) throw new Error("网站接口连接失败。");
        return { rows: pages[page], total: 2 };
      },
      assets: () => { details++; assert.equal(reads, 2); }
    } });
    await f.page.run(f.task.id);
    const saved = await f.store.getTask();
    assert.equal(saved.status, fail ? "failed" : "completed");
    assert.equal(details, fail ? 0 : 2);
    assert.equal(saved.completed, fail ? 0 : 2);
    if (fail) {
      assert.equal(saved.scanned, 0);
      assert.equal(f.backend.calls.filter(call => !call.filename.endsWith(".csv")).length, 0);
    }
  }
});

test("expired login stops the task and a new task after login downloads every order into a new directory", async t => {
  const pages = [[row("O1", "R1"), row("O2", "R2"), row("O3", "R3", "08")], [row("O4", "R4")]];
  let expired = true, token = "old-session";
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null, token: options.headers?.userPortalToken });
    if (options.headers) assert.equal(options.headers.userPortalToken, token);
    const reply = data => ({ ok: true, json: async () => ({ success: true, data }) });
    if (url.endsWith("queryList")) return reply({ list: pages[JSON.parse(options.body).current], total: 4 });
    if (url.endsWith("queryDtl")) {
      const last = JSON.parse(options.body).uuid === "id-O4";
      if (last && expired) return { ok: false, status: 401 };
      return reply({ templateId: "T", productJson: { sn: "sn", invoice: JSON.parse(options.body).uuid === "id-O3" ? "" : "invoice", proof: last ? "proof" : "" } });
    }
    if (url.includes("queryTemplateInfo")) return reply({ productJson: [{ its: [
      { type: "img", key: "sn", desc: "SN码" }, { type: "img", key: "invoice", desc: "发票" },
      { type: "img", key: "proof", desc: "证明材料图三" }
    ] }] });
    assert.equal(new URL(url).searchParams.get("userPortalToken"), token);
    return image();
  };
  const f = await flow(t, pages, { content: { realApi: true, fetch, token: () => token } });
  await f.page.run(f.task.id);
  const stopped = await f.store.getTask();
  assert.deepEqual([stopped.status, stopped.completed, stopped.skipped, stopped.failed], ["failed", 2, 1, 1]);
  assert.match(stopped.error, /登录/);
  assert.equal(stopped.currentRows.length, 0);
  assert.equal(f.backend.calls.length, 5);
  assert.deepEqual(requests.slice(0, 2).map(request => request.body.current), [0, 1]);
  assert.ok(requests.slice(0, 2).every(request => request.url.endsWith("queryList")));
  const before = f.backend.calls.length;
  expired = false; token = "new-session";
  const second = (await f.backend.begin()).task;
  await f.page.run(second.id);
  const finished = await f.store.getTask();
  assert.deepEqual([finished.id, finished.status, finished.scanned, finished.completed, finished.skipped, finished.failed], [second.id, "completed", 4, 3, 1, 0]);
  assert.notEqual(finished.folderName, stopped.folderName);
  const calls = f.backend.calls.slice(before);
  assert.equal(calls.length, 7);
  assert.ok(calls.every(call => call.filename.startsWith("pic-expert/" + second.folderName + "/")));
  // The template's proof image has a value for O4 but is not downloaded.
  assert.ok(calls.some(call => call.filename.endsWith("/R4/SN图片.jpg")));
  assert.ok(calls.every(call => !call.filename.includes("证明材料")));
  const csv = decodeURIComponent(calls.at(-1).url.split(",").slice(1).join(","));
  assert.equal(csv, "\uFEFF订单号,参考号,处理结果,原因\r\nO1,R1,成功,\r\nO2,R2,成功,\r\nO3,R3,跳过,必填图片缺失：发票\r\nO4,R4,成功,");
});

test("login expiry before the first list page stops the task and a new task completes after login", async t => {
  let token = null;
  const fetch = async (url) => {
    assert.ok(url.endsWith("queryList"));
    return { ok: true, json: async () => ({ success: true, data: { list: [], total: 0 } }) };
  };
  const f = await flow(t, [[]], { content: { realApi: true, fetch, token: () => token } });
  await f.page.run(f.task.id);
  assert.equal((await f.store.getTask()).status, "failed");
  assert.equal(f.backend.calls.filter(call => !call.filename.endsWith(".csv")).length, 0);
  token = "new-session";
  await f.page.run((await f.backend.begin()).task.id);
  assert.equal((await f.store.getTask()).status, "completed");
});

test("list persistence failure stops before any material processing", async t => {
  const pages = [[row("O1", "R1")], [row("O2", "R2")]];
  const f = await flow(t, pages);
  const save = f.store.save.bind(f.store);
  f.store.save = async (task, changes) => {
    if (changes?.pages?.some(page => page.page === 2)) throw new Error("列表保存失败");
    return save(task, changes);
  };
  await f.page.run(f.task.id);
  const stopped = await f.store.getTask();
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.listed, 1);
  assert.match(stopped.error, /列表保存失败/);
  assert.ok(await f.store.getPage(f.task.id, 1));
  assert.equal(await f.store.getPage(f.task.id, 2), null);
  assert.equal(f.backend.calls.filter(call => !call.filename.endsWith(".csv")).length, 0);
});

test("three overlapping orders keep every numbered image in its own reference folder and annotate material modification", async t => {
  const gate = imageGate();
  const rows = [row("O1", "R1", "04"), { ...row("O2", "R2", "08"), statusDesc: "待审核", statusText: "材料修改" }, row("O3", "R3", "S03")];
  const f = await flow(t, [rows], { content: { fetch: gate.fetch, assets: order => ({
    files: Object.fromEntries([["SN图片-1", "s1"], ["SN图片-2", "s2"], ["发票-1", "i1"], ["发票-2", "i2"], ["发票-3", "i3"]].map(([name, path]) => [name, "https://portal.test/" + order.transRef + "/" + path])), missing: [], notices: []
  }) } });
  const running = f.page.run(f.task.id);
  await until(() => gate.live() === 6);
  assert.equal((await f.store.getTask()).currentRows.length, 3);
  assert.equal(f.backend.calls.length, 0);
  await until(async () => { gate.release("R2"); return (await f.store.getTask()).completed === 1; });
  assert.ok(f.backend.calls.every(call => call.filename.includes("/R2/")));
  gate.releaseAll();
  await running;
  const task = await f.store.getTask();
  assert.deepEqual([task.scanned, task.completed, task.skipped, task.failed], [3, 3, 0, 0]);
  assert.equal(gate.peak(), 6);
  for (const reference of ["R1", "R2", "R3"]) {
    const calls = f.backend.calls.filter(call => call.filename.includes("/" + reference + "/"));
    const names = ["SN图片-1.jpg", "SN图片-2.jpg", "发票-1.jpg", "发票-2.jpg", "发票-3.jpg"];
    assert.deepEqual(calls.map(call => call.filename.split("/").at(-1)), names);
    assert.ok(calls.every(call => call.filename.startsWith("pic-expert/" + task.folderName + "/" + reference + "/")));
    assert.deepEqual(calls.map(call => Buffer.from(call.url.split(",")[1], "base64").subarray(3).toString()),
      ["s1", "s2", "i1", "i2", "i3"].map(name => "https://portal.test/" + reference + "/" + name));
    const pair = await f.store.getPair(task.id, reference);
    assert.equal(Object.keys(pair.files).length, 5);
  }
  const results = await f.store.rows(task.id);
  assert.equal(results.find(result => result.referenceNo === "R2").reason, "材料修改");
  assert.equal(results.find(result => result.referenceNo === "R1").reason, "");
  const manifest = f.backend.calls.find(call => call.filename.endsWith(".csv"));
  assert.match(decodeURIComponent(manifest.url), /O2,R2,成功,材料修改/);
  assert.equal(f.backend.calls.length, 16);
});

test("failure of a later numbered image rolls back every file of only that order and preserves the material note", async t => {
  const f = await flow(t, [[{ ...row("O1", "R1"), statusDesc: "材料修改" }, row("O2", "R2")]], {
    downloads: { failFilename: "/R1/发票-2.jpg" },
    content: { assets: order => ({
      files: Object.fromEntries([["SN图片-1", "s1"], ["SN图片-2", "s2"], ["发票-1", "i1"], ["发票-2", "i2"]].map(([name, path]) => [name, "https://portal.test/" + order.transRef + "/" + path])), missing: [], notices: []
    }) }
  });
  await f.page.run(f.task.id);
  const task = await f.store.getTask();
  assert.deepEqual([task.completed, task.failed], [1, 1]);
  assert.deepEqual((await f.store.getPair(task.id, "R1")).files, {});
  assert.equal(f.backend.removed.length, 3);
  assert.ok(f.backend.removed.every(id => f.backend.items.get(id).filename.includes("/R1/")));
  const failed = await f.store.getRow(task.id, { orderNo: "O1", referenceNo: "R1" });
  assert.match(failed.reason, /材料修改.*NETWORK_FAILED/);
  assert.equal((await f.store.getPair(task.id, "R2")).status, "complete");

});

test("worker restart after images are saved but before the result is recorded keeps the success on stop", async t => {
  const f = await flow(t, [[row("O1", "R1")]]);
  const identity = { orderNo: "O1", referenceNo: "R1" };
  assert.equal((await f.backend.send({ type: "PIC_EXPERT_ORDER_CLAIM", taskId: f.task.id, identity })).done, false);
  // The worker stops inside settle: the images are saved, but the result row is never written.
  const save = f.store.save.bind(f.store);
  f.store.save = (task, changes) => changes.rows?.length ? Promise.reject(new Error("worker stopped")) : save(task, changes);
  assert.equal((await f.backend.send({ type: "PIC_EXPERT_ORDER_SETTLE", taskId: f.task.id, note: "",
    row: { ...identity, result: "成功", reason: "" }, assets: { ...assets, "发票-2": assets["发票"] } })).ok, false);
  assert.equal((await f.store.getPair(f.task.id, "R1")).status, "complete");
  assert.equal(await f.store.getRow(f.task.id, identity), null);
  const before = await f.store.getTask();
  assert.deepEqual([before.scanned, before.completed, before.failed, before.currentRows.length], [0, 0, 0, 1]);

  const store = new TaskStore(f.store.storage, f.store.databaseName);
  t.after(async () => (await store.open()).close());
  const restarted = background({ store, items: f.backend.items });
  const response = await restarted.send({ type: "PIC_EXPERT_TASK_STOP" }, {});
  assert.ok(response.ok);
  const task = await store.getTask(), result = await store.getRow(task.id, identity);
  assert.equal(task.id, f.task.id);
  assert.equal(task.folderName, f.task.folderName);
  assert.equal(task.status, "failed");
  assert.deepEqual([task.scanned, task.completed, task.failed, task.currentRows.length], [1, 1, 0, 0]);
  assert.equal(result.result, "成功");
  assert.equal(result.reason, "");
  const directory = "pic-expert/" + task.folderName + "/R1/";
  assert.deepEqual(f.backend.calls.map(call => call.filename),
    [directory + "SN图片.jpg", directory + "发票.png", directory + "发票-2.png"]);
  assert.deepEqual(Object.values((await store.getPair(task.id, "R1")).files).map(file => file.filename),
    [directory + "SN图片.jpg", directory + "发票.png", directory + "发票-2.png"]);
  assert.ok(f.backend.calls.every((_call, index) => f.backend.items.get(index + 1).exists));
  assert.equal(restarted.removed.length, 0);

  // Repeated recovery must neither duplicate counts nor download images again.
  assert.ok((await restarted.send({ type: "PIC_EXPERT_TASK_STOP" }, {})).ok);
  assert.ok((await restarted.send({ type: "PIC_EXPERT_TASK_STOP" }, {})).ok);
  const final = await store.getTask();
  assert.deepEqual([final.scanned, final.completed, final.failed], [task.scanned, task.completed, task.failed]);
  assert.equal(restarted.calls.length, 1);
  assert.equal(restarted.calls[0].filename, "pic-expert/" + task.folderName + "/下载清单.csv");
  assert.equal(decodeURIComponent(restarted.calls[0].url).split(",").slice(1).join(","),
    "\uFEFF订单号,参考号,处理结果,原因\r\nO1,R1," + result.result + "," + result.reason);
});

test("stop aborts three detail requests through the real site API", async t => {
  let active = 0, aborted = 0;
  const requests = [];
  const rows = [row("O1", "R1"), row("O2", "R2"), row("O3", "R3")];
  const fetch = async (url, options) => {
    requests.push(url);
    assert.equal(options.headers.userPortalToken, "session");
    if (url.endsWith("queryList")) return { ok: true, json: async () => ({ success: true, data: { list: rows, total: 3 } }) };
    assert.ok(url.endsWith("queryDtl"));
    active++;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        active--; aborted++; reject(options.signal.reason);
      }, { once: true });
    });
  };
  const f = await flow(t, [rows], { content: { realApi: true, fetch } });
  const running = f.page.run(f.task.id);
  await until(() => active === 3);
  await f.backend.send({ type: "PIC_EXPERT_TASK_STOP" }, {});
  await running;
  const task = await f.store.getTask();
  assert.deepEqual([task.status, task.failed, task.currentRows.length, active, aborted], ["failed", 3, 0, 0, 3]);
  assert.equal(requests.length, 4);
  assert.equal(f.backend.calls.filter(call => !call.filename.endsWith(".csv")).length, 0);
});

test("verified total precedes downloads; the order limit and two reads per order overlap without crossing a page", async t => {
  const gate = imageGate(), total = MAX_ORDERS + 2;
  const f = await flow(t, [rows(MAX_ORDERS + 1), [row("O" + total, "R" + total)]],
    { downloads: { holdPair: true }, content: { fetch: gate.fetch } });
  const running = f.page.run(f.task.id);
  await until(() => gate.live() === MAX_ORDERS * 2);
  const active = await f.store.getTask();
  assert.equal(active.total, total);
  assert.equal(active.currentRows.length, MAX_ORDERS);
  assert.equal(f.backend.calls.length, 0);
  assert.equal(f.page.calls.length, 2);
  assert.equal((await f.backend.send({ type: "PIC_EXPERT_PAGE_BEGIN", taskId: f.task.id, page: 2 })).ok, false);
  gate.release("R2");
  await finishOrder(f.backend, "R2");
  await until(() => [...gate.pending.keys()].filter(url => url.includes("/" + extra + "/")).length === 2);
  assert.equal((await f.store.getTask()).currentRows.length, MAX_ORDERS);
  assert.equal(f.page.calls.length, 2);
  gate.release(extra);
  await finishOrder(f.backend, extra);
  await until(async () => (await f.store.getTask()).completed === 2);
  assert.equal(f.page.calls.length, 2);
  f.downloadOptions.holdPair = false;
  gate.releaseAll();
  await running;
  const finished = await f.store.getTask();
  assert.equal(finished.status, "completed");
  assert.deepEqual([finished.total, finished.scanned, finished.completed, finished.failed, finished.currentRows.length], [total, total, total, 0, 0]);
  assert.equal(gate.peak(), MAX_ORDERS * 2);
  assert.deepEqual(f.page.calls.map(call => call.page), [0, 1]);
  assert.equal((await f.store.rows(f.task.id)).length, total);
  const csvCalls = f.backend.calls.filter(call => call.filename.endsWith(".csv"));
  assert.equal(csvCalls.length, 1);
  assert.equal(decodeURIComponent(csvCalls[0].url).split("\r\n").length, total + 1);
  assert.ok(f.backend.calls.every(call => call.filename.startsWith("pic-expert/" + f.task.folderName + "/")));
  assert.equal(f.backend.handlers.size, 0);
});

test("a failed order rolls back its own images while other orders succeed", async t => {
  const f = await flow(t, [[row("O1", "R1"), row("O2", "R2"), row("O3", "R3"), row("O4", "R4", "08")]],
    { downloads: { failInvoice: "R2" } });
  await f.page.run(f.task.id);
  const task = await f.store.getTask();
  assert.deepEqual([task.scanned, task.completed, task.skipped, task.failed, task.currentRows.length], [4, 3, 0, 1, 0]);
  for (const reference of ["R1", "R3"]) {
    const pair = await f.store.getPair(task.id, reference);
    assert.equal(pair.status, "complete");
    assert.ok(Object.values(pair.files).every(file => f.backend.items.get(file.downloadId).exists));
  }
  assert.deepEqual((await f.store.getPair(task.id, "R2")).files, {});
  assert.ok(f.backend.removed.every(id => f.backend.items.get(id).filename.includes("/R2/")));
});

test("stop cancels mixed in-flight orders before terminal state", async t => {
  const gate = imageGate();
  const f = await flow(t, [rows(MAX_ORDERS + 1)], { downloads: { holdPair: true }, content: { fetch: gate.fetch } });
  const running = f.page.run(f.task.id);
  await until(() => gate.live() === MAX_ORDERS * 2);
  gate.release("R1");
  await until(() => f.backend.items.size === 1);
  await f.backend.send({ type: "PIC_EXPERT_TASK_STOP" }, {});
  await running;
  const task = await f.store.getTask();
  assert.equal(task.status, "failed");
  assert.deepEqual([task.scanned, task.completed, task.failed, task.currentRows.length], [MAX_ORDERS, 0, MAX_ORDERS, 0]);
  assert.equal(gate.live(), 0);
  assert.equal(gate.starts.length, MAX_ORDERS * 2);
  assert.deepEqual((await f.store.getPair(task.id, "R1")).files, {});
  assert.equal(f.backend.items.get(1).exists, false);
  assert.equal(f.backend.calls.filter(call => call.filename.endsWith(".csv")).length, 1);
  assert.equal(f.backend.handlers.size, 0);

});

for (const fault of ["authentication", "query-change"]) test(`${fault} halts dispatch and drains pending reads`, async t => {
  const gate = imageGate();
  const f = await flow(t, [rows(MAX_ORDERS + 1)], {
    content: { fetch: async (url, options) => {
      if (fault === "authentication" && url.includes("/R2/")) return { ok: false, status: 401 };
      return gate.fetch(url, options);
    } }
  });
  const running = f.page.run(f.task.id);
  if (fault === "query-change") {
    await until(() => gate.live() === MAX_ORDERS * 2);
    f.page.changeFilters({ status: ["01"] }); gate.release("R1");
  }
  await running;
  const task = await f.store.getTask();
  assert.equal(task.status, "failed");
  assert.match(task.error, fault === "authentication" ? /登录/ : /查询条件/);
  assert.equal(task.currentRows.length, 0);
  assert.equal(gate.live(), 0);
  assert.ok(!gate.starts.some(url => url.includes("/" + extra + "/")));
  assert.equal(f.backend.calls.filter(call => !call.filename.endsWith(".csv")).length, 0);
});

test("zero and one order complete with correct totals and one manifest", async t => {
  for (const rows of [[], [row("O1", "R1")]]) {
    const f = await flow(t, [rows]);
    await f.page.run(f.task.id);
    const task = await f.store.getTask();
    assert.deepEqual([task.status, task.total, task.scanned, task.completed], ["completed", rows.length, rows.length, rows.length]);
    assert.equal(f.backend.calls.length, rows.length * 2 + 1);
  }
});

test("changed totals and duplicate identities fail before dispatching an invalid page", async t => {
  for (const duplicate of [false, true]) {
    const pages = duplicate ? [[row("O1", "R1"), row("O1", "R1")]] : [[row("O1", "R1")], [row("O2", "R2")]];
    const f = await flow(t, pages, { content: { list: async (_filters, page) => ({ rows: pages[page], total: duplicate ? 2 : page ? 3 : 2 }) } });
    await f.page.run(f.task.id);
    const task = await f.store.getTask();
    assert.equal(task.status, "failed");
    assert.match(task.error, duplicate ? /重复订单/ : /总数发生变化/);
    assert.equal(task.scanned, 0);
    assert.equal(f.backend.calls.filter(call => !call.filename.endsWith(".csv")).length, 0);
  }
});
