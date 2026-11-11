const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, row } = require("./content-harness.cjs");

test("whole-list request is independent of the visible page and completes before assets", async () => {
  const rows = Array.from({ length: 33 }, (_, i) => row("O" + i, "R" + i));
  let h;
  h = harness([rows.slice(0, 10)], {
    size: 10, listSize: 10000,
    visiblePage: { page: 2, total: 33, signature: rows.slice(10, 20).map(r => r.merOrderId + "::" + r.transRef).join("\n") },
    list: () => ({ rows, total: rows.length }),
    assets: () => { assert.ok(h.messages.some(m => m.type === "PIC_EXPERT_LIST_COMPLETE")); }
  });
  await h.run("T1");
  assert.deepEqual(h.calls.map(({ page, size }) => ({ page, size })), [{ page: 0, size: 10000 }]);
  assert.equal(h.messages.filter(m => m.type === "PIC_EXPERT_ORDER_SETTLE").length, 33);
  assert.equal(h.messages.at(-1).status, "completed");
});

test("whole-list truncation or duplicate identities pause before reading assets", async () => {
  for (const rows of [[row("O1", "R1")], [row("O1", "R1"), row("O1", "R1")]]) {
    const h = harness([rows], { listSize: 10000, hasOtherFilters: true, list: () => ({ rows, total: 2 }) });
    await h.run("T1");
    assert.equal(h.messages.some(m => m.type === "PIC_EXPERT_ORDER_CLAIM"), false);
    assert.equal(h.messages.at(-1).type, "PIC_EXPERT_TASK_AUTO_PAUSE");
  }
});

test("whole-list continuation keeps the saved request size and skips completed orders", async () => {
  const rows = [row("O1", "R1"), row("O2", "R2"), row("O3", "R3")];
  const pages = new Map(), completed = new Set();
  const h = harness([rows.slice(0, 2)], {
    listSize: 10000, list: () => ({ rows, total: 3 }),
    visiblePage: { page: 1, total: 3, signature: "O1::R1\nO2::R2" },
    sendMessage: async m => {
      if (m.type === "PIC_EXPERT_LIST_PAGE") pages.set(m.page, { rows: m.rows });
      if (m.type === "PIC_EXPERT_LIST_GET") return { ok: true, page: pages.get(m.page) || null };
      if (m.type === "PIC_EXPERT_ORDER_CLAIM") return { ok: true, done: completed.has(m.identity.orderNo) };
      if (m.type === "PIC_EXPERT_ORDER_SETTLE") completed.add(m.row.orderNo);
      return { ok: true, files: {} };
    }
  });
  await h.run("T1");
  const checkpoint = h.messages.findLast(m => m.type === "PIC_EXPERT_CHECKPOINT").checkpoint;
  await h.run("T1", checkpoint);
  assert.deepEqual(h.calls.map(c => c.size), [10000, 10000]);
  assert.equal(h.messages.filter(m => m.type === "PIC_EXPERT_ORDER_SETTLE" && m.assets).length, 3);
  assert.equal(h.messages.at(-1).status, "completed");
});

test("a larger total causes a second complete request and saves its request size", async () => {
  const rows = Array.from({ length: 10001 }, (_, i) => row("O" + i, "R" + i));
  let h;
  h = harness([rows.slice(0, 10)], {
    size: 10, listSize: 10000, hasOtherFilters: true,
    list: (_filters, _page, size) => ({ rows: rows.slice(0, size), total: rows.length }),
    onMessage: m => { if (m.type === "PIC_EXPERT_LIST_COMPLETE") h.rowStatus({ type: "PIC_EXPERT_PAUSE" }, {}, () => {}); }
  });
  await h.run("T1");
  assert.deepEqual(h.calls.map(c => c.size), [10000, 10001]);
  assert.equal(h.messages.find(m => m.type === "PIC_EXPERT_LIST_PAGE").rows.length, 10001);
  assert.ok(h.messages.some(m => m.type === "PIC_EXPERT_CHECKPOINT" && m.checkpoint.size === 10001));
  assert.equal(h.messages.at(-1).type, "PIC_EXPERT_TASK_PAUSED");
});

test("all API pages and previously excluded statuses are processed", async () => {
  const h = harness([[row("O1", "R1", "08"), row("O2", "R2")], [row("O3", "R3")]]);
  await h.run("T1");
  assert.deepEqual(h.calls.map(call => call.page), [0, 1]);
  assert.deepEqual(h.messages.filter(message => message.type === "PIC_EXPERT_ORDER_SETTLE").map(message => message.row.result), ["成功", "成功", "成功"]);
  assert.equal(h.messages.at(-1).status, "completed");
});

