(() => {
  const INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001F]/g;
  // Orders processed at once; the page and the background both enforce it. Live test: no gain above 5.
  const MAX_ORDERS = 5;
  const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

  const sanitizePathPart = (value, fallback = "unknown") => {
    const cleaned = cleanText(value).replace(INVALID_FILENAME, "_").replace(/[. ]+$/g, "").slice(0, 120);
    return cleaned || fallback;
  };

  const csvCell = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const buildManifestCsv = (rows) => {
    const headers = ["订单号", "参考号", "处理结果", "原因"];
    const lines = [headers, ...rows.map((row) => [
      row.orderNo,
      row.referenceNo,
      row.result,
      row.reason
    ])];
    return `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}`;
  };

  const makeTaskId = (date = new Date()) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${crypto.randomUUID()}`;
  };

  const api = Object.freeze({ cleanText, sanitizePathPart, buildManifestCsv, makeTaskId,
    MAX_ORDERS });
  globalThis.PIC_EXPERT_CORE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
