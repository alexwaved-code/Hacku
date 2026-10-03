const $ = (selector, root = document) => root.querySelector(selector);

const els = {
  list: $("#messages"),
  form: $("#composer"),
  input: $("#message"),
  send: $("#send"),
  stop: $("#stop"),
  newChat: document.querySelectorAll("#new-chat, #new-chat-narrow"),
  cartLink: $("#cart-link"),
  chatList: $("#chat-list"),
  sideCart: $("#side-cart"),
  toLatest: $("#to-latest"),
  chatSearch: $("#chat-search"),
  sideChats: $("#side-chats"),
  sideCartPanel: $("#side-cart-panel"),
  cartToggle: $("#cart-toggle"),
  openChats: $("#open-chats"),
  foldChats: $("#fold-chats"),
  chatTitle: $("#chat-title"),
  scrim: $(".scrim"),
};
const narrowScreen = window.matchMedia("(max-width: 900px)");

const CHAT_KEY = "hacku.chat";
const CHATS_KEY = "hacku.chats";
const CURRENT_KEY = "hacku.currentChat";
const CHATS_FOLD_KEY = "hacku.chatsFolded";
const IDLE_TIMEOUT_MS = 75000;
const GREETING = "想買什麼？說出預算、用途，或想逛的商店，我幫你上網查。其他問題也可以問我。";
const SKELETON_CARDS = 5;

const state = {
  thread: [],
  busy: false,
  controller: null,
  pendingAsk: null,
  afterTurn: null,
};
const cardPainters = new Set();
let cartSeen = null;
let chatsSeen = null;
let lastMandate = null;
let lastQuick = [];
const comparing = new Map();
const mentions = new Map();
const MAX_COMPARE = 3;
const NUMERALS = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const REF_ZH = /第\s*([一二兩三四五六七八九十]|\d{1,2})\s*(?:個|款|件|張|項)/;
const REF_EN = /(?<![&\w])#([1-9])\b|\b(?:card|option|item|no\.)\s*#?([1-9])\b|\bthe\s+(first|second|third|fourth|fifth)(?:\s+(?:one|card|option|pick))?\b/i;
const PICK_WORDS = /最推薦|推薦|首選|最適合|建議|recommend|best (?:pick|choice|bet|option)|top pick|go with|i'd (?:pick|choose)/i;

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.input.value;
  if (state.busy || (!text.trim() && !mentions.size)) return;
  els.input.value = "";
  els.form.classList.remove("has-text");
  send(text, { withMentions: true });
});
els.stop.addEventListener("click", () => state.controller?.abort());
els.input.addEventListener("input", syncComposer);
els.newChat.forEach((button) => button.addEventListener("click", resetChat));
els.list.addEventListener(
  "scroll",
  () => {
    els.toLatest.hidden = els.list.scrollHeight - els.list.scrollTop - els.list.clientHeight < 240;
  },
  { passive: true }
);
els.toLatest.addEventListener("click", () => els.list.scrollTo({ top: els.list.scrollHeight, behavior: "smooth" }));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.querySelector(".sheet-scrim")) {
    closeCompare();
    return;
  }
  if (event.key === "Escape" && document.body.classList.contains("drawer-open")) {
    closeDrawers();
    return;
  }
  if (event.key === "Escape" && state.busy) {
    state.controller?.abort();
    return;
  }
  if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && els.chatSearch) {
    event.preventDefault();
    openDrawer(els.sideChats);
    els.chatSearch.focus();
    els.chatSearch.select();
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  if (event.key === "/" && !typing) {
    event.preventDefault();
    els.input.focus();
  }
});
els.cartLink?.addEventListener("click", (event) => {
  if (openDrawer(els.sideCartPanel)) event.preventDefault();
  else saveChat();
});
els.openChats?.addEventListener("click", () => {
  if (!openDrawer(els.sideChats)) setChatsFolded(false);
});
els.foldChats?.addEventListener("click", () => setChatsFolded(true, true));
els.scrim?.addEventListener("click", closeDrawers);
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeDrawers));
els.cartToggle?.addEventListener("click", () => {
  const button = els.cartToggle;
  button.classList.remove("bounce");
  void button.offsetWidth;
  button.classList.add("bounce");
  if (narrowScreen.matches) return;
  const collapsed = els.sideCartPanel.classList.toggle("collapsed");
  button.setAttribute("aria-expanded", String(!collapsed));
});
narrowScreen.addEventListener("change", () => {
  closeDrawers();
  if (narrowScreen.matches) {
    els.sideCartPanel?.classList.remove("collapsed");
    els.cartToggle?.setAttribute("aria-expanded", "true");
  }
});
els.chatSearch?.addEventListener("input", renderChatList);
els.chatSearch?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.stopPropagation();
    els.chatSearch.value = "";
    renderChatList();
    els.chatSearch.blur();
  } else if (event.key === "Enter") {
    els.chatList.querySelector(".chat-open")?.click();
  }
});
els.list.addEventListener("mouseover", (event) => linkCard(event.target, true));
els.list.addEventListener("mouseout", (event) => linkCard(event.target, false));
els.list.addEventListener("click", (event) => {
  const card = refCard(event.target);
  if (!card) return;
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
});
window.addEventListener("pagehide", saveChat);
setupVoice();
document.querySelectorAll("[data-lang]").forEach((button) => button.addEventListener("click", () => setLanguage(button.dataset.lang)));
HackuText.apply();
try {
  setChatsFolded(localStorage.getItem(CHATS_FOLD_KEY) === "1");
} catch {
  setChatsFolded(false);
}
updateCartCount();
renderMandate();

/* ---------- Shopping helpers ---------- */

function tagCards(container, products) {
  const wraps = [...container.querySelectorAll(":scope > .card-wrap:not(.skeleton)")];
  wraps.forEach((wrap) => wrap.querySelector(".card-tags")?.remove());
  const list = (products || []).map((product, index) => ({ product, index }));
  const tags = new Map();
  const tag = (index, label, kind) => tags.set(index, [...(tags.get(index) || []), [label, kind]]);
  const priced = list.filter(({ product }) => product.price != null && !Number.isNaN(Number(product.price)));
  if (priced.length >= 2 && new Set(priced.map(({ product }) => product.currency || "HKD")).size === 1) {
    const low = priced.reduce((a, b) => (Number(b.product.price) < Number(a.product.price) ? b : a));
    if (priced.some(({ product }) => Number(product.price) > Number(low.product.price))) tag(low.index, t("tagCheapest"), "cheap");
  }
  const reviewed = list.filter(({ product }) => Number(product.reviews) > 0);
  if (reviewed.length >= 2) {
    const most = reviewed.reduce((a, b) => (Number(b.product.reviews) > Number(a.product.reviews) ? b : a));
    tag(most.index, t("tagPopular"), "popular");
    const rated = reviewed.filter(({ product }) => Number(product.reviews) >= 20 && product.rating != null);
    if (rated.length >= 2) {
      const best = rated.reduce((a, b) => (Number(b.product.rating) > Number(a.product.rating) ? b : a));
      if (best.index !== most.index && rated.filter(({ product }) => Number(product.rating) === Number(best.product.rating)).length === 1) tag(best.index, t("tagTopRated"), "rated");
    }
  }
  for (const [index, labels] of tags) {
    const price = wraps[index]?.querySelector(".price");
    if (price) price.after(h("p", { class: "card-tags" }, labels.map(([label, kind]) => h("span", { class: `card-tag ${kind}` }, label))));
  }
}

function toggleCompare(product) {
  const key = HackuCart.idOf(product);
  if (comparing.has(key)) comparing.delete(key);
  else if (comparing.size >= MAX_COMPARE) {
    const bar = compareBar();
    bar.classList.remove("shake");
    void bar.offsetWidth;
    bar.classList.add("shake");
    bar.querySelector(".compare-note").textContent = t("compareFull");
    return;
  } else comparing.set(key, product);
  syncCompare();
}

function syncCompare() {
  document.querySelectorAll(".card-wrap[data-key]").forEach((wrap) => {
    const on = comparing.has(wrap.dataset.key);
    wrap.classList.toggle("comparing", on);
    wrap.querySelector(".cmp-btn")?.setAttribute("aria-pressed", String(on));
  });
  const bar = compareBar();
  const items = [...comparing.values()];
  bar.hidden = !items.length;
  bar.querySelector(".compare-thumbs").replaceChildren(
    ...items.map((product) => h("span", { class: "compare-thumb", title: product.name }, product.image ? h("img", { src: product.image, alt: "", referrerpolicy: "no-referrer", onerror: hideBrokenImage }) : null))
  );
  bar.querySelector(".compare-note").textContent = items.length < 2 ? t("compareNeedTwo") : t("comparePicked", items.length);
  bar.querySelector(".compare-go").disabled = items.length < 2;
}

function compareBar() {
  let bar = document.querySelector("#compare-bar");
  if (bar) return bar;
  bar = h(
    "div",
    { id: "compare-bar", class: "compare-bar", hidden: true },
    h("span", { class: "compare-thumbs" }),
    h("span", { class: "compare-note" }),
    h("button", { type: "button", class: "compare-go", onclick: openCompare }, t("compareOpen")),
    h("button", { type: "button", class: "compare-clear", onclick: () => { comparing.clear(); syncCompare(); } }, t("compareClear"))
  );
  els.form.before(bar);
  return bar;
}

