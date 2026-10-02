const messages = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const input = document.querySelector("#message");
const sendButton = composer.querySelector("button");

appendMessage("agent", "Ask me about a purchase. The API is not connected yet.");

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  appendMessage("user", text);
  setBusy(true);

  try {
    const reply = await askAgent(text);
    appendMessage("agent", reply);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Request failed.";
    appendMessage("agent", detail);
  } finally {
    setBusy(false);
    input.focus();
  }
});

function appendMessage(role, text) {
  const item = document.createElement("li");
  item.className = `message ${role}`;
  item.textContent = text;
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
}

function setBusy(busy) {
  input.disabled = busy;
  sendButton.disabled = busy;
}

/**
 * Swap this body when the API is ready.
 * Keep the return value as the agent's reply text.
 */
async function askAgent(message) {
  return `Got it: “${message}”. I cannot shop or spend until the API is connected.`;
}
