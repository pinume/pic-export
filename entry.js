const openTaskButton = document.querySelector("#open-task");
const entryError = document.querySelector("#entry-error");
const labels = { running: "运行中", pausing: "正在暂停", paused: "已暂停", stopping: "正在停止", finalizing: "生成清单中", completed: "已完成", failed: "已停止" };
let sourceTabId = null;
let detectedBusiness = null;
const detectMerchant = async () => {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabs = await chrome.tabs.query({ url: "https://service.chinaums.com/*" });
    const source = tabs.find(tab => tab.id === active?.id) || (tabs.length === 1 ? tabs[0] : null);
    if (!source) throw new Error(tabs.length ? "请在需要导出的银联商务页面打开弹窗。" : "请先打开银联商务网站并登录。");
    await chrome.scripting.executeScript({ target: { tabId: source.id }, files: ["merchant.js"] });
    const results = await chrome.scripting.executeScript({ target: { tabId: source.id }, func: () => globalThis.PIC_EXPERT_MERCHANT.read() });
    const merchant = results[0]?.result;
    if (!merchant?.name || !merchant.number) throw new Error("无法读取当前商户，请重新打开弹窗。");
    document.querySelector("#merchant-name").textContent = merchant.name;
    document.querySelector("#merchant-number").textContent = "商户号 " + merchant.number;
    const business = merchant.business;
    if (!["appliance", "digital"].includes(business)) throw new Error("该商户暂未配置资料导出功能。");
    sourceTabId = source.id;
    detectedBusiness = business;
    const prefix = business === "digital" ? "digital" : "entry";
    document.querySelector("#" + prefix + "-card").hidden = false;
    document.querySelector("#entry-title").hidden = false;
    const response = await chrome.runtime.sendMessage({ type: "PIC_EXPERT_TASK_STATE", business });
    if (!response?.ok) throw new Error(response?.error || "无法读取任务状态。");
    const task = response.task;
    const statusEl = document.querySelector("#" + prefix + "-status");
    statusEl.textContent = task ? labels[task.status] || task.status : "未开始";
    if (statusEl?.dataset) statusEl.dataset.status = task?.status || "";
    document.querySelector("#" + prefix + "-progress").textContent = task ? "成功 " + task.completed + " · 跳过 " + task.skipped + " · 失败 " + task.failed : business === "digital" ? "按订单类型下载数码图片资料" : "SN码、发票及证明材料";
  } catch (error) {
    if (!document.querySelector("#merchant-number").textContent) document.querySelector("#merchant-name").textContent = "未识别";
    if (detectedBusiness) {
      const errStatusEl = document.querySelector("#" + (detectedBusiness === "digital" ? "digital" : "entry") + "-status");
      errStatusEl.textContent = "读取失败";
      if (errStatusEl?.dataset) errStatusEl.dataset.status = "error";
    }
    entryError.textContent = error.message;
  }
};
void detectMerchant();
const openTask = async (business, button) => {
  if (business !== detectedBusiness) return;
  button.disabled = true;
  try {
    const pageUrl = chrome.runtime.getURL("popup.html");
    const pages = (await chrome.tabs.query({ url: pageUrl + "*" })).filter(tab => (new URL(tab.url).searchParams.get("business") || "appliance") === business);
    const url = new URL(pageUrl);
    url.searchParams.set("business", business);
    url.searchParams.set("tabId", String(sourceTabId));
    if (pages.length) {
      await chrome.tabs.update(pages[0].id, { active: true, url: url.href });
      await chrome.windows.update(pages[0].windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: url.href });
    }
    window.close();
  } catch (error) { entryError.textContent = error.message; button.disabled = false; }
};
openTaskButton.addEventListener("click", () => openTask("appliance", openTaskButton));
const digitalButton = document.querySelector("#open-digital");
digitalButton.addEventListener("click", () => openTask("digital", digitalButton));