function openCompare() {
  const items = [...comparing.values()];
  if (items.length < 2) return;
  const best = (pick) => {
    const values = items.map(pick).filter((value) => value != null && !Number.isNaN(value));
    return values.length >= 2 ? values : null;
  };
  const prices = best((p) => (p.price != null && new Set(items.map((i) => i.currency || "HKD")).size === 1 ? Number(p.price) : null));
  const ratings = best((p) => (p.rating != null ? Number(p.rating) : null));
  const low = prices ? Math.min(...prices) : null;
  const top = ratings ? Math.max(...ratings) : null;
  const column = (product) => {
    const add = h("button", { type: "button", class: "pill compare-add" }, cartIcon(), t("addCart"));
    add.addEventListener("click", () => {
      flyToCart(add.closest(".compare-col")?.querySelector(".compare-pic") || add, product);
      HackuCart.add(product);
      updateCartCount();
      add.classList.add("done");
    });
    return h(
      "div",
      { class: "compare-col" },
      h("div", { class: "compare-pic" }, product.image ? h("img", { src: product.image, alt: "", referrerpolicy: "no-referrer", onerror: hideBrokenImage }) : null),
      h("p", { class: "compare-name", title: product.name }, product.name),
      h("dl", {},
        h("dt", {}, t("price")),
        h("dd", { class: low != null && Number(product.price) === low ? "best" : "" }, product.price != null ? HackuMoney.text(product.price, product.currency) : t("priceAtStore")),
        h("dt", {}, t("store")),
        h("dd", {}, product.store || "—"),
        h("dt", {}, t("rating")),
        h("dd", { class: top != null && Number(product.rating) === top ? "best" : "" }, product.rating != null ? `★ ${Number(product.rating).toFixed(1)}` : "—"),
        h("dt", {}, t("reviews")),
        h("dd", {}, product.reviews ? compact(product.reviews) : "—")
      ),
      product.url ? h("a", { class: "compare-link", href: product.url, target: "_blank", rel: "noopener noreferrer" }, t("goStore", shortStore(product.store))) : null,
      add
    );
  };
  const ask = h("button", { type: "button", class: "order-pay" }, t("askWhich"));
  ask.addEventListener("click", () => {
    const names = items.map((p, i) => `${i + 1}. ${p.name}${p.price != null ? ` ${HackuMoney.text(p.price, p.currency)}` : ""}`).join(t("sep"));
    closeCompare();
    send(t("askCompare", names));
  });
  const close = h("button", { type: "button", class: "icon-btn", "aria-label": t("close"), onclick: closeCompare }, lineIcon("M6 6l12 12M18 6L6 18"));
  const sheet = h(
    "div",
    { class: "compare-sheet", role: "dialog", "aria-modal": "true", "aria-label": t("compareHeading") },
    h("div", { class: "compare-head" }, h("h2", {}, t("compareHeading")), close),
    h("div", { class: "compare-grid", style: `--cols:${items.length}` }, items.map(column)),
    h("div", { class: "compare-foot" }, ask)
  );
  const scrim = h("div", { class: "sheet-scrim" }, sheet);
  scrim.addEventListener("click", (event) => {
    if (event.target === scrim) closeCompare();
  });
  document.body.append(scrim);
  ask.focus();
}

function closeCompare() {
  document.querySelector(".sheet-scrim")?.remove();
}

function renderCapMeter(items) {
  const meter = document.querySelector("#cap-meter");
  if (!meter) return;
  const codes = new Set(items.map((item) => item.currency || "HKD"));
  const priced = items.every((item) => item.price != null && !Number.isNaN(Number(item.price)));
  const code = [...codes][0];
  const cap = lastMandate?.valid ? Number((lastMandate.caps || {})[code]) : NaN;
  if (!items.length || codes.size !== 1 || !priced || !(cap > 0)) {
    meter.hidden = true;
    return;
  }
  const total = items.reduce((sum, item) => sum + Number(item.price) * (Number(item.qty) || 1), 0);
  const over = total > cap;
  meter.hidden = false;
  meter.classList.toggle("over", over);
  meter.querySelector(".cap-bar span").style.width = `${Math.max(3, Math.min(100, (total / cap) * 100))}%`;
  meter.querySelector(".cap-text").textContent = over ? t("capOver", HackuMoney.text(cap, code)) : t("capOk", HackuMoney.text(cap - total, code));
}

function actionChip(icon, label, prompt) {
  return h("button", { type: "button", class: "quick-chip", onclick: () => send(prompt) }, icon, h("span", {}, label));
}

function setQuick(actions) {
  const seen = new Set();
  lastQuick = [];
  for (const item of Array.isArray(actions) ? actions : []) {
    const label = String(item.label || "").trim().slice(0, 24);
    const prompt = String(item.prompt || item.label || "").trim().slice(0, 80);
    if (!label || !prompt || seen.has(prompt)) continue;
    seen.add(prompt);
    lastQuick.push({ label, prompt });
    if (lastQuick.length >= 5) break;
  }
  renderQuick();
}

function renderQuick() {
  const box = document.querySelector("#quick");
  if (!box) return;
  if (!lastQuick.length) box.replaceChildren();
  else box.replaceChildren(h("div", { class: "quick-row" }, lastQuick.map((item) => actionChip(null, item.label, item.prompt))));
}

function setupVoice() {
  const mic = document.querySelector("#mic");
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!mic || !Speech) return;
  mic.hidden = false;
  let listening = null;
  mic.addEventListener("click", () => {
    if (listening) {
      listening.stop();
      return;
    }
    if (state.busy) return;
    const recognition = new Speech();
    recognition.lang = HackuText.get() === "en" ? "en-US" : "zh-HK";
    recognition.interimResults = true;
    let heard = "";
    let failed = false;
    recognition.onresult = (event) => {
      heard = [...event.results].map((result) => result[0].transcript).join("");
      els.input.value = heard;
      els.form.classList.toggle("has-text", !!heard.trim());
    };
    recognition.onerror = () => {
      failed = true;
    };
    recognition.onend = () => {
      listening = null;
      mic.classList.remove("listening");
      els.input.placeholder = t(state.pendingAsk ? "askPlaceholder" : "placeholder");
      if (heard.trim()) els.form.requestSubmit();
      else if (failed) {
        els.input.placeholder = t("micError");
        setTimeout(() => (els.input.placeholder = t(state.pendingAsk ? "askPlaceholder" : "placeholder")), 2500);
      }
    };
    listening = recognition;
    mic.classList.add("listening");
    els.input.placeholder = t("micListening");
    recognition.start();
  });
}

function cartForAgent() {
  return HackuCart.load().map((item) => ({ id: item.id, qty: item.qty, sealed: item.sealed, sig: item.sig }));
}

function applyCartOps(ops) {
  const added = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    if (op.op === "add" && op.card) {
      added.push(op.card);
      HackuCart.setQty(op.card, HackuCart.qtyOf(op.card) + (Number(op.qty) || 1));
    } else if (op.op === "remove") HackuCart.remove(op.id);
    else if (op.op === "set") {
      const item = HackuCart.load().find((entry) => entry.id === op.id);
      if (item) HackuCart.changeQty(op.id, (Number(op.qty) || 1) - (Number(item.qty) || 1));
    }
  }
  added.forEach((card, index) => setTimeout(() => flyToCart(cardSource(card), card), index * 90));
  updateCartCount();
}

function syncComposer() {
  els.form.classList.toggle("has-text", !!(els.input.value.trim() || mentions.size));
}

function cartLineOf(id) {
  const index = HackuCart.load().findIndex((item) => item.id === id);
  return index >= 0 ? `c${index + 1}` : "";
}

function shortName(name) {
  const text = String(name || "").trim();
  return text.length > 16 ? `${text.slice(0, 16)}…` : text;
}

function mentionPrompt(extra) {
  const parts = [...mentions.values()]
    .map((item) => {
      const line = cartLineOf(item.id);
      const name = item.name || "";
      if (!name) return "";
      return line ? `${line}「${name}」` : `「${name}」`;
    })
    .filter(Boolean);
  const listed = parts.join(t("sep"));
  const typed = String(extra || "").trim();
  if (!parts.length) return typed;
  return typed ? t("mentionWithText", { listed, text: typed }) : t("mentionAsk", listed);
}

function toggleMention(item) {
  if (!item?.id) return;
  if (mentions.has(item.id)) mentions.delete(item.id);
  else mentions.set(item.id, item);
  renderMentions();
  paintMentionRows();
}

function clearMentions() {
  mentions.clear();
  renderMentions();
  paintMentionRows();
}

function mentionBar() {
  let bar = document.querySelector("#mention-bar");
  if (bar) return bar;
  bar = h("div", { id: "mention-bar", class: "mention-bar", hidden: true });
  els.form.before(bar);
  return bar;
}

function renderMentions() {
  const alive = new Set(HackuCart.load().map((item) => item.id));
  for (const id of [...mentions.keys()]) if (!alive.has(id)) mentions.delete(id);
  const bar = mentionBar();
  const items = [...mentions.values()];
  bar.hidden = !items.length;
  if (!items.length) {
    bar.replaceChildren();
    syncComposer();
    return;
  }
  const ask = h("button", { type: "button", class: "mention-ask" }, t("mentionSend"));
  ask.addEventListener("click", () => {
    closeDrawers();
    send("", { withMentions: true });
  });
  const clear = h("button", { type: "button", class: "mention-clear" }, t("mentionClear"));
  clear.addEventListener("click", clearMentions);
  bar.replaceChildren(
    h(
      "div",
      { class: "mention-chips" },
      items.map((item) => {
        const chip = h(
          "button",
          { type: "button", class: "mention-chip", title: item.name },
          item.image ? h("img", { src: item.image, alt: "", referrerpolicy: "no-referrer", onerror: hideBrokenImage }) : null,
          h("span", {}, shortName(item.name)),
          h("span", { class: "mention-x", "aria-hidden": "true" }, "×")
        );
        chip.addEventListener("click", () => toggleMention(item));
        return chip;
      })
    ),
    ask,
    clear
  );
  syncComposer();
}

