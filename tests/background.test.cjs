const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, assets } = require("./background-harness.cjs");
// A settle response saved the order only when it records success; save failures come back as a failed row.
const saved = response => response.ok && response.row?.result === "成功";
const claim = (h, taskId, extra = {}, source) => h.send({ type: "PIC_EXPERT_ORDER_CLAIM", taskId, identity: { orderNo: "O1", referenceNo: "R1" }, ...extra }, source);

test("concurrent starts create one task", async () => {
  const h = harness();
  const results = await Promise.all([h.begin(), h.begin()]);
  assert.equal(results.filter(r => r.ok).length, 1);
});
test("duplicate pair messages download one correctly named pair", async () => {
  const h = harness(), { task } = await h.begin();
  const responses = await Promise.all([h.pair(task.id), h.pair(task.id)]);
  assert.ok(responses.every(saved));
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0].filename, /\/R1\/SN图片\.jpg$/);
  assert.match(h.calls[1].filename, /\/R1\/发票\.png$/);
  assert.ok(saved(await h.pair(task.id)));
  assert.equal(h.calls.length, 2);
});
test("date range prefixes every new task download path", async () => {
  const h = harness(), { task } = await h.begin(["20260101", "20260131"]);
  assert.equal(task.folderName, "家电电脑/20260101-20260131_" + task.id);
  await h.pair(task.id);
  await h.send({ type: "PIC_EXPERT_TASK_END", taskId: task.id, status: "completed" });
  await h.send({ type: "PIC_EXPERT_LOG_EXPORT" }, {});
  assert.ok(h.calls.length >= 4);
  assert.ok(h.calls.every(call => call.filename.startsWith("pic-expert/家电电脑/20260101-20260131_" + task.id + "/")));
});
test("legacy task logs keep using the task ID folder", async () => {
  const initial = { id: "OLD", status: "completed", logs: [{ time: "2026-10-05", level: "info", stage: "test", message: "old" }] };
  const h = harness({}, initial);
  await h.send({ type: "PIC_EXPERT_LOG_EXPORT" }, {});
  assert.equal(h.calls[0].filename, "pic-expert/OLD/运行日志-001.txt");
});
test("new task creation rejects missing or malformed trade date ranges", async () => {
  const h = harness();
  assert.equal((await h.begin(null)).ok, false);
  assert.equal((await h.begin(["2026/01/01", "20260131"])).ok, false);
  assert.equal((await h.begin([20260101, "20260131"])).ok, false);
});
test("messages from another frame cannot download", async () => {
  const h = harness(), { task } = await h.begin();
  const response = await h.pair(task.id, {}, { tab: { id: 7 }, frameId: 0 });
  assert.equal(response.ok, false);
  assert.equal(h.calls.length, 0);
});
test("failed invoice rolls back the pair and never marks success", async () => {
  const h = harness({ failInvoice: true }), { task } = await h.begin();
  const response = await h.pair(task.id);
  assert.equal(saved(response), false);
  assert.equal(response.row.reason, "NETWORK_FAILED");
  assert.equal((await h.task()).manifestRows[0].result, "失败");
  assert.equal((await h.task()).downloads.R1.status, "failed");
  assert.deepEqual(h.removed, [1]);
  assert.deepEqual((await h.task()).downloads.R1.files, {});
});
test("failed rollback retains the actual leftover path", async () => {
  const h = harness({ failInvoice: true, failRemove: true }), { task } = await h.begin();
  assert.equal(saved(await h.pair(task.id)), false);
  assert.match((await h.task()).downloads.R1.files["SN图片"].filename, /SN图片\.jpg$/);
});
test("reference cannot be reused for a different order", async () => {
  const h = harness(), { task } = await h.begin();
  await h.pair(task.id);
  const result = await h.pair(task.id, { row: { orderNo: "O2", referenceNo: "R1", result: "成功", reason: "" } });
  assert.equal(saved(result), false);
  assert.match(result.row.reason, /同一参考号对应多个订单/);
  assert.equal(h.calls.length, 2);
});
test("duplicate end messages produce one manifest", async () => {
  const h = harness(), { task } = await h.begin();
  await h.pair(task.id);
  const end = { type: "PIC_EXPERT_TASK_END", taskId: task.id, status: "completed" };
  await Promise.all([h.send(end), h.send(end)]);
  await h.send(end);
  assert.equal(h.calls.filter(c => c.filename.endsWith(".csv")).length, 1);
  assert.equal((await h.task()).status, "completed");
  assert.equal((await h.task()).manifestRows[0].result, "成功");
});
test("manifest failure preserves terminal state and permits next task", async () => {
  const h = harness({ failManifest: true }), { task } = await h.begin();
  await h.send({ type: "PIC_EXPERT_TASK_END", taskId: task.id, status: "failed", error: "navigation_failed" });
  assert.equal((await h.task()).status, "failed");
  assert.match((await h.task()).manifestError, /清单下载失败/);
  assert.ok((await h.begin()).ok);
});
test("stop interrupts an ongoing pair and cleans it before finalizing", async () => {
  const h = harness({ holdPair: true }), { task } = await h.begin();
  const download = h.pair(task.id);
  while (!(await h.task()).downloads.R1?.files["SN图片"]) await new Promise(setImmediate);
  const stopped = await h.send({ type: "PIC_EXPERT_TASK_STOP" }, {});
  assert.ok(stopped.ok);
  assert.equal((await download).ok, false);
  assert.equal((await h.task()).status, "failed");
  assert.equal((await h.task()).manifestRows[0].result, "失败");
  assert.deepEqual((await h.task()).downloads.R1.files, {});
});

