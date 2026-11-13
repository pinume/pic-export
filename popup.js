const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const retryButton = document.querySelector("#retry");
const exportLogsButton = document.querySelector("#export-logs");
const statusElement = document.querySelector("#status");
const progressElement = document.querySelector("#progress");
const completionElement = document.querySelector("#completion");
const errorElement = document.querySelector("#error");
const interruptionElement = document.querySelector("#interruption");
const logsElement = document.querySelector("#logs");
const copyLogsButton = document.querySelector("#copy-logs");
const copyStatusElement = document.querySelector("#copy-status");
let exportingLogs = false;
const businessSelect = document.querySelector("#business");
businessSelect.value = new URLSearchParams(location.search).get("business") === "digital" ? "digital" : "appliance";
let business = businessSelect.value;
const preferredTabId = Number(new URLSearchParams(location.search).get("tabId")) || null;
const sourceTab = async () => {
  const tabs = await chrome.tabs.query({ url: "https://service.chinaums.com/*" });
  const task = (await request({ type: "PIC_EXPERT_TASK_STATE" })).task;
  const id = preferredTabId || task?.tabId;
  const bound = tabs.find(tab => tab.id === id);
  if (bound) return bound;
  if (tabs.length === 1) return tabs[0];
  if (!tabs.length) throw new Error("请先打开银联商务网站，登录并完成订单查询。");
  throw new Error("打开了多个银联商务页面，无法确定订单来源。请只保留一个订单网站标签页后重试。");
};
const request = async message => {
  const response = await chrome.runtime.sendMessage({ ...message, business });
  if (!response?.ok) throw new Error(response?.error || "后台无响应。");
  return response;
};
const renderTask = task => {
  const labels = { running: "运行中", stopping: "正在停止", finalizing: "正在生成清单", completed: "已完成", failed: "已停止" };
  const hasFailed = task?.failed > 0;
  const displayStatus = task?.status === "completed" && hasFailed ? "failed" : task?.status;
  statusElement.textContent = task?.status === "completed" && hasFailed ? "处理结束，存在失败订单" : task ? labels[task.status] || task.status : "未开始";
  if (task?.status === "running" && task.phase) statusElement.textContent = task.phase === "listing" ? "正在读取完整订单列表" : "正在处理订单资料";
  // Page and in-flight orders only matter while orders are still being processed.
  const active = ["running", "stopping"].includes(task?.status);
  progressElement.textContent = !task ? "" : ["订单总数 " + (task.total ?? "核对中"),
    ...(task.phase === "listing" ? ["列表已读取 " + (task.listed || 0)] : [
      active && task.page ? "第 " + task.page + " 页" : "", "已处理 " + (task.scanned ?? 0),
      active ? "正在处理 " + (task.currentRows?.length || 0) : "",
      "成功 " + (task.completed ?? 0), "跳过 " + (task.skipped ?? 0), "失败 " + (task.failed ?? 0)])
  ].filter(Boolean).join(" · ");
  const setEl = (sel, txt) => { const el = document.querySelector(sel); if (el) el.textContent = txt; };
  statusElement.dataset.status = displayStatus || "";
  if (!task) {
    const bar = document.querySelector("#progress-bar-fill");
    if (bar?.style) { bar.style.width = "0%"; if (bar.dataset) bar.dataset.status = ""; }
    setEl("#progress-percent", "0%");
  } else {
    const totalNum = Number(task.total);
    const scannedNum = Number(task.scanned || 0);
    const pct = Number.isFinite(totalNum) && totalNum > 0 ? Math.min(100, Math.max(0, Math.round((scannedNum / totalNum) * 100))) : (task.status === "completed" ? 100 : 0);
    const bar = document.querySelector("#progress-bar-fill");
    if (bar?.style) { bar.style.width = pct + "%"; if (bar.dataset) bar.dataset.status = displayStatus; }
    setEl("#progress-percent", task.phase === "listing" && task.status === "running" ? "读取列表 " + (task.listed || 0) : "已处理 " + pct + "%" + (hasFailed ? " · 失败 " + task.failed : ""));
  }
  const terminal = task && ["completed", "failed"].includes(task.status);
  completionElement.hidden = !terminal;
  completionElement.dataset.status = terminal ? displayStatus : "";
  completionElement.textContent = terminal ?
    (task.status === "completed" ? hasFailed ? "处理结束，存在失败订单" : "任务已完成" : "任务已停止，已完整下载的订单文件保留") +
      "。已处理 " + task.scanned + "/" + (task.total ?? "未知") + "，成功 " + task.completed + "，跳过 " + task.skipped +
      "，失败 " + task.failed + "。" + (task.manifestError ? "清单下载失败" :
        task.manifestDownloadId !== undefined ? "清单已下载" : "清单状态未知") + (task.error ? "\n" + task.error : "") : "";
  const interrupted = Boolean(task?.error) && ["stopping", "finalizing"].includes(task?.status);
  // The interruption or end notice already carries the task error.
  errorElement.textContent = [interrupted || terminal ? "" : task?.error, task?.manifestError].filter(Boolean).join("\n");
  interruptionElement.hidden = !interrupted;
  interruptionElement.textContent = interrupted ? "任务已中断，正在整理未完成订单。\n" + task.error : "";
  startButton.disabled = ["running", "stopping", "finalizing"].includes(task?.status);
  stopButton.hidden = !["running", "stopping", "finalizing"].includes(task?.status);
  exportLogsButton.disabled = !task || exportingLogs;
  retryButton.hidden = !task?.manifestError;
  const logText = (task?.logs || []).map(entry => new Date(entry.time).toLocaleString("zh-CN", { hour12: false }) +
    " [" + entry.level + "] " + entry.stage + "：" + entry.message).join("\n");
  if (logsElement.value !== logText) {
    logsElement.value = logText;
    logsElement.scrollTop = logsElement.scrollHeight;
  }
  copyLogsButton.disabled = !logText;
};
const refresh = async () => {
  const selected = business;
  try { const response = await request({ type: "PIC_EXPERT_TASK_STATE" }); if (selected === business) renderTask(response.task); }
  catch (error) { if (selected === business) errorElement.textContent = error.message; }
};
const launch = async () => {
  businessSelect.disabled = true;
  startButton.disabled = true;
  errorElement.textContent = "";
  let task;
  try {
    const tab = await sourceTab();
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, files: ["core.js", "page-core.js", "materials.js", "site-api.js", "image-reader.js", "content.js"]
    });
    const probes = await Promise.all(injected.map(async result => ({
      frameId: result.frameId,
      result: await chrome.tabs.sendMessage(tab.id, { type: "PIC_EXPERT_PROBE" }, { frameId: result.frameId }).catch(() => null)
    })));
    const frameId = globalThis.PIC_EXPERT_PAGE_CORE.chooseFrame(probes);
    const probe = probes.find(item => item.frameId === frameId)?.result;
    if (probe?.running) throw new Error("页面上一笔任务仍在退出，请稍候，或手动刷新页面并重新查询后再开始。");
    task = (await request({ type: "PIC_EXPERT_TASK_BEGIN", tabId: tab.id, frameId, tradeDateRange: probe?.tradeDateRange })).task;
    const response = await chrome.tabs.sendMessage(tab.id, { type: "PIC_EXPERT_START", taskId: task.id, task: { business } }, { frameId });
    if (!response?.ok) throw new Error(response?.error || "页面任务启动失败。");
    renderTask(task);
  } catch (error) {
    if (task) await request({ type: "PIC_EXPERT_TASK_END", taskId: task.id, status: "failed", error: error.message }).catch(() => {});
    await refresh();
    errorElement.textContent = error.message;
    startButton.disabled = false;
  }
  finally { businessSelect.disabled = false; }
};
startButton.addEventListener("click", launch);
for (const [button, type] of [
  [stopButton, "PIC_EXPERT_TASK_STOP"],
  [retryButton, "PIC_EXPERT_MANIFEST_RETRY"]
]) {
  button.addEventListener("click", async () => {
    const selected = business;
    button.disabled = true;
    try { const response = await request({ type }); if (selected === business) renderTask(response.task); }
    catch (error) { if (selected === business) errorElement.textContent = error.message; }
    finally { button.disabled = false; }
  });
}
exportLogsButton.addEventListener("click", async () => {
  const selected = business;
  exportingLogs = true;
  exportLogsButton.disabled = true;
  try { await request({ type: "PIC_EXPERT_LOG_EXPORT" }); if (selected === business) copyStatusElement.textContent = "完整日志已开始下载"; }
  catch (error) { if (selected === business) errorElement.textContent = error.message; }
  finally { exportingLogs = false; exportLogsButton.disabled = false; }
});
copyLogsButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(logsElement.value);
    copyStatusElement.textContent = "已复制";
  } catch {
    logsElement.focus();
    logsElement.select();
    copyStatusElement.textContent = document.execCommand("copy") ? "已复制" : "请手动复制已选中的日志";
  }
});
businessSelect.addEventListener("change", () => {
  business = businessSelect.value;
  copyStatusElement.textContent = "";
  const url = new URL(location.href); url.searchParams.set("business", business);
  history.replaceState(null, "", url.href);
  refresh();
});
refresh();
const pollTimer = setInterval(refresh, 1000);
window.addEventListener("unload", () => clearInterval(pollTimer));