test("material modification is a CSV note on success, missing required images and failures", async () => {
  for (const mode of ["success", "missing", "failure"]) {
    const h = harness([[{ ...row("O1", "R1", "H03"), statusDesc: "材料修改" }]], {
      assets: () => {
        if (mode === "failure") throw new Error("读取详情失败");
        return { files: { "SN图片": "https://portal.test/sn", "发票": "https://portal.test/invoice" },
          missing: mode === "missing" ? ["必填图片缺失：发票"] : [] };
      }
    });
    await h.run("T1");
    const result = h.messages.find(message => message.type === "PIC_EXPERT_ORDER_SETTLE").row;
    assert.equal(result.result, { success: "成功", missing: "跳过", failure: "失败" }[mode]);
    assert.equal(result.reason, { success: "材料修改", missing: "材料修改；必填图片缺失：发票", failure: "材料修改；读取详情失败" }[mode]);
  }
});

test("page probe exposes the queried trade date interval", async () => {
  const h = harness([[row("O1", "R1")]]);
  const response = await h.pageMessage({ type: "PIC_EXPERT_PROBE" });
  assert.equal(response.tradeDateRange[0], "20261001");
  assert.equal(response.tradeDateRange[1], "20261004");
  assert.equal(response.ready, true);
});

test("duplicate identities across API pages stop the task", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")], [row("O1", "R1")]]);
  await h.run("T1");
  assert.equal(h.messages.at(-1).type, "PIC_EXPERT_TASK_AUTO_PAUSE");
  assert.match(h.messages.at(-1).error, /重复订单身份/);
});

test("API results that do not match the displayed query stop before order processing", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")]], {
    visiblePage: { page: 1, total: 2, signature: "OTHER::QUERY" }
  });
  await h.run("T1");
  assert.equal(h.messages.some(message => message.type === "PIC_EXPERT_ORDER_CLAIM"), false);
  assert.match(h.messages.at(-1).error, /与页面当前查询不一致/);
});

test("other website filters do not narrow the date-and-status list or block its complete processing", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")], [row("O3", "R3")]], {
    hasOtherFilters: true,
    visiblePage: { page: 1, total: 1, signature: "O1::R1" }
  });
  await h.run("T1");
  assert.deepEqual(h.calls.map(call => call.page), [0, 1]);
  assert.equal(h.messages.filter(message => message.type === "PIC_EXPERT_ORDER_SETTLE").length, 3);
  assert.equal(h.messages.at(-1).status, "completed");
});

test("a changed query filter stops before processing the next order", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")]], {
    onMessage: (message, setFilters) => { if (message.type === "PIC_EXPERT_ORDER_SETTLE") setFilters({ status: ["01"] }); }
  });
  await h.run("T1");
  assert.equal(h.messages.filter(item => item.type === "PIC_EXPERT_ORDER_CLAIM").length, 2);
  assert.match(h.messages.at(-1).error, /查询条件或页面发生变化/);
});

test("resume verifies the API query and checkpoint page signature", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")] ]);
  await h.run("T1", { url: h.context.url, page: 1, total: 2, signature: "wrong", filters: [], query: { status: ["01"] }, size: 2 });
  assert.equal(h.calls.length, 0);
  assert.equal(h.messages.at(-1).type, "PIC_EXPERT_TASK_AUTO_PAUSE");
  assert.match(h.messages.at(-1).error, /查询与断点不同/);
});

test("legacy checkpoints continue only when the saved page still matches", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")], [row("O3", "R3")]], { listSize: 10000 });
  await h.run("T1", { url: h.context.url, page: 1, total: 3, signature: "O1::R1\nO2::R2", filters: [] });
  assert.deepEqual(h.calls.map(c => c.size), [2, 2]);
  assert.equal(h.messages.at(-1).status, "completed");
});

test("authentication failure stops the task instead of marking every order failed", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")]], {
    assets: () => { const error = new Error("登录状态已失效"); error.auth = true; throw error; }
  });
  await h.run("T1");
  assert.equal(h.messages.filter(message => message.type === "PIC_EXPERT_ORDER_CLAIM").length, 2);
  assert.equal(h.messages.some(message => message.type === "PIC_EXPERT_ORDER_SETTLE"), false);
  assert.equal(h.messages.at(-1).type, "PIC_EXPERT_TASK_AUTO_PAUSE");
});

test("pause is saved at the order boundary", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")]]);
  h.pauseAfterNextRow();
  await h.run("T1");
  assert.equal(h.messages.filter(message => message.type === "PIC_EXPERT_ORDER_CLAIM").length, 2);
  assert.equal(h.messages.at(-1).type, "PIC_EXPERT_TASK_PAUSED");
});

test("image authentication errors stop before the next order even when another image fails first", async () => {
  for (const status of [401, 403]) {
    const requests = [];
    const h = harness([[row("O1", "R1"), row("O2", "R2")]], {
      fetch: async url => {
        requests.push(url);
        return { ok: false, status: url.endsWith("SN图片") ? 404 : status };
      }
    });
    await h.run("T1");
    assert.equal(h.messages.filter(m => m.type === "PIC_EXPERT_ORDER_CLAIM").length, 2);
    assert.equal(h.messages.some(m => m.type === "PIC_EXPERT_ORDER_SETTLE"), false);
    assert.equal(h.messages.some(m => m.type === "PIC_EXPERT_ORDER_SETTLE" && m.assets), false);
    assert.equal(h.messages.at(-1).type, "PIC_EXPERT_TASK_AUTO_PAUSE");
    assert.match(h.messages.at(-1).error, /登录/);
    assert.ok(requests.length >= 2 && requests.length <= 4);
  }
});