test("a stopped task is recoverable after worker restart during finalization", async () => {
  const initial = { id:"T1",status:"finalizing",finalStatus:"completed",finishedAt:"2026-10-04",
    tabId:7,frameId:4,manifestRows:[],downloads:{},scanned:0,completed:0,skipped:0,failed:0 };
  const h = harness({}, initial);
  assert.equal((await h.send({type:"PIC_EXPERT_TASK_STOP"},{})).task.status, "failed");
  assert.ok((await h.begin()).ok);
});

function interruptedTask(result = "失败") {
  return {id:"T1", status:"running", tabId:7, frameId:4, scanned:1, completed:0, skipped:0, failed:1,
    manifestRows:[{orderNo:"O1",referenceNo:"R1",result,reason:"页面中断",snFile:"",invoiceFile:""}],
    downloads:{R1:{orderNo:"O1",status:"pending",files:{"SN图片":{downloadId:1,filename:"pic-expert/T1/R1/SN图片.jpg"}}}}};
}
test("worker recovery reconciles leftover files and logs paths omitted from CSV", async () => {
  const h = harness({failRemove:true}, interruptedTask());
  await h.send({type:"PIC_EXPERT_TASK_STOP"},{});
  const rows = (await h.task()).manifestRows;
  assert.equal(rows.length, 1);
  const files = (await h.task()).downloads.R1.files;
  assert.equal(files["SN图片"].filename, "pic-expert/T1/R1/SN图片.jpg");
  assert.equal(files["发票"], undefined);
  assert.equal(rows[0].result, "失败");
  assert.match(rows[0].reason, /页面中断.*部分文件无法清理/);
  assert.ok((await h.task()).logs.some(entry => entry.stage === "残留文件" && entry.message.includes(files["SN图片"].filename)));
  assert.doesNotMatch(decodeURIComponent(h.calls[0].url), /SN图片.jpg/);
  assert.equal((await h.task()).failed, 1);
});
test("rolled-back pair clears file records and success from an existing row", async () => {
  const initial = interruptedTask("成功");
  const h = harness({}, initial);
  await h.send({type:"PIC_EXPERT_TASK_STOP"},{});
  assert.equal((await h.task()).manifestRows[0].result, "失败");
  assert.deepEqual((await h.task()).downloads.R1.files, {});
  assert.equal((await h.task()).completed, 0);
});
test("complete files retain a separately recorded failure reason", async () => {
  const initial = interruptedTask();
  initial.downloads.R1.status = "complete";
  const h = harness({}, initial);
  await h.send({type:"PIC_EXPERT_TASK_STOP"},{});
  assert.equal((await h.task()).manifestRows[0].result, "失败");
  assert.equal((await h.task()).manifestRows[0].reason, "页面中断");
  assert.match((await h.task()).downloads.R1.files["SN图片"].filename, /SN图片.jpg$/);
});
test("retry clears obsolete CSV error when native download already completed", async () => {
  const h = harness({failManifest:true}), {task} = await h.begin();
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"completed"});
  h.items.get((await h.task()).manifestDownloadId).state = "complete";
  const response = await h.send({type:"PIC_EXPERT_MANIFEST_RETRY"},{});
  assert.equal(response.task.manifestError, "");
  assert.equal((await h.task()).manifestError, "");
  assert.equal(h.calls.length, 1);
});
test("retry waits for in-progress CSV and clears persisted error on completion", async () => {
  const h = harness({failManifest:true}), {task} = await h.begin();
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"completed"});
  const item = h.items.get((await h.task()).manifestDownloadId);
  item.state = "in_progress";
  setImmediate(() => { item.state = "complete"; });
  const response = await h.send({type:"PIC_EXPERT_MANIFEST_RETRY"},{});
  assert.equal(response.task.manifestError, "");
  assert.equal(h.calls.length, 1);
});
test("task logs survive worker restart and are bounded to the latest 500 entries", async () => {
  const h = harness(), {task} = await h.begin();
  for (let i = 0; i < 505; i++) {
    assert.ok((await h.send({type:"PIC_EXPERT_LOG",taskId:task.id,stage:"日期控件",message:String(i)})).ok);
  }
  const saved = (await h.task()), restarted = harness({}, saved);
  const current = (await restarted.send({type:"PIC_EXPERT_TASK_STATE"},{})).task;
  assert.equal(current.logs.length, 500);
  assert.equal(current.logs[0].message, "5");
  assert.equal(current.logs.at(-1).message, "504");
  assert.ok(current.logs.every(entry => !Number.isNaN(Date.parse(entry.time))));
});
test("diagnostic log messages reject wrong task and frame", async () => {
  const h = harness(), {task} = await h.begin(), before = (await h.task()).logs.length;
  assert.equal((await h.send({type:"PIC_EXPERT_LOG",taskId:"old",message:"invalid"})).ok, false);
  assert.equal((await h.send({type:"PIC_EXPERT_LOG",taskId:task.id,message:"invalid"},{tab:{id:7},frameId:0})).ok, false);
  assert.equal((await h.task()).logs.length, before);
});
test("paired downloads and CSV completion are persisted in task logs", async () => {
  const h = harness(), {task} = await h.begin();
  await h.pair(task.id);
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"completed"});
  const logs = (await h.task()).logs;
  assert.equal(logs.filter(entry => entry.stage === "下载图片").length, 2);
  assert.ok(logs.some(entry => entry.stage === "配对完成"));
  assert.ok(logs.some(entry => entry.stage === "下载清单" && entry.message.includes("清单已下载")));
});
const multiAssets = {"SN图片-1":assets["SN图片"],"SN图片-2":assets["发票"],"发票-1":assets["发票"],"发票-2":assets["SN图片"],"发票-3":assets["发票"]};
test("duplicate messages download five files once and export a four-column CSV", async () => {
  const h = harness(), {task} = await h.begin();
  const results = await Promise.all([h.pair(task.id,{assets:multiAssets}),h.pair(task.id,{assets:multiAssets})]);
  assert.ok(results.every(saved));
  assert.equal(h.calls.length, 5);
  assert.match(h.calls[2].filename, /\/R1\/发票-1.png$/);
  assert.match(h.calls[3].filename, /\/R1\/发票-2.jpg$/);
  assert.match(h.calls[4].filename, /\/R1\/发票-3.png$/);
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"completed"});
  assert.equal((await h.task()).downloads.R1.files["发票-2"].filename, h.calls[3].filename);
  assert.equal(decodeURIComponent(h.calls[5].url).split(",").slice(1).join(","), "\uFEFF订单号,参考号,处理结果,原因\r\nO1,R1,成功,");
});
test("failed numbered image rolls back every file of the order and never succeeds", async () => {
  const h = harness({failProof:"发票-2"}), {task} = await h.begin();
  assert.equal(saved(await h.pair(task.id,{assets:multiAssets})), false);
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.removed, [1,2,3]);
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"completed"});
  assert.equal((await h.task()).manifestRows[0].result, "失败");
  assert.deepEqual((await h.task()).downloads.R1.files, {});
});
test("failed cleanup retains its path in download records", async () => {
  const h = harness({failProof:"发票-2",failRemoveId:3}), {task} = await h.begin();
  await h.pair(task.id,{assets:multiAssets});
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"failed"});
  assert.match((await h.task()).downloads.R1.files["发票-1"].filename, /发票-1.png$/);
  assert.equal((await h.task()).downloads.R1.files["SN图片-1"], undefined);
});
test("missing required pair, proof images or invalid format create no downloads", async () => {
  const h = harness(), {task} = await h.begin();
  for (const value of [{"SN图片":assets["SN图片"]},{...assets,"证明材料图一":assets["SN图片"]},{...assets,"发票":{extension:".html",url:"data:text/html;base64,AA=="}}]) {
    assert.equal(saved(await h.pair(task.id,{assets:value})), false);
  }
  assert.equal(h.calls.length, 0);
});
const checkpoint = {url:"https://portal.test/app#/auditOfTrade2026",page:1,total:2,signature:"O1::R1\nO2::R2",filters:[]};
const saveCheckpoint = (h,id) => h.send({type:"PIC_EXPERT_CHECKPOINT",taskId:id,checkpoint});
test("graceful pause preserves the task directory and completed files without exporting partial CSV", async () => {
  const h=harness({livePage:true}),{task}=await h.begin();
  await saveCheckpoint(h,task.id); await h.pair(task.id);
  await h.send({type:"PIC_EXPERT_TASK_PAUSE"},{});
  assert.equal((await h.task()).status,"pausing");
  await h.send({type:"PIC_EXPERT_TASK_PAUSED",taskId:task.id});
  assert.equal((await h.task()).status,"paused");
  assert.equal(h.calls.length,2);
  const resumed=await h.send({type:"PIC_EXPERT_TASK_RESUME",tabId:7,frameId:4},{});
  assert.equal(resumed.task.id,task.id);
  assert.equal(resumed.task.folderName,task.folderName);
  assert.equal(resumed.task.completed,1);
  assert.equal((await claim(h,task.id)).done,true);
});
test("worker restart preserves completed rows and can rebind continuation to a new frame", async () => {
  const h=harness(),{task}=await h.begin(); await saveCheckpoint(h,task.id); await h.pair(task.id);
  await h.send({type:"PIC_EXPERT_TASK_PAUSE"},{});
  const restarted=harness({store:h.store,items:h.items});
  assert.ok((await restarted.send({type:"PIC_EXPERT_TASK_RESUME",tabId:7,frameId:9},{})).ok);
  assert.equal((await restarted.pair(task.id)).ok,false);
  const response=await claim(restarted,task.id,{},{tab:{id:7},frameId:9});
  assert.equal(response.done,true);
  assert.equal(restarted.calls.length,0);
});
test("missing completed files are redownloaded rather than blindly skipped", async () => {
  const h=harness(),{task}=await h.begin(); await saveCheckpoint(h,task.id); await h.pair(task.id);
  h.items.get(1).exists=false;
  assert.equal((await claim(h,task.id)).done,false);
  assert.ok(saved(await h.pair(task.id)));
  assert.equal(h.calls.length,4);
});
test("failed pair is only retried after explicit continuation, never by duplicate messages", async () => {
  const options={failInvoice:true}, h=harness(options),{task}=await h.begin(); await saveCheckpoint(h,task.id);
  assert.equal(saved(await h.pair(task.id)),false);
  assert.equal(saved(await h.pair(task.id)),false);
  assert.equal(h.calls.length,2);
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"failed"});
  await h.send({type:"PIC_EXPERT_TASK_RESUME",tabId:7,frameId:4},{});
  options.failInvoice=false;
  assert.ok(saved(await h.pair(task.id)));
  assert.equal((await h.task()).scanned,1);
  assert.equal((await h.task()).completed,1);
  assert.equal((await h.task()).failed,0);
});
test("force pause cleans an in-flight pair and retains a resumable checkpoint", async () => {
  const options={livePage:true,holdPair:true},h=harness(options),{task}=await h.begin();
  await saveCheckpoint(h,task.id); const download=h.pair(task.id);
  while(!(await h.task()).downloads.R1?.files["SN图片"]) await new Promise(setImmediate);
  await h.send({type:"PIC_EXPERT_TASK_PAUSE"},{});
  assert.equal((await h.task()).status,"pausing");
  await h.send({type:"PIC_EXPERT_TASK_PAUSE"},{});
  assert.equal((await download).ok,false);
  await h.send({type:"PIC_EXPERT_TASK_PAUSED",taskId:task.id});
  assert.equal((await h.task()).status,"paused");
  assert.deepEqual((await h.task()).downloads.R1.files,{});
  assert.equal(h.calls.some(c=>c.filename.endsWith(".csv")),false);
  assert.ok((await h.task()).checkpoint);
});
test("large-task log updates write bounded metadata and popup responses contain no order arrays", async () => {
  const rows=Array.from({length:20000},(_,i)=>({orderNo:"O"+i,referenceNo:"R"+i,result:"成功"}));
  const h=harness({}, {id:"T1",status:"running",tabId:7,frameId:4,manifestRows:rows,downloads:{}});
  await h.store.getTask();
  const writes=[], save=h.store.save.bind(h.store);
  h.store.save=(task,changes={})=>{ writes.push({metadataBytes:JSON.stringify(task).length,rows:changes.rows?.length||0,pairs:changes.pairs?.length||0}); return save(task,changes); };
  await h.send({type:"PIC_EXPERT_LOG",taskId:"T1",stage:"测试",message:"small update"});
  const write=writes.at(-1);
  assert.equal(write.rows,0); assert.equal(write.pairs,0); assert.ok(write.metadataBytes<1000);
  const current=(await h.send({type:"PIC_EXPERT_TASK_STATE"},{})).task;
  assert.equal(current.manifestRows,undefined); assert.equal(current.downloads,undefined);
  assert.equal(current.completed,20000);
});
test("full-log export includes early entries beyond the popup's 500-row window", async () => {
  const h=harness(),{task}=await h.begin();
  await h.store.save(await h.store.getTask(),{logs:Array.from({length:520},(_,i)=>({time:"2026-10-05",level:"info",stage:"test",message:"entry-"+i}))});
  await h.send({type:"PIC_EXPERT_LOG_EXPORT"},{});
  const text=decodeURIComponent(h.calls[0].url);
  assert.match(text,/entry-0\n/); assert.match(text,/entry-519/);
  assert.ok((await h.store.logs(task.id,Infinity)).length>500);
});
test("full-log export splits large logs into bounded segments with no omissions", async () => {
  const h=harness(),{task}=await h.begin();
  await h.store.save(await h.store.getTask(),{logs:Array.from({length:5100},(_,i)=>({time:"2026-10-05",level:"info",stage:"test",message:"row-"+i}))});
  await h.send({type:"PIC_EXPERT_LOG_EXPORT"},{});
  assert.equal(h.calls.length,2);
  const text=h.calls.map(call=>decodeURIComponent(call.url)).join("\n");
  assert.equal((text.match(/row-\d+/g)||[]).length,5100);
  assert.match(h.calls[0].filename,/运行日志-001.txt$/);
  assert.match(h.calls[1].filename,/运行日志-002.txt$/);
});
test("native completion events release waiters and listeners are removed afterward", async () => {
  const h=harness({holdPair:true}),{task}=await h.begin(),download=h.pair(task.id);
  while(!(await h.task()).downloads.R1?.files["SN图片"]) await new Promise(setImmediate);
  h.notify(1,"complete");
  while(!(await h.task()).downloads.R1?.files["发票"]) await new Promise(setImmediate);
  h.notify(2,"complete");
  assert.ok(saved(await download));
  assert.equal(h.handlers.size,0);
});
test("concurrent manifest retries start only one replacement CSV download", async () => {
  const options={failManifest:true},h=harness(options),{task}=await h.begin();
  await h.send({type:"PIC_EXPERT_TASK_END",taskId:task.id,status:"completed"});
  options.failManifest=false;
  await Promise.all([h.send({type:"PIC_EXPERT_MANIFEST_RETRY"},{}),h.send({type:"PIC_EXPERT_MANIFEST_RETRY"},{})]);
  assert.equal(h.calls.length,2);
  assert.equal((await h.task()).manifestError,"");
});
test("force-pause cleanup blocks new tasks until pending downloads settle", async () => {
  const h=harness({livePage:true,holdPair:true}),{task}=await h.begin();
  await saveCheckpoint(h,task.id); const download=h.pair(task.id);
  while(!(await h.task()).downloads.R1?.files["SN图片"]) await new Promise(setImmediate);
  await h.send({type:"PIC_EXPERT_TASK_PAUSE"},{});
  const pause=h.send({type:"PIC_EXPERT_TASK_PAUSE"},{});
  while(!(await h.task()).forcePause) await new Promise(setImmediate);
  assert.equal((await h.begin()).ok,false);
  await pause; await download;
  await h.send({type:"PIC_EXPERT_TASK_PAUSED",taskId:task.id});
  assert.equal((await h.task()).status,"paused");
});

