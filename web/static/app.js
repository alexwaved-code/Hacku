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
  openChats: $("#open-chats"),
  scrim: $(".scrim"),
};
const narrowScreen = window.matchMedia("(max-width: 900px)");

const CHAT_KEY = "hacku.chat";
const CHATS_KEY = "hacku.chats";
const CURRENT_KEY = "hacku.currentChat";
const IDLE_TIMEOUT_MS = 75000;
const GREETING = "想買什麼？說出預算、用途，或想逛的商店，我幫你上網查。其他問題也可以問我。";
const PLACEHOLDER = "想買什麼，或想問什麼？";
const ASK_PLACEHOLDER = "點上面的選項，或直接打字回答";
const EXAMPLES = [
  ["降噪耳機", "HK$500 以內，通勤用的降噪耳機"],
  ["行動電源", "可以充手提電腦的行動電源"],
  ["淘寶手機殼", "淘寶上的 iPhone 16 手機殼"],
  ["生日禮物", "送給爸爸的生日禮物，HK$800 以內"],
];
const FOLLOW_UPS = ["有沒有更便宜的？", "比較前兩個", "換個牌子看看"];
const PHASES = {
  plan: { label: "理解你的需求", hints: ["讀懂預算和用途", "決定要比哪些商店", "準備搜尋關鍵字"] },
  think: { label: "整理剛拿到的資料", hints: ["看看結果夠不夠好", "決定下一步"] },
  answer: { label: "比較商品，寫推薦", hints: ["比較價錢和評價", "檢查規格合不合用", "寫下重點"] },
};
const TOOL_HINTS = {
  shop_search: ["連到 Google 購物", "讀取各家價錢", "濾掉超出預算的"],
  web_search: ["搜尋網頁", "讀取搜尋結果"],
  open_page: ["打開網頁", "讀取價錢和規格"],
  show_products: ["比對商品名稱", "找商店連結"],
  buy: ["核對商品和價錢", "檢查付款授權"],
};
const SKELETON_CARDS = 5;

const state = {
  thread: [],
  busy: false,
  controller: null,
  pendingAsk: null,
};
const cardPainters = new Set();
let cartSeen = null;
let chatsSeen = null;
const NUMERALS = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.input.value;
  if (!text.trim() || state.busy) return;
  els.input.value = "";
  els.form.classList.remove("has-text");
  send(text);
});
els.stop.addEventListener("click", () => state.controller?.abort());
els.input.addEventListener("input", () => els.form.classList.toggle("has-text", !!els.input.value.trim()));
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
els.openChats?.addEventListener("click", () => openDrawer(els.sideChats));
els.scrim?.addEventListener("click", closeDrawers);
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeDrawers));
narrowScreen.addEventListener("change", closeDrawers);
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
updateCartCount();
renderMandate();

/* ---------- Sending ---------- */

function send(text) {
  text = String(text || "").trim();
  if (!text || state.busy) return;
  const reply = takePendingAsk({ user_reply: text });
  runTurn(text, [reply || { role: "user", content: text }]);
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
  els.input.placeholder = PLACEHOLDER;
  ask.close(payload);
  return { role: "tool", tool_call_id: ask.id, content: JSON.stringify(payload) };
}

