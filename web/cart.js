const cart = document.querySelector("#cart");
const PENDING_KEY = "hacku.checkout";
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

let consent = null;
let notice = null;

function money(amount, currency) {
  const number = Number(amount);
  if (amount == null || !Number.isFinite(number)) return "價格見商店";
  const digits = Number.isInteger(number) ? 0 : 2;
  const text = number.toLocaleString("en-HK", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = SIGNS[currency];
  return sign ? `${sign}${text}` : `${currency || ""} ${text}`.trim();
}

function groups(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.store || "其他"}|${item.currency || "HKD"}`;
    if (!map.has(key)) map.set(key, { store: item.store || "其他", currency: item.currency || "HKD", items: [] });
    map.get(key).items.push(item);
  }
  return [...map.values()];
}

function render() {
  const items = HackuCart.load();
  cart.replaceChildren();
  if (notice) cart.append(el("p", `notice ${notice.kind}`, notice.text));
  if (consent) {
    cart.append(
      el(
        "p",
        consent.valid ? "consent ok" : "consent off",
        consent.valid ? "授權有效：代理人可以在你按下付款後開啟結帳。" : `授權無效，不能付款：${consent.detail}`
      )
    );
  }
  if (!items.length) {
    cart.append(el("p", "empty", "購物車是空的。回到對話，在推薦商品上按「加入購物車」。"));
    return;
  }

  for (const group of groups(items)) cart.append(groupBlock(group));
  cart.append(el("p", "test-note", "Stripe 測試模式：卡號 4242 4242 4242 4242，任何未來日期與 CVC。不會扣真錢。"));
}

function groupBlock(group) {
  const list = el("ul", "cart-list");
  let known = 0;
  let missing = false;
  for (const item of group.items) {
    const qty = Number(item.qty) || 1;
    if (item.price == null) missing = true;
    else known += Number(item.price) * qty;
    list.append(itemRow(item, qty));
  }

  const total = missing && known === 0 ? "價格見商店" : missing ? `${money(known, group.currency)}（部分價格見商店）` : money(known, group.currency);
  const message = el("p", "pay-message");
  const pay = el("button", "pay", "用 Stripe 測試付款");
  pay.type = "button";
  const payable = !missing && group.items.every((item) => item.sig && item.sealed);
  pay.disabled = !payable || (consent && !consent.valid);
  if (!payable) message.textContent = missing ? "有商品沒有標價，請到商店頁購買。" : "請回到對話重新加入這些商品。";
  pay.addEventListener("click", () => checkout(group, pay, message));

  return el(
    "section",
    "cart-group",
    el("h2", "group-title", group.store),
    list,
    el("div", "group-foot", el("p", "cart-total", `小計 ${total}`), pay),
    message
  );
}

function itemRow(item, qty) {
  const picture = item.image ? el("img", "cart-pic") : el("div", "cart-pic");
  if (item.image) {
    picture.src = item.image;
    picture.alt = "";
    picture.referrerPolicy = "no-referrer";
  }
  const remove = el("button", "pill", "移除");
  remove.type = "button";
  remove.addEventListener("click", () => {
    HackuCart.remove(item.id);
    render();
  });
  const title = item.url ? el("a", "cart-name", item.name) : el("p", "cart-name", item.name);
  if (item.url) {
    title.href = item.url;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
  }
  return el(
    "li",
    "cart-row",
    picture,
    el("div", "cart-info", title, el("p", "price", `${money(item.price, item.currency)} × ${qty}`)),
    remove
  );
}

async function checkout(group, button, message) {
  button.disabled = true;
  button.textContent = "檢查授權與商品…";
  message.textContent = "";
  try {
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: group.items.map((item) => ({ ...item.sealed, id: item.id, qty: Number(item.qty) || 1, sig: item.sig })),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.url) throw new Error(data.error || "沒辦法開啟結帳，請再試一次。");
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ id: data.id, items: group.items.map((item) => item.id) }));
    location.href = data.url;
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
    button.textContent = "用 Stripe 測試付款";
  }
}

async function loadConsent() {
  try {
    const response = await fetch("/api/consent");
    consent = response.ok ? await response.json() : null;
  } catch {
    consent = null;
  }
}

async function finishReturn() {
  const params = new URLSearchParams(location.search);
  if (params.has("canceled")) {
    notice = { kind: "info", text: "已取消付款，商品還在購物車。" };
  }
  const session = params.get("paid");
  if (session) {
    try {
      const response = await fetch(`/api/checkout/status?session=${encodeURIComponent(session)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "查不到這筆付款。");
      if (data.paid) {
        const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
        if (pending?.id === session) HackuCart.removeMany(pending.items);
        sessionStorage.removeItem(PENDING_KEY);
        const record = data.hash ? `，紀錄 ${data.hash.slice(0, 12)}` : "";
        notice = { kind: "ok", text: `付款成功（Stripe 測試模式）：${money(data.amount, data.currency)}${record}。` };
      } else {
        notice = { kind: "info", text: "這筆付款還沒完成。" };
      }
    } catch (error) {
      notice = { kind: "error", text: error.message };
    }
  }
  if (params.has("paid") || params.has("canceled")) history.replaceState(null, "", "cart.html");
}

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

Promise.all([loadConsent(), finishReturn()]).then(render);
render();
