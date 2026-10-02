const cart = document.querySelector("#cart");
const PENDING_KEY = "hacku.checkout";
const DAY_CHOICES = [1, 7, 30];

let mandate = null;
let editing = false;
let notice = null;

function money(amount, currency) {
  return HackuMoney.text(amount, currency) || "價格見商店";
}

function groups(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.store || "其他"}|${item.currency || "HKD"}`;
    if (!map.has(key)) map.set(key, { store: item.store || "其他", currency: item.currency || "HKD", items: [] });
    map.get(key).items.push(item);
  }
  for (const group of map.values()) {
    group.missing = group.items.some((item) => item.price == null);
    group.total = group.items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.qty) || 1), 0);
  }
  return [...map.values()];
}

function render() {
  const items = HackuCart.load();
  const all = groups(items);
  cart.replaceChildren();
  if (notice) cart.append(el("p", `notice ${notice.kind}`, notice.text));
  cart.append(mandateBlock(all));
  if (!items.length) {
    cart.append(el("p", "empty", "購物車是空的。回到對話，在推薦商品上按「加入購物車」。"));
    return;
  }
  for (const group of all) cart.append(groupBlock(group));
  cart.append(el("p", "test-note", "Stripe 測試模式：卡號 4242 4242 4242 4242，任何未來日期與 CVC。不會扣真錢。"));
}

function mandateBlock(all) {
  const box = el("section", "mandate");
  if (!mandate) {
    box.append(el("p", "mandate-status off", "讀不到付款授權狀態。"));
    return box;
  }
  if (mandate.valid && !editing) {
    const caps = Object.entries(mandate.caps).map(([code, cap]) => money(cap, code)).join("、");
    const change = button("pill", "修改上限", () => {
      editing = true;
      render();
    });
    const revoke = button("pill", "撤銷授權", () => send("/api/mandate/revoke", {}, "已撤銷授權，代理人不能再開啟結帳。"));
    box.append(
      el("p", "mandate-status ok", `付款授權有效：每筆上限 ${caps}。${mandate.detail}`),
      el("div", "mandate-actions", change, revoke)
    );
    return box;
  }
  box.append(el("p", `mandate-status ${mandate.valid ? "ok" : "off"}`, mandate.valid ? "修改付款授權" : mandate.detail));
  box.append(mandateForm(all));
  return box;
}

function mandateForm(all) {
  const form = el("form", "mandate-form");
  const codes = new Set([...Object.keys(mandate.caps || {}), ...all.map((group) => group.currency)]);
  if (!codes.size) codes.add("HKD");
  for (const code of codes) {
    const largest = Math.max(0, ...all.filter((group) => group.currency === code).map((group) => group.total));
    const input = el("input", "cap-input");
    input.type = "number";
    input.min = "1";
    input.step = "any";
    input.required = true;
    input.name = code;
    input.value = mandate.caps?.[code] ?? (largest ? Math.ceil(largest / 100) * 100 : "");
    form.append(el("label", "cap", `${code} 每筆上限`, input));
  }
  const days = el("select", "days");
  for (const value of DAY_CHOICES) {
    const option = el("option", "", `${value} 天`);
    option.value = String(value);
    option.selected = value === 7;
    days.append(option);
  }
  form.append(el("label", "cap", "有效", days));
  const submit = el("button", "pay", "簽署授權");
  submit.type = "submit";
  form.append(submit);
  if (mandate.valid) {
    form.append(
      button("pill", "取消", () => {
        editing = false;
        render();
      })
    );
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const caps = {};
    for (const input of form.querySelectorAll(".cap-input")) caps[input.name] = Number(input.value);
    editing = false;
    send("/api/mandate", { caps, days: Number(days.value) }, "已簽署付款授權。");
  });
  return form;
}

async function send(path, body, okText) {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "授權沒有更新，請再試一次。");
    mandate = data;
    notice = { kind: "ok", text: okText };
  } catch (error) {
    notice = { kind: "error", text: error.message };
  }
  render();
}

function blocked(group) {
  if (group.missing) return "有商品沒有標價，請到商店頁購買。";
  if (!group.items.every((item) => item.sig && item.sealed)) return "請回到對話重新加入這些商品。";
  if (!mandate?.valid) return "先簽署付款授權。";
  const cap = mandate.caps[group.currency];
  if (cap == null) return `付款授權沒有涵蓋 ${group.currency}。`;
  if (group.total > cap) return `小計超過每筆上限 ${money(cap, group.currency)}。`;
  return "";
}

function groupBlock(group) {
  const list = el("ul", "cart-list");
  for (const item of group.items) list.append(itemRow(item, Number(item.qty) || 1));

  const known = group.total;
  const total = group.missing && known === 0 ? "價格見商店" : group.missing ? `${money(known, group.currency)}（部分價格見商店）` : money(known, group.currency);
  const reason = blocked(group);
  const message = el("p", "pay-message", reason);
  const pay = button("pay", "用 Stripe 測試付款", () => checkout(group, pay, message));
  pay.disabled = Boolean(reason);

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
  const remove = button("pill", "移除", () => {
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

async function checkout(group, pay, message) {
  pay.disabled = true;
  pay.textContent = "檢查授權與商品…";
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
    pay.disabled = false;
    pay.textContent = "用 Stripe 測試付款";
  }
}

async function loadMandate() {
  try {
    const response = await fetch("/api/mandate");
    mandate = response.ok ? await response.json() : null;
  } catch {
    mandate = null;
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

function button(className, label, onClick) {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
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

Promise.all([loadMandate(), finishReturn()]).then(render);