async function runTurn(display, entries) {
  els.list.querySelectorAll(".follow-ups, .act-retry").forEach((node) => node.remove());
  const userItem = appendUser(display);
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
    if (turn.timedOut) {
      state.thread.length = base;
      turn.fail("等太久沒有回應，請再試一次。", retry);
    } else if (controller.signal.aborted) {
      const partial = turn.stop();
      if (partial) state.thread.push({ role: "assistant", content: partial });
    } else {
      state.thread.length = base;
      turn.fail(error instanceof Error ? error.message : "發生錯誤。", retry);
    }
  } finally {
    state.controller = null;
    setBusy(false);
    if (!state.pendingAsk) els.input.focus();
  }
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
        body: JSON.stringify({ messages: state.thread }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error("連不上伺服器。請先執行 python3 web/server.py");
    }

    if (!(response.headers.get("content-type") || "").includes("text/event-stream")) {
      const raw = await response.text();
      let payload = {};
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = {};
      }
      throw new Error(payload.error || `請求失敗（${response.status}）`);
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
        else if (event.type === "error") throw new Error(event.message || "助理發生錯誤。");
        else if (event.type === "done") added = Array.isArray(event.messages) ? event.messages : [];
      }
    }

    if (!added) throw new Error("連線中斷，請再試一次。");
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
  if (badge) {
    badge.hidden = !count;
    badge.textContent = String(count);
  }
  if (grew) {
    for (const node of [document.querySelector(".cart-mark"), badge]) {
      node?.classList.remove("pulse");
      void node?.offsetWidth;
      node?.classList.add("pulse");
    }
  }
  els.sideCart.replaceChildren();
  if (!items.length) {
    els.sideCart.append(
      h(
        "div",
        { class: "cart-empty" },
        h("span", { class: "cart-empty-icon", "aria-hidden": "true" }, cartIcon()),
        h("strong", {}, "購物車是空的"),
        h("p", {}, "在商品卡按購物車圖示，或跟助理說「幫我買第一個」。")
      )
    );
    renderSideTotal(items);
    return;
  }
  const list = h("ul", { class: "side-cart-list" });
  for (const item of items) list.append(sideCartItem(item, fresh.includes(item.id)));
  els.sideCart.append(list);
  renderSideTotal(items);
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
  const row = h("li", { class: fresh ? "side-cart-item fresh" : "side-cart-item" });
  const change = (delta) => {
    if (qty + delta < 1) {
      row.classList.add("leaving");
      setTimeout(() => {
        HackuCart.remove(item.id);
        updateCartCount();
      }, 220);
      return;
    }
    HackuCart.changeQty(item.id, delta);
    updateCartCount();
  };
  const minus = h(
    "button",
    { type: "button", class: qty > 1 ? "qty-btn" : "qty-btn qty-remove", "aria-label": qty > 1 ? "減一個" : "移除", title: qty > 1 ? "減一個" : "移除" },
    qty > 1 ? "−" : trashIcon()
  );
  const plus = h("button", { type: "button", class: "qty-btn", "aria-label": "加一個", title: "加一個" }, "+");
  minus.addEventListener("click", () => change(-1));
  plus.addEventListener("click", () => change(1));
  row.append(
    picture,
    h(
      "div",
      { class: "side-cart-body" },
      name,
      h("p", { class: "side-cart-meta" }, item.store || "商店"),
      h(
        "div",
        { class: "side-cart-foot" },
        h("div", { class: "qty-step" }, minus, h("span", { class: "qty-count" }, String(qty)), plus),
        h("strong", { class: "side-cart-price" }, line == null ? "價格見商店" : HackuMoney.text(line, item.currency))
      )
    )
  );
  return row;
}

