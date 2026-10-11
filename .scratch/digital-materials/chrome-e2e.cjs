const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const repo=path.resolve(__dirname,'../..');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label){const end=Date.now()+30000;while(Date.now()<end){const v=await check();if(v)return v;await pause(100);}throw Error('Timeout: '+label);}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(name) {
  const chunk = (type, data) => { const bytes = Buffer.concat([Buffer.from(type), data]); const length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(bytes)); return Buffer.concat([length, bytes, crc]); };
  const header = Buffer.from([0,0,0,1,0,0,0,1,8,2,0,0,0]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('tEXt', Buffer.from('source\0' + name)), chunk('IDAT', zlib.deflateSync(Buffer.from([0,15,100,220]))), chunk('IEND', Buffer.alloc(0))]);
}
function connect(endpoint) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint), pending = new Map(); let sequence = 0;
    ws.addEventListener('error', reject, { once: true });
    ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (!message.id) return; const item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); });
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); },
      close() { ws.close(); }
    }));
  });
}
const root=fs.mkdtempSync('/private/tmp/pic-digital-e2e-');
const cfg={root,profile:path.join(root,'profile'),extension:path.join(root,'extension'),downloads:path.join(root,'downloads'),port:9225};
for(const dir of [cfg.profile,cfg.extension,cfg.downloads,path.join(cfg.profile,'Default')])fs.mkdirSync(dir,{recursive:true});
for(const file of ['core.js','page-core.js','site-api.js','content.js','background.js','store.js','order-downloads.js','popup.js','popup.html','entry.js','entry.html','merchant.js','styles.css','favicon.ico','logo.png'])fs.copyFileSync(path.join(repo,file),path.join(cfg.extension,file));
const manifest=JSON.parse(fs.readFileSync(path.join(repo,'manifest.json')));
manifest.host_permissions=['http://127.0.0.1/*'];
fs.writeFileSync(path.join(cfg.extension,'manifest.json'),JSON.stringify(manifest));
fs.writeFileSync(path.join(cfg.extension,'popup.js'),fs.readFileSync(path.join(repo,'popup.js'),'utf8').replace('https://service.chinaums.com/*','http://127.0.0.1/*'));
fs.writeFileSync(path.join(cfg.profile,'Default/Preferences'),JSON.stringify({download:{default_directory:cfg.downloads,prompt_for_download:false,directory_upgrade:true}}));
let account='original',business='digital',token='session-1',hold=true,merchantMode='supported';
const rows=[1,2,3,4].map(n=>({merOrderId:'O'+n,transRef:'R'+n,id:'O'+n,mchntId:'M',status:'S02'}));
const images=new Map(),events=[];
const digitalFields=[
{type:'img',key:'sn',desc:'（必填）手机系统SN码照',required:true},
{type:'img',key:'box',desc:'（必填）SN码和包装盒的二合一照',required:true},
{type:'img',key:'imei',desc:'系统IMEI码照片',required:false},
{type:'img',key:'invoice',desc:'（必填）发票图片',required:true},
{type:'img',key:'proof',desc:'证明材料图三',required:false}
];
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1');
 if(u.pathname==='/'){
  res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
  res.end('<div class="userInfo"><span class="loginName">'+account+'</span></div><div class="search-item"><label>交易日期*</label><input value="2026/10/01 ~ 2026/10/11"></div><div class="search-item"><label>订单状态</label><input class="el-input__inner" value=""></div><div class="el-table"><div class="el-table__header-wrapper"><table><thead><tr><th>订单号</th><th>参考号</th></tr></thead></table></div><div class="el-table__body-wrapper"><table><tbody>'+rows.map(r=>'<tr><td>'+r.merOrderId+'</td><td>'+r.transRef+'</td></tr>').join('')+'</tbody></table></div></div><div class="el-pagination"><div class="el-pagination__sizes"><select><option>4</option></select></div><div class="el-pager"><span class="active">1</span></div><span class="el-pagination__total">共 4 条</span></div><script>localStorage.setItem("userPortalVerifyToken",'+JSON.stringify(token)+');fetch("/uisportal/api/uis-tradein-server/portal/yjhx/v3/queryList",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({current:0,size:4})}).then(()=>window.fixtureReady=true)</script>');return;
 }
 if(u.pathname==='/uisportal/merInfoUser/businessCenter'){
  assert.equal(req.headers['x-requested-with'],'XMLHttpRequest');
  if(merchantMode==='error'){res.writeHead(500);res.end();return;}
  const number=merchantMode==='unsupported'?'898000000000001':business==='digital'?'89813014812B06R':'89813015722APT1';
  const field=(label,value)=>'<li><div class="leftTitle">'+label+':</div><div class="rightCont">'+value+'</div></li>';
  res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
  res.end(merchantMode==='login'?'<form>登录</form>':'<ul>'+field('商户编号',number)+field('商户名称','测试商户')+(merchantMode==='ambiguous'?field('商户编号',number):'')+'</ul>');return;
 }
 let body='';for await(const c of req)body+=c;const params=body?JSON.parse(body):{};
 const reply=data=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({success:true,data}));};
 events.push({path:u.pathname,id:params.uuid});
 if(u.pathname.endsWith('/queryList')){assert.equal(params.current,0);reply({list:rows,total:4});return;}
 if(u.pathname.endsWith('/queryDtl')){
  if(hold)await until(()=>!hold,'release details');
  const n=params.uuid.slice(1),product={sn:'R'+n+'-sn',invoice:n==='4'?'':'R'+n+'-invoice'};
  if(business==='digital'){product.box='R'+n+'-box';if(n==='1')product.imei='R1-imei';if(n==='2')product.proof='R2-proof';}
  reply({templateId:'T',productJson:product});return;
 }
 if(u.pathname.includes('/queryTemplateInfo/')){reply({productJson:[{its:business==='digital'?digitalFields:[{type:'img',key:'sn',desc:'SN码'},{type:'img',key:'invoice',desc:'发票'}]}]});return;}
 if(u.pathname.includes('/img/tradein/download/')){const name=decodeURIComponent(u.pathname.split('/').at(-1)),bytes=png(name);images.set(name,bytes);res.writeHead(200,{'Content-Type':'image/png'});res.end(bytes);return;}
 res.writeHead(404);res.end();
});
async function main(){
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const chrome=require('node:child_process').spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--user-data-dir='+cfg.profile,'--remote-debugging-port='+cfg.port,'--enable-unsafe-extension-debugging','--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
 let cdp, diagnostic;
 try{
  const version=await until(async()=>{try{return await(await fetch('http://127.0.0.1:'+cfg.port+'/json/version')).json();}catch{return null;}},'Chrome');
  cdp=await connect(version.webSocketDebuggerUrl);
  const {id}=await cdp.send('Extensions.loadUnpacked',{path:cfg.extension});
  const fixture='http://127.0.0.1:'+server.address().port+'/#/auditOfTrade2026';
  fs.writeFileSync(path.join(cfg.extension,'entry.js'),fs.readFileSync(path.join(repo,'entry.js'),'utf8').replaceAll('https://service.chinaums.com/*','http://127.0.0.1/*'));
  const {targetId}=await cdp.send('Target.createTarget',{url:fixture});
  const source=(await cdp.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;
  const evaluate=async(session,expression)=>{const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  await until(()=>evaluate(source,'Boolean(window.fixtureReady)'),'query');
  const open=async type=>{
   await cdp.send('Target.activateTarget',{targetId});
   const tab=(await cdp.send('Target.getTargets',{filter:[{type:'tab'}]})).targetInfos.find(t=>t.url===fixture);
   await cdp.send('Extensions.triggerAction',{id,targetId:tab.targetId});
   const entry=await until(async()=>(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/entry.html')),'entry popup');
   const session=(await cdp.send('Target.attachToTarget',{targetId:entry.targetId,flatten:true})).sessionId;
   await until(()=>evaluate(session,'document.querySelector("#merchant-number")?.textContent.length>0'),'merchant detection');
   assert.equal(await evaluate(session,'document.querySelector("#'+(type==='digital'?'digital':'entry')+'-card").hidden'),false);
   assert.equal(await evaluate(session,'document.querySelector("#'+(type==='digital'?'entry':'digital')+'-card").hidden'),true);
   assert.match(await evaluate(session,'document.querySelector("#merchant-number").textContent'),new RegExp(type==='digital'?'89813014812B06R':'89813015722APT1'));
   await evaluate(session,'document.querySelector('+JSON.stringify(type==='digital'?'#open-digital':'#open-task')+').click()');
   const task=await until(async()=>(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url.includes('/popup.html?')&&t.url.includes('business='+type)),'task page');
   const taskSession=(await cdp.send('Target.attachToTarget',{targetId:task.targetId,flatten:true})).sessionId;
   await until(()=>evaluate(taskSession,'typeof launch==="function"'),'task scripts');
   return taskSession;
  };
  const digital=await open('digital');
  const state=async(session,type)=>(await evaluate(session,'chrome.runtime.sendMessage({type:"PIC_EXPERT_TASK_STATE",business:'+JSON.stringify(type)+'})')).task;
  diagnostic=async()=>({task:await state(digital,'digital'),ui:await evaluate(digital,'({error:document.querySelector("#error").textContent,resumeDisabled:document.querySelector("#resume").disabled})')});
  await evaluate(digital,'document.querySelector("#start").click()');
  const first=await until(async()=>{const t=await state(digital,'digital');return t?.phase==='processing'?t:null;},'processing');
  await until(()=>evaluate(digital,'!document.querySelector("#pause").hidden'),'pause visible');
  await evaluate(digital,'document.querySelector("#pause").click()');
  await until(async()=> (await state(digital,'digital'))?.status==='pausing','pause requested');
  hold=false;
  const paused=await until(async()=>{const t=await state(digital,'digital');return t?.status==='paused'?t:null;},'pause');
  const before=(await evaluate(digital,'chrome.downloads.search({})')).filter(d=>d.filename.endsWith('.png'));
  assert.equal(paused.id,first.id);
  account='other';token='session-2';hold=true;
  await cdp.send('Page.reload',{},source);await until(()=>evaluate(source,'Boolean(window.fixtureReady)'),'changed login');
  await until(()=>evaluate(digital,'!document.querySelector("#resume").hidden&&!document.querySelector("#resume").disabled'),'resume ready');
  await evaluate(digital,'document.querySelector("#resume").click()');
  await until(async()=> (await state(digital,'digital'))?.status==='running','manual selection resume');
  await until(()=>evaluate(digital,'!document.querySelector("#pause").hidden'),'pause resumed task');
  await evaluate(digital,'document.querySelector("#pause").click()');
  await until(async()=> (await state(digital,'digital'))?.status==='pausing','second pause requested');
  hold=false;
  await until(async()=> (await state(digital,'digital'))?.status==='paused','second pause');
  business='appliance';const appliance=await open('appliance');
  await evaluate(appliance,'document.querySelector("#start").click()');
  const a=await until(async()=>{const t=await state(appliance,'appliance');return t?.status==='completed'?t:null;},'appliance complete');
  assert.equal(a.completed,3);assert.equal(a.skipped,1);
  assert.equal((await state(digital,'digital')).id,first.id);
  account='original';business='digital';token='session-3';
  await cdp.send('Page.reload',{},source);await until(()=>evaluate(source,'Boolean(window.fixtureReady)'),'original account');
  const lost=before.find(d=>d.filename.includes('/R1/'));
  assert.ok(lost);
  await evaluate(digital,'chrome.downloads.removeFile('+lost.id+')');
  await until(()=>evaluate(digital,'!document.querySelector("#resume").hidden&&!document.querySelector("#resume").disabled'),'resume ready');
  await evaluate(digital,'document.querySelector("#resume").click()');
  const done=await until(async()=>{const t=await state(digital,'digital');return t?.status==='completed'?t:null;},'digital complete');
  assert.ok(fs.existsSync(lost.filename));
  assert.equal(done.id,first.id);assert.deepEqual([done.completed,done.skipped,done.failed],[3,1,0]);
  const dir=path.join(cfg.downloads,'pic-expert',done.folderName);
  const expected=[['R1','手机系统SN码照','sn'],['R1','SN码和包装盒的二合一照','box'],['R1','系统IMEI码照片','imei'],['R1','发票图片','invoice'],['R2','手机系统SN码照','sn'],['R2','SN码和包装盒的二合一照','box'],['R2','发票图片','invoice'],['R2','证明材料图三','proof'],['R3','手机系统SN码照','sn'],['R3','SN码和包装盒的二合一照','box'],['R3','发票图片','invoice']];
  for(const [ref,name,kind] of expected)assert.ok(fs.readFileSync(path.join(dir,ref,name+'.png')).equals(images.get(ref+'-'+kind)),name);
  assert.equal(fs.existsSync(path.join(dir,'R4')),false);
  const csv=fs.readFileSync(path.join(dir,'下载清单.csv'),'utf8');assert.match(csv,/O4,R4,跳过,必填图片缺失：发票图片/);assert.equal(csv.split('\r\n').length,5);
  for(const item of before.filter(d=>!d.filename.includes('/R1/')))assert.equal((await evaluate(digital,'chrome.downloads.search({filenameRegex:'+JSON.stringify(item.filename.replace(/[.*+?^$()|[\]\\]/g,'\\$&'))+'})')).length,1);
  const previewId=(await cdp.send('Target.createTarget',{url:'chrome-extension://'+id+'/entry.html'})).targetId;
  const preview=(await cdp.send('Target.attachToTarget',{targetId:previewId,flatten:true})).sessionId;
  await until(()=>evaluate(preview,'document.querySelector("#merchant-number")?.textContent.length>0'),'merchant preview');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:360,height:520,deviceScaleFactor:1,mobile:false},preview);
  fs.writeFileSync('/private/tmp/pic-merchant-entry.png',Buffer.from((await cdp.send('Page.captureScreenshot',{},preview)).data,'base64'));
  for(const mode of ['unsupported','login','ambiguous','error']){
   merchantMode=mode;
   await cdp.send('Page.reload',{},preview);
   await until(()=>evaluate(preview,'document.querySelector("#entry-error")?.textContent.length>0'),'merchant '+mode);
   assert.equal(await evaluate(preview,'document.querySelector("#entry-card").hidden&&document.querySelector("#digital-card").hidden'),true);
  }
  await cdp.send('Target.closeTarget',{targetId:previewId});
  const result={outcome:'passed',browser:version.Browser,root,checks:['merchant name and number from live HTML','only matching entry visible','unsupported login ambiguous and HTTP failures hide entries','two actual entry buttons','digital template filenames and bytes','optional IMEI and proof','missing required invoice skip','pause and page reload','manual selection accepts changed login','separate business tasks','appliance rules','same-account new token resume','no duplicate completed images','missing-file recovery'],digitalImages:11,applianceImages:6,fixtureAdaptation:'localhost permission and source-tab URL pattern only'};
  fs.writeFileSync(path.join(__dirname,'e2e-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }catch(e){console.error(JSON.stringify(diagnostic?await diagnostic():{error:e.message},null,2));throw e;}finally{if(cdp){await cdp.send('Browser.close').catch(()=>{});cdp.close();}else chrome.kill();server.closeAllConnections();server.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
