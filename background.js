importScripts("core.js", "materials.js", "store.js", "order-downloads.js");
const { buildManifestCsv, makeTaskId } = globalThis.PIC_EXPERT_CORE;
const db = globalThis.PIC_EXPERT_STORE;
const MATERIALS = globalThis.PIC_EXPERT_MATERIALS, BUSINESSES = Object.keys(MATERIALS);
const endings = new Map(), manifestExports = new Map();
let stateQueue = Promise.resolve();
const getTask = id => db.getTask(id);
const businessOf = message => {
  const business = message.business || "appliance";
  if (!BUSINESSES.includes(business)) throw new Error("导出功能无效。");
  return business;
};
const selectedTask = message => db.getBusinessTask(businessOf(message));
const assertIdle = async () => {
  for (const business of BUSINESSES) {
    const task = await db.getBusinessTask(business);
    if (["running", "stopping", "finalizing"].includes(task?.status)) throw new Error("已有任务运行；请先停止。");
  }
};
const isTaskPage = sender => sender.url?.split("?")[0] === chrome.runtime.getURL("popup.html");
const mutate = operation => {
  const promise = stateQueue.then(operation);
  stateQueue = promise.catch(() => {});
  return promise;
};
const assertTask = (task, id, sender, running = true) => {
  if (!task || task.id !== id || (running && task.status !== "running")) throw new Error("任务身份已失效。");
  if (sender.tab && !isTaskPage(sender) && (sender.tab.id !== task.tabId || sender.frameId !== task.frameId)) throw new Error("消息来自其他页面或 frame。");
};
const appendLog = (changes, stage, message, level = "info") => {
  changes.logs.push({ time: new Date().toISOString(), level: level === "error" ? "error" : "info",
    stage: String(stage || "任务").slice(0, 80), message: String(message || "").slice(0, 500) });
};
const update = (id, sender, operation, running = true) => mutate(async () => {
  const task = await getTask(id);
  assertTask(task, id, sender, running);
  if ((await db.getBusinessTask(task.business || "appliance"))?.id !== id) throw new Error("任务已被新任务替换。");
  const changes = { rows: [], pairs: [], logs: [], pages: [] };
  await operation(task, changes);
  await db.save(task, changes);
  return task;
});
const summary = async task => task ? { ...task, logs: await db.logs(task.id, 500) } : null;
const taskDirectory = task => task.folderName || task.id;
const waitForDownload = async (id, timeoutMs = 120000, taskId = null) => {
  if (!Number.isInteger(id)) throw new Error("Chrome 未返回有效下载编号。");
  const deadline = Date.now() + timeoutMs;
  // Install before search; a completion event cannot fall between the two.
  let wake;
  const changed = delta => { if (delta.id === id) wake?.(); };
  chrome.downloads.onChanged?.addListener(changed);
  try {
    while (Date.now() < deadline) {
      if (taskId) assertTask(await getTask(taskId), taskId, {}, true);
      const [item] = await chrome.downloads.search({ id });
      if (!item) throw new Error("下载记录丢失。");
      if (item.state === "complete") return item;
      if (item.state === "interrupted") throw new Error(item.error || "download_interrupted");
      await new Promise(resolve => {
        const timer = setTimeout(resolve, Math.min(1000, deadline - Date.now()));
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = null;
    }
    throw new Error("download_timeout");
  } finally { chrome.downloads.onChanged?.removeListener(changed); }
};
const orders = globalThis.PIC_EXPERT_ORDER_DOWNLOADS({
  db, downloads: chrome.downloads, getTask, update, assertTask, appendLog, waitForDownload
});
const startTask = message => mutate(async () => {
  const business = businessOf(message);
  await assertIdle();
  if (!Number.isInteger(message.tabId) || !Number.isInteger(message.frameId)) throw new Error("目标页面不完整。");
  const range = message.tradeDateRange;
  if (!Array.isArray(range) || range.length !== 2 || range.some(value => typeof value !== "string" || !/^\d{8}$/.test(value))) throw new Error("无法识别本次查询的交易日期区间。");
  const id = makeTaskId();
  const task = { id, business, folderName: MATERIALS[business].folder + "/" + range[0] + "-" + range[1] + "_" + id, status: "running", tabId: message.tabId, frameId: message.frameId,
    startedAt: new Date().toISOString(), page: 1,
    scanned: 0, completed: 0, skipped: 0, failed: 0, currentRows: [], phase: "listing", listed: 0 };
  const changes = { logs: [] };
  appendLog(changes, "创建任务", "任务 " + task.id + "，frame " + task.frameId);
  await db.save(task, changes);
  // Cleanup must not fail the new task; whatever is left is removed when the next task starts.
  await db.prune().catch(error => console.error("旧任务清理失败：", error));
  return task;
});
const exportManifest = (taskId, sender, retry = false) => {
  if (manifestExports.has(taskId)) return manifestExports.get(taskId);
  const promise = (async () => {
  let task = await getTask(taskId); assertTask(task, taskId, sender, false);
  if (task.manifestDownloadId !== undefined && !retry) {
    try { await waitForDownload(task.manifestDownloadId); return await update(taskId, sender, t => { t.manifestError = ""; }, false); }
    catch (error) { return update(taskId, sender, (t, c) => { t.manifestError = "清单下载失败：" + error.message; appendLog(c, "下载清单", t.manifestError, "error"); }, false); }
  }
  const filename = "pic-expert/" + taskDirectory(task) + "/下载清单.csv";
  try {
    const downloadId = await chrome.downloads.download({ url: "data:text/csv;charset=utf-8," + encodeURIComponent(buildManifestCsv(await db.rows(taskId))), filename, saveAs: false, conflictAction: "overwrite" });
    await update(taskId, sender, t => { t.manifestDownloadId = downloadId; }, false);
    await waitForDownload(downloadId);
    return update(taskId, sender, (t, c) => { t.manifestError = ""; appendLog(c, "下载清单", "清单已下载：" + filename); }, false);
  } catch (error) {
    return update(taskId, sender, (t, c) => { t.manifestError = "清单下载失败：" + error.message; appendLog(c, "下载清单", t.manifestError, "error"); }, false);
  }
  })().finally(() => manifestExports.delete(taskId));
  manifestExports.set(taskId, promise);
  return promise;
};
const finalizeTask = (message, sender) => {
  const { taskId } = message;
  if (endings.has(taskId)) return endings.get(taskId);
  const promise = (async () => {
    let task = await update(taskId, sender, (t, c) => {
      if (t.finishedAt) return;
      t.status = "finalizing"; t.finalStatus = message.status === "completed" ? "completed" : "failed";
      t.error = message.error || t.error || "";
      appendLog(c, "结束任务", t.finalStatus + (t.error ? "：" + t.error : ""), t.finalStatus === "failed" ? "error" : "info");
    }, false);
    if (!task.finishedAt) {
      await orders.reconcile(taskId, sender);
      task = await update(taskId, sender, (t, c) => {
        t.finishedAt = new Date().toISOString();
        const durationMs = Math.max(0, Date.now() - (Date.parse(t.startedAt) || Date.now()));
        appendLog(c, "处理汇总", "已处理 " + t.scanned + "/" + (t.total ?? "未知") + "，成功 " + t.completed + "，跳过 " + t.skipped + "，失败 " + t.failed + "，历时 " + Math.round(durationMs / 1000) + " 秒");
      }, false);
    }
    await exportManifest(taskId, sender);
    return update(taskId, sender, t => { if (t.finalStatus) { t.status = t.finalStatus; delete t.finalStatus; } }, false);
  })().finally(() => endings.delete(taskId));
  endings.set(taskId, promise);
  return promise;
};
// Manual stops and source interruptions end the same way. After a manual stop a live page reports its own end;
// a refreshed or closed source may acknowledge the stop and then vanish, so the background finishes it at once.
const stopTask = async (task, sender, error, waitForPage = true) => {
  task = await update(task.id, sender, t => { t.status = "stopping"; t.finalStatus = "failed"; t.error ||= error; }, false);
  const response = await chrome.tabs.sendMessage(task.tabId, { type: "PIC_EXPERT_STOP", taskId: task.id }, { frameId: task.frameId }).catch(() => null);
  if (waitForPage && response?.running) return getTask(task.id);
  return finalizeTask({ taskId: task.id, status: "failed", error: task.error }, sender);
};
const sourceInterrupted = async (tabId, reason) => {
  for (const business of BUSINESSES) {
    const task = await db.getBusinessTask(business);
    // A halted or stopped page has not ended its task yet; the closed source can no longer do so.
    if (task?.tabId === tabId && ["running", "stopping"].includes(task.status)) await stopTask(task, {}, reason, false);
  }
};
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") sourceInterrupted(tabId, "来源网页已刷新或跳转，任务已终止。").catch(error => console.error("中断终止失败：", error));
});
chrome.tabs.onRemoved.addListener(tabId => {
  sourceInterrupted(tabId, "来源网站标签页已关闭，任务已终止。").catch(error => console.error("中断终止失败：", error));
});
// Pause and resume no longer exist; a task paused by an earlier version becomes stopped and keeps its results and logs.
const retired = (async () => {
  for (const business of BUSINESSES) {
    const task = await db.getBusinessTask(business);
    if (!["pausing", "paused"].includes(task?.status)) continue;
    await orders.reconcile(task.id, {});
    await update(task.id, {}, (t, c) => {
      t.status = "failed"; t.finishedAt ||= new Date().toISOString(); delete t.forcePause;
      appendLog(c, "停止任务", "暂停功能已移除，旧的暂停任务转为已停止");
    }, false);
  }
})().catch(error => console.error("旧暂停任务转换失败：", error));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await retired;
    switch (message?.type) {
      case "PIC_EXPERT_TASK_BEGIN": return { ok: true, task: await startTask(message) };
      case "PIC_EXPERT_LIST_BEGIN":
        return { ok: true, task: await update(message.taskId, sender, t => {
          if (t.currentRows.length) throw new Error("仍有订单未完成，不能读取列表。");
          if (!Number.isInteger(message.size) || message.size < 1) throw new Error("分页大小无效。");
          t.phase = "listing"; t.listed = 0; t.total = null; t.size = message.size;
        }) };
      case "PIC_EXPERT_LIST_PAGE":
        return { ok: true, task: await update(message.taskId, sender, (t, c) => {
          if (t.phase !== "listing" || message.page !== Math.floor(t.listed / t.size) + 1) throw new Error("列表页顺序无效。");
          if (!Number.isInteger(message.total) || message.total < 0 || !Array.isArray(message.rows) ||
            message.rows.length !== Math.max(0, Math.min(t.size, message.total - t.listed)) ||
            (t.total !== null && t.total !== message.total)) throw new Error("订单列表条数与查询总数不一致。");
          t.total = message.total;
          t.page = message.page;
          t.listed += message.rows.length;
          c.pages.push({ page: message.page, rows: message.rows });
          appendLog(c, "读取列表", t.listed === t.total && message.page === 1 ? "已读取完整订单列表 " + t.listed + "/" + t.total : "第 " + message.page + " 页，已读取 " + t.listed + "/" + t.total);
        }) };
      case "PIC_EXPERT_LIST_COMPLETE":
        return { ok: true, task: await update(message.taskId, sender, (t, c) => {
          if (t.phase !== "listing" || t.listed !== t.total) throw new Error("订单列表未读取完整。");
          t.phase = "processing";
          appendLog(c, "列表完成", "已读取全部 " + t.total + " 笔订单，开始处理资料");
        }) };
      case "PIC_EXPERT_LIST_GET": {
        assertTask(await getTask(message.taskId), message.taskId, sender);
        return { ok: true, page: await db.getPage(message.taskId, message.page) };
      }
      case "PIC_EXPERT_PAGE_BEGIN":
        return { ok: true, task: await update(message.taskId, sender, t => {
          if (t.currentRows?.length) throw new Error("当前页仍有订单正在处理，不能切换处理页。");
          if (!Number.isInteger(message.page) || message.page < 1) throw new Error("处理页无效。");
          t.page = message.page;
        }) };
      case "PIC_EXPERT_ORDER_CLAIM": return { ok: true, ...await orders.claim(message, sender) };
      case "PIC_EXPERT_ORDER_SETTLE": return { ok: true, ...await orders.settle(message, sender) };
      case "PIC_EXPERT_LOG":
        await update(message.taskId, sender, (_t, c) => appendLog(c, message.stage, message.message, message.level), false);
        return { ok: true };
      case "PIC_EXPERT_TASK_END": return { ok: true, task: await summary(await finalizeTask(message, sender)) };
      case "PIC_EXPERT_TASK_HALT":
        return { ok: true, task: await update(message.taskId, sender, t => { t.status = "stopping"; t.error = message.error || "任务中断。"; }) };
      case "PIC_EXPERT_TASK_STOP": {
        const task = await selectedTask(message);
        if (!task || !["running", "stopping", "finalizing"].includes(task.status)) return { ok: true, task: await summary(task) };
        return { ok: true, task: await summary(await stopTask(task, sender, "用户停止任务。")) };
      }
      case "PIC_EXPERT_MANIFEST_RETRY": {
        const task = await selectedTask(message);
        if (!task || !["completed", "failed"].includes(task.status)) throw new Error("请等待任务结束。");
        if (task.manifestDownloadId !== undefined) {
          const [item] = await chrome.downloads.search({ id: task.manifestDownloadId });
          if (["complete", "in_progress"].includes(item?.state)) return { ok: true, task: await summary(await exportManifest(task.id, sender)) };
        }
        return { ok: true, task: await summary(await exportManifest(task.id, sender, true)) };
      }
      case "PIC_EXPERT_LOG_EXPORT": {
        const task = await selectedTask(message); if (!task) throw new Error("没有运行日志。");
        let after = 0, part = 1, page;
        do {
          page = await db.logPage(task.id, after);
          if (!page.logs.length) break;
          const text = page.logs.map(e => e.time + " [" + e.level + "] " + e.stage + "：" + e.message).join("\n");
          const id = await chrome.downloads.download({url:"data:text/plain;charset=utf-8," + encodeURIComponent(text),filename:"pic-expert/" + taskDirectory(task) + "/运行日志-" + String(part++).padStart(3,"0") + ".txt",saveAs:false,conflictAction:"overwrite"});
          await waitForDownload(id);
          after = page.next;
        } while (page.more);
        return { ok: true };
      }
      case "PIC_EXPERT_TASK_STATE": return { ok: true, task: await summary(await selectedTask(message)) };
      default: return { ok: false, error: "unknown_message" };
    }
  })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message, files: error.files }));
  return true;
});
