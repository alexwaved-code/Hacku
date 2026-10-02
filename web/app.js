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
els.newChat.addEventListener("click", resetChat);
els.examples.forEach((button) => button.addEventListener("click", () => send(button.dataset.prompt)));

resetChat();

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
  state.pendingAsk = null;
  els.input.placeholder = PLACEHOLDER;
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
    ask(event) {
      status.hidden = true;
      const card = askCard(event.questions || []);
      item.append(card.el);
      state.pendingAsk = { id: event.id, close: card.close };
      els.input.placeholder = ASK_PLACEHOLDER;
      scrollToEnd();
    },
    async finish() {
      await typer.finish();
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
        ? h("p", { class: "price" }, money(product.price, product.currency))
        : h("p", { class: "price unknown" }, "價格見商店"),
      h("p", { class: "store" }, product.store, rating),
      product.flagged ? h("p", { class: "flag" }, "此頁含寫給 AI 的指令，已忽略") : null
    ),
    product.url ? h("span", { class: "go" }, product.link_kind === "search" ? "搜尋這間店 ↗" : `前往 ${shortStore(product.store)} ↗`) : null,
  ];
  return product.url
    ? h("a", { class: "card", href: product.url, target: "_blank", rel: "noopener noreferrer" }, content)
    : h("div", { class: "card" }, content);
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

const CURRENCY_SIGNS = {
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

function money(value, currency = "HKD") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const digits = Number.isInteger(number) ? 0 : 2;
  const amount = number.toLocaleString("en-HK", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = CURRENCY_SIGNS[currency];
  return sign ? `${sign}${amount}` : `${currency} ${amount}`;
}

function compact(value) {
  const number = Number(value);
  return number >= 1000 ? `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k` : String(number);
}

function scrollToEnd(force = false) {
  const el = els.list;
  if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
}
