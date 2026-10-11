(() => {
  const read = async () => {
    const response = await fetch("/uisportal/merInfoUser/businessCenter", {
      credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10000),
      headers: { "X-Requested-With": "XMLHttpRequest" }
    });
    if (!response.ok || response.redirected) throw new Error("无法读取当前商户，请登录网站后重新打开弹窗。");
    const doc = new DOMParser().parseFromString(await response.text(), "text/html");
    const field = label => {
      const values = [...doc.querySelectorAll(".leftTitle")]
        .filter(element => element.textContent.replace(/[:：\s]/g, "") === label)
        .map(element => element.parentElement.querySelector(".rightCont")?.textContent.trim())
        .filter(Boolean);
      if (values.length !== 1) throw new Error("无法唯一识别当前商户，请确认网站已登录。");
      return values[0];
    };
    const number = field("商户编号"), name = field("商户名称");
    if (!/^[A-Za-z0-9]{15}$/.test(number)) throw new Error("当前商户号格式无法识别。");
    const business = { "89813015722APT1": "appliance", "89813014812B06R": "digital" }[number] || null;
    return { name, number, business };
  };
  globalThis.PIC_EXPERT_MERCHANT = Object.freeze({ read });
})();
