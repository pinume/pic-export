(() => {
  const isMaterialModification = (text) => /材料修改/.test(String(text ?? ""));

  const chooseFrame = (results) => {
    const frames = results.filter(x => x.result?.ok && x.result.ready);
    if (frames.length !== 1) throw new Error(frames.length ? "发现多个订单列表，无法唯一定位。" : "未找到已查询的订单列表，请先完成查询。");
    return frames[0].frameId;
  };
  const api = Object.freeze({ isMaterialModification, chooseFrame });
  globalThis.PIC_EXPERT_PAGE_CORE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