function paintMentionRows() {
  document.querySelectorAll(".side-cart-item[data-id]").forEach((row) => {
    const on = mentions.has(row.dataset.id);
    row.classList.toggle("mentioned", on);
    const btn = row.querySelector(".mention-btn");
    if (btn) {
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  });
}

function cardSource(product) {
  const key = HackuCart.idOf(product);
  const wrap = [...document.querySelectorAll(".card-wrap[data-key]")].find((node) => node.dataset.key === key);
  return wrap?.querySelector(".pic") || wrap || document.querySelector(".turn:last-child");
}

function cartTarget() {
  const mark = document.querySelector(".cart-mark");
  const box = mark?.getBoundingClientRect();
  if (box && box.width > 2 && box.bottom > 0 && box.top < window.innerHeight && box.left < window.innerWidth) return mark;
  return document.querySelector("#cart-link") || mark;
}

function pulseCart() {
  for (const node of [document.querySelector(".cart-mark"), document.querySelector("#side-count"), document.querySelector("#cart-toggle-count"), document.querySelector("#cart-link")]) {
    if (!node) continue;
    node.classList.remove("pulse");
    void node.offsetWidth;
    node.classList.add("pulse");
  }
}

function flyToCart(source, product) {
  const target = cartTarget();
  const from = source?.getBoundingClientRect?.();
  const to = target?.getBoundingClientRect?.();
  if (!from || !to || from.width < 2 || to.width < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    pulseCart();
    return;
  }
  const ghost = document.createElement("div");
  ghost.className = "cart-fly";
  ghost.setAttribute("aria-hidden", "true");
  if (product?.image) {
    const pic = document.createElement("img");
    pic.src = product.image;
    pic.alt = "";
    pic.referrerPolicy = "no-referrer";
    ghost.append(pic);
  } else ghost.append(cartIcon());
  const size = Math.max(36, Math.min(56, from.width, from.height));
  const x0 = from.left + from.width / 2;
  const y0 = from.top + from.height / 2;
  ghost.style.left = `${x0 - size / 2}px`;
  ghost.style.top = `${y0 - size / 2}px`;
  ghost.style.width = `${size}px`;
  ghost.style.height = `${size}px`;
  ghost.style.setProperty("--dx", `${to.left + to.width / 2 - x0}px`);
  ghost.style.setProperty("--dy", `${to.top + to.height / 2 - y0}px`);
  document.body.append(ghost);
  ghost.addEventListener(
    "animationend",
    () => {
      ghost.remove();
      pulseCart();
    },
    { once: true }
  );
}

function setLanguage(lang) {
  if (lang === HackuText.get()) return;
  HackuText.set(lang);
  if (state.busy) {
    els.input.placeholder = t(state.pendingAsk ? "askPlaceholder" : "placeholder");
    paintChatTitle();
  } else {
    const top = els.list.scrollTop;
    restoreChat();
    els.list.scrollTop = top;
  }
  renderChatList();
  renderSideCart();
  renderMandate(lastMandate);
  document.querySelector("#compare-bar")?.remove();
  if (comparing.size) syncCompare();
  setChatsFolded(document.body.classList.contains("chats-folded"));
}

/* ---------- Sending ---------- */

function send(text, opts = {}) {
  if (state.busy) return;
  let message = String(text || "").trim();
  if (opts.withMentions) message = mentionPrompt(message);
  if (!message) return;
  if (opts.withMentions) {
    mentions.clear();
    renderMentions();
    paintMentionRows();
  }
  const reply = takePendingAsk({ user_reply: message });
  runTurn(message, [reply || { role: "user", content: message }]);
}

function answerAsk(payload, display) {
  if (state.busy) return;
  const reply = takePendingAsk(payload);
  if (reply) runTurn(display, [reply]);
}

function takePendingAsk(payload) {
  const ask = state.pendingAsk;
  if (!ask) return null;
  state.pendingAsk = null;
  state.openAsk = null;
  els.input.placeholder = t("placeholder");
  ask.close(payload);
  return { role: "tool", tool_call_id: ask.id, content: JSON.stringify(payload) };
}

async function runTurn(display, entries) {
  els.list.querySelectorAll(".follow-ups, .turn-quick, .act-retry").forEach((node) => node.remove());
  const userItem = appendUser(display);
  const existing = loadChats().find((chat) => chat.id === currentChatId());
  if (!existing?.renamed) paintChatTitle(display);
  const turn = createTurn();
  const base = state.thread.length;
  state.thread.push(...entries);
  setBusy(true);

  const controller = new AbortController();
  state.controller = controller;
  const retry = () => {
    userItem.remove();
    turn.remove();
    runTurn(display, entries);
  };

  try {
    const added = await streamChat(controller, turn);
    await turn.finish();
    state.thread.push(...added);
    turn.addActions(() => {
      if (state.busy) return;
      state.thread.length = base;
      userItem.remove();
      turn.remove();
      runTurn(display, entries);
    });
    syncOrders();
    saveChat();
  } catch (error) {
    state.afterTurn = null;
    if (turn.timedOut) {
      state.thread.length = base;
      turn.fail(t("timeout"), retry);
    } else if (controller.signal.aborted) {
      const partial = turn.stop();
      if (partial) state.thread.push({ role: "assistant", content: partial });
    } else {
      state.thread.length = base;
      turn.fail(error instanceof Error ? error.message : t("genericError"), retry);
    }
  } finally {
    state.controller = null;
    setBusy(false);
    if (!state.pendingAsk) els.input.focus();
    runAfterTurn();
  }
}

function pageAction(action) {
  if (action === "open_cart") {
    if (!openDrawer(els.sideCartPanel)) {
      els.sideCartPanel?.classList.remove("flash");
      void els.sideCartPanel?.offsetWidth;
      els.sideCartPanel?.classList.add("flash");
    }
    return;
  }
  state.afterTurn = action;
}

function runAfterTurn() {
  const action = state.afterTurn;
  state.afterTurn = null;
  if (!action) return;
  const go = (href) => setTimeout(() => {
    saveChat();
    location.href = href;
  }, 900);
  if (action === "cart_page") go("pay.html");
  else if (action === "orders_page") go("orders.html");
  else if (action === "new_chat") setTimeout(resetChat, 900);
  else if (action === "chinese") setLanguage("zh");
  else if (action === "english") setLanguage("en");
}

async function streamChat(controller, turn) {
  let idle = null;
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      turn.timedOut = true;
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };
  bump();

  try {
    let response;
    try {
      response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ messages: state.thread, lang: HackuText.get(), cart: cartForAgent() }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error(t("offline"));
    }

    if (!(response.headers.get("content-type") || "").includes("text/event-stream")) {
      const raw = await response.text();
      let payload = {};
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = {};
      }
      throw new Error(payload.error || t("requestFailed", response.status));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let added = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bump();
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseEvent(block);
        if (!event) continue;
        if (event.type === "delta") turn.write(event.text);
        else if (event.type === "retract") turn.retract();
        else if (event.type === "tool_start") turn.stepStart(event);
        else if (event.type === "tool_result") turn.stepDone(event);
        else if (event.type === "cards") turn.showCards(event.items, true);
        else if (event.type === "phase") turn.phase(event.phase);
        else if (event.type === "ask") turn.ask(event);
        else if (event.type === "next") setQuick(event.actions);
        else if (event.type === "error") throw new Error(event.message || t("agentError"));
        else if (event.type === "done") added = Array.isArray(event.messages) ? event.messages : [];
      }
    }

    if (!added) throw new Error(t("dropped"));
    return added;
  } finally {
    clearTimeout(idle);
  }
}

function parseEvent(block) {
  const line = block.split("\n").find((item) => item.startsWith("data:"));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(5).trim());
  } catch {
    return null;
  }
}

function updateCartCount() {
  const badge = document.querySelector("#cart-count");
  const count = HackuCart.count();
  if (badge) badge.textContent = count ? ` ${count}` : "";
  for (const painter of cardPainters) {
    if (painter.node.isConnected) painter.paint(HackuCart.qtyOf(painter.product));
    else cardPainters.delete(painter);
  }
  renderSideCart();
}

function renderSideCart() {
  if (!els.sideCart) return;
  const items = HackuCart.load();
  const count = items.reduce((n, item) => n + (Number(item.qty) || 1), 0);
  const fresh = cartSeen ? items.filter((item) => !cartSeen.has(item.id)).map((item) => item.id) : [];
  const grew = cartSeen && count > cartSeen.count;
  cartSeen = new Set(items.map((item) => item.id));
  cartSeen.count = count;
  const badge = document.querySelector("#side-count");
  const closedBadge = document.querySelector("#cart-toggle-count");
  if (badge) {
    badge.hidden = !count;
    badge.textContent = String(count);
  }
  if (closedBadge) {
    closedBadge.hidden = !count;
    closedBadge.textContent = String(count);
  }
  if (grew) pulseCart();
  els.sideCart.replaceChildren();
  if (!items.length) {
    els.sideCart.append(
      h(
        "div",
        { class: "cart-empty" },
        h("strong", {}, t("cartEmpty")),
        h("p", {}, t("cartEmptyHint"))
      )
    );
    renderSideTotal(items);
    renderMentions();
    return;
  }
  const list = h("ul", { class: "side-cart-list" });
  for (const item of items) list.append(sideCartItem(item, fresh.includes(item.id)));
  els.sideCart.append(list);
  renderSideTotal(items);
  renderMentions();
}

