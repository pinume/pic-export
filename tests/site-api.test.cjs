const test = require("node:test");
const assert = require("node:assert/strict");
const pageCore = require("../page-core.js");
const fileCore = require("../core.js");
globalThis.PIC_EXPERT_PAGE_CORE = pageCore;
globalThis.PIC_EXPERT_CORE = fileCore;
const site = require("../site-api.js");

const field = (label, value = "") => ({
  querySelector: selector => selector === "label" ? { textContent: label } : selector === "input" ? { value } : null,
  querySelectorAll: selector => selector === ".el-tag__content" ? [] : []
});
const fixtureDocument = (values = {}) => {
  const fields = [field("提交日期", values.submitDate || ""), field("订单号", values.merOrderId || ""),
    field("交易日期*", values.dealDate ?? "2026/01/01 ~ 2026/01/31"), field("参考号", values.transRef || ""),
    { ...field("订单状态"), querySelector: selector => selector === "label" ? { textContent: "订单状态" } : selector === ".el-input__inner" ? { value: "" } : null,
      querySelectorAll: selector => selector === ".el-tag__content" ? (values.tags || []).map(textContent => ({ textContent })) : [] }];
  const rows = values.rows || [{ orderNo: "O1", referenceNo: "R1" }];
  const headers = ["订单号", "参考号"].map(textContent => ({ textContent }));
  const table = { querySelectorAll: selector => selector === ".el-table__header-wrapper thead th" ? headers :
    selector === ".el-table__body-wrapper tbody tr" ? rows.map(row => ({ querySelectorAll: query => query === "td" ?
      [{ textContent: row.orderNo }, { textContent: row.referenceNo }] : [] })) : [] };
  const pager = { querySelector: selector => selector === ".el-pager .active" ? { textContent: String(values.page || 1) } :
    selector === ".el-pagination__total" ? { textContent: "共 " + (values.total ?? rows.length) + " 条" } : null };
  return {
    defaultView: { performance: { getEntriesByType: () => [{ name: "https://portal.test/uisportal/api/uis-tradein-server/portal/yjhx/v3/queryList" }] } },
    querySelectorAll: selector => selector === ".search-item" ? fields : selector === ".el-table" ? [table] : selector === ".el-pagination" ? [pager] : [],
    querySelector: selector => selector.startsWith(".el-pagination__sizes") ? { value: values.pageSize || "10" } : selector === ".el-pagination" ? pager : null
  };
};
const response = data => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });

test("query context maps the current UI filters to the website query fields", () => {
  const context = site.context(fixtureDocument({ merOrderId: "ORDER-1", transRef: "REF-1" }), {
    hash: "#/auditOfTrade2026", href: "https://portal.test/app#/auditOfTrade2026"
  });
  assert.deepEqual(context.filters, {
    beginTransDate: "20260101", endTransDate: "20260131", status: []
  });
  assert.equal(context.size, 10);
  assert.equal(context.listSize, 10000);
  assert.deepEqual(context.visiblePage, { page: 1, total: 1, signature: "O1::R1" });
  assert.equal(context.hasOtherFilters, true);
});

test("trade dates are required and valid; unrelated filters never enter the API query", () => {
  const location = { hash: "#/auditOfTrade2026", href: "https://portal.test/app#/auditOfTrade2026" };
  for (const dealDate of ["", "2026/02/30 ~ 2026/03/01", "2026/02/01 ~ 2026/01/01"]) {
    assert.throws(() => site.context(fixtureDocument({ dealDate }), location), /交易日期/);
  }
  assert.deepEqual(site.context(fixtureDocument({ merOrderId: "O1", transRef: "R1", submitDate: "invalid", tags: ["审核通过"] }), location).filters,
    { beginTransDate: "20260101", endTransDate: "20260131", status: ["S02"] });
});

test("missing token and all known authentication responses retain the authentication flag", async () => {
  assert.throws(() => site.makeClient(null), error => error.auth === true);
  for (const reply of [
    { ok: false, status: 401 }, { ok: false, status: 403 },
    { ok: true, headers: { get: () => "text/html" } },
    { ok: true, json: async () => ({ success: false, message: "token已过期" }) }
  ]) {
    await assert.rejects(site.makeClient("old", async () => reply).list({}, 0, 10), error => error.auth === true);
  }
});