async function renderMandate() {
  const box = document.querySelector("#side-mandate");
  if (!box) return;
  let mandate = null;
  try {
    const response = await fetch("/api/mandate");
    if (response.ok) mandate = await response.json();
  } catch {
    /* The server is down; the chat shows its own error. */
  }
  if (!mandate) return;
  const caps = Object.entries(mandate.caps || {})
    .sort(([a], [b]) => (b === "HKD") - (a === "HKD"))
    .map(([code, cap]) => HackuMoney.text(cap, code));
  const end = mandate.expires ? new Date(mandate.expires) : null;
  const valid = end && !Number.isNaN(end.getTime());
  const until = valid ? `${end.getMonth() + 1}月${end.getDate()}日` : "";
  const days = valid ? Math.max(0, Math.ceil((end - Date.now()) / 86400000)) : null;
  const shield = lineIcon(mandate.valid ? "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3zM9 12l2 2 4-4" : "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3zM12 8v4M12 15.5v.5");
  box.className = `side-mandate ${mandate.valid ? "ok" : "missing"}`;
  box.replaceChildren(
    h("span", { class: "mandate-icon" }, shield),
    h(
      "span",
      { class: "mandate-body" },
      ...(mandate.valid
        ? [
            h("strong", {}, "已授權助理付款"),
            h("span", {}, `每筆上限 ${caps.join("、")}`),
            until ? h("span", { class: "mandate-days" }, days > 0 ? `還有 ${days} 天・到 ${until}` : `今天到期`) : null,
          ]
        : [h("strong", {}, "還沒有付款授權"), h("span", {}, "簽好授權，助理才能幫你下單。")])
    ),
    h("span", { class: "mandate-go", "aria-hidden": "true" }, lineIcon("M9 6l6 6-6 6"))
  );
  box.title = mandate.valid ? "修改付款授權" : "簽署付款授權";
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
  if (label) label.textContent = `${count} 件商品`;
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
  total.textContent = parts.length ? `${parts.join("、")}${missing ? "＋見商店" : ""}` : "見商店";
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
    const t = Math.min(1, (now - started) / 450);
    const eased = 1 - (1 - t) ** 3;
    node.textContent = t < 1 ? HackuMoney.text(Math.round(from + (amount - from) * eased), code) : HackuMoney.text(amount, code);
    if (t < 1) node._frame = requestAnimationFrame(step);
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

function setBusy(busy) {
  state.busy = busy;
  els.send.hidden = busy;
  els.stop.hidden = !busy;
  els.form.classList.toggle("busy", busy);
}

function welcomeItem() {
  const examples = EXAMPLES.map(([title, prompt], index) =>
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
    h("h2", {}, "今天想買什麼？"),
    h("p", {}, "說出預算和用途，我幫你上網比價，挑出最合適的。"),
    h("div", { class: "examples" }, examples)
  );
}

function resetChat() {
  saveChat();
  state.controller?.abort();
  state.thread = [];
  state.pendingAsk = null;
  state.openAsk = null;
  els.input.placeholder = PLACEHOLDER;
  els.input.value = "";
  sessionStorage.setItem(CURRENT_KEY, crypto.randomUUID());
  sessionStorage.removeItem(CHAT_KEY);
  els.list.replaceChildren(welcomeItem());
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
  if (chat.pinned) return "釘選";
  const day = (time) => new Date(time).setHours(0, 0, 0, 0);
  const diff = Math.round((day(Date.now()) - day(chat.updated || 0)) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return "過去 7 天";
  return "更早";
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
      h("li", { class: "chat-empty" }, query ? `找不到「${els.chatSearch.value.trim()}」。` : "還沒有對話。問第一個問題後，會出現在這裡。")
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
    { type: "button", class: "chat-open", title: chat.title || "對話" },
    h("span", { class: "chat-title" }, chat.title || "對話")
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
      tool("重新命名", pencilIcon(), () => startRename(chat.id, button)),
      tool(chat.pinned ? "取消釘選" : "釘選", pinIcon(), () => togglePin(chat.id), chat.pinned ? "pinned" : ""),
      tool("刪除", trashIcon(), () => confirmDelete(chat.id, bar))
    )
  );
  return h("li", { class: "chat-row", "data-id": chat.id }, bar);
}

function confirmDelete(id, bar) {
  const keep = () => renderChatList();
  const yes = h("button", { type: "button", class: "chat-confirm-yes" }, "刪除");
  const no = h("button", { type: "button", class: "chat-confirm-no" }, "取消");
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
  bar.replaceChildren(h("span", { class: "chat-confirm-text" }, "刪除這個對話？"), yes, no);
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
  const input = h("input", { class: "chat-rename", value: chat.title || "", "aria-label": "對話名稱" });
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
    JSON.stringify({ thread: chat.thread || [], view: chat.view || [], openAsk: chat.openAsk || null })
  );
  restoreChat();
  renderChatList();
}

