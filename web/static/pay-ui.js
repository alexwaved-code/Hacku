const PENDING_KEY = "hacku.checkout";
const CHAT_KEY = "hacku.chat";
const CHATS_KEY = "hacku.chats";
const DAY_CHOICES = [1, 7, 30];
const root = document.querySelector("#pay-root");

let mandate = null;
let orders = null;
let editing = false;
let notice = null;
let paid = null;
let card = null;
let log = null;

function money(amount, currency) {
  return HackuMoney.text(amount, currency) || t("priceAtStore");
}

function live() {
  return Boolean(orders?.live);
}

function groups(items) {
  const map = new Map();
  for (const item of items) {
    const currency = item.currency || "HKD";
    if (!map.has(currency)) map.set(currency, { currency, items: [] });
    map.get(currency).items.push(item);
  }
  return [...map.values()].map((group) => ({
    ...group,
    missing: group.items.some((item) => item.price == null),
    total: group.items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.qty) || 1), 0),
  }));
}

function mark() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "pay-mark");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6.8 12.4l3.3 3.3 7.1-7.4");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function stampChats(session, receipt) {
  const result = {
    kind: "receipt",
    paid: true,
    amount: receipt.amount,
    currency: receipt.currency,
    hash: receipt.hash,
    items: receipt.items,
    ship_to: receipt.ship_to,
    live: receipt.live,
  };
  const stamp = (payload) => {
    if (!payload?.view) return payload;
    for (const entry of payload.view) {
      for (const rec of entry.receipts || []) {
        if (rec.kind === "order" && rec.session === session) rec.result = result;
      }
    }
    return payload;
  };
  try {
    const current = JSON.parse(sessionStorage.getItem(CHAT_KEY) || "null");
    if (current) sessionStorage.setItem(CHAT_KEY, JSON.stringify(stamp(current)));
  } catch {
    /* The open chat copy is optional. */
  }
  try {
    const chats = JSON.parse(localStorage.getItem(CHATS_KEY) || "[]");
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats.map((chat) => stamp(chat) || chat)));
  } catch {
    /* The saved chat list is optional. */
  }
}

function render() {
  HackuText.apply();
  document.title = `${t("payTitle")} · ${t("title")}`;
  root.replaceChildren();
  if (notice) root.append(el("p", `pay-notice ${notice.kind}`, notice.text));
  if (paid) {
    root.append(doneCard(paid));
    return;
  }
  const items = HackuCart.load();
  const all = groups(items);
  root.append(itemsCard(items, all));
  root.append(mandateCard(all));
  root.append(walletCard());
  root.append(logCard());
  if (location.hash === "#log") document.querySelector("#log")?.scrollIntoView();
}

function walletCard() {
  const box = el("section", "pay-card", el("h2", "", t("walletTitle")));
  if (card?.saved) {
    box.append(el("p", "pay-status ok", t("walletSaved", { brand: brandName(card.brand), last4: card.last4 })), el("p", "pay-hint", t("walletAgentPays")));
    if (card.ship_to) box.append(el("p", "pay-hint", t("shipTo", card.ship_to)));
    box.append(el("div", "pay-actions", button("pay-pill", t("walletForget"), () => forgetCard())));
    return box;
  }
  const ship = shipFromProfile();
  const save = button("pay-sign", t("walletSave"), () => saveCard(save, ship));
  box.append(el("div", "pay-actions", save));
  return box;
}

function brandName(brand) {
  const name = String(brand || "card");
  return name === "amex" ? "American Express" : name.charAt(0).toUpperCase() + name.slice(1);
}

function shipFromProfile() {
  const profile = typeof HackuProfile === "undefined" ? {} : HackuProfile.load();
  const city = String(profile.district || "")
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return { name: profile.consignee || "", phone: profile.phone || "", line1: profile.line1 || "", line2: profile.line2 || "", city };
}