function sideCartItem(item, fresh) {
  const qty = Number(item.qty) || 1;
  const line = item.price == null ? null : Number(item.price) * qty;
  const picture = item.image
    ? h("img", { class: "side-cart-pic", src: item.image, alt: "", referrerpolicy: "no-referrer", onerror: hideBrokenImage })
    : h("span", { class: "side-cart-pic missing", "aria-hidden": "true" });
  const name = item.url
    ? h("a", { class: "side-cart-name", href: item.url, target: "_blank", rel: "noopener noreferrer", title: item.name }, item.name)
    : h("p", { class: "side-cart-name", title: item.name }, item.name);
  const row = h("li", {
    class: `${fresh ? "side-cart-item fresh" : "side-cart-item"}${mentions.has(item.id) ? " mentioned" : ""}`,
    "data-id": item.id,
  });
  const mention = h(
    "button",
    {
      type: "button",
      class: mentions.has(item.id) ? "mention-btn on" : "mention-btn",
      title: t("mentionTitle"),
      "aria-label": t("mentionTitle"),
      "aria-pressed": String(mentions.has(item.id)),
    },
    lineIcon("M5 6h14v9H8l-3 3V6z")
  );
  mention.addEventListener("click", () => toggleMention(item));
  const drop = h("button", { type: "button", class: "cart-remove", title: t("remove"), "aria-label": t("remove") }, t("remove"));
  drop.addEventListener("click", () => {
    row.classList.add("leaving");
    setTimeout(() => {
      HackuCart.remove(item.id);
      updateCartCount();
    }, 180);
  });
  const minus = h("button", { type: "button", class: "qty-btn", "aria-label": t("less"), title: t("less"), disabled: qty <= 1 }, "−");
  const plus = h("button", { type: "button", class: "qty-btn", "aria-label": t("more"), title: t("more") }, "+");
  minus.addEventListener("click", () => {
    if (qty <= 1) return;
    HackuCart.changeQty(item.id, -1);
    updateCartCount();
  });
  plus.addEventListener("click", () => {
    HackuCart.changeQty(item.id, 1);
    updateCartCount();
  });
  row.append(
    picture,
    h(
      "div",
      { class: "side-cart-body" },
      h("div", { class: "side-cart-top" }, name, mention),
      h("p", { class: "side-cart-meta" }, item.store || t("store")),
      h(
        "div",
        { class: "side-cart-foot" },
        h("div", { class: "qty-step" }, minus, h("span", { class: "qty-count" }, String(qty)), plus),
        h("strong", { class: "side-cart-price" }, line == null ? t("priceAtStore") : HackuMoney.text(line, item.currency)),
        drop
      )
    )
  );
  return row;
}

async function renderMandate(known = null) {
  const box = document.querySelector("#side-mandate");
  if (!box) return;
  let mandate = known;
  if (!mandate) {
    try {
      const response = await fetch("/api/mandate");
      if (response.ok) mandate = await response.json();
    } catch {
      /* The server is down; the chat shows its own error. */
    }
  }
  if (!mandate) return;
  lastMandate = mandate;
  renderCapMeter(HackuCart.load());
  const caps = Object.entries(mandate.caps || {})
    .sort(([a], [b]) => (b === "HKD") - (a === "HKD"))
    .map(([code, cap]) => HackuMoney.text(cap, code));
  const end = mandate.expires ? new Date(mandate.expires) : null;
  const valid = end && !Number.isNaN(end.getTime());
  const until = valid ? HackuText.date(end) : "";
  const days = valid ? Math.max(0, Math.ceil((end - Date.now()) / 86400000)) : null;
  box.className = `side-mandate ${mandate.valid ? "ok" : "missing"}`;
  box.replaceChildren(
    h(
      "span",
      { class: "mandate-body" },
      h("strong", {}, mandate.valid ? t("mandateOk") : t("mandateMissing")),
      mandate.valid
        ? h("span", {}, `${t("capEach", caps.join(t("sep")))}${until ? ` · ${days > 0 ? t("daysLeft", { days, until }) : t("endsToday")}` : ""}`)
        : h("span", {}, t("mandateMissingHint"))
    )
  );
  box.title = t(mandate.valid ? "editMandate" : "signMandate");
  box.hidden = false;
}

function renderSideTotal(items) {
  const total = document.querySelector("#side-total");
  const box = document.querySelector("#side-pay-box");
  const label = document.querySelector("#side-items");
  if (!total || !box) return;
  box.hidden = !items.length;
  if (!items.length) {
    total.textContent = "";
    total._amount = null;
    return;
  }
  const count = items.reduce((n, item) => n + (Number(item.qty) || 1), 0);
  if (label) label.textContent = t("itemCount", count);
  renderCapMeter(items);
  const sums = new Map();
  let missing = false;
  for (const item of items) {
    if (item.price == null || Number.isNaN(Number(item.price))) {
      missing = true;
      continue;
    }
    const code = item.currency || "HKD";
    sums.set(code, (sums.get(code) || 0) + Number(item.price) * (Number(item.qty) || 1));
  }
  if (sums.size === 1 && !missing) {
    const [[code, amount]] = [...sums.entries()];
    countTo(total, amount, code);
    return;
  }
  total._amount = null;
  const parts = [...sums.entries()].map(([code, amount]) => HackuMoney.text(amount, code));
  total.textContent = parts.length ? `${parts.join(t("sep"))}${missing ? t("plusStore") : ""}` : t("seeStore");
}

function countTo(node, amount, code) {
  const from = node._code === code && Number.isFinite(node._amount) ? node._amount : null;
  node._amount = amount;
  node._code = code;
  cancelAnimationFrame(node._frame);
  clearTimeout(node._settle);
  if (from === null || from === amount || document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    node.textContent = HackuMoney.text(amount, code);
    return;
  }
  node._settle = setTimeout(() => {
    cancelAnimationFrame(node._frame);
    node.textContent = HackuMoney.text(amount, code);
  }, 500);
  const started = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - started) / 450);
    const eased = 1 - (1 - progress) ** 3;
    node.textContent = progress < 1 ? HackuMoney.text(Math.round(from + (amount - from) * eased), code) : HackuMoney.text(amount, code);
    if (progress < 1) node._frame = requestAnimationFrame(step);
  };
  node._frame = requestAnimationFrame(step);
  node.classList.remove("tick");
  void node.offsetWidth;
  node.classList.add("tick");
}

function openDrawer(panel) {
  if (!panel || !narrowScreen.matches) return false;
  closeDrawers();
  panel.classList.add("open");
  els.scrim.hidden = false;
  document.body.classList.add("drawer-open");
  return true;
}

function closeDrawers() {
  document.querySelectorAll(".side.open").forEach((panel) => panel.classList.remove("open"));
  if (els.scrim) els.scrim.hidden = true;
  document.body.classList.remove("drawer-open");
}

function setChatsFolded(folded, focus) {
  document.body.classList.toggle("chats-folded", folded);
  try {
    localStorage.setItem(CHATS_FOLD_KEY, folded ? "1" : "0");
  } catch {
    /* The choice lasts for this page only. */
  }
  els.openChats?.setAttribute("aria-expanded", String(!folded));
  els.openChats?.setAttribute("aria-label", folded ? t("showChats") : t("chatHistory"));
  els.openChats?.setAttribute("title", folded ? t("showChats") : t("chatHistory"));
  if (folded && focus) els.openChats?.focus();
}

function setBusy(busy) {
  state.busy = busy;
  els.send.hidden = busy;
  els.stop.hidden = !busy;
  els.form.classList.toggle("busy", busy);
}

function welcomeItem() {
  const examples = t("examples").map(([title, prompt], index) =>
    h(
      "button",
      { type: "button", class: "example", style: `--i:${index}`, onclick: () => send(prompt) },
      h("strong", {}, title),
      h("span", {}, prompt)
    )
  );
  return h(
    "li",
    { class: "welcome" },
    h("img", { class: "welcome-logo", src: "logo.svg", alt: "" }),
    h("h2", {}, t("welcomeTitle")),
    h("div", { class: "examples" }, examples)
  );
}

function resetChat() {
  saveChat();
  state.controller?.abort();
  state.thread = [];
  state.pendingAsk = null;
  state.openAsk = null;
  els.input.placeholder = t("placeholder");
  els.input.value = "";
  sessionStorage.setItem(CURRENT_KEY, crypto.randomUUID());
  sessionStorage.removeItem(CHAT_KEY);
  setQuick([]);
  clearMentions();
  els.list.replaceChildren(welcomeItem());
  paintChatTitle(t("newChat"));
  renderChatList();
  closeDrawers();
  els.input.focus();
}

function currentChatId() {
  let id = sessionStorage.getItem(CURRENT_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(CURRENT_KEY, id);
  }
  return id;
}

function loadChats() {
  try {
    const chats = JSON.parse(localStorage.getItem(CHATS_KEY) || "[]");
    return Array.isArray(chats) ? chats : [];
  } catch {
    return [];
  }
}

function chatGroup(chat) {
  if (chat.pinned) return t("groupPinned");
  const day = (time) => new Date(time).setHours(0, 0, 0, 0);
  const diff = Math.round((day(Date.now()) - day(chat.updated || 0)) / 86400000);
  if (diff <= 0) return t("groupToday");
  if (diff === 1) return t("groupYesterday");
  if (diff < 7) return t("groupWeek");
  return t("groupOlder");
}

function renderChatList() {
  if (!els.chatList) return;
  const query = (els.chatSearch?.value || "").trim().toLowerCase();
  const all = loadChats()
    .slice()
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.updated || 0) - (a.updated || 0));
  const chats = query ? all.filter((chat) => (chat.title || "").toLowerCase().includes(query)) : all;
  const firstPaint = chatsSeen === null;
  const seen = chatsSeen || new Set();
  chatsSeen = new Set(all.map((chat) => chat.id));
  els.chatList.replaceChildren();
  if (!chats.length) {
    els.chatList.append(
      h("li", { class: "chat-empty" }, query ? t("noMatch", els.chatSearch.value.trim()) : t("noChats"))
    );
    return;
  }
  const current = currentChatId();
  let group = "";
  chats.forEach((chat, index) => {
    const name = chatGroup(chat);
    if (name !== group) {
      group = name;
      els.chatList.append(h("li", { class: "chat-group" }, name));
    }
    const row = chatRow(chat, chat.id === current);
    if (firstPaint) {
      row.classList.add("enter");
      row.style.setProperty("--i", Math.min(index, 10));
    } else if (!seen.has(chat.id)) {
      row.classList.add("enter");
    }
    els.chatList.append(row);
  });
}

