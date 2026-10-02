const messages = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const input = document.querySelector("#message");
const sendButton = composer.querySelector("button");

const thread = [
  {
    role: "system",
    content:
      "You are a shopping assistant. Answer the user's questions about products and purchases. Keep replies concise. You cannot pay, open wallets, or complete a checkout.",
  },
];

appendMessage("agent", "Ask me about a purchase.");

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  thread.push({ role: "user", content: text });
  appendMessage("user", text);
  const pending = appendMessage("agent", "Thinking…", true);
  const typer = createTyper(pending);
  setBusy(true);

  try {
    const reply = await askAgent(thread, (chunk) => typer.push(chunk));
    const shown = await typer.finish();
    pending.textContent = shown || reply;
    pending.classList.remove("pending", "typing");
    thread.push({ role: "assistant", content: reply });
  } catch (error) {
    typer.cancel();
    const detail = error instanceof Error ? error.message : "Request failed.";
    pending.textContent = detail;
    pending.classList.remove("pending", "typing");
  } finally {
    setBusy(false);
    input.focus();
  }
});

function appendMessage(role, text, pending = false) {
  const item = document.createElement("li");
  item.className = pending ? `message ${role} pending` : `message ${role}`;
  item.textContent = text;
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
  return item;
}

function setBusy(busy) {
  input.disabled = busy;
  sendButton.disabled = busy;
}

function createTyper(el) {
  let queue = "";
  let shown = "";
  let timer = null;
  let cancelled = false;

  function paint() {
    el.textContent = shown;
    messages.scrollTop = messages.scrollHeight;
  }

  function tick() {
    timer = null;
    if (cancelled || !queue) return;
    const ch = queue[0];
    queue = queue.slice(1);
    shown += ch;
    paint();
    timer = window.setTimeout(tick, ch === "\n" ? 36 : 18);
  }

  return {
    push(text) {
      if (cancelled || !text) return;
      if (el.classList.contains("pending")) {
        el.textContent = "";
        el.classList.remove("pending");
      }
      el.classList.add("typing");
      queue += text;
      if (timer == null) tick();
    },
    async finish() {
      while (!cancelled && (queue || timer != null)) {
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      el.classList.remove("typing");
      return shown;
    },
    cancel() {
      cancelled = true;
      queue = "";
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
      el.classList.remove("typing");
    },
  };
}

async function askAgent(history, onDelta) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  let response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        messages: history.map(({ role, content }) => ({ role, content })),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The model took too long. Try again.");
    }
    throw new Error("Cannot reach the local chat server. Run python3 web/server.py");
  }

  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/event-stream")) {
    clearTimeout(timer);
    const raw = await response.text();
    if (raw.includes("data:")) {
      return readSseText(raw, onDelta);
    }
    let payload = {};
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
    if (typeof payload.reply === "string" && payload.reply.trim()) {
      const reply = payload.reply.trim();
      onDelta(reply);
      return reply;
    }
    throw new Error(
      readJsonError(payload) || raw.trim().slice(0, 180) || `The model request failed (${response.status}).`
    );
  }

  if (!response.body) {
    clearTimeout(timer);
    throw new Error("The model stream is empty.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const result = readSseData(part);
        if (!result) continue;
        if (result.error) throw new Error(result.error);
        if (result.delta) {
          reply += result.delta;
          onDelta(result.delta);
        }
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  if (!reply.trim()) {
    throw new Error("The model returned an empty reply.");
  }
  return reply.trim();
}

function readSseText(raw, onDelta) {
  let reply = "";
  for (const part of raw.split("\n\n")) {
    const result = readSseData(part);
    if (!result) continue;
    if (result.error) throw new Error(result.error);
    if (result.delta) {
      reply += result.delta;
      onDelta(result.delta);
    }
  }
  if (!reply.trim()) {
    throw new Error("The model returned an empty reply.");
  }
  return reply.trim();
}

function readJsonError(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.error === "string") return payload.error;
  const err = payload.error;
  if (err && typeof err === "object") {
    if (typeof err.message === "string") return err.message;
    if (typeof err.msg === "string") return err.msg;
  }
  if (typeof payload.message === "string") return payload.message;
  return "";
}

function readSseData(block) {
  const line = block.split("\n").find((item) => item.startsWith("data:"));
  if (!line) return null;
  const raw = line.slice(5).trim();
  if (!raw || raw === "[DONE]") return { done: true };
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