test("continuation retains locked leftovers and retries after the user removes them", async () => {
  const options = { failInvoice: true, failRemove: true };
  const h = harness(options), { task } = await h.begin();
  await saveCheckpoint(h, task.id);
  assert.equal(saved(await h.pair(task.id)), false);
  await h.send({ type: "PIC_EXPERT_TASK_END", taskId: task.id, status: "failed" });
  await h.send({ type: "PIC_EXPERT_TASK_RESUME", tabId: 7, frameId: 4 }, {});
  options.failInvoice = false;
  const before = h.calls.length;
  assert.equal(saved(await h.pair(task.id)), false);
  assert.equal(h.calls.length, before);
  assert.ok((await h.task()).downloads.R1.files["SN图片"]);
  await h.send({ type: "PIC_EXPERT_TASK_END", taskId: task.id, status: "failed" });
  h.items.get(1).exists = false;
  await h.send({ type: "PIC_EXPERT_TASK_RESUME", tabId: 7, frameId: 4 }, {});
  assert.ok(saved(await h.pair(task.id)));
  assert.equal((await h.task()).downloads.R1.status, "complete");
  assert.ok((await h.task()).downloads.R1.files["SN图片"].downloadId !== 1);
});

test("failed cancellation retains the in-progress download and logs its path", async () => {
  const h = harness({ holdPair: true, failCancel: true }), { task } = await h.begin();
  const download = h.pair(task.id);
  while (!(await h.task()).downloads.R1?.files["SN图片"]) await new Promise(setImmediate);
  await h.send({ type: "PIC_EXPERT_TASK_STOP" }, {});
  assert.equal((await download).ok, false);
  assert.ok((await h.task()).downloads.R1.files["SN图片"]);
  assert.equal(h.items.get(1).state, "in_progress");
  assert.ok((await h.task()).logs.some(entry => entry.stage === "残留文件" && entry.message.includes("SN图片.jpg")));
});

