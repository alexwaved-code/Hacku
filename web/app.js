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
  setBusy(true);

  try {
    const reply = await askAgent(thread, (chunk) => {
      if (pending.classList.contains("pending")) {
        pending.textContent = "";
        pending.classList.remove("pending");
      }
      pending.textContent += chunk;
      messages.scrollTop = messages.scrollHeight;
    });
    pending.textContent = reply;
    pending.classList.remove("pending");
    thread.push({ role: "assistant", content: reply });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Request failed.";
    pending.textContent = detail;
    pending.classList.remove("pending");
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

async function askAgent(history, onDelta) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  let response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    throw new Error(payload.error || "The model request failed.");
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
