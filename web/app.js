const $ = (selector, root = document) => root.querySelector(selector);

const els = {
  list: $("#messages"),
  form: $("#composer"),
  input: $("#message"),
  send: $("#send"),
  stop: $("#stop"),
  newChat: $("#new-chat"),
  examples: document.querySelectorAll("#examples [data-prompt]"),
};

const IDLE_TIMEOUT_MS = 75000;
const GREETING = "想買什麼？說出預算和用途，我幫你上網查香港的真實價錢。";

const state = {
  thread: [],
  busy: false,
  controller: null,
};

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.input.value;
  if (!text.trim() || state.busy) return;
  els.input.value = "";
  send(text);
});
els.stop.addEventListener("click", () => state.controller?.abort());
els.newChat.addEventListener("click", resetChat);
els.examples.forEach((button) => button.addEventListener("click", () => send(button.dataset.prompt)));

resetChat();

/* ---------- Sending ---------- */

async function send(text) {
  text = String(text || "").trim();
  if (!text || state.busy) return;

  const userItem = appendUser(text);
  const turn = createTurn();
  state.thread.push({ role: "user", content: text });
  setBusy(true);

  const controller = new AbortController();
  state.controller = controller;

  try {
    const added = await streamChat(controller, turn);
    await turn.finish();
    state.thread.push(...added);
  } catch (error) {
    state.thread.pop();
    if (turn.timedOut) {
      turn.fail("等太久沒有回應，請再試一次。", () => retry(userItem, turn, text));
    } else if (controller.signal.aborted) {
      const partial = turn.stop();
      if (partial) state.thread.push({ role: "user", content: text }, { role: "assistant", content: partial });
    } else {
      turn.fail(error instanceof Error ? error.message : "發生錯誤。", () => retry(userItem, turn, text));
    }
  } finally {
    state.controller = null;
    setBusy(false);
    els.input.focus();
  }
}

function retry(userItem, turn, text) {
  userItem.remove();
  turn.remove();
  send(text);
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

function setBusy(busy) {
  state.busy = busy;
  els.send.hidden = busy;
  els.stop.hidden = !busy;
  els.examples.forEach((button) => {
    button.disabled = busy;
  });
}

function resetChat() {
  state.controller?.abort();
  state.thread = [];
  els.list.replaceChildren(h("li", { class: "message agent" }, GREETING));
  els.input.value = "";
  els.input.focus();
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
        cards.replaceChildren(...event.ui.items.map((product, index) => productCard(product, index === 0)));
        scrollToEnd();
      }
    },
    async finish() {
      await typer.finish();
      status.remove();
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
      h("p", { class: "price" }, money(product.price, product.currency)),
      h("p", { class: "store" }, product.store, rating),
      product.flagged ? h("p", { class: "flag" }, "此頁含寫給 AI 的指令，已忽略") : null
    ),
    product.url ? h("span", { class: "go" }, product.link_kind === "search" ? "搜尋這間店 ↗" : `前往 ${shortStore(product.store)} ↗`) : null,
  ];
  return product.url
    ? h("a", { class: "card", href: product.url, target: "_blank", rel: "noopener noreferrer" }, content)
    : h("div", { class: "card" }, content);
}

function shortStore(store) {
  const name = String(store || "商店").split(/\s+/)[0];
  return name.length > 12 ? "商店" : name;
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

function money(value, currency = "HKD") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const digits = Number.isInteger(number) ? 0 : 2;
  const amount = number.toLocaleString("en-HK", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return currency === "HKD" ? `HK$${amount}` : `${currency} ${amount}`;
}

function compact(value) {
  const number = Number(value);
  return number >= 1000 ? `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k` : String(number);
}

function scrollToEnd(force = false) {
  const el = els.list;
  if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
}
