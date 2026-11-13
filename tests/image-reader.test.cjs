const test = require("node:test");
const assert = require("node:assert/strict");
const { createImageReader } = require("../image-reader.js");
// A complete 1x1 PNG. Node cannot decode it; the decode adapter below only drives the reader's control flow.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const reply = (bytes, { status = 200, type = "image/jpeg", body } = {}) => ({
  ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": type }),
  blob: body || (async () => new Blob([bytes]))
});
// Builds a reader whose fetcher answers from `responses` in order and records every call.
const fixture = (responses, decode) => {
  let closed = 0;
  decode ||= async () => ({ close() { closed++; } });
  const calls = [], retries = [];
  const reader = createImageReader({
    fetcher: async (url, options) => {
      calls.push(options);
      const next = responses[calls.length - 1];
      return typeof next === "function" ? next(options) : next;
    },
    decode: async blob => { calls.decoded = (calls.decoded || 0) + 1; return decode(blob); },
    onRetry: async () => { retries.push(Date.now()); }
  });
  return { reader, calls, retries, closed: () => closed };
};
const live = () => new AbortController().signal;

test("a complete image is read by its content, not its declared type, and its bitmap is released", async () => {
  const f = fixture([reply(PNG, { type: "image/jpeg" })]);
  const result = await f.reader.read("https://portal.test/a", live());
  assert.deepEqual(result, { url: "data:image/png;base64," + PNG.toString("base64"), extension: ".png" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].credentials, "same-origin");
  assert.equal(f.closed(), 1);
});
test("every supported format is recognized from its first bytes", async () => {
  const samples = [[[0xff, 0xd8, 0xff, 0xe0], ".jpg"], [[...PNG.subarray(0, 8)], ".png"], [[..."GIF89a"].map(c => c.charCodeAt(0)), ".gif"],
    [[..."RIFF\0\0\0\0WEBP"].map(c => c.charCodeAt(0)), ".webp"], [[0x42, 0x4d, 0, 0], ".bmp"]];
  for (const [bytes, extension] of samples) {
    assert.equal((await fixture([reply(new Uint8Array(bytes))]).reader.read("u", live())).extension, extension);
  }
});
test("a network break while reading the body is retried once after the retry callback", async () => {
  const broken = reply(PNG, { body: async () => { throw new TypeError("network error"); } });
  const f = fixture([broken, reply(PNG)]);
  const started = Date.now();
  assert.equal((await f.reader.read("u", live())).extension, ".png");
  assert.equal(f.calls.length, 2);
  assert.equal(f.retries.length, 1);
  assert.ok(Date.now() - started >= 950);
});
test("retries are exhausted after two attempts for network errors and retryable statuses", async () => {
  const broken = reply(PNG, { body: async () => { throw new TypeError("network error"); } });
  const network = fixture([broken, broken]);
  await assert.rejects(network.reader.read("u", live()), /network error/);
  assert.equal(network.calls.length, 2);
  const busy = fixture([reply(PNG, { status: 503 }), reply(PNG, { status: 503 })]);
  await assert.rejects(busy.reader.read("u", live()), /图片读取失败：503/);
  assert.equal(busy.calls.length, 2);
});
test("expired login and a login page are authentication errors that are never retried", async () => {
  for (const response of [reply(PNG, { status: 401 }), reply(PNG, { status: 403 }), reply(Buffer.from("<html>"), { type: "text/html; charset=utf-8" })]) {
    const f = fixture([response]);
    await assert.rejects(f.reader.read("u", live()), error => error.auth === true && /登录/.test(error.message));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls.decoded, undefined);
  }
});
test("unknown content and failed decoding are not retried and not authentication errors", async () => {
  const unknown = fixture([reply(Buffer.from("<svg/>"), { type: "image/png" })]);
  await assert.rejects(unknown.reader.read("u", live()), error => !error.auth && /无法识别/.test(error.message));
  assert.equal(unknown.calls.decoded, undefined);
  const truncated = fixture([reply(new Uint8Array([0xff, 0xd8, 0xff]))], async () => { throw new Error("decode failed"); });
  await assert.rejects(truncated.reader.read("u", live()), error => !error.auth && /图片内容不完整或已损坏/.test(error.message));
  assert.equal(truncated.calls.length, 1);
});
test("cancellation keeps its reason and never starts another request or returns a result", async () => {
  const reason = new Error("用户停止任务。");
  const before = new AbortController(); before.abort(reason);
  const idle = fixture([reply(PNG)]);
  await assert.rejects(idle.reader.read("u", before.signal), error => error === reason);
  assert.equal(idle.calls.length, 0);

  const waiting = new AbortController();
  const retry = fixture([reply(PNG, { status: 503 }), reply(PNG)]);
  const pending = retry.reader.read("u", waiting.signal);
  setTimeout(() => waiting.abort(reason), 100);
  await assert.rejects(pending, error => error === reason);
  assert.equal(retry.calls.length, 1);

  const inFlight = new AbortController();
  const request = fixture([options => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))]);
  const reading = request.reader.read("u", inFlight.signal);
  setTimeout(() => inFlight.abort(reason), 10);
  await assert.rejects(reading, error => error === reason);
  assert.equal(request.calls.length, 1);

  const header = new AbortController();
  const headerRead = fixture([reply(null, { body: async () => ({ slice: () => ({ arrayBuffer: async () => {
    header.abort(reason);
    return new TextEncoder().encode("<html>").buffer;
  } }) }) })]);
  await assert.rejects(headerRead.reader.read("u", header.signal), error => error === reason);
  assert.equal(headerRead.calls.decoded, undefined);

  for (const fails of [false, true]) {
    const decoding = new AbortController();
    const late = fixture([reply(PNG)], async () => { decoding.abort(reason); if (fails) throw new Error("decode failed"); return { close() {} }; });
    await assert.rejects(late.reader.read("u", decoding.signal), error => error === reason);
  }
});