test("resume rescans every page, retries failures and missing files, and preserves good downloads and CSV totals", async () => {
  require("fake-indexeddb/auto");
  const { TaskStore } = require("../store.js");
  const { harness: background } = require("./background-harness.cjs");
  let pointer;
  const store = new TaskStore({
    get: async () => ({ picExpertTask: pointer }),
    set: async value => { pointer = value.picExpertTask; }
  }, "resume-test-" + process.pid);
  const options = { store, failInvoice: "R1" };
  const backend = background(options);
  const { task } = await backend.begin();
  const pages = [[row("O1", "R1"), row("O2", "R2")], [row("O3", "R3"), row("O4", "R4", "08")]];
  const h = harness(pages, {
    sendMessage: backend.send
  });
  try {
    await h.run(task.id);
    options.failInvoice = false;
    const finished = await store.getTask();
    assert.equal(finished.status, "completed");
    assert.equal(finished.checkpoint.page, 2);
    assert.equal(finished.failed, 1);
    const goodPair = await store.getPair(task.id, "R3");
    const lostPair = await store.getPair(task.id, "R2");
    backend.items.get(lostPair.files["SN图片"].downloadId).exists = false;
    const before = backend.calls.length;
    const resumed = await backend.send({ type: "PIC_EXPERT_TASK_RESUME", tabId: 7, frameId: 4 }, {});
    assert.equal(resumed.ok, true);
    assert.equal(resumed.task.id, task.id);
    assert.equal(resumed.task.folderName, task.folderName);
    await h.run(task.id, resumed.task.checkpoint);
    const finalTask = await store.getTask();
    assert.equal(finalTask.status, "completed");
    assert.deepEqual([finalTask.scanned, finalTask.completed, finalTask.skipped, finalTask.failed], [4, 4, 0, 0]);
    assert.equal((await store.rows(task.id)).length, 4);
    assert.deepEqual(await store.getPair(task.id, "R3"), goodPair);
    const newCalls = backend.calls.slice(before);
    assert.equal(newCalls.length, 5);
    assert.ok(newCalls.slice(0, 4).every(call => /\/(R1|R2)\//.test(call.filename)));
    const manifests = backend.calls.filter(call => call.filename.endsWith(".csv"));
    assert.equal(manifests.length, 2);
    assert.equal(manifests[0].filename, manifests[1].filename);
    assert.equal(manifests[1].conflictAction, "overwrite");
    const csv = decodeURIComponent(manifests[1].url.split(",").slice(1).join(","));
    assert.equal(csv, "\uFEFF订单号,参考号,处理结果,原因\r\nO1,R1,成功,\r\nO2,R2,成功,\r\nO3,R3,成功,\r\nO4,R4,成功,");
    assert.equal((await backend.send({ type: "PIC_EXPERT_TASK_RESUME", tabId: 7, frameId: 4 }, {})).ok, false);
  } finally { (await store.open()).close(); }
});

test("changed checkpoint page stops before retrying earlier pages", async () => {
  const h = harness([[row("O1", "R1"), row("O2", "R2")], [row("O3", "R3")]]);
  await h.run("T1", { url: h.context.url, page: 2, total: 3, signature: "wrong", filters: [], size: 2 });
  assert.equal(h.messages.some(m => m.type === "PIC_EXPERT_ORDER_CLAIM"), false);
  assert.match(h.messages.at(-1).error, /断点页订单集合/);
});

test('digital task sends all selected images and skips a missing required field without partial download', async () => {
  for (const missing of [false,true]) {
    const h=harness([[row('O1','R1')]], {assets: () => ({files:{'二合一照片':'https://portal.test/box','IMEI':'https://portal.test/imei','发票':'https://portal.test/invoice'},missing:missing?['必填图片缺失：IMEI']:[]})});
    await h.run('T1',null,{business:'digital'});
    const result=h.messages.find(m=>m.type==='PIC_EXPERT_ORDER_SETTLE').row;
    assert.equal(result.result,missing?'跳过':'成功');
    const download=h.messages.find(m=>m.type==='PIC_EXPERT_ORDER_SETTLE'&&m.assets);
    if(missing){assert.equal(download,undefined);assert.match(result.reason,/IMEI/);}else assert.deepEqual(Object.keys(download.assets),['二合一照片','IMEI','发票']);
  }
});
test('a changed login token pauses before saving images', async () => {
  let token='original';
  const h=harness([[row('O1','R1')]],{token:()=>token,fetch:async()=>{token='other';return {ok:true,status:200,blob:async()=>new Blob([new Uint8Array([255,216,255])])};}});
  await h.run('T1',null,{business:'appliance'});
  assert.equal(h.messages.some(m=>m.type==='PIC_EXPERT_ORDER_SETTLE'),false);
  assert.equal(h.messages.at(-1).type,'PIC_EXPERT_TASK_AUTO_PAUSE');
});