function chatRow(chat, current) {
  const button = h(
    "button",
    { type: "button", class: "chat-open", title: chat.title || t("chat") },
    h("span", { class: "chat-title" }, chat.title || t("chat"))
  );
  button.addEventListener("click", () => openChat(chat.id));
  const tool = (label, icon, onClick, extra = "") =>
    h("button", { type: "button", class: `chat-tool ${extra}`.trim(), "aria-label": label, title: label, onclick: (event) => {
      event.stopPropagation();
      onClick();
    } }, icon);
  const bar = h(
    "div",
    { class: current ? "chat-bar current" : "chat-bar" },
    button,
    h(
      "div",
      { class: "chat-tools" },
      tool(t("rename"), pencilIcon(), () => startRename(chat.id, button)),
      tool(t(chat.pinned ? "unpin" : "pin"), pinIcon(), () => togglePin(chat.id), chat.pinned ? "pinned" : ""),
      tool(t("delete"), trashIcon(), () => confirmDelete(chat.id, bar))
    )
  );
  return h("li", { class: "chat-row", "data-id": chat.id }, bar);
}

function confirmDelete(id, bar) {
  const keep = () => renderChatList();
  const yes = h("button", { type: "button", class: "chat-confirm-yes" }, t("delete"));
  const no = h("button", { type: "button", class: "chat-confirm-no" }, t("cancel"));
  yes.addEventListener("click", (event) => {
    event.stopPropagation();
    const row = bar.closest(".chat-row");
    row?.classList.add("leaving");
    setTimeout(() => deleteChat(id), 200);
  });
  no.addEventListener("click", (event) => {
    event.stopPropagation();
    keep();
  });
  bar.classList.add("confirm");
  bar.replaceChildren(h("span", { class: "chat-confirm-text" }, t("deleteChat")), yes, no);
  no.focus();
}

function deleteChat(id) {
  localStorage.setItem(CHATS_KEY, JSON.stringify(loadChats().filter((chat) => chat.id !== id)));
  if (id === currentChatId()) {
    state.controller?.abort();
    state.thread = [];
    sessionStorage.removeItem(CHAT_KEY);
    sessionStorage.setItem(CURRENT_KEY, crypto.randomUUID());
    restoreChat();
  }
  renderChatList();
}

function startRename(id, button) {
  const chat = loadChats().find((item) => item.id === id);
  if (!chat) return;
  const input = h("input", { class: "chat-rename", value: chat.title || "", "aria-label": t("chatName") });
  button.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const title = input.value.trim().slice(0, 42);
    if (title) {
      const chats = loadChats().map((item) => (item.id === id ? { ...item, title, renamed: true } : item));
      localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
      if (id === currentChatId()) paintChatTitle(title);
    }
    renderChatList();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      done = true;
      renderChatList();
    }
  });
  input.addEventListener("blur", commit);
}

function togglePin(id) {
  const chats = loadChats().map((item) => (item.id === id ? { ...item, pinned: !item.pinned } : item));
  localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
  renderChatList();
}

function openChat(id) {
  closeDrawers();
  if (id === currentChatId()) return;
  saveChat();
  const chat = loadChats().find((item) => item.id === id);
  if (!chat) return;
  state.controller?.abort();
  sessionStorage.setItem(CURRENT_KEY, id);
  sessionStorage.setItem(
    CHAT_KEY,
    JSON.stringify({ thread: chat.thread || [], view: chat.view || [], openAsk: chat.openAsk || null, next: chat.next || [] })
  );
  clearMentions();
  restoreChat();
  renderChatList();
}

function restoreChat() {
  const saved = readChat();
  state.pendingAsk = null;
  state.openAsk = null;
  els.input.placeholder = t("placeholder");
  if (!saved) {
    setQuick([]);
    els.list.replaceChildren(welcomeItem());
    paintChatTitle();
    return;
  }
  state.thread = Array.isArray(saved.thread) ? saved.thread : [];
  els.list.replaceChildren();
  for (const entry of saved.view || []) {
    if (entry.kind === "user") appendUser(entry.text);
    else if (entry.kind === "agent") appendSavedAgent(entry);
    else if (entry.text && entry.text !== GREETING) els.list.append(h("li", { class: "message agent" }, entry.text));
  }
  for (const item of els.list.children) item.classList.add("restored");
  if (!els.list.children.length) els.list.append(welcomeItem());
  if (saved.openAsk) {
    const card = askCard(saved.openAsk.questions || []);
    els.list.lastElementChild?.append(card.el);
    state.pendingAsk = { id: saved.openAsk.id, close: card.close };
    state.openAsk = saved.openAsk;
    els.input.placeholder = t("askPlaceholder");
  }
  setQuick(saved.next);
  paintChatTitle();
}

function readChat() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CHAT_KEY) || "");
    if (!saved || !Array.isArray(saved.view)) return null;
    return saved;
  } catch {
    return null;
  }
}

function cleanTitle(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`「」『』]+|["'`「」『』]+$/g, "")
    .replace(/[。．.!?！？]+$/g, "")
    .slice(0, 42);
}

function chatHeading() {
  const chat = loadChats().find((item) => item.id === currentChatId());
  return (chat?.title || "").trim() || t("newChat");
}

function paintChatTitle(title) {
  const text = cleanTitle(title) || chatHeading();
  if (els.chatTitle) {
    els.chatTitle.textContent = text;
    els.chatTitle.title = text;
  }
  document.title = text === t("newChat") ? t("title") : `${text} · ${t("title")}`;
}

function saveChat() {
  const view = snapshotView();
  const payload = {
    thread: state.thread,
    view,
    openAsk: state.openAsk || null,
    next: lastQuick,
  };
  try {
    sessionStorage.setItem(CHAT_KEY, JSON.stringify(payload));
  } catch {
    /* The browser refused to store the chat. The cart still works. */
  }
  const spoken = (view.find((entry) => entry.kind === "user")?.text || "").trim();
  if (!spoken) return;
  const previous = loadChats().find((chat) => chat.id === currentChatId());
  const chats = loadChats().filter((chat) => chat.id !== currentChatId());
  const title = previous?.renamed ? previous.title : spoken.slice(0, 42);
  chats.unshift({
    id: currentChatId(),
    title,
    renamed: !!previous?.renamed,
    pinned: !!previous?.pinned,
    updated: Date.now(),
    ...payload,
  });
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats.slice(0, 30)));
  } catch {
    /* The conversation list could not be stored. */
  }
  paintChatTitle(title);
  renderChatList();
}

function snapshotView() {
  return [...els.list.children].filter((item) => !item.classList.contains("welcome")).map((item) => {
    if (item.classList.contains("user")) return { kind: "user", text: item.textContent };
    if (item.classList.contains("turn")) {
      return {
        kind: "agent",
        text: item._markdown || item.querySelector(".text")?.innerText || "",
        products: item._products || [],
        receipts: item._receipts || [],
      };
    }
    return { kind: "note", text: item.textContent };
  });
}

function appendSavedAgent(entry) {
  const text = h("div", { class: "text" });
  if (entry.text) text.innerHTML = renderMarkdown(entry.text);
  const cards = h("div", { class: "cards" });
  const products = Array.isArray(entry.products) ? entry.products : [];
  if (products.length) cards.append(...products.map(productCard));
  const receipts = Array.isArray(entry.receipts) ? entry.receipts : [];
  const item = h("li", { class: "message agent turn" }, cards, ...receipts.map(paymentCard), text);
  item._markdown = entry.text || "";
  item._products = products;
  item._receipts = receipts;
  if (products.length) cards.style.setProperty("--n", String(Math.min(products.length, 5)));
  numberCards(cards);
  tagCards(cards, products);
  markPick(item, entry.text);
  els.list.append(item);
}

/* ---------- Messages ---------- */

function appendUser(text) {
  els.list.querySelector(".welcome")?.remove();
  const item = h("li", { class: "message user" }, text);
  els.list.append(item);
  scrollToEnd(true);
  return item;
}

