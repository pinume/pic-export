const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./background-harness.cjs');
test('two export functions retain separate tasks and reject simultaneous execution', async () => {
  const h = harness();
  const begin = business => h.send({type:'PIC_EXPERT_TASK_BEGIN',business,tabId:7,frameId:4,tradeDateRange:['20261001','20261011']},{});
  const a = await begin('appliance');
  assert.equal(a.ok,true);
  assert.equal((await begin('digital')).ok,false);
  await h.send({type:'PIC_EXPERT_TASK_STOP',business:'appliance'},{});
  const d = await begin('digital');
  assert.equal(d.ok,true);
  assert.notEqual(a.task.id,d.task.id);
  assert.match(d.task.folderName,/数码/);
  const saved = await h.send({type:'PIC_EXPERT_TASK_STATE',business:'appliance'},{});
  assert.equal(saved.task.id,a.task.id);
  assert.equal(saved.task.status,'failed');
});
test('the list start message carries its page size', async () => {
  const h=harness();
  const {task}=await h.begin();
  assert.equal((await h.send({type:'PIC_EXPERT_LIST_BEGIN',taskId:task.id}, {tab:{id:7},frameId:4})).ok,false);
  assert.equal((await h.send({type:'PIC_EXPERT_LIST_BEGIN',taskId:task.id,size:10000}, {tab:{id:7},frameId:4})).ok,true);
  assert.equal((await h.task()).size,10000);
  assert.equal((await h.task()).accountId,undefined);
});
test('digital download keeps the selected names and rolls back an incomplete order', async () => {
  const h=harness({failFilename:'IMEI.jpg'});
  const {task}=await h.send({type:'PIC_EXPERT_TASK_BEGIN',business:'digital',tabId:7,frameId:4,tradeDateRange:['20261001','20261011']},{});
  const asset={extension:'.jpg',url:'data:image/jpeg;base64,/9j/'};
  const result=await h.send({type:'PIC_EXPERT_ORDER_SETTLE',taskId:task.id,note:'',row:{orderNo:'O1',referenceNo:'R1',result:'成功',reason:''},assets:{'二合一照片':asset,'IMEI':asset,'发票':asset}}, {tab:{id:7},frameId:4});
  assert.equal(result.row.result,'失败');
  assert.match(h.calls[0].filename,/\/R1\/二合一照片\.jpg$/);
  assert.equal(h.calls.length,2);
  assert.deepEqual(h.removed,[1]);
});
test('late messages cannot restore a replaced business task or bypass the running guard', async () => {
  const h=harness();
  const old=await h.begin();
  await h.send({type:'PIC_EXPERT_TASK_STOP'},{});
  const current=await h.begin();
  const late=await h.send({type:'PIC_EXPERT_LOG',taskId:old.task.id,message:'late'}, {tab:{id:7},frameId:4});
  assert.equal(late.ok,false);
  assert.equal((await h.send({type:'PIC_EXPERT_TASK_STATE'},{})).task.id,current.task.id);
  assert.equal((await h.begin()).ok,false);
});
test('stopping a stopped function does not stop another running function', async () => {
  const h=harness();await h.begin();await h.send({type:'PIC_EXPERT_TASK_STOP'},{});
  const {task}=await h.send({type:'PIC_EXPERT_TASK_BEGIN',business:'digital',tabId:7,frameId:4,tradeDateRange:['20261001','20261011']},{});
  assert.equal((await h.send({type:'PIC_EXPERT_TASK_STOP',business:'appliance'},{})).task.status,'failed');
  assert.equal((await h.send({type:'PIC_EXPERT_TASK_STATE',business:'digital'},{})).task.id,task.id);
  assert.equal((await h.send({type:'PIC_EXPERT_TASK_STATE',business:'digital'},{})).task.status,'running');
});
