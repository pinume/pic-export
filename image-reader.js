// Reads one order image into savable data: network retry, response checks, format, full decode and conversion.
(() => {
  const RETRY_STATUSES = [429, 500, 502, 503, 504];
  const RETRY_ERRORS = ["TypeError", "TimeoutError", "AbortError"];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const isHtml = response => Boolean(response.headers?.get("content-type")?.includes("text/html"));
  const authError = message => Object.assign(new Error(message), { auth: true });
  // The format comes from the file content; response headers are not trusted.
  const imageFormat = bytes => {
    const b = Array.from(bytes);
    const starts = (...prefix) => prefix.every((v, i) => b[i] === v);
    if (starts(0xff, 0xd8, 0xff)) return { mime: "image/jpeg", extension: ".jpg" };
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: "image/png", extension: ".png" };
    const ascii = String.fromCharCode(...b);
    if (/^GIF8[79]a/.test(ascii)) return { mime: "image/gif", extension: ".gif" };
    if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return { mime: "image/webp", extension: ".webp" };
    if (starts(0x42, 0x4d)) return { mime: "image/bmp", extension: ".bmp" };
    throw new Error("图片内容无法识别，已跳过以避免保存错误文件。");
  };
  const base64 = bytes => {
    let text = "";
    // Chunks keep each fromCharCode call under the engine's argument limit.
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const createImageReader = ({ fetcher, decode, onRetry }) => {
    // One attempt covers the request and the body read; returns the last response and, when it is usable, its body.
    const download = async (url, signal) => {
      let response, blob;
      for (let attempt = 1; ; attempt++) {
        signal.throwIfAborted();
        try {
          response = await fetcher(url, { credentials: "same-origin", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
          blob = response.ok && !isHtml(response) ? await response.blob() : null;
          if (response.ok || !RETRY_STATUSES.includes(response.status) || attempt === 2) return { response, blob };
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          if (attempt === 2 || !RETRY_ERRORS.includes(error.name)) throw error;
        }
        await onRetry();
        await sleep(1000);
      }
    };
    const read = async (url, signal) => {
      const { response, blob } = await download(url, signal);
      if ([401, 403].includes(response.status)) throw authError("登录状态已失效，任务已终止；请重新登录后重新开始。");
      if (!response.ok) throw new Error("图片读取失败：" + response.status);
      if (isHtml(response)) throw authError("图片接口返回了登录页面，任务已终止；请重新登录后重新开始。");
      const header = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      signal.throwIfAborted();
      const format = imageFormat(header);
      // The header check accepts truncated files; only a full decode proves the saved image opens.
      const bitmap = await decode(blob).catch(() => {
        signal.throwIfAborted();
        throw new Error("图片内容不完整或已损坏。");
      });
      bitmap.close();
      signal.throwIfAborted();
      const data = "data:" + format.mime + ";base64," + base64(new Uint8Array(await blob.arrayBuffer()));
      signal.throwIfAborted();
      return { url: data, extension: format.extension };
    };
    return { read };
  };
  globalThis.PIC_EXPERT_IMAGE_READER = { createImageReader };
  if (typeof module !== "undefined" && module.exports) module.exports = { createImageReader };
})();