function createTurn() {
  const activity = createActivity();
  const cards = h("div", { class: "cards" });
  const receipts = h("div", { class: "receipts" });
  const text = h("div", { class: "text" });
  const typing = h("div", { class: "typing", hidden: true, "aria-label": t("writing") }, h("span"), h("span"), h("span"));
  const item = h("li", { class: "message agent turn" }, activity.el, cards, receipts, text, typing);
  item._receipts = [];
  els.list.append(item);
  scrollToEnd(true);

  const typer = createTyper(text);
  const clearSkeleton = () => cards.querySelectorAll(".skeleton").forEach((node) => node.remove());
  const showSkeleton = () => {
    if (cards.children.length) return;
    cards.style.setProperty("--n", String(SKELETON_CARDS));
    for (let i = 0; i < SKELETON_CARDS; i += 1) {
      cards.append(
        h(
          "div",
          { class: "card-wrap skeleton", style: `--i:${i}`, "aria-hidden": "true" },
          h("div", { class: "card" }, h("div", { class: "pic" }), h("div", { class: "info" }, h("p", { class: "bar" }), h("p", { class: "bar short" }), h("p", { class: "bar price-bar" })))
        )
      );
    }
    scrollToEnd();
  };

  return {
    timedOut: false,
    phase(name) {
      activity.phase(name);
      if (name !== "plan") clearSkeleton();
      if (name === "answer") {
        typing.hidden = false;
        scrollToEnd();
      }
    },
    write(piece) {
      if (!piece) return;
      activity.wrote();
      typing.hidden = true;
      typer.push(piece);
    },
    retract() {
      typer.reset();
    },
    stepStart(event) {
      activity.toolStart(event);
      if (event.name === "shop_search" || event.name === "show_products") showSkeleton();
    },
    showCards(items, settled = false) {
      if (!Array.isArray(items)) return;
      item._products = items;
      cards.replaceChildren(
        ...items.map((product, index) => {
          const card = productCard(product);
          if (settled) card.classList.add("settled");
          else card.style.setProperty("--i", index);
          return card;
        })
      );
      cards.style.setProperty("--n", String(Math.min(items.length, 5) || 5));
      numberCards(cards);
      tagCards(cards, items);
      cards.querySelectorAll("img").forEach((img) => {
        if (!img.complete) img.addEventListener("load", () => scrollToEnd(), { once: true });
      });
      scrollToEnd();
    },
    stepDone(event) {
      activity.toolDone(event);
      if (event.ui?.kind === "products") {
        this.showCards(event.ui.items);
        scrollToEnd();
      }
      if (event.ui?.kind === "cart") applyCartOps(event.ui.ops);
      if (event.ui?.kind === "page") pageAction(event.ui.action);
      if (event.ui?.kind === "receipt" || event.ui?.kind === "order") {
        const entry = { ...event.ui, call: event.id };
        item._receipts.push(entry);
        receipts.append(paymentCard(entry));
        if (entry.kind === "receipt" && entry.paid) {
          HackuCart.removeMany((entry.items || []).map((line) => line.id));
          updateCartCount();
        }
        scrollToEnd();
      }
    },
    ask(event) {
      activity.finish(t("needChoice"));
      typing.hidden = true;
      clearSkeleton();
      const card = askCard(event.questions || []);
      item.append(card.el);
      state.openAsk = { id: event.id, questions: event.questions || [] };
      state.pendingAsk = { id: event.id, close: card.close };
      els.input.placeholder = t("askPlaceholder");
      scrollToEnd();
    },
    async finish() {
      await typer.finish();
      item._markdown = typer.text();
      typing.remove();
      clearSkeleton();
      markPick(item, item._markdown);
      activity.finish(t("done"));
      item.querySelector(".ask-opt")?.focus({ preventScroll: true });
      scrollToEnd(true);
    },
    addActions(onRetry) {
      const said = typer.text().trim();
      const copy = h("button", { type: "button", class: "act-btn", title: t("copyReply") }, copyIcon(), t("copy"));
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(said);
          copy.lastChild.textContent = t("copied");
          setTimeout(() => {
            copy.lastChild.textContent = t("copy");
          }, 1400);
        } catch {
          copy.lastChild.textContent = t("copyFailed");
        }
      });
      const retry = h("button", { type: "button", class: "act-btn act-retry", title: t("regenerate") }, retryIcon(), t("regenerate"));
      retry.addEventListener("click", onRetry);
      if (said) item.append(h("div", { class: "turn-actions" }, copy, retry));
      if (!state.pendingAsk && lastQuick.length) {
        item.append(
          h(
            "div",
            { class: "quick turn-quick" },
            h("div", { class: "quick-row" }, lastQuick.map((entry) => actionChip(null, entry.label, entry.prompt)))
          )
        );
      }
      scrollToEnd(true);
    },
    stop() {
      typer.flush();
      typing.remove();
      clearSkeleton();
      activity.finish(t("stopped"));
      item.append(h("p", { class: "note" }, t("stopped")));
      return typer.text().trim();
    },
    fail(message, onRetry) {
      typer.cancel();
      typing.remove();
      clearSkeleton();
      activity.finish(t("notFinished"));
      text.replaceChildren(
        h("p", { class: "error" }, message),
        h("button", { type: "button", class: "pill", onclick: onRetry }, t("retry"))
      );
      scrollToEnd();
    },
    remove() {
      activity.finish("");
      item.remove();
    },
  };
}

function createActivity() {
  const started = performance.now();
  const seconds = () => ((performance.now() - started) / 1000).toFixed(1);
  const timer = h("span", { class: "act-timer" }, t("seconds", "0.0"));
  const title = h("span", { class: "act-title" }, t("starting"));
  const head = h(
    "button",
    { type: "button", class: "act-head", "aria-expanded": "true" },
    h("span", { class: "orb", "aria-hidden": "true" }),
    title,
    timer,
    h("span", { class: "act-chevron", "aria-hidden": "true" })
  );
  const steps = h("ol", { class: "act-steps" });
  const el = h("div", { class: "activity live" }, head, steps);
  const open = new Map();
  let finished = false;
  let count = 0;
  let tools = 0;

  const setHint = (step, value) => {
    const node = h("span", { class: "act-hint" }, value);
    step.hint.replaceWith(node);
    step.hint = node;
  };
  const clock = setInterval(() => {
    timer.textContent = t("seconds", seconds());
  }, 100);
  const rotate = setInterval(() => {
    for (const step of open.values()) {
      if (step.hints.length < 2) continue;
      step.index = (step.index + 1) % step.hints.length;
      setHint(step, step.hints[step.index]);
    }
  }, 1500);

  const add = (key, label, hints = []) => {
    const hint = h("span", { class: "act-hint" }, hints[0] || "");
    const li = h("li", { class: "act-step run" }, h("span", { class: "act-dot", "aria-hidden": "true" }), h("span", { class: "act-label" }, label), hint);
    steps.append(li);
    open.set(key, { li, hint, hints, index: 0, label });
    count += 1;
    title.textContent = label;
    scrollToEnd();
  };
  const done = (key, detail = "", ok = true) => {
    const step = open.get(key);
    if (!step) return;
    open.delete(key);
    step.li.className = `act-step ${ok ? "done" : "fail"}`;
    setHint(step, detail);
    const running = [...open.values()].pop();
    if (running) title.textContent = running.label;
  };
  const settleThinking = () => {
    for (const key of [...open.keys()]) if (key.startsWith("phase:")) done(key);
  };

  head.addEventListener("click", () => {
    if (!finished) return;
    const expanded = el.classList.toggle("open");
    head.setAttribute("aria-expanded", String(expanded));
  });

  return {
    el,
    phase(name) {
      if (finished) return;
      settleThinking();
      const phases = t("phases");
      const phase = phases[name] || phases.think;
      add(`phase:${count}`, phase.label, phase.hints);
    },
    toolStart(event) {
      if (finished) return;
      settleThinking();
      tools += 1;
      add(`tool:${event.id}`, event.label || event.name, t("toolHints")[event.name] || []);
    },
    toolDone(event) {
      done(`tool:${event.id}`, [event.summary, event.detail].filter(Boolean).join(" · "), event.ok !== false);
    },
    wrote: settleThinking,
    finish(label) {
      if (finished) return;
      finished = true;
      clearInterval(clock);
      clearInterval(rotate);
      for (const key of [...open.keys()]) done(key);
      if (!tools && label === t("done")) {
        el.remove();
        return;
      }
      el.classList.remove("live");
      head.setAttribute("aria-expanded", "false");
      title.textContent = label;
      timer.textContent = t("stepsSeconds", { n: count, s: seconds() });
    },
  };
}

function productCard(product) {
  const picture = product.image
    ? h("img", { src: product.image, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: hideBrokenImage })
    : null;
  const rating =
    product.rating != null
      ? h("span", { class: "rating" }, `★ ${Number(product.rating).toFixed(1)}`, product.reviews ? `（${compact(product.reviews)}）` : "")
      : null;
  const content = [
    h("div", { class: "pic" }, picture),
    h(
      "div",
      { class: "info" },
      h("p", { class: "name", title: product.name }, product.name),
      product.price != null
        ? h("p", { class: "price" }, HackuMoney.text(product.price, product.currency))
        : h("p", { class: "price unknown" }, t("priceAtStore")),
      h("p", { class: "store" }, product.store || ""),
      h("p", { class: "rating" }, rating || ""),
      h("p", { class: "flag" }, product.flagged ? t("injected") : "")
    ),
  ];
  const startQty = HackuCart.qtyOf(product);
  const add = h("button", {
    type: "button",
    class: startQty ? "add-cart added" : "add-cart",
    "aria-label": t("addCart"),
    title: t("addCart"),
  }, cartIcon());
  const qtyBtn = h("button", {
    type: "button",
    class: "cart-qty",
    hidden: startQty < 1,
    "aria-label": t("changeQty"),
  }, startQty ? `x${startQty}` : "");
  const paintQty = (n) => {
    if (n < 1) {
      qtyBtn.hidden = true;
      qtyBtn.textContent = "";
      add.classList.remove("added");
      return;
    }
    qtyBtn.hidden = false;
    qtyBtn.textContent = `x${n}`;
    add.classList.add("added");
  };
  add.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    flyToCart(card.querySelector(".pic") || add, product);
    HackuCart.add(product);
    add.classList.remove("bounce");
    void add.offsetWidth;
    add.classList.add("bounce");
    const reveal = () => paintQty(HackuCart.qtyOf(product));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !qtyBtn.hidden) reveal();
    else add.addEventListener("animationend", reveal, { once: true });
    updateCartCount();
  });
  qtyBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    editQty(product, qtyBtn, paintQty);
  });
  const go = h(
    "span",
    { class: product.url ? "go" : "go go-empty", "aria-hidden": product.url ? null : "true" },
    product.url ? (product.link_kind === "search" ? t("findStore") : t("goStore", shortStore(product.store))) : ""
  );
  content.push(h("div", { class: "card-foot" }, go, h("div", { class: "cart-controls" }, add, qtyBtn)));
  const card = product.url
    ? h("a", { class: "card", href: product.url, target: "_blank", rel: "noopener noreferrer" }, content)
    : h("div", { class: "card" }, content);
  const key = HackuCart.idOf(product);
  const buy = h("button", { type: "button", class: "tool-btn buy-btn", title: t("buyNowTitle") }, lineIcon("M13 3L5 13h6l-1 8 8-10h-6l1-8z"), h("span", {}, t("buyNow")));
  const pick = h(
    "button",
    { type: "button", class: "tool-btn cmp-btn", title: t("compareTitle"), "aria-pressed": String(comparing.has(key)) },
    lineIcon("M12 4v16M8 20h8M4 8h16M7 8l-3 6a3 3 0 0 0 6 0L7 8zM17 8l-3 6a3 3 0 0 0 6 0l-3-6z"),
    h("span", {}, t("compare"))
  );
  const wrap = h("div", { class: comparing.has(key) ? "card-wrap comparing" : "card-wrap", "data-key": key }, card, h("div", { class: "card-tools" }, pick, buy));
  if (product.price != null && !Number.isNaN(Number(product.price))) wrap.dataset.price = String(product.price);
  buy.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.busy) return;
    const number = [...wrap.parentElement.querySelectorAll(":scope > .card-wrap:not(.skeleton)")].indexOf(wrap) + 1;
    send(t("buyThis", { n: number, name: product.name }));
  });
  pick.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleCompare(product);
  });
  cardPainters.add({ node: wrap, product, paint: (n) => qtyBtn.isConnected && paintQty(n) });
  return wrap;
}