function restoreChat() {
  const saved = readChat();
  state.pendingAsk = null;
  state.openAsk = null;
  els.input.placeholder = PLACEHOLDER;
  if (!saved) {
    els.list.replaceChildren(welcomeItem());
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
    els.input.placeholder = ASK_PLACEHOLDER;
  }
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

function saveChat() {
  const view = snapshotView();
  const payload = {
    thread: state.thread,
    view,
    openAsk: state.openAsk || null,
  };
  try {
    sessionStorage.setItem(CHAT_KEY, JSON.stringify(payload));
  } catch {
    /* The browser refused to store the chat. The cart still works. */
  }
  const title = (view.find((entry) => entry.kind === "user")?.text || "").trim();
  if (!title) return;
  const previous = loadChats().find((chat) => chat.id === currentChatId());
  const chats = loadChats().filter((chat) => chat.id !== currentChatId());
  chats.unshift({
    id: currentChatId(),
    title: previous?.renamed ? previous.title : title.slice(0, 42),
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
  numberCards(cards);
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
  const typing = h("div", { class: "typing", hidden: true, "aria-label": "正在寫回覆" }, h("span"), h("span"), h("span"));
  const item = h("li", { class: "message agent turn" }, activity.el, cards, receipts, text, typing);
  item._receipts = [];
  els.list.append(item);
  scrollToEnd(true);

  const typer = createTyper(text);
  const clearSkeleton = () => cards.querySelectorAll(".skeleton").forEach((node) => node.remove());
  const showSkeleton = () => {
    if (cards.children.length) return;
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
      numberCards(cards);
    },
    stepDone(event) {
      activity.toolDone(event);
      if (event.ui?.kind === "products") {
        this.showCards(event.ui.items);
        scrollToEnd();
      }
      if (event.ui?.kind === "receipt" || event.ui?.kind === "order") {
        const entry = { ...event.ui, call: event.id };
        item._receipts.push(entry);
        receipts.append(paymentCard(entry));
        scrollToEnd();
      }
    },
    ask(event) {
      activity.finish("需要你選一下");
      typing.hidden = true;
      clearSkeleton();
      const card = askCard(event.questions || []);
      item.append(card.el);
      state.openAsk = { id: event.id, questions: event.questions || [] };
      state.pendingAsk = { id: event.id, close: card.close };
      els.input.placeholder = ASK_PLACEHOLDER;
      scrollToEnd();
    },
    async finish() {
      await typer.finish();
      item._markdown = typer.text();
      typing.remove();
      clearSkeleton();
      markPick(item, item._markdown);
      activity.finish("完成");
      item.querySelector(".ask button")?.focus({ preventScroll: true });
    },
    addActions(onRetry) {
      const said = typer.text().trim();
      const copy = h("button", { type: "button", class: "act-btn", title: "複製回覆" }, copyIcon(), "複製");
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(said);
          copy.lastChild.textContent = "已複製";
          setTimeout(() => {
            copy.lastChild.textContent = "複製";
          }, 1400);
        } catch {
          copy.lastChild.textContent = "無法複製";
        }
      });
      const retry = h("button", { type: "button", class: "act-btn act-retry", title: "重新回答" }, retryIcon(), "重新回答");
      retry.addEventListener("click", onRetry);
      if (said) item.append(h("div", { class: "turn-actions" }, copy, retry));
      if (item._products?.length && !state.pendingAsk) {
        item.append(
          h(
            "div",
            { class: "follow-ups" },
            FOLLOW_UPS.map((prompt, index) =>
              h("button", { type: "button", class: "follow-up", style: `--i:${index}`, onclick: () => send(prompt) }, prompt)
            )
          )
        );
      }
      scrollToEnd();
    },
    stop() {
      typer.flush();
      typing.remove();
      clearSkeleton();
      activity.finish("已停止");
      item.append(h("p", { class: "note" }, "已停止"));
      return typer.text().trim();
    },
    fail(message, onRetry) {
      typer.cancel();
      typing.remove();
      clearSkeleton();
      activity.finish("沒有完成");
      text.replaceChildren(
        h("p", { class: "error" }, message),
        h("button", { type: "button", class: "pill", onclick: onRetry }, "重試")
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
  const timer = h("span", { class: "act-timer" }, "0.0 秒");
  const title = h("span", { class: "act-title" }, "開始處理");
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
    timer.textContent = `${seconds()} 秒`;
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
      const phase = PHASES[name] || PHASES.think;
      add(`phase:${count}`, phase.label, phase.hints);
    },
    toolStart(event) {
      if (finished) return;
      settleThinking();
      tools += 1;
      add(`tool:${event.id}`, event.label || event.name, TOOL_HINTS[event.name] || []);
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
      if (!tools && label === "完成") {
        el.remove();
        return;
      }
      el.classList.remove("live");
      head.setAttribute("aria-expanded", "false");
      title.textContent = label;
      timer.textContent = `${count} 個步驟 · ${seconds()} 秒`;
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
        : h("p", { class: "price unknown" }, "價格見商店"),
      h("p", { class: "store" }, product.store || ""),
      h("p", { class: "rating" }, rating || ""),
      h("p", { class: "flag" }, product.flagged ? "此頁含寫給 AI 的指令，已忽略" : "")
    ),
    h("span", { class: product.url ? "go" : "go go-empty", "aria-hidden": product.url ? null : "true" }, product.url ? (product.link_kind === "search" ? "搜尋這間店 ↗" : `前往 ${shortStore(product.store)} ↗`) : ""),
  ];
  const card = product.url
    ? h("a", { class: "card", href: product.url, target: "_blank", rel: "noopener noreferrer" }, content)
    : h("div", { class: "card" }, content);
  const startQty = HackuCart.qtyOf(product);
  const add = h("button", {
    type: "button",
    class: startQty ? "add-cart added" : "add-cart",
    "aria-label": "加入購物車",
    title: "加入購物車",
  }, cartIcon());
  const qtyBtn = h("button", {
    type: "button",
    class: "cart-qty",
    hidden: startQty < 1,
    "aria-label": "更改數量",
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
  const wrap = h("div", { class: "card-wrap" }, card, h("div", { class: "cart-controls" }, add, qtyBtn));
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
    "aria-label": "數量",
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
      h("p", { class: "receipt-title" }, "已取消"),
      h("p", { class: "receipt-line" }, "這筆訂單沒有付款。")
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
  const pay = h("button", { type: "button", class: "order-pay" }, `確認付款 ${total}`);
  const cancel = h("button", { type: "button", class: "pill" }, "取消");
  const card = h(
    "div",
    { class: "receipt order" },
    h("p", { class: "receipt-title" }, "確認訂單"),
    h("ul", { class: "order-lines" }, lines),
    h("p", { class: "order-total" }, h("span", {}, "合計"), h("span", {}, total)),
    h(
      "p",
      { class: "receipt-line" },
      `授權每筆上限 ${order.cap != null ? HackuMoney.text(order.cap, order.currency) : "—"} · ${
        order.live ? "真實付款，會向商店下單並送到你填的地址" : "Stripe 測試模式，沒有扣真錢"
      }`
    ),
    order.session ? h("p", { class: "receipt-line order-message" }, "付款頁已開啟。付好後會回到這裡。") : message,
    h("div", { class: "order-actions" }, pay, cancel)
  );

  const settle = () => {
    card.replaceWith(orderCard(order));
    syncOrders();
    saveChat();
  };
  pay.addEventListener("click", async () => {
    pay.disabled = cancel.disabled = true;
    pay.textContent = "檢查中…";
    message.hidden = false;
    message.textContent = "正在驗證商品，通常要 10 到 30 秒，之後會打開 Stripe 付款頁。";
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
      pay.textContent = `確認付款 ${total}`;
      message.textContent = response ? data.error || "付款服務發生錯誤，請再按一次。" : "連不上伺服器，請再按一次。";
      return;
    }
    if (!response.ok || !data.url) {
      order.result = { kind: "receipt", paid: false, reason: data.error || "付款被拒絕。" };
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
      h("p", { class: "receipt-title" }, "沒有付款"),
      h("p", { class: "receipt-line" }, receipt.reason || "付款被拒絕。"),
      h("a", { class: "receipt-link", href: "cart.html" }, "到購物車調整授權 ↗")
    );
  }
  const items = (receipt.items || []).map((entry) =>
    h("li", {}, `${entry.name}${entry.qty > 1 ? ` × ${entry.qty}` : ""}`, h("span", { class: "receipt-store" }, entry.store))
  );
  return h(
    "div",
    { class: "receipt paid" },
    h("p", { class: "receipt-title" }, `已付款 ${HackuMoney.text(receipt.amount, receipt.currency)}`),
    h("ul", { class: "receipt-items" }, items),
    receipt.ship_to ? h("p", { class: "receipt-line" }, `送到：${receipt.ship_to}`) : null,
    h("p", { class: "receipt-line" }, receipt.live ? "真實付款。接著會向商店下單，下單後會有商店訂單編號。" : "Stripe 測試模式，沒有扣真錢，也不會向商店下單。"),
    receipt.hash ? h("p", { class: "receipt-line mono" }, `紀錄 ${receipt.hash.slice(0, 12)}`) : null,
    h("a", { class: "receipt-link", href: "orders.html" }, receipt.live ? "查看代購進度 ↗" : "到代購訂單看這筆 ↗")
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
  const picked = questions.map(() => new Set());
  const note = h("input", { class: "ask-note", type: "text", placeholder: "其他想法（可不填）", "aria-label": "其他想法" });
  const submit = h("button", { type: "button", class: "ask-send", disabled: true }, "送出");
  const skip = h("button", { type: "button", class: "pill" }, "略過");
  const quick = questions.length === 1 && !questions[0].multiple;

  const ready = () => picked.every((set) => set.size > 0) || note.value.trim().length > 0;
  const refresh = () => {
    submit.disabled = !ready();
  };

  const groups = questions.map((question, index) => {
    const buttons = question.options.map((label) =>
      h("button", { type: "button", class: "opt", "aria-pressed": "false" }, label)
    );
    buttons.forEach((button) =>
      button.addEventListener("click", () => {
        const set = picked[index];
        const label = button.textContent;
        if (question.multiple) {
          set.has(label) ? set.delete(label) : set.add(label);
        } else {
          set.clear();
          set.add(label);
        }
        buttons.forEach((b) => b.setAttribute("aria-pressed", String(set.has(b.textContent))));
        refresh();
        if (quick) submitAnswers();
      })
    );
    return h(
      "fieldset",
      { class: "q" },
      h("legend", {}, question.prompt, question.multiple ? h("span", { class: "hint" }, "可多選") : null),
      h("div", { class: "opts" }, buttons)
    );
  });

  const submitAnswers = () => {
    if (!ready()) return;
    const answers = questions
      .map((question, index) => ({ question: question.prompt, chosen: [...picked[index]] }))
      .filter((answer) => answer.chosen.length);
    const extra = note.value.trim();
    const payload = extra ? { answers, note: extra } : { answers };
    const display = [...answers.map((answer) => answer.chosen.join("、")), extra].filter(Boolean).join(" · ");
    answerAsk(payload, display);
  };

  note.addEventListener("input", refresh);
  note.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      submitAnswers();
    }
  });
  submit.addEventListener("click", submitAnswers);
  skip.addEventListener("click", () => answerAsk({ skipped: true }, "略過"));

  if (quick) groups[0].querySelector(".opts").append(skip);
  const el = h(
    "div",
    { class: "ask" },
    groups,
    quick ? null : h("div", { class: "ask-foot" }, note, h("div", { class: "ask-actions" }, submit, skip))
  );

  const close = (payload) => {
    el.classList.add("closed");
    el.querySelectorAll("button, input").forEach((control) => {
      control.disabled = true;
    });
    if (payload.skipped) el.append(h("p", { class: "note" }, "已略過"));
    else if (payload.user_reply) el.append(h("p", { class: "note" }, "已改用文字回答"));
  };

  return { el, close };
}

