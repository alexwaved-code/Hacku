const root = document.querySelector("#orders");
const POLL_MS = 3000;
const STEPS = {
  pending: "待向商店下單",
  filling: "助理正在 Chrome 視窗代填…",
  cart_ready: "購物車已備好，請到 Chrome 視窗付款",
  opened: "已開啟商店頁，請在 Chrome 視窗完成",
  needs_login: "要先登入商店",
  failed: "代填失敗",
  placed: "已向商店下單",
  refunded: "已退款",
};

let orders = [];
let notice = null;
let timer = null;

async function load() {
  try {
    const response = await fetch("/api/fulfil");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "讀不到訂單。");
    orders = data.orders || [];
  } catch (error) {
    notice = { kind: "error", text: error.message };
  }
  render();
  clearTimeout(timer);
  if (orders.some((order) => order.fulfil === "filling")) timer = setTimeout(load, POLL_MS);
}

function render() {
  root.replaceChildren();
  if (notice) root.append(el("p", `notice ${notice.kind}`, notice.text));
  if (!orders.length) {
    root.append(el("p", "empty", "還沒有已付款的訂單。"));
    return;
  }
  for (const order of orders) root.append(orderBlock(order));
}

function orderBlock(order) {
  const when = order.at.replace("T", " ").slice(0, 16);
  const items = el(
    "ul",
    "fulfil-items",
    order.items.map((item) => {
      const link = el("a", "", item.name);
      if (item.url) {
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      return el("li", "", link, el("span", "fulfil-meta", ` × ${item.qty} · ${item.store} · 付款時 ${HackuMoney.text(item.price, order.currency) || "—"}`));
    })
  );
  const ship = order.shipping || {};
  const address = [ship.line1, ship.line2, ship.city, ship.state, ship.country].filter(Boolean).join("，");
  const contact = el(
    "div",
    "fulfil-ship",
    el("p", "", `收件人：${ship.name || "—"}　電話：${ship.phone || "—"}`),
    el("p", "", `地址：${address || "—"}`),
    ship.email ? el("p", "", `電郵：${ship.email}`) : null
  );
  const step = el("p", `fulfil-step ${order.fulfil}`, STEPS[order.fulfil] || "—", order.store_order ? `（商店訂單 ${order.store_order}）` : "");
  const note = order.fulfil_note ? el("p", "fulfil-note", order.fulfil_note) : null;

  const done = order.fulfil === "placed" || order.fulfil === "refunded";
  const fill = button("pay", order.fulfil === "needs_login" || order.fulfil === "failed" ? "再代填一次" : "助理代填購物車", () =>
    act("/api/fulfil/start", { id: order.id }, "已開始代填，Chrome 視窗會打開。")
  );
  fill.disabled = done || order.fulfil === "filling";
  const number = el("input", "store-order");
  number.placeholder = "商店訂單編號";
  number.value = order.store_order || "";
  const placed = button("pill", "標成已下單", () => act("/api/fulfil/placed", { id: order.id, store_order: number.value }, "已記下商店訂單。"));
  const refund = button("pill danger", "退款", () => {
    if (confirm(`確定要退款 ${HackuMoney.text(order.total, order.currency)} 給買家嗎？`)) act("/api/fulfil/refund", { id: order.id }, "已送出退款。");
  });
  placed.disabled = number.disabled = order.fulfil === "refunded";
  refund.disabled = order.fulfil === "refunded";

  return el(
    "section",
    "cart-group fulfil",
    el(
      "h2",
      "group-title",
      `${HackuMoney.text(order.total, order.currency)} · ${order.live ? "真實付款" : "測試"} · ${when}`
    ),
    step,
    note,
    items,
    contact,
    order.fulfil === "refunded" ? null : el("div", "fulfil-actions", fill, number, placed, refund),
    order.hash ? el("p", "order-hash", `紀錄 ${order.hash.slice(0, 12)}`) : null
  );
}

async function act(path, body, okText) {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "沒有更新，請再試一次。");
    notice = { kind: "ok", text: okText };
  } catch (error) {
    notice = { kind: "error", text: error.message };
  }
  load();
}

function button(className, label, onClick) {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

load();