test("missing download history does not claim that an unknown file was removed", async () => {
  const initial = interruptedTask();
  const h = harness({ items: new Map() }, initial);
  await h.send({ type: "PIC_EXPERT_TASK_STOP" }, {});
  assert.ok((await h.task()).downloads.R1.files["SN图片"]);
  assert.match((await h.task()).manifestRows[0].reason, /无法清理/);
});

test("worker restart reconciles every in-flight identity and retains completed rows", async () => {
  const identities = [1, 2, 3].map(n => ({ orderNo: "O" + n, referenceNo: "R" + n, page: 2 }));
  const h = harness({}, { id: "T1", status: "running", tabId: 7, frameId: 4, page: 2, currentRows: identities,
    manifestRows: [{ orderNo: "O0", referenceNo: "R0", result: "成功", page: 1 }],
    downloads: { R1: { orderNo: "O1", status: "pending", files: { "SN图片": { downloadId: 1, filename: "SN图片.jpg" } } } } });
  await h.send({ type: "PIC_EXPERT_TASK_PAUSE" }, {});
  assert.equal((await h.task()).status, "paused");
  assert.deepEqual([(await h.task()).scanned, (await h.task()).completed, (await h.task()).failed, (await h.task()).currentRows.length], [4, 1, 3, 0]);
  assert.ok((await h.task()).manifestRows.filter(row => row.result === "失败").every(row => row.page === 2));
  assert.deepEqual((await h.task()).downloads.R1.files, {});
});

