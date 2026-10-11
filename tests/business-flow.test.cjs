const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./background-harness.cjs');
test('two export functions retain separate tasks and reject simultaneous execution', async () => {
  const h = harness();
  const begin = business => h.send({type:'PIC_EXPERT_TASK_BEGIN',business,tabId:7,frameId:4,tradeDateRange:['20261001','20261011']},{});
  const a = await begin('appliance');
  assert.equal(a.ok,true);
  assert.equal((await begin('digital')).ok,false);
  await h.send({type:'PIC_EXPERT_TASK_PAUSE',business:'appliance'},{});
  const d = await begin('digital');
  assert.equal(d.ok,true);
  assert.notEqual(a.task.id,d.task.id);
  assert.match(d.task.folderName,/数码/);
  const saved = await h.send({type:'PIC_EXPERT_TASK_STATE',business:'appliance'},{});
  assert.equal(saved.task.id,a.task.id);
  assert.equal(saved.task.status,'paused');
});
test('manual business selection resumes without an account identity', async () => {
  const h=harness();
  const {task}=await h.begin();
  await h.send({type:'PIC_EXPERT_LIST_BEGIN',taskId:task.id,checkpoint:{page:1,total:0,size:10000}}, {tab:{id:7},frameId:4});
  await h.send({type:'PIC_EXPERT_TASK_PAUSE'},{});
  const result=await h.send({type:'PIC_EXPERT_TASK_RESUME',tabId:8,frameId:0},{});
  assert.equal(result.ok,true);
  assert.equal(h.task().status,'running');
  assert.equal(h.task().tabId,8);
  assert.equal(h.task().accountId,undefined);
});
test('digital download preserves template names and rolls back an incomplete order', async () => {
  const h=harness({failFilename:'系统IMEI码照片.jpg'});
  const {task}=await h.send({type:'PIC_EXPERT_TASK_BEGIN',business:'digital',tabId:7,frameId:4,tradeDateRange:['20261001','20261011']},{});
  const asset={extension:'.jpg',url:'data:image/jpeg;base64,/9j/'};
  const result=await h.send({type:'PIC_EXPERT_DOWNLOAD_PAIR',taskId:task.id,orderNo:'O1',referenceNo:'R1',assets:{'商品SN照片':asset,'系统IMEI码照片':asset,'发票图片':asset}}, {tab:{id:7},frameId:4});
  assert.equal(result.ok,false);
  assert.equal(h.calls.length,2);
  assert.deepEqual(h.removed,[1]);
});
test('late messages cannot restore a replaced business task or bypass the running guard', async () => {
  const h=harness();
  const old=await h.begin();
  await h.send({type:'PIC_EXPERT_TASK_PAUSE'},{});
  const current=await h.begin();
  const late=await h.send({type:'PIC_EXPERT_LOG',taskId:old.task.id,message:'late'}, {tab:{id:7},frameId:4});
  assert.equal(late.ok,false);
  assert.equal((await h.send({type:'PIC_EXPERT_TASK_STATE'},{})).task.id,current.task.id);
  assert.equal((await h.begin()).ok,false);
});
test('stopping a paused function does not stop another running function', async () => {
  const h=harness();await h.begin();await h.send({type:'PIC_EXPERT_TASK_PAUSE'},{});
  const {task}=await h.send({type:'PIC_EXPERT_TASK_BEGIN',business:'digital',tabId:7,frameId:4,tradeDateRange:['20261001','20261011']},{});
  assert.equal((await h.send({type:'PIC_EXPERT_TASK_STOP',business:'appliance'},{})).ok,false);
  assert.equal((await h.send({type:'PIC_EXPERT_TASK_STATE',business:'digital'},{})).task.id,task.id);
  assert.equal((await h.send({type:'PIC_EXPERT_TASK_STATE',business:'digital'},{})).task.status,'running');
});
