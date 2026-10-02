const HackuMoney = (() => {
  const SIGNS = {
    HKD: "HK$",
    TWD: "NT$",
    USD: "US$",
    SGD: "S$",
    AUD: "A$",
    CNY: "人民幣 ¥",
    JPY: "日圓 ¥",
    KRW: "₩",
    EUR: "€",
    GBP: "£",
  };

  function text(value, currency = "HKD") {
    if (value == null || value === "") return "";
    const number = Number(value);
    if (!Number.isFinite(number)) return "";
    const digits = Number.isInteger(number) ? 0 : 2;
    const amount = number.toLocaleString("en-HK", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const sign = SIGNS[currency];
    return sign ? `${sign}${amount}` : `${currency || ""} ${amount}`.trim();
  }

  return { SIGNS, text };
})();
