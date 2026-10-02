const messages = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const input = document.querySelector("#message");
const sendButton = composer.querySelector("button");

const thread = [
  {
    role: "system",
    content:
      "You are a shopping assistant. Answer the user's questions about products and purchases. You cannot pay, open wallets, or complete a checkout.",
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
    const reply = await askAgent(thread);
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

async function askAgent(history) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: history.map(({ role, content }) => ({ role, content })),
    }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || "The model request failed.");
  }
  if (typeof payload.reply !== "string" || !payload.reply.trim()) {
    throw new Error("The model returned an empty reply.");
  }
  return payload.reply.trim();
}