test("duplicate claim and settle messages do not occupy extra slots or double count results", async () => {
  const h = harness(), { task } = await h.begin();
  const identity = { orderNo: "O1", referenceNo: "R1" };
  await Promise.all(Array.from({ length: 3 }, () => claim(h, task.id)));
  assert.equal((await h.task()).currentRows.length, 1);
  const row = { ...identity, result: "跳过", reason: "材料修改" };
  await Promise.all(Array.from({ length: 3 }, () => h.send({ type: "PIC_EXPERT_ORDER_SETTLE", taskId: task.id, note: "材料修改", row })));
  assert.deepEqual([(await h.task()).currentRows.length, (await h.task()).scanned, (await h.task()).skipped], [0, 1, 1]);
});

test("recovery retains material modification notes for completed numbered files and orders interrupted before saving", async () => {
  for (const settled of [false, true]) {
    const h = harness(), { task } = await h.begin();
    await claim(h, task.id, { note: "材料修改" });
    if (settled) {
      const result = await h.pair(task.id, { note: "材料修改", row: { orderNo: "O1", referenceNo: "R1", result: "成功", reason: "材料修改" },
        assets: { "SN图片-2": assets["SN图片"], "发票": assets["发票"], "SN图片-1": assets["SN图片"] } });
      assert.ok(saved(result));
      assert.deepEqual(h.calls.map(call => call.filename.split("/").at(-1)), ["SN图片-1.jpg", "SN图片-2.jpg", "发票.png"]);
    }
    const restarted = harness({ store: h.store, items: h.items });
    await restarted.send({ type: "PIC_EXPERT_TASK_STOP" }, {});
    const result = (await h.task()).manifestRows[0];
    assert.equal(result.result, settled ? "成功" : "失败");
    assert.match(result.reason, /材料修改/);
    if (settled) assert.equal(result.reason, "材料修改");
    else assert.match(result.reason, /用户停止/);
    assert.match(decodeURIComponent(restarted.calls[0].url), /材料修改/);
  }
});

test("continuation rechecks orders skipped by removed rules and keeps genuine missing-image skips", async () => {
  for (const [reason, done] of [["材料修改", false], ["SN码或发票图片缺失或不唯一", false], ["SN码或发票图片缺失", true]]) {
    const h = harness({}, { id: "T1", status: "running", tabId: 7, frameId: 4,
      manifestRows: [{ orderNo: "O1", referenceNo: "R1", result: "跳过", reason }] });
    const result = await claim(h, "T1");
    assert.equal(result.ok, true);
    assert.equal(result.done, done);
  }
});