async function saveCard(save, ship) {
  save.disabled = true;
  save.textContent = t("walletOpening");
  try {
    const response = await fetch("/api/wallet/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ship }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.url) throw new Error(data.error || t("payError"));
    location.href = data.url;
  } catch (error) {
    notice = { kind: "error", text: error.message };
    render();
  }
}

async function forgetCard() {
  try {
    const response = await fetch("/api/wallet/forget", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || t("payError"));
    card = data;
    notice = { kind: "ok", text: t("walletRemoved") };
  } catch (error) {
    notice = { kind: "error", text: error.message };
  }
  await refreshLog();
}

function logCard() {
  const box = el("section", "pay-card pay-log", el("h2", "", t("logTitle")));
  box.id = "log";
  if (!log) return box;
  box.append(el("p", `pay-status ${log.chain_ok ? "ok" : "off"}`, t(log.chain_ok ? "logIntact" : "logBroken")));
  if (!log.entries.length) {
    box.append(el("p", "pay-hint", t("logEmpty")));
    return box;
  }
  const steps = t("logSteps");
  const list = el("ol", "pay-log-list");
  for (const entry of log.entries) list.append(logRow(entry, steps));
  box.append(list);
  return box;
}

function logRow(entry, steps) {
  const when = new Date(entry.at);
  const time = Number.isNaN(when.getTime()) ? entry.at : `${HackuText.date(when)} ${when.toTimeString().slice(0, 8)}`;
  const amount = entry.total != null && entry.currency ? money(entry.total, entry.currency) : "";
  const by = entry.by ? t("logBy")[entry.by] || entry.by : "";
  let detail = [amount, by].filter(Boolean).join(" · ");
  if (entry.step === "mandate_issued") detail = Object.entries(entry.caps || {}).map(([code, cap]) => t("capEach", money(cap, code))).join(t("sep"));
  if (entry.step === "card_saved" || entry.step === "card_removed") detail = t("walletSaved", { brand: brandName(entry.brand), last4: entry.last4 });
  if (entry.step === "paid" && entry.card) detail += ` · •${entry.card}`;
  const row = el(
    "li",
    `pay-log-row ${entry.step === "refused" ? "pay-log-stop" : entry.step === "paid" ? "pay-log-paid" : ""}`,
    el("span", "pay-log-time", time),
    el("strong", "pay-log-step", steps[entry.step] || entry.step),
    el("span", "pay-log-detail", detail),
    el("code", "pay-log-hash", entry.hash.slice(0, 12))
  );
  if (entry.step === "refused") {
    const cap = entry.cap != null && entry.currency ? ` · ${t("capEach", money(entry.cap, entry.currency))}` : "";
    row.append(el("span", "pay-log-rule", `${t("logRule", entry.rule)}${cap}`), el("span", "pay-log-reason", entry.reason));
  }
  return row;
}

async function refreshLog() {
  [card, log] = await Promise.all([load("/api/wallet"), load("/api/log")]);
  render();
}

function doneCard(receipt) {
  return el(
    "section",
    "pay-card pay-done",
    mark(),
    el("h2", "", t("paid", money(receipt.amount, receipt.currency))),
    receipt.ship_to ? el("p", "pay-ship", t("shipTo", receipt.ship_to)) : null,
    Object.assign(el("a", "pay-home", t("payBackChat")), { href: "./" })
  );
}

function itemsCard(items, all) {
  const box = el("section", "pay-card", el("h2", "", t("payItems")));
  if (!items.length) {
    const hint = el("p", "pay-empty", t("cartEmpty"));
    hint.append(
      document.createTextNode(" · "),
      el("span", "", t("cartEmptyHint")),
      document.createTextNode(" "),
      Object.assign(el("a", "", t("payBackChat")), { href: "./" })
    );
    box.append(hint);
    return box;
  }
  for (const group of all) {
    for (const item of group.items) box.append(itemRow(item));
    const reason = blocked(group);
    const message = el("p", "pay-hint", reason);
    const pay = button("pay-go", payLabel(group), () => checkout(group, pay, message));
    pay.disabled = Boolean(reason);
    box.append(
      el("div", "pay-sum", el("span", "", t("total")), el("strong", "", money(group.total, group.currency))),
      el("div", "pay-actions", pay),
      message
    );
  }
  return box;
}

function itemRow(item) {
  const qty = Number(item.qty) || 1;
  const picture = item.image ? el("img", "pay-pic") : el("div", "pay-pic-empty");
  if (item.image) {
    picture.src = item.image;
    picture.alt = "";
    picture.referrerPolicy = "no-referrer";
  }
  const title = item.url ? el("a", "pay-name", item.name) : el("p", "pay-name", item.name);
  if (item.url) {
    title.href = item.url;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
  }
  const less = button("pay-step", "−", () => {
    HackuCart.changeQty(item.id, -1);
    render();
  });
  const more = button("pay-step", "+", () => {
    HackuCart.changeQty(item.id, 1);
    render();
  });
  less.setAttribute("aria-label", t("less"));
  more.setAttribute("aria-label", t("more"));
  return el(
    "div",
    "pay-line",
    picture,
    el("div", "", title, el("p", "pay-meta", `${money(item.price, item.currency)} · ${item.store || t("store")}`)),
    el(
      "div",
      "pay-qty",
      less,
      el("span", "pay-count", String(qty)),
      more,
      button("pay-drop", t("remove"), () => {
        HackuCart.remove(item.id);
        render();
      })
    )
  );
}

function mandateCard(all) {
  const box = el("section", "pay-card", el("h2", "", t("navMandate")));
  if (!mandate) {
    box.append(el("p", "pay-status off", t("payMandateOff")));
    return box;
  }
  if (mandate.valid && !editing) {
    const caps = Object.entries(mandate.caps)
      .map(([code, cap]) => money(cap, code))
      .join(t("sep"));
    const until = mandateUntil();
    box.append(
      el("p", "pay-status ok", t("mandateOk")),
      el("p", "pay-hint", until ? `${t("capEach", caps)} · ${until}` : t("capEach", caps)),
      el(
        "div",
        "pay-actions",
        button("pay-pill", t("editMandate"), () => {
          editing = true;
          render();
        }),
        button("pay-pill", t("payRevoke"), () => send("/api/mandate/revoke", {}, t("payRevoked")))
      )
    );
    return box;
  }
  box.append(el("p", `pay-status ${mandate.valid ? "ok" : "off"}`, mandate.valid ? t("editMandate") : mandate.detail || t("mandateMissing")));
  box.append(mandateForm(all));
  return box;
}

function mandateUntil() {
  const end = mandate.expires ? new Date(mandate.expires) : null;
  if (!end || Number.isNaN(end.getTime())) return "";
  const days = Math.max(0, Math.ceil((end - Date.now()) / 86400000));
  return days > 0 ? t("daysLeft", { days, until: HackuText.date(end) }) : t("endsToday");
}

function mandateForm(all) {
  const form = el("form", "pay-form");
  const codes = new Set([...Object.keys(mandate.caps || {}), ...all.map((group) => group.currency)]);
  if (!codes.size) codes.add("HKD");
  for (const code of codes) {
    const largest = Math.max(0, ...all.filter((group) => group.currency === code).map((group) => group.total));
    const input = el("input");
    input.type = "number";
    input.min = "1";
    input.step = "any";
    input.required = true;
    input.name = code;
    input.value = mandate.caps?.[code] ?? (largest ? Math.ceil(largest / 100) * 100 : "");
    form.append(el("label", "", `${code} · ${t("payCap")}`, input));
  }
  const days = el("select");
  for (const value of DAY_CHOICES) {
    const option = document.createElement("option");
    option.value = String(value);
    option.selected = value === 7;
    option.textContent = t("payDays", value);
    days.append(option);
  }
  form.append(el("label", "", t("payValid"), days));
  const submit = el("button", "pay-sign", t("signMandate"));
  submit.type = "submit";
  form.append(submit);
  if (mandate.valid) {
    form.append(
      button("pay-pill", t("cancel"), () => {
        editing = false;
        render();
      })
    );
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const caps = {};
    for (const input of form.querySelectorAll("input[type=number]")) caps[input.name] = Number(input.value);
    editing = false;
    send("/api/mandate", { caps, days: Number(days.value) }, t("paySigned"));
  });
  return form;
}

