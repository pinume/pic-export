const test = require("node:test");
const assert = require("node:assert/strict");
require("../core.js");
const { appliance, digital } = require("../materials.js");
// Template groups and order values go in; the identity function stands in for the site's image URL.
const select = (rules, its, product) => rules.select([{ its }], product, value => value);
const img = (key, desc, required) => ({ type: "img", key, desc, ...(required === undefined ? {} : { required }) });

test("appliance saves SN图片 and 发票, numbers distinct addresses in template order and removes duplicates", () => {
  const its = [img("s1", "SN码"), img("s2", "SN码照片"), img("s3", "SN码图片"), img("i1", "发票"), img("i2", "发票图片")];
  const result = select(appliance, its, { s1: "sn1", s2: "sn2", s3: "sn1", i1: "inv1", i2: "inv2" });
  assert.deepEqual(Object.entries(result.files), [["SN图片-1", "sn1"], ["SN图片-2", "sn2"], ["发票-1", "inv1"], ["发票-2", "inv2"]]);
  assert.deepEqual(select(appliance, [img("sn", "（必填）SN码照片"), img("inv", "（必填）发票图片：")], { sn: "a", inv: "b" }).files, { "SN图片": "a", "发票": "b" });
});
test("appliance ignores proof images, including repeated ones, and skips when SN图片 or 发票 is empty", () => {
  const its = [img("sn", "SN码"), img("invoice", "发票"), img("p1", "证明材料图一"), img("p2", "证明材料图一")];
  assert.deepEqual(Object.keys(select(appliance, its, { sn: "sn", invoice: "inv", p1: "x", p2: "y" }).files), ["SN图片", "发票"]);
  assert.deepEqual(select(appliance, its, { sn: "sn", invoice: "", p1: "x" }).missing, ["必填图片缺失：发票"]);
  assert.deepEqual(select(appliance, its, {}).missing, ["必填图片缺失：SN图片、发票"]);
});
test("appliance templates without an SN or invoice field fail instead of skipping", () => {
  for (const its of [[img("sn", "（必填）SN码照片")], [img("sn", "（必填）SN照片"), img("invoice", "（必填）发票图片")]]) {
    assert.throws(() => select(appliance, its, { sn: "sn", invoice: "inv" }), /家电模板缺少SN图片或发票字段/);
  }
});
test("appliance file names are ordered and limited to SN图片 and 发票", () => {
  assert.deepEqual(appliance.names({ "发票": 1, "SN图片-2": 1, "SN图片-1": 1 }), ["SN图片-1", "SN图片-2", "发票"]);
  assert.throws(() => appliance.names({ "SN图片": 1 }), /必须提供/);
  assert.throws(() => appliance.names({ "SN图片": 1, "发票": 1, "证明材料图一": 1 }), /不受支持/);
});

const phone = [img("img1", "（必填）手机系统SN码照", true), img("img2", "（必填）SN码和包装盒的二合一照", true),
  img("img3", "（必填）手机系统IMEI码照", true), img("img4", "证明材料图一", false), img("invoice", "（必填）发票图片", true)];
const product = [img("img1", "（必填）商品SN照片  ", true), img("img2", "（必填）产品系统和包装盒SN码的二合一照", true),
  img("img3", "系统IMEI码照片", false), img("invoice", "（必填）发票图片", true)];
test("digital saves only 二合一照片, IMEI and 发票 and checks only those required fields", () => {
  // SN is empty although required: it is not downloaded, so it does not skip the order.
  const result = select(digital, phone, { img2: "box", img3: "imei", img4: "proof", invoice: "inv" });
  assert.deepEqual([Object.entries(result.files), result.missing], [[["二合一照片", "box"], ["IMEI", "imei"], ["发票", "inv"]], []]);
  assert.deepEqual(select(digital, phone, { img1: "sn", img2: "box", img3: "imei" }).missing, ["必填图片缺失：发票"]);
  assert.deepEqual(Object.keys(select(digital, product, { img1: "sn", img2: "box", img3: "imei", invoice: "inv" }).files), ["二合一照片", "IMEI", "发票"]);
  const optionalEmpty = select(digital, product, { img1: "sn", img2: "box", invoice: "inv" });
  assert.deepEqual([Object.keys(optionalEmpty.files), optionalEmpty.missing], [["二合一照片", "发票"], []]);
});
test("digital templates without the selected images, renamed labels, malformed values and malformed groups fail", () => {
  const box = img("box", "（必填）SN码和包装盒的二合一照", true);
  assert.throws(() => select(digital, [img("a", "新资料/照片", true)], { a: "x" }), /模板/);
  assert.throws(() => select(digital, [box, img("a", "（必填）发票图片", true)], { box: "box", a: { url: "x" } }), /格式/);
  // A renamed invoice label must fail the order instead of downloading it without an invoice.
  assert.throws(() => select(digital, [box, img("a", "（必填）发票照片", true)], { box: "box", a: "inv" }), /缺少二合一照片或发票字段/);
  assert.throws(() => select(digital, [img("a", "（必填）发票图片", true)], { a: "inv" }), /缺少二合一照片或发票字段/);
  assert.throws(() => digital.select([{ its: [box, img("a", "发票图片", true)] }, { its: { hiddenRequired: true } }], { box: "b", a: "x" }, v => v), /模板/);
});
test("digital labels mapped to the same name are numbered in template order", () => {
  const its = [img("a", "（必填）手机系统IMEI码照", true), img("b", "系统IMEI码照片", false), img("box", "（必填）SN码和包装盒的二合一照", true), img("inv", "（必填）发票图片", true)];
  assert.deepEqual(Object.entries(select(digital, its, { a: "imei-a", b: "imei-b", box: "box", inv: "inv" }).files),
    [["IMEI-1", "imei-a"], ["IMEI-2", "imei-b"], ["二合一照片", "box"], ["发票", "inv"]]);
});
test("digital file names must be safe path parts", () => {
  assert.deepEqual(digital.names({ "二合一照片": 1, "发票": 1 }), ["二合一照片", "发票"]);
  for (const assets of [{}, { "a/b": 1 }, { "..": 1 }]) assert.throws(() => digital.names(assets), /文件名无效/);
});
test("each business saves into its own folder", () => {
  assert.deepEqual([appliance.folder, digital.folder], ["家电电脑", "数码"]);
});
