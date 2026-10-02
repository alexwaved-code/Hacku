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
  examples: document.querySelectorAll("#examples [data-prompt]"),
};

const CHAT_KEY = "hacku.chat";
const CHATS_KEY = "hacku.chats";
const CURRENT_KEY = "hacku.currentChat";
const IDLE_TIMEOUT_MS = 75000;
const GREETING = "想買什麼？說出預算、用途，或想逛的商店，我幫你上網查。其他問題也可以問我。";
const PLACEHOLDER = "想買什麼，或想問什麼？";
const ASK_PLACEHOLDER = "點上面的選項，或直接打字回答";

const state = {
  thread: [],
  busy: false,
  controller: null,
  pendingAsk: null,
};

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.input.value;
  if (!text.trim() || state.busy) return;
  els.input.value = "";
  send(text);
});
els.stop.addEventListener("click", () => state.controller?.abort());
els.examples.forEach((button) => button.addEventListener("click", () => send(button.dataset.prompt)));
els.newChat.forEach((button) => button.addEventListener("click", resetChat));
els.cartLink?.addEventListener("click", saveChat);
window.addEventListener("pagehide", saveChat);
updateCartCount();

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
  renderSideCart();
}

function renderSideCart() {
  if (!els.sideCart) return;
  const items = HackuCart.load();
  els.sideCart.replaceChildren();
  if (!items.length) {
    els.sideCart.append(h("p", { class: "side-empty" }, "還沒有商品。"));
    renderSideTotal(items);
    return;
  }
  const list = h("ul", { class: "side-cart-list" });
  for (const item of items) {
    const remove = h("button", { type: "button", class: "pill" }, "移除");
    remove.addEventListener("click", () => {
      HackuCart.remove(item.id);
      updateCartCount();
    });
    const price = HackuMoney.text(item.price, item.currency) || "價格見商店";
    const picture = item.image
      ? h("img", { class: "side-cart-pic", src: item.image, alt: "", referrerpolicy: "no-referrer" })
      : h("span", { class: "side-cart-pic missing", "aria-hidden": "true" });
    list.append(
      h(
        "li",
        { class: "side-cart-item" },
        picture,
        h(
          "div",
          {},
          h("p", { class: "side-cart-name" }, item.name),
          h("p", { class: "side-cart-meta" }, `${item.store || "商店"} · x${item.qty || 1} · ${price}`),
          remove
        )
      )
    );
  }
  els.sideCart.append(list, h("a", { class: "pill side-checkout", href: "cart.html" }, "去結帳"));
  renderSideTotal(items);
}

function renderSideTotal(items) {
  const total = document.querySelector("#side-total");
  if (!total) return;
  if (!items.length) {
    total.textContent = "";
    return;
  }
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
  const parts = [...sums.entries()].map(([code, amount]) => HackuMoney.text(amount, code));
  total.textContent = parts.length
    ? `合計 ${parts.join("、")}${missing ? "（部分見商店）" : ""}`
    : "合計見商店";
}

function setBusy(busy) {
  state.busy = busy;
  els.send.hidden = busy;
  els.stop.hidden = !busy;
  els.examples.forEach((button) => {
    button.disabled = busy;
  });
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
  els.list.replaceChildren(h("li", { class: "message agent" }, GREETING));
  renderChatList();
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

function renderChatList() {
  if (!els.chatList) return;
  const chats = loadChats();
  els.chatList.replaceChildren();
  if (!chats.length) {
    els.chatList.append(h("li", { class: "side-empty" }, "還沒有對話。"));
    return;
  }
  const current = currentChatId();
  for (const chat of chats) {
    const button = h("button", { type: "button", class: chat.id === current ? "current" : "" }, chat.title || "對話");
    button.addEventListener("click", () => openChat(chat.id));
    els.chatList.append(h("li", {}, button));
  }
}

function openChat(id) {
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
  if (!saved) {
    els.list.replaceChildren(h("li", { class: "message agent" }, GREETING));
    return;
  }
  state.thread = Array.isArray(saved.thread) ? saved.thread : [];
  els.list.replaceChildren();
  for (const entry of saved.view || []) {
    if (entry.kind === "user") appendUser(entry.text);
    else if (entry.kind === "agent") appendSavedAgent(entry);
    else els.list.append(h("li", { class: "message agent" }, entry.text || GREETING));
  }
  if (!els.list.children.length) els.list.append(h("li", { class: "message agent" }, GREETING));
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
  const chats = loadChats().filter((chat) => chat.id !== currentChatId());
  chats.unshift({
    id: currentChatId(),
    title: title.slice(0, 42),
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
  return [...els.list.children].map((item) => {
    if (item.classList.contains("user")) return { kind: "user", text: item.textContent };
    if (item.classList.contains("turn")) {
      return {
        kind: "agent",
        text: item._markdown || item.querySelector(".text")?.innerText || "",
        products: item._products || [],
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
  if (products.length) cards.append(...products.map((product, index) => productCard(product, index === 0)));
  const item = h("li", { class: "message agent turn" }, cards, text);
  item._markdown = entry.text || "";
  item._products = products;
  els.list.append(item);
}

/* ---------- Messages ---------- */

function appendUser(text) {
  const item = h("li", { class: "message user" }, text);
  els.list.append(item);
  scrollToEnd(true);
  return item;
}

function createTurn() {
  const status = h("p", { class: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", {}, "思考中…"));
  const cards = h("div", { class: "cards" });
  const text = h("div", { class: "text" });
  const item = h("li", { class: "message agent turn" }, status, cards, text);
  els.list.append(item);
  scrollToEnd(true);

  const typer = createTyper(text);
  const running = new Map();

  const showStatus = () => {
    const labels = [...running.values()];
    status.hidden = false;
    status.lastChild.textContent = labels.length ? `${labels.join("、")}…` : "整理中…";
  };

  return {
    timedOut: false,
    write(piece) {
      if (!piece) return;
      status.hidden = true;
      typer.push(piece);
    },
    retract() {
      typer.reset();
      showStatus();
    },
    stepStart(event) {
      running.set(event.id, event.label || event.name);
      showStatus();
    },
    stepDone(event) {
      running.delete(event.id);
      showStatus();
      if (event.ui?.kind === "products") {
        item._products = event.ui.items;
        cards.replaceChildren(...event.ui.items.map((product, index) => productCard(product, index === 0)));
        scrollToEnd();
      }
    },
    ask(event) {
      status.hidden = true;
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
      status.remove();
      item.querySelector(".ask button")?.focus({ preventScroll: true });
    },
    stop() {
      typer.flush();
      status.remove();
      item.append(h("p", { class: "note" }, "已停止"));
      return typer.text().trim();
    },
    fail(message, onRetry) {
      typer.cancel();
      status.remove();
      text.replaceChildren(
        h("p", { class: "error" }, message),
        h("button", { type: "button", class: "pill", onclick: onRetry }, "重試")
      );
      scrollToEnd();
    },
    remove() {
      item.remove();
    },
  };
}

function productCard(product, best) {
  const picture = product.image
    ? h("img", { src: product.image, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: hideBrokenImage })
    : null;
  const rating =
    product.rating != null
      ? h("span", { class: "rating" }, `★ ${Number(product.rating).toFixed(1)}`, product.reviews ? `（${compact(product.reviews)}）` : "")
      : null;
  const content = [
    h("div", { class: "pic" }, picture, best ? h("span", { class: "badge" }, "首選") : null),
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
  return h("div", { class: "card-wrap" }, card, h("div", { class: "cart-controls" }, add, qtyBtn));
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
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
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