function blocked(group) {
  if (group.missing) return t("payNeedPrice");
  if (!mandate?.valid) return t("mandateMissingHint");
  const cap = mandate.caps[group.currency];
  if (cap == null) return t("payNeedCurrency", group.currency);
  if (group.total > cap) return t("capOver", money(cap, group.currency));
  return "";
}

function payLabel(group) {
  const total = money(group.total, group.currency);
  return live() ? t("payNowLive", total) : t("payNow", total);
}

async function checkout(group, pay, message) {
  pay.disabled = true;
  pay.textContent = t(card?.saved ? "checking" : "verifying");
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
    if (response.ok && data.paid) {
      HackuCart.removeMany(group.items.map((item) => item.id));
      paid = data;
      render();
      return;
    }
    if (!response.ok || !data.url) throw new Error(data.error || t("payError"));
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ id: data.id, items: group.items.map((item) => item.id) }));
    location.href = data.url;
  } catch (error) {
    message.textContent = error.message;
    pay.disabled = false;
    pay.textContent = payLabel(group);
  }
}

async function send(path, body, okText) {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || t("payError"));
    mandate = data;
    notice = { kind: "ok", text: okText };
  } catch (error) {
    notice = { kind: "error", text: error.message };
  }
  await refreshLog();
}

async function load(path) {
  try {
    const response = await fetch(path);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function finishReturn() {
  const params = new URLSearchParams(location.search);
  if (params.has("canceled")) notice = { kind: "info", text: t("payCanceled") };
  const saved = params.get("card");
  if (saved) {
    try {
      const response = await fetch(`/api/wallet/confirm?session=${encodeURIComponent(saved)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("payError"));
      notice = { kind: "ok", text: t("walletDone") };
    } catch (error) {
      notice = { kind: "error", text: error.message };
    }
  }
  const session = params.get("paid");
  if (session) {
    try {
      const response = await fetch(`/api/checkout/status?session=${encodeURIComponent(session)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("payError"));
      if (data.paid) {
        const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
        if (pending?.id === session) HackuCart.removeMany(pending.items);
        sessionStorage.removeItem(PENDING_KEY);
        paid = data;
        stampChats(session, data);
      } else {
        notice = { kind: "info", text: t("payPending") };
      }
    } catch (error) {
      notice = { kind: "error", text: error.message };
    }
  }
  if (params.has("paid") || params.has("canceled") || saved) history.replaceState(null, "", `pay.html${location.hash}`);
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

HackuText.apply();
document.title = `${t("payTitle")} · ${t("title")}`;

document.querySelectorAll("[data-lang]").forEach((button) => {
  button.addEventListener("click", () => {
    HackuText.set(button.dataset.lang);
    document.title = `${t("payTitle")} · ${t("title")}`;
    const home = document.querySelector(".pay-home");
    if (home) home.textContent = t("payBackChat");
    render();
  });
});

finishReturn()
  .then(() => Promise.all([load("/api/mandate"), load("/api/orders"), load("/api/wallet"), load("/api/log")]))
  .then(([nextMandate, nextOrders, nextCard, nextLog]) => {
    mandate = nextMandate;
    orders = nextOrders;
    card = nextCard;
    log = nextLog;
    render();
  });