function shortStore(store) {
  const name = String(store || "").trim();
  if (name && name.length <= 10) return name;
  const local = name.split(/\s+/).find((part) => /[\u3400-\u9fff]/.test(part) && part.length <= 8);
  return local || "商店";
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
    .replace(/(?:HK|NT|US|S|A)\$\s?\d[\d,]*(?:\.\d+)?|(?:人民幣\s?)?[¥￥]\s?\d[\d,]*(?:\.\d+)?/g, '<b class="money">$&</b>')
    .replace(/第\s*([一二兩三四五六七八九十]|\d{1,2})\s*(?:個|款|件|張|項)/g, (match, n) => {
      const index = NUMERALS[n] || Number(n);
      return index ? `<span class="ref" data-n="${index}">${match}</span>` : match;
    });
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
  const byNumber = /(?:最推薦|推薦|首選|最適合|建議選|建議買)[^。！？\n]{0,6}?第\s*([一二兩三四五六七八九十]|\d{1,2})\s*(?:個|款|件)/.exec(text);
  if (byNumber) return (NUMERALS[byNumber[1]] || Number(byNumber[1])) - 1;
  const sentence = text.split(/[。！？\n]/).find((part) => /最推薦|推薦|首選|最適合|建議/.test(part));
  if (!sentence) return -1;
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
  wrap.append(h("span", { class: "pick-badge" }, "推薦"));
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
  if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
}

restoreChat();
saveChat();
renderChatList();
finishStripeReturn();