function editQty(product, qtyBtn, paintQty) {
  const input = h("input", {
    type: "number",
    class: "cart-qty-input",
    min: "0",
    inputmode: "numeric",
    value: String(HackuCart.qtyOf(product)),
    "aria-label": t("qty"),
  });
  qtyBtn.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const next = HackuCart.setQty(product, input.value);
    paintQty(next);
    if (input.isConnected) input.replaceWith(qtyBtn);
    updateCartCount();
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      done = true;
      input.replaceWith(qtyBtn);
    }
  });
  input.addEventListener("blur", commit);
}

function lineIcon(d) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function pencilIcon() {
  return lineIcon("M4 20h4L18 10l-4-4L4 16v4z");
}

function pinIcon() {
  return lineIcon("M8 3h8v6l2 2v2H6v-2l2-2V3zM12 13v8");
}

function copyIcon() {
  return lineIcon("M9 9h10v10H9zM5 15V5h10");
}

function retryIcon() {
  return lineIcon("M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4");
}

function trashIcon() {
  return lineIcon("M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12");
}

function paidMark() {
  const svg = lineIcon("M6.8 12.4l3.3 3.3 7.1-7.4");
  svg.setAttribute("class", "receipt-mark");
  return svg;
}

function cartIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 6h15l-1.6 9H8L6 6zm0 0L5 3H2");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  const left = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  left.setAttribute("cx", "9");
  left.setAttribute("cy", "20");
  left.setAttribute("r", "1.4");
  left.setAttribute("fill", "currentColor");
  const right = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  right.setAttribute("cx", "18");
  right.setAttribute("cy", "20");
  right.setAttribute("r", "1.4");
  right.setAttribute("fill", "currentColor");
  svg.append(path, left, right);
  return svg;
}

function paymentCard(entry) {
  return entry.kind === "order" ? orderCard(entry) : receiptCard(entry);
}

function orderCard(order) {
  if (order.result) return receiptCard(order.result);
  if (order.canceled) {
    return h(
      "div",
      { class: "receipt canceled" },
      h("p", { class: "receipt-title" }, t("canceledTitle")),
      h("p", { class: "receipt-line" }, t("canceledLine"))
    );
  }
  const total = HackuMoney.text(order.total, order.currency);
  const lines = (order.lines || []).map((line) =>
    h(
      "li",
      {},
      h("span", { class: "order-name" }, `${line.name}${line.qty > 1 ? ` × ${line.qty}` : ""}`),
      h("span", { class: "order-price" }, HackuMoney.text(line.price * line.qty, order.currency)),
      h("span", { class: "receipt-store" }, line.store)
    )
  );
  const message = h("p", { class: "receipt-line order-message", hidden: true });
  const pay = h("button", { type: "button", class: "order-pay" }, t("confirmPay", total));
  const cancel = h("button", { type: "button", class: "pill" }, t("cancel"));
  const card = h(
    "div",
    { class: "receipt order" },
    h("p", { class: "receipt-title" }, t("confirmOrder")),
    h("ul", { class: "order-lines" }, lines),
    h("p", { class: "order-total" }, h("span", {}, t("total")), h("span", {}, total)),
    h(
      "p",
      { class: "receipt-line" },
      `${t("capLine", order.cap != null ? HackuMoney.text(order.cap, order.currency) : "—")} · ${t(order.live ? "liveLine" : "testLine")}`
    ),
    order.session ? h("p", { class: "receipt-line order-message" }, t("payOpened")) : message,
    h("div", { class: "order-actions" }, pay, cancel)
  );

  const settle = () => {
    card.replaceWith(orderCard(order));
    syncOrders();
    saveChat();
  };
  pay.addEventListener("click", async () => {
    pay.disabled = cancel.disabled = true;
    pay.textContent = t("checking");
    message.hidden = false;
    message.textContent = t("verifying");
    let response;
    let data = {};
    try {
      response = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: order.items }),
      });
      data = await response.json().catch(() => ({}));
    } catch {
      response = null;
    }
    if (!response || response.status >= 500) {
      pay.disabled = cancel.disabled = false;
      pay.textContent = t("confirmPay", total);
      message.textContent = response ? data.error || t("payError") : t("payOffline");
      return;
    }
    if (!response.ok || !data.url) {
      order.result = { kind: "receipt", paid: false, reason: data.error || t("payRefused") };
      settle();
      return;
    }
    order.session = data.id;
    saveChat();
    window.location.assign(data.url);
  });
  cancel.addEventListener("click", () => {
    order.canceled = true;
    settle();
  });
  return card;
}

function syncOrders() {
  const outcomes = new Map();
  for (const item of els.list.children) {
    for (const entry of item._receipts || []) {
      if (entry.kind !== "order" || !entry.call) continue;
      if (entry.result?.paid) {
        const { amount, currency, hash, live, ship_to } = entry.result;
        outcomes.set(entry.call, { paid: true, amount, currency, live: Boolean(live), ship_to, record: (hash || "").slice(0, 12) });
      } else if (entry.result) outcomes.set(entry.call, { refused: entry.result.reason });
      else if (entry.canceled) outcomes.set(entry.call, { canceled: true });
    }
  }
  for (const message of state.thread) {
    if (message.role !== "tool" || !outcomes.has(message.tool_call_id)) continue;
    try {
      const content = JSON.parse(message.content);
      content.shopper = outcomes.get(message.tool_call_id);
      message.content = JSON.stringify(content);
    } catch {
      /* Not a JSON tool result. */
    }
  }
}

function receiptCard(receipt) {
  if (!receipt.paid) {
    return h(
      "div",
      { class: "receipt refused" },
      h("p", { class: "receipt-title" }, t("notPaid")),
      h("p", { class: "receipt-line" }, receipt.reason || t("payRefused")),
      receipt.rule ? h("p", { class: "receipt-line mono" }, t("logRule", receipt.rule)) : null,
      h("a", { class: "receipt-link", href: receipt.rule ? "pay.html#log" : "pay.html" }, t(receipt.rule ? "seeLog" : "fixMandate"))
    );
  }
  const items = (receipt.items || []).map((entry) =>
    h("li", {}, `${entry.name}${entry.qty > 1 ? ` × ${entry.qty}` : ""}`, h("span", { class: "receipt-store" }, entry.store))
  );
  return h(
    "div",
    { class: "receipt paid" },
    paidMark(),
    h(
      "div",
      { class: "receipt-body" },
      h("p", { class: "receipt-title" }, t("paid", HackuMoney.text(receipt.amount, receipt.currency))),
      h("ul", { class: "receipt-items" }, items),
      receipt.card?.last4 ? h("p", { class: "receipt-line" }, t("paidCard", receipt.card.last4)) : null,
      receipt.ship_to ? h("p", { class: "receipt-line" }, t("shipTo", receipt.ship_to)) : null,
      receipt.hash ? h("p", { class: "receipt-line mono" }, t("record", receipt.hash.slice(0, 12))) : null,
      receipt.hash ? h("a", { class: "receipt-link", href: "pay.html#log" }, t("seeLog")) : null
    )
  );
}

async function finishStripeReturn() {
  const params = new URLSearchParams(window.location.search);
  const session = params.get("paid");
  if (!session && !params.has("canceled")) return;
  history.replaceState(null, "", window.location.pathname);
  const orders = [...els.list.children].flatMap((item) => item._receipts || []).filter((entry) => entry.kind === "order");
  const order = session ? orders.find((entry) => entry.session === session) : orders.filter((entry) => entry.session && !entry.result).pop();
  if (!order) return;
  if (session) {
    try {
      const response = await fetch(`/api/checkout/status?session=${encodeURIComponent(session)}`);
      const data = await response.json();
      if (response.ok && data.paid) {
        order.result = { kind: "receipt", paid: true, amount: data.amount, currency: data.currency, hash: data.hash, items: data.items, ship_to: data.ship_to, live: data.live };
      }
    } catch {
      /* Stripe status is read again on the next return. */
    }
  }
  if (!order.result) delete order.session;
  syncOrders();
  saveChat();
  restoreChat();
  scrollToEnd(true);
}