test("pagination size reads Element UI's displayed page-size value", () => {
  const context = site.context(fixtureDocument({ pageSize: "20条/页" }), {
    hash: "#/auditOfTrade2026", href: "https://portal.test/app#/auditOfTrade2026"
  });
  assert.equal(context.size, 20);
});

test("only a queried order-list route is a launch target", () => {
  const location = { hash: "#/auditOfTrade2026", href: "https://portal.test/app#/auditOfTrade2026" };
  assert.equal(site.isReady(fixtureDocument(), location), true);
  assert.equal(site.isReady(fixtureDocument(), { ...location, hash: "#/tradeInDetail2026" }), false);
  const doc = fixtureDocument();
  doc.defaultView.performance.getEntriesByType = () => [];
  assert.equal(site.isReady(doc, location), false);
});

test("selected status paths expand to the website status codes", () => {
  const context = site.context(fixtureDocument({ tags: ["待审核 / 待核销", "已通过 / 审核通过"] }), {
    hash: "#/auditOfTrade2026", href: "https://portal.test/app#/auditOfTrade2026"
  });
  assert.deepEqual(context.filters.status, ["20", "03", "S02"]);
});

test("query list uses the authenticated JSON POST contract and maps its page", async () => {
  const calls = [];
  const client = site.makeClient("secret", async (url, options) => {
    calls.push({ url, options });
    return response({ list: [{ id: "id-1", merOrderId: "O1", transRef: "R1" }], total: 1 });
  });
  const page = await client.list({ status: [], beginTransDate: "20260101", endTransDate: "20260131" }, 0, 10);
  assert.equal(page.total, 1);
  assert.equal(page.rows[0].id, "id-1");
  assert.equal(calls[0].url, "/uisportal/api/uis-tradein-server/portal/yjhx/v3/queryList");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.userPortalToken, "secret");
  assert.equal(calls[0].options.headers["X-Requested-With"], "XMLHttpRequest");
  assert.deepEqual(JSON.parse(calls[0].options.body), { status: [], beginTransDate: "20260101", endTransDate: "20260131", current: 0, size: 10 });
});

test("detail and template responses map labeled image fields to download URLs", async () => {
  const calls = [];
  const client = site.makeClient("secret", async (url, options) => {
    calls.push(url);
    if (url.endsWith("queryDtl")) return response({ templateId: "template-1", productJson: JSON.stringify({ snImage: "sn-id", invoiceImgId: "invoice-id", proofImage: "proof-id" }) });
    return response({ productJson: JSON.stringify([{ its: [
      { type: "img", key: "snImage", desc: "（必填）SN码照片" },
      { type: "img", key: "invoiceImgId", desc: "（必填）发票图片" },
      { type: "img", key: "proofImage", desc: "证明材料图三" }
    ] }]) });
  });
  const assets = await client.assets({ id: "row-id", mchntId: "merchant-id" }, "https://portal.test");
  assert.deepEqual(calls, [
    "/uisportal/api/uis-tradein-server/portal/yjhx/v3/queryDtl",
    "/uisportal/api/uis-tradein-server/portal/yjhx/v3/queryTemplateInfo/template-1"
  ]);
  assert.match(assets.files["SN码"], /img\/tradein\/download\/sn-id\?userPortalToken=secret/);
  assert.match(assets.files["发票"], /img\/tradein\/download\/invoice-id\?userPortalToken=secret/);
  assert.match(assets.files["证明材料图三"], /img\/tradein\/download\/proof-id\?userPortalToken=secret/);
  assert.deepEqual(assets.missing, []);
  assert.deepEqual(assets.notices, ["证明材料图一为空，跳过", "证明材料图二为空，跳过"]);
});

test("unknown status tags and rejected API requests fail closed", async () => {
  assert.throws(() => site.context(fixtureDocument({ tags: ["未知状态"] }), {
    hash: "#/auditOfTrade2026", href: "https://portal.test/app#/auditOfTrade2026"
  }), /无法安全识别/);
  const client = site.makeClient("secret", async () => ({ ok: true, status: 200, json: async () => ({ success: false, code: "999999" }) }));
  await assert.rejects(client.list({}, 0, 10), /拒绝了请求/);
});

