/* Delivery profile for this browser. Card numbers are never stored. */
const HackuProfile = (() => {
  const KEY = "hacku.profile";
  const METHODS = ["visa", "mastercard", "unionpay", "fps", "alipay", "wechat"];
  const DISTRICTS = [
    "central",
    "wan-chai",
    "eastern",
    "southern",
    "yau-tsim-mong",
    "sham-shui-po",
    "kowloon-city",
    "wong-tai-sin",
    "kwun-tong",
    "kwai-tsing",
    "tsuen-wan",
    "tuen-mun",
    "yuen-long",
    "north",
    "tai-po",
    "sha-tin",
    "sai-kung",
    "islands",
  ];

  function clip(value, max) {
    return String(value || "").trim().slice(0, max);
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!raw || typeof raw !== "object") return empty();
      const district = clip(raw.district, 40);
      const payment = clip(raw.payment, 20);
      return {
        consignee: clip(raw.consignee, 80),
        phone: clip(raw.phone, 24),
        line1: clip(raw.line1, 120),
        line2: clip(raw.line2, 120),
        district: DISTRICTS.includes(district) ? district : "",
        payment: METHODS.includes(payment) ? payment : "",
      };
    } catch {
      return empty();
    }
  }

  function empty() {
    return { consignee: "", phone: "", line1: "", line2: "", district: "", payment: "" };
  }

  function save(profile) {
    const next = {
      consignee: clip(profile.consignee, 80),
      phone: clip(profile.phone, 24),
      line1: clip(profile.line1, 120),
      line2: clip(profile.line2, 120),
      district: DISTRICTS.includes(profile.district) ? profile.district : "",
      payment: METHODS.includes(profile.payment) ? profile.payment : "",
    };
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  }

  function clear() {
    localStorage.removeItem(KEY);
    return empty();
  }

  return { load, save, clear, empty, METHODS, DISTRICTS };
})();