function askCard(questions) {
  questions = Array.isArray(questions) ? questions : [];
  const picked = questions.map(() => new Set());
  const skipped = questions.map(() => false);
  const others = [];
  const skips = [];
  const groups = [];
  const submit = h("button", { type: "button", class: "ask-send", disabled: true }, t("askSend"));
  const status = h("p", { class: "ask-status" }, questions.length > 1 ? t("askQuestions", questions.length) : "");

  const otherOf = (index) => (others[index]?.value || "").trim();
  const ready = () => questions.every((_, index) => skipped[index] || picked[index].size > 0 || otherOf(index));
  const refresh = () => {
    submit.disabled = !ready();
  };
  const clearSkip = (index) => {
    skipped[index] = false;
    skips[index]?.setAttribute("aria-pressed", "false");
    groups[index]?.classList.remove("skipped");
  };

  questions.forEach((question, index) => {
    const multiple = Boolean(question.multiple);
    const other = h("input", {
      class: "ask-other",
      type: "text",
      placeholder: t("otherThoughts"),
      "aria-label": `${question.prompt} · ${t("otherThoughtsLabel")}`,
    });
    const skip = h("button", { type: "button", class: "ask-skip", "aria-pressed": "false" }, t("skip"));
    const buttons = (question.options || []).map((label) =>
      h("button", { type: "button", class: "ask-opt", "aria-pressed": "false", "data-label": label }, label)
    );
    buttons.forEach((button) =>
      button.addEventListener("click", () => {
        const set = picked[index];
        const label = button.dataset.label;
        clearSkip(index);
        if (multiple) {
          set.has(label) ? set.delete(label) : set.add(label);
        } else {
          set.clear();
          set.add(label);
        }
        buttons.forEach((item) => item.setAttribute("aria-pressed", String(set.has(item.dataset.label))));
        refresh();
      })
    );
    other.addEventListener("input", () => {
      if (otherOf(index)) clearSkip(index);
      refresh();
    });
    other.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        submitAnswers();
      }
    });
    skip.addEventListener("click", () => {
      skipped[index] = !skipped[index];
      if (skipped[index]) {
        picked[index].clear();
        other.value = "";
        buttons.forEach((button) => button.setAttribute("aria-pressed", "false"));
      }
      skip.setAttribute("aria-pressed", String(skipped[index]));
      groups[index].classList.toggle("skipped", skipped[index]);
      refresh();
    });
    others[index] = other;
    skips[index] = skip;
    const titleId = `ask-q-${index}-${Math.random().toString(36).slice(2, 8)}`;
    groups[index] = h(
      "fieldset",
      { class: `ask-q${multiple ? " multi" : ""}` },
      h(
        "div",
        { class: "ask-prompt", id: titleId },
        questions.length > 1 ? h("span", { class: "ask-num" }, String(index + 1)) : null,
        h("span", { class: "ask-title" }, question.prompt),
        multiple ? h("span", { class: "ask-mode" }, t("pickAny")) : null
      ),
      h("div", { class: "ask-opts", role: "group", "aria-labelledby": titleId }, buttons),
      h("div", { class: "ask-more" }, other, skip)
    );
  });

  const collect = () =>
    questions.map((question, index) => {
      const other = otherOf(index);
      if (skipped[index]) return { question: question.prompt, skipped: true };
      const chosen = [...picked[index]];
      if (other) return chosen.length ? { question: question.prompt, chosen, other } : { question: question.prompt, other };
      return { question: question.prompt, chosen };
    });

  const submitAnswers = () => {
    if (!ready()) return;
    const answers = collect();
    if (answers.every((answer) => answer.skipped)) {
      answerAsk({ skipped: true }, t("skip"));
      return;
    }
    const display = answers
      .map((answer) => (answer.skipped ? t("skipped") : [...(answer.chosen || []), answer.other].filter(Boolean).join(t("sep"))))
      .filter(Boolean)
      .join(" · ");
    answerAsk({ answers }, display);
  };

  submit.addEventListener("click", submitAnswers);

  const el = h(
    "div",
    { class: "ask", role: "form", "aria-label": t("needChoice") },
    h("header", { class: "ask-head" }, h("p", { class: "ask-kicker" }, t("needChoice")), status),
    h("div", { class: "ask-body" }, groups),
    h("footer", { class: "ask-foot" }, submit)
  );

  const close = (payload) => {
    el.classList.add("closed");
    if (payload.skipped) el.classList.add("skipped");
    else if (payload.user_reply) el.classList.add("typed");
    status.textContent = payload.skipped ? t("skipped") : payload.user_reply ? t("typedInstead") : t("askAnswered");
    groups.forEach((group, index) => {
      if (payload.skipped || skipped[index]) {
        group.classList.add("skipped");
        group.append(h("p", { class: "ask-result" }, t("skipped")));
      } else if (otherOf(index)) {
        group.append(h("p", { class: "ask-result" }, otherOf(index)));
      }
    });
    el.querySelectorAll("button, input").forEach((control) => {
      control.disabled = true;
    });
  };

  return { el, close };
}

function shortStore(store) {
  const name = String(store || "").trim();
  if (name && name.length <= 10) return name;
  const parts = name.split(/\s+/);
  const local = parts.find((part) => /[\u3400-\u9fff]/.test(part) && part.length <= 8);
  if (local) return local;
  if (name.length <= 14) return name;
  let short = "";
  for (const part of parts) {
    if (`${short} ${part}`.trim().length > 14) break;
    short = `${short} ${part}`.trim();
  }
  return short || t("store");
}

function hideBrokenImage(event) {
  event.currentTarget.remove();
}

/* ---------- Typing ---------- */

function createTyper(target) {
  let queue = "";
  let shown = "";
  let timer = null;
  let stopped = false;

  const paint = () => {
    target.innerHTML = renderMarkdown(shown);
    scrollToEnd();
  };

  const tick = () => {
    timer = null;
    if (stopped || !queue) return;
    const size = queue.length > 120 ? 4 : queue.length > 40 ? 2 : 1;
    shown += queue.slice(0, size);
    queue = queue.slice(size);
    paint();
    timer = setTimeout(tick, 18);
  };

  return {
    push(piece) {
      if (stopped) return;
      queue += piece;
      if (timer === null) tick();
    },
    async finish() {
      while (!stopped && (queue || timer !== null)) {
        await new Promise((resolve) => setTimeout(resolve, 24));
      }
    },
    flush() {
      clearTimeout(timer);
      timer = null;
      shown += queue;
      queue = "";
      stopped = true;
      if (shown) paint();
    },
    cancel() {
      clearTimeout(timer);
      timer = null;
      queue = "";
      stopped = true;
    },
    reset() {
      clearTimeout(timer);
      timer = null;
      queue = "";
      shown = "";
      target.replaceChildren();
    },
    text: () => shown,
  };
}

/* ---------- Helpers ---------- */

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === "") continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

function renderMarkdown(source) {
  return String(source)
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${block.split("\n").map((line) => inline(line.replace(/^\s*(?:[-*•]|\d+[.)]|#{1,6})\s+/, ""))).join("<br>")}</p>`)
    .join("");
}

function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(?:HK|NT|US|S|A)\$\s?\d[\d,]*(?:\.\d+)?|(?:人民幣\s?|日圓\s?|CN|JP)?[¥￥]\s?\d[\d,]*(?:\.\d+)?/g, '<b class="money">$&</b>')
    .replace(new RegExp(`${REF_ZH.source}|${REF_EN.source}`, "gi"), (match, ...groups) => {
      const index = refNumber(groups.slice(0, 4));
      return index ? `<span class="ref" data-n="${index}">${match}</span>` : match;
    });
}

function refNumber(groups) {
  const found = groups.find((group) => typeof group === "string" && group);
  return found ? NUMERALS[found.toLowerCase()] || NUMERALS[found] || Number(found) || 0 : 0;
}

function refCard(target) {
  const ref = target instanceof Element ? target.closest(".ref") : null;
  if (!ref) return null;
  return ref.closest(".turn")?.querySelectorAll(".cards > .card-wrap:not(.skeleton)")[Number(ref.dataset.n) - 1] || null;
}

function linkCard(target, on) {
  const card = refCard(target);
  if (card) card.classList.toggle("linked", on);
}

function numberCards(cards) {
  cards.querySelectorAll(":scope > .card-wrap:not(.skeleton)").forEach((wrap, index) => {
    if (!wrap.querySelector(".card-num")) wrap.append(h("span", { class: "card-num", "aria-hidden": "true" }, String(index + 1)));
  });
}

function pickIndex(markdown, products) {
  const text = markdown || "";
  const sentence = text.split(/[。！？\n]|[.!?](?=\s|$)/).find((part) => PICK_WORDS.test(part));
  if (!sentence) return -1;
  const byNumber = new RegExp(`${REF_ZH.source}|${REF_EN.source}`, "i").exec(sentence.slice(sentence.search(PICK_WORDS)));
  if (byNumber) return refNumber(byNumber.slice(1, 5)) - 1;
  const said = sentence.toLowerCase();
  let best = -1;
  let bestScore = 0;
  let tie = false;
  (products || []).forEach((product, index) => {
    const words = String(product.name || "").toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
    const score = new Set(words.filter((word) => said.includes(word))).size;
    if (score > bestScore) {
      best = index;
      bestScore = score;
      tie = false;
    } else if (score && score === bestScore) {
      tie = true;
    }
  });
  return tie ? -1 : best;
}

function markPick(item, markdown) {
  const index = pickIndex(markdown, item._products);
  if (index < 0) return;
  const wrap = item.querySelectorAll(".cards > .card-wrap:not(.skeleton)")[index];
  if (!wrap || wrap.classList.contains("picked")) return;
  wrap.classList.add("picked");
  wrap.append(h("span", { class: "pick-badge" }, t("pickBadge")));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function compact(value) {
  const number = Number(value);
  return number >= 1000 ? `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k` : String(number);
}

function scrollToEnd(force = false) {
  const el = els.list;
  const go = () => {
    if (!force && el.scrollHeight - el.scrollTop - el.clientHeight >= 360) return;
    el.scrollTop = el.scrollHeight;
  };
  go();
  requestAnimationFrame(go);
}

restoreChat();
saveChat();
renderChatList();
finishStripeReturn();
renderQuick();
