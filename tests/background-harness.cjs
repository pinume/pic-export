const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../core.js");
require("fake-indexeddb/auto");
const { TaskStore } = require("../store.js");
let sequence = 0;
const sender = { tab: { id: 7 }, frameId: 4 };
const assets = { "SN图片": { extension: ".jpg", url: "data:image/jpeg;base64,/9j/" },
  "发票": { extension: ".png", url: "data:image/png;base64,iVBORw==" } };
function harness(options = {}, initial = null) {
  // Legacy initial tasks enter through chrome.storage, exactly as TaskStore migrates them in the extension.
  let listener, removedListener, updatedListener, stored = initial;
  const storage = {
    get: async () => ({ picExpertTask: structuredClone(stored) }),
    set: async value => { stored = structuredClone(value.picExpertTask); }
  };
  const store = options.store || new TaskStore(storage, "background-" + process.pid + "-" + sequence++);
  const calls = [], removed = [], items = options.items || new Map(
    Object.values(initial?.downloads || {}).flatMap(pair => Object.values(pair.files).map(file =>
      [file.downloadId, { id: file.downloadId, state: "complete", exists: true }]))
  );
  const handlers = new Set();
  const notify = (id, state) => {
    items.get(id).state = state;
    for (const handler of handlers) handler({id,state:{current:state}});
  };
  const chrome = {
    storage: { local: storage },
    runtime: { getURL: file => "chrome-extension://test-extension/" + file, onMessage: { addListener: f => { listener = f; } } },
    tabs: { onUpdated: { addListener: fn => { updatedListener = fn; } }, onRemoved: { addListener: fn => { removedListener = fn; } },
      sendMessage: async (_tab, message) => options.pageMessage ? options.pageMessage(message) : ({ ok: true, running: Boolean(options.livePage) }) },
    downloads: {
      onChanged: {addListener:handler=>handlers.add(handler),removeListener:handler=>handlers.delete(handler)},
      download: async args => {
        const id = Math.max(0, ...items.keys()) + 1;
        calls.push(args);
        const failed = (options.failInvoice && args.filename.includes("发票") && (options.failInvoice === true || args.filename.includes("/" + options.failInvoice + "/"))) ||
          (options.failFilename && args.filename.endsWith(options.failFilename)) ||
          (options.failProof && args.filename.includes(options.failProof)) ||
          (options.failManifest && args.filename.endsWith(".csv"));
        items.set(id, { id, filename: args.filename, state: failed ? "interrupted" : options.holdPair && !args.filename.endsWith(".csv") ? "in_progress" : "complete", exists: !failed, error: failed ? "NETWORK_FAILED" : undefined });
        return id;
      },
      search: async ({ id }) => items.has(id) ? [items.get(id)] : [],
      cancel: async id => {
        if (options.failCancel) throw new Error("cancel_failed");
        if (items.get(id)?.state === "in_progress") {
          notify(id,"interrupted"); items.get(id).exists = false;
        }
      },
      removeFile: async id => {
        const item = items.get(id);
        if (!item) throw new Error("Invalid downloadId");
        if (item.state !== "complete") throw new Error("Download must be complete");
        if (item.exists === false) throw new Error("Download file already deleted");
        if ((options.failRemove && id === 1) || options.failRemoveId === id) throw new Error("file_locked");
        removed.push(id); item.exists = false;
      }
    }
  };
  const sandbox = vm.createContext({
    chrome, PIC_EXPERT_CORE: core, PIC_EXPERT_STORE: store, setTimeout, clearTimeout, Date, Map,
    importScripts(...files) {
      for (const file of files) {
        if (["core.js", "store.js"].includes(file)) continue; // Supplied above.
        vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), sandbox);
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), sandbox);
  const send = (message, source = sender) => new Promise(resolve => listener(message, source, resolve));
  const begin = (tradeDateRange = ["20261001", "20261004"]) => send({ type: "PIC_EXPERT_TASK_BEGIN", tabId: 7, frameId: 4, tradeDateRange }, {});
  // Settles order O1/R1 as a success with the default images; the response row says whether saving worked.
  const pair = (taskId, extra = {}, source) => send({ type: "PIC_EXPERT_ORDER_SETTLE", taskId, note: "",
    row: { orderNo: "O1", referenceNo: "R1", result: "成功", reason: "" }, assets, ...extra }, source);
  return { send, begin, pair, calls, removed, items, store, notify, handlers, removeTab: id => removedListener(id), reloadTab: id => updatedListener(id, { status: "loading" }), task: async () => {
    // The active task with its rows, pairs and latest logs, read back through the store's own interface.
    const task = await store.getTask();
    return task && { ...task, manifestRows: await store.rows(task.id),
      downloads: Object.fromEntries((await store.pairs(task.id)).map(pair => [pair.referenceNo, pair])), logs: await store.logs(task.id, 500) };
  } };
}
module.exports = { harness, assets };
