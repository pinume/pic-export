(() => {
  // Order material rules per business: which template images to save, their file names and which are required.
  // select() reads a template and an order's product values; names() checks file names again before saving.
  const { cleanText, sanitizePathPart } = globalThis.PIC_EXPERT_CORE;
  const label = item => cleanText(item.desc || item.name).replace(/^[（(](?:必填|选填)[）)]\s*/, "");
  const missingReason = names => names.length ? ["必填图片缺失：" + names.join("、")] : [];

  const APPLIANCE_KINDS = Object.freeze(["SN图片", "发票"]);
  const applianceKind = item => {
    const text = label(item).replace(/\s+/g, "").replace(/[:：]$/, "");
    if (/^(?:S\/?N码(?:照片|图片)?|序列号(?:照片|图片)?)$/i.test(text)) return "SN图片";
    if (/^发票(?:照片|图片)?$/.test(text)) return "发票";
    return null;
  };
  const applianceFileKind = name => {
    if (APPLIANCE_KINDS.includes(name)) return name;
    const numbered = String(name).match(/^(SN图片|发票)-([1-9]\d*)$/);
    return numbered && Number.isSafeInteger(Number(numbered[2])) ? numbered[1] : null;
  };
  const appliance = Object.freeze({
    folder: "家电电脑",
    select(groups, product, toUrl) {
      const found = {}, fieldKinds = new Set();
      for (const item of groups.flatMap(group => Array.isArray(group?.its) ? group.its : [])) {
        if (item?.type !== "img") continue;
        const kind = applianceKind(item);
        if (!kind || !item.key) continue;
        fieldKinds.add(kind);
        const value = cleanText(product[item.key]);
        if (value) (found[kind] ||= new Set()).add(toUrl(value));
      }
      // A renamed site label must fail the order instead of reporting the image as missing.
      if (APPLIANCE_KINDS.some(kind => !fieldKinds.has(kind))) throw new Error("家电模板缺少SN图片或发票字段。");
      const files = Object.fromEntries(APPLIANCE_KINDS.flatMap(kind => {
        const urls = [...(found[kind] || [])];
        return urls.map((url, i) => [urls.length > 1 ? kind + "-" + (i + 1) : kind, url]);
      }));
      return { files, missing: missingReason(APPLIANCE_KINDS.filter(kind => !found[kind]?.size)) };
    },
    names(assets) {
      const names = Object.keys(assets || {}).sort((a, b) =>
        APPLIANCE_KINDS.indexOf(applianceFileKind(a)) - APPLIANCE_KINDS.indexOf(applianceFileKind(b)) ||
        Number(a.match(/-(\d+)$/)?.[1] || 0) - Number(b.match(/-(\d+)$/)?.[1] || 0));
      if (APPLIANCE_KINDS.some(kind => !names.some(name => applianceFileKind(name) === kind))) throw new Error("必须提供 SN图片和发票图片。");
      if (names.some(name => !applianceFileKind(name))) throw new Error("图片类型不受支持。");
      return names;
    }
  });

  const DIGITAL_NAMES = new Map([
    ["手机系统IMEI码照", "IMEI"], ["系统IMEI码照片", "IMEI"], ["SN码和包装盒的二合一照", "二合一照片"],
    ["产品系统和包装盒SN码的二合一照", "二合一照片"], ["发票图片", "发票"]
  ]);
  const digital = Object.freeze({
    folder: "数码",
    select(groups, product, toUrl) {
      if (Array.isArray(product) || groups.some(group => !Array.isArray(group?.its) || group.its.some(item => !item || typeof item.type !== "string"))) throw new Error("数码图片模板分组无法安全识别。");
      // Only the mapped image types are downloaded or checked; other template images are ignored.
      const fields = groups.flatMap(group => group.its).filter(item => item.type === "img" && DIGITAL_NAMES.has(label(item)));
      if (!fields.length || fields.some(item => !item.key || typeof item.required !== "boolean")) throw new Error("数码图片模板无法安全识别。");
      const names = fields.map(item => DIGITAL_NAMES.get(label(item)));
      // A renamed site label would otherwise drop the field silently and still report success.
      if (!names.includes("二合一照片") || !names.includes("发票")) throw new Error("数码模板缺少二合一照片或发票字段。");
      const keys = new Set(), numbers = {}, files = Object.create(null), missing = [];
      for (const [index, item] of fields.entries()) {
        if (keys.has(item.key)) throw new Error("数码图片字段身份或名称不唯一。");
        keys.add(item.key);
        const value = product[item.key];
        if (value != null && typeof value !== "string") throw new Error("数码图片字段格式无法识别。");
        let name = names[index];
        if (names.filter(n => n === name).length > 1) name += "-" + (numbers[name] = (numbers[name] || 0) + 1);
        if (!cleanText(value)) { if (item.required) missing.push(name); continue; }
        files[name] = toUrl(cleanText(value));
      }
      return { files, missing: missingReason(missing) };
    },
    names(assets) {
      const names = Object.keys(assets || {});
      if (!names.length || names.some(name => sanitizePathPart(name) !== name || name === "." || name === "..")) throw new Error("数码图片文件名无效。");
      return names;
    }
  });

  const api = Object.freeze({ appliance, digital });
  globalThis.PIC_EXPERT_MATERIALS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