test("multiple required image addresses are returned in template order with duplicate addresses removed", async () => {
  const client = site.makeClient("session", async url => {
    if (url.endsWith("queryDtl")) return response({ templateId: "T", productJson: { s1: "sn1", s2: "sn2", s3: "sn1", i1: "inv1", i2: "inv2" } });
    return response({ productJson: [{ its: [
      { type: "img", desc: "SN码", key: "s1" }, { type: "img", desc: "SN码照片", key: "s2" },
      { type: "img", desc: "SN码图片", key: "s3" }, { type: "img", desc: "发票", key: "i1" },
      { type: "img", desc: "发票图片", key: "i2" }
    ] }] });
  });
  const found = await client.assets({ id: "O1", mchntId: "merchant" }, "https://portal.test");
  assert.deepEqual([found.files["SN码-1"], found.files["SN码-2"]].map(url => new URL(url).pathname.split("/").at(-1)), ["sn1", "sn2"]);
  assert.deepEqual([found.files["发票-1"], found.files["发票-2"]].map(url => new URL(url).pathname.split("/").at(-1)), ["inv1", "inv2"]);
  assert.deepEqual(Object.keys(found.files), ["SN码-1", "SN码-2", "发票-1", "发票-2"]);
});
test('digital templates preserve distinct names, optional fields and required missing names', async () => {
  const fetcher=async url=>response(url.includes('queryDtl')?{templateId:'T',productJson:{img1:'sn',img2:'box',proof:'proof'}}:{productJson:[{its:[{type:'img',key:'img1',desc:'（必填）手机系统SN码照',required:true},{type:'img',key:'img2',desc:'（必填）SN码和包装盒的二合一照',required:true},{type:'img',key:'img3',desc:'系统IMEI码照片',required:false},{type:'img',key:'invoice',desc:'（必填）发票图片',required:true},{type:'img',key:'proof',desc:'证明材料图三',required:false}]}]});
  const result=await site.makeClient('session',fetcher).assets({mchntId:'M',id:'O'},'https://portal.test','digital');
  assert.deepEqual(Object.keys(result.files),['手机系统SN码照','SN码和包装盒的二合一照','证明材料图三']);
  assert.deepEqual(result.missing,['必填图片缺失：发票图片']);
  assert.deepEqual(result.notices, []);
});
test('digital unknown labels are saved safely and malformed values fail', async () => {
  for(const value of ['image', {url:'image'}]){
    const fetcher=async url=>response(url.includes('queryDtl')?{templateId:'T',productJson:{img:value}}:{productJson:[{its:[{type:'img',key:'img',desc:'新资料/照片',required:false}]}]});
    const read=site.makeClient('session',fetcher).assets({mchntId:'M',id:'O'},'https://portal.test','digital');
    if(typeof value==='string')assert.deepEqual(Object.keys((await read).files),['新资料_照片']);else await assert.rejects(read,/格式/);
  }
});
test('digital malformed groups fail and special names remain actual image fields', async () => {
  for(const groups of [[{its:[{type:'img',key:'a',desc:'__proto__',required:true}]}],[{its:[{type:'img',key:'a',desc:'照片',required:true}]},{its:{hiddenRequired:true}}]]){
    const fetcher=async url=>response(url.includes('queryDtl')?{templateId:'T',productJson:{a:'image'}}:{productJson:groups});
    const result=site.makeClient('session',fetcher).assets({mchntId:'M',id:'O'},'https://portal.test','digital');
    if(groups.length===1)assert.deepEqual(Object.keys((await result).files),['__proto__']);else await assert.rejects(result,/模板/);
  }
});

 test('appliance missing required images takes precedence over ambiguous proof', async () => {
  for (const missing of [true, false]) {
    const fetcher = async url => response(url.endsWith('queryDtl') ? { templateId: 'T', productJson: { sn: 'sn', invoice: missing ? '' : 'invoice', p1: 'proof1', p2: 'proof2' } } : { productJson: [{ its: [
      { type: 'img', key: 'sn', desc: 'SN码' }, { type: 'img', key: 'invoice', desc: '发票' },
      { type: 'img', key: 'p1', desc: '证明材料图一' }, { type: 'img', key: 'p2', desc: '证明材料图一' }
    ] }] });
    const read = site.makeClient('session', fetcher).assets({ id: 'O', mchntId: 'M' }, 'https://portal.test');
    if (missing) assert.deepEqual((await read).missing, ['SN码或发票图片缺失']);
    else await assert.rejects(read, /证明材料图一图片不唯一，已停止该订单下载。/);
  }
});
