(() => {
  if (globalThis.__PIC_EXPERT_CONTENT_INSTALLED__) return;
  globalThis.__PIC_EXPERT_CONTENT_INSTALLED__ = true;
  const CORE = globalThis.PIC_EXPERT_PAGE_CORE;
  const FILES = globalThis.PIC_EXPERT_CORE;
  const SITE = globalThis.PIC_EXPERT_SITE_API;
  let running = false, stopped = false, activeTaskId = null;
  let requestController = null;
  const log = async (stage, message, level = "info") => {
    console[level === "error" ? "error" : "info"]?.("[Pic Expert] " + stage + "：" + message);
    if (activeTaskId) await chrome.runtime.sendMessage({ type: "PIC_EXPERT_LOG", taskId: activeTaskId, stage, message, level }).catch(() => {});
  };
  const checkedSend = async message => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      const error = new Error(response?.error || "后台任务无响应。");
      error.files = response?.files;
      throw error;
    }
    return response;
  };
  const pageContext = () => SITE.context(document, location);
  const taskFetch = async (url, options = {}) => {
    const signal = AbortSignal.any([requestController.signal, options.signal].filter(Boolean));
    try { return await fetch(url, { ...options, signal }); }
    catch (error) { if (signal.aborted) throw signal.reason; throw error; }
  };
  const getClient = () => SITE.makeClient(globalThis.localStorage?.getItem("userPortalVerifyToken"), taskFetch);
  const images = globalThis.PIC_EXPERT_IMAGE_READER.createImageReader({
    fetcher: (url, options) => fetch(url, options), decode: blob => createImageBitmap(blob),
    onRetry: () => log("读取重试", "图片网络读取失败，等待 1 秒后重试一次")
  });
  const identity = row => ({ orderNo: FILES.cleanText(row.merOrderId), referenceNo: FILES.cleanText(row.transRef) });
  const processRow = async (row, client, taskId, ensureActive, note, business) => {
    const id = identity(row);
    if (!id.orderNo || !id.referenceNo) return { row: { ...id, result: "失败", reason: "订单号或参考号缺失" } };
    const reason = message => [note, message].filter(Boolean).join("；");
    try {
      await log("读取详情", "订单 " + id.orderNo + "，参考号 " + id.referenceNo);
      const states = await client.assets(row, location.origin, business);
      ensureActive();
      if (states.missing.length) {
        return { row: { ...id, result: "跳过", reason: reason(states.missing.join("；")) } };
      }
      const assets = states.files;
      const kinds = Object.keys(assets);
      const prepared = Object.create(null);
      let cursor = 0;
      const readers = Array.from({ length: Math.min(2, kinds.length) }, async () => {
        while (cursor < kinds.length) {
          ensureActive();
          const kind = kinds[cursor++];
          await log("读取图片", kind + "：验证图片格式");
          try { prepared[kind] = await images.read(assets[kind], requestController.signal); }
          catch (error) {
            if (error.auth) { requestController.abort(error); throw error; }
            throw new Error(kind + "：" + error.message);
          }
        }
      });
      const results = await Promise.allSettled(readers);
      const failure = results.find(result => result.status === "rejected" && result.reason.auth) ||
        results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      // The background saves the images and records a failure itself if saving fails.
      return { row: { ...id, result: "成功", reason: note }, assets: prepared };
    } catch (error) {
      if (error.auth || error.fatal) { requestController.abort(error); throw error; }
      return { row: { ...id, result: "失败", reason: reason(error.message) } };
    }
  };
  const loadPage = async (client, context, page, total = null) => {
    const result = await client.list(context.filters, page, context.size);
    if (!Number.isInteger(result.total) || result.total < 0) throw new Error("接口返回的订单总数无效，已停止。");
    if (total !== null && result.total !== total) throw new Error("接口返回的查询总数发生变化，已停止。");
    const expected = Math.max(0, Math.min(context.size, result.total - page * context.size));
    if (result.rows.length !== expected) throw new Error("接口分页条数与查询总数不一致，已停止。");
    if (result.rows.some(row => !identity(row).orderNo || !identity(row).referenceNo)) throw new Error("订单列表缺少订单号或参考号，已停止。");
    return result;
  };
  // Throws when the login token or the page query differs from the start of the task; returns the current context.
  const queryGuard = initial => {
    const token = globalThis.localStorage?.getItem("userPortalVerifyToken");
    const query = JSON.stringify(initial.filters), visiblePage = JSON.stringify(initial.visiblePage);
    return size => {
      if (globalThis.localStorage?.getItem("userPortalVerifyToken") !== token) {
        const error = new Error("登录状态已变化，任务已终止。"); error.auth = true; throw error;
      }
      const current = pageContext();
      if (JSON.stringify(current.filters) !== query || current.url !== initial.url ||
        current.size !== initial.size || JSON.stringify(current.visiblePage) !== visiblePage) {
        const error = new Error("任务运行期间查询条件或页面发生变化。");
        error.fatal = true;
        throw error;
      }
      return { ...current, size };
    };
  };
  // Reads the complete order list through the site, checks it against the page and saves it in the background.
  // Throws before any order is processed when the list cannot be trusted.
  const readCompleteList = async (taskId, initial, unchanged) => {
    let listSize = initial.listSize || initial.size;
    const readAll = Boolean(initial.listSize);
    let context = { ...initial, size: listSize };
    const ensureActive = () => {
      requestController.signal.throwIfAborted();
      context = unchanged(listSize);
    };
    const client = getClient();
    await log("任务启动", "先通过网站接口读取完整订单列表");
    let displayedPage = await loadPage(client, readAll ? context : initial, readAll ? 0 : initial.visiblePage.page - 1);
    if (readAll && displayedPage.total > listSize) {
      listSize = displayedPage.total;
      context = unchanged(listSize);
      displayedPage = await loadPage(client, context, 0, displayedPage.total);
    }
    await checkedSend({ type: "PIC_EXPERT_LIST_BEGIN", taskId, size: listSize });
    const visibleStart = (initial.visiblePage.page - 1) * initial.size;
    const visibleRows = readAll ? displayedPage.rows.slice(visibleStart, visibleStart + initial.size) : displayedPage.rows;
    if (!context.hasOtherFilters && (displayedPage.total !== initial.visiblePage.total ||
      SITE.signature(visibleRows) !== initial.visiblePage.signature)) {
      throw new Error("接口结果与页面当前查询不一致，任务已终止；请重新查询后重新开始。");
    }
    const total = displayedPage.total;
    const pageCount = Math.max(1, Math.ceil(total / context.size));
    const seen = new Set();
    for (let page = 0; page < pageCount; page++) {
      ensureActive();
      const result = (readAll && page === 0) || (!readAll && context.size === initial.size && page === initial.visiblePage.page - 1)
        ? displayedPage : await loadPage(client, context, page, total);
      ensureActive();
      for (const row of result.rows) {
        const id = identity(row), key = id.orderNo + "::" + id.referenceNo;
        if (seen.has(key)) throw new Error("查询结果出现重复订单身份，任务已终止。");
        seen.add(key);
      }
      await checkedSend({ type: "PIC_EXPERT_LIST_PAGE", taskId, page: page + 1, total, rows: result.rows });
    }
    if (seen.size !== total) throw new Error("扫描条数与查询总条数不一致，任务已终止。");
    ensureActive();
    await checkedSend({ type: "PIC_EXPERT_LIST_COMPLETE", taskId });
    return { client, context, total, pageCount };
  };
  const run = async (taskId, task = { business: "appliance" }) => {
    running = true; stopped = false; activeTaskId = taskId;
    requestController = new AbortController();
    let visited = 0, failure = null, haltPromise;
    const halt = error => {
      if (!failure) {
        failure = requestController.signal.aborted ? requestController.signal.reason : error;
        requestController.abort(failure);
        haltPromise = checkedSend({ type: "PIC_EXPERT_TASK_HALT", taskId, error: failure.message }).catch(() => {});
      }
      return haltPromise;
    };
    try {
      const initial = pageContext(), unchanged = queryGuard(initial);
      const { client, total, pageCount, ...list } = await readCompleteList(taskId, initial, unchanged);
      let context = list.context;
      const ensureContextUnchanged = () => unchanged(context.size);
      const ensureActive = () => {
        requestController.signal.throwIfAborted();
        context = ensureContextUnchanged();
      };
      for (let page = 0; page < pageCount; page++) {
        ensureActive();
        const result = (await checkedSend({ type: "PIC_EXPERT_LIST_GET", taskId, page: page + 1 })).page;
        if (!result) throw new Error("已保存的订单列表缺失，请停止并开始新任务。");
        await checkedSend({ type: "PIC_EXPERT_PAGE_BEGIN", taskId, page: page + 1 });
        let cursor = 0;
        const workers = Array.from({ length: Math.min(FILES.MAX_ORDERS, result.rows.length) }, async () => {
          while (!stopped && !failure && cursor < result.rows.length) {
            const row = result.rows[cursor++], id = identity(row);
            try {
              ensureActive();
              visited += 1;
              if (visited > total) throw new Error("扫描条数超过原查询总条数。");
              const note = CORE.isMaterialModification([row.statusDesc, row.statusText].join(" ")) ? "材料修改" : "";
              if ((await checkedSend({ type: "PIC_EXPERT_ORDER_CLAIM", taskId, identity: id, note })).done) continue;
              const outcome = await processRow(row, client, taskId, ensureActive, note, task.business);
              ensureActive();
              await checkedSend({ type: "PIC_EXPERT_ORDER_SETTLE", taskId, note, ...outcome });
            } catch (error) {
              if (!stopped) await halt(error);
              return;
            }
          }
        });
        await Promise.allSettled(workers);
        if (failure) throw failure;
        ensureActive();
      }
      if (visited !== total) throw new Error("扫描条数与查询总条数不一致，已停止。");
      ensureContextUnchanged();
      await checkedSend({ type: "PIC_EXPERT_TASK_END", taskId, status: "completed" });
    } catch (error) {
      error = failure || (requestController.signal.aborted ? requestController.signal.reason : error);
      await log("任务中断", error.message, "error");
      await chrome.runtime.sendMessage({ type: "PIC_EXPERT_TASK_END", taskId, status: "failed", error: error.message }).catch(() => {});
    } finally { running = false; activeTaskId = null; requestController = null; }
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PIC_EXPERT_PROBE") {
      const ready = SITE.isReady(document, location);
      let tradeDateRange = null;
      if (ready) {
        try {
          const { filters } = pageContext();
          tradeDateRange = [filters.beginTransDate, filters.endTransDate];
        } catch {}
      }
      sendResponse({ ok: true, ready, running, tradeDateRange });
      return false;
    }
    if (message?.type === "PIC_EXPERT_STOP") {
      if (message.taskId && message.taskId !== activeTaskId) { sendResponse({ ok: true, running: false }); return false; }
      stopped = true; requestController?.abort(new Error("用户停止任务。"));
      sendResponse({ ok: true, running }); return false;
    }
    if (message?.type !== "PIC_EXPERT_START") return false;
    if (running) { sendResponse({ ok: false, error: "当前页面已有任务。" }); return false; }
    running = true; stopped = false;
    sendResponse({ ok: true });
    void run(message.taskId, message.task);
    return false;
  });
  if (typeof module !== "undefined" && module.exports) module.exports = { run };
})();
