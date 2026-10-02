const messages = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const input = document.querySelector("#message");
const sendButton = composer.querySelector("button");
const examples = document.querySelectorAll(".examples button");
const consent = document.querySelector("#consent");
const revokeButton = document.querySelector("#revoke");

appendMessage(
  "agent",
  "Tell me a category and an amount. You will see Mastercard and UnionPay compared, then you authorize settlement."
);

examples.forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.example;
    input.focus();
  });
});

revokeButton.addEventListener("click", async () => {
  revokeButton.disabled = true;
  try {
    const response = await fetch("/api/revoke", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not revoke.");
    consent.textContent = data.detail;
    appendMessage("agent", data.text);
  } catch (error) {
    appendMessage("agent", error instanceof Error ? error.message : "Could not revoke.");
    revokeButton.disabled = false;
  }
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  appendMessage("user", text);
  setBusy(true);

  try {
    const turn = await askAgent(text);
    appendTurn(turn);
  } catch (error) {
    appendMessage("agent", error instanceof Error ? error.message : "Request failed.");
  } finally {
    setBusy(false);
    input.focus();
  }
});

loadConsent();

async function loadConsent() {
  try {
    const response = await fetch("/api/consent");
    const data = await response.json();
    consent.textContent = data.detail;
  } catch {
    consent.textContent = "Consent status is unavailable.";
  }
}

async function askAgent(message) {
  let response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
  } catch {
    throw new Error("The chat server is not running.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  if (!Array.isArray(data.steps)) throw new Error("The agent returned no steps.");
  return data;
}

async function authorize(draftId, executeText, button) {
  button.disabled = true;
  try {
    const response = await fetch("/api/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Settlement refused.");
    executeText.textContent = data.text;
    button.remove();
  } catch (error) {
    executeText.textContent = error instanceof Error ? error.message : "Settlement refused.";
    button.disabled = false;
  }
}

function appendTurn(turn) {
  const item = document.createElement("li");
  item.className = "message agent turn";
  turn.steps.forEach((step) => {
    const block = document.createElement("section");
    block.className = `step ${step.status || ""}`;
    const title = document.createElement("h2");
    title.textContent = step.title;
    const text = document.createElement("p");
    text.textContent = step.text;
    block.append(title, text);
    (step.products || []).forEach((product) => {
      const row = document.createElement("p");
      row.className = "product";
      const rating = product.rating == null ? "not rated" : `rating ${product.rating}`;
      row.textContent = `${product.name}: ${rating}. ${product.reason}`;
      block.append(row);
    });
    (step.rails || []).forEach((rail) => {
      const row = document.createElement("p");
      row.className = rail.recommended ? "rail recommended" : "rail";
      const reward = rail.reward == null ? "reward unknown" : `$${Number(rail.reward).toFixed(2)} back`;
      const pick = rail.recommended ? "Use " : "";
      row.textContent = `${pick}${rail.name}: ${rail.rateLabel}. ${reward}. ${rail.source}`;
      block.append(row);
    });
    if (step.phase === "execute" && turn.canSettle) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "authorize";
      button.textContent = "Authorize settlement";
      button.addEventListener("click", () => authorize(turn.draftId, text, button));
      block.append(button);
    }
    item.append(block);
  });
  const echoed = turn.steps.some((step) => step.text === turn.note);
  if (turn.note && !echoed) {
    const why = document.createElement("p");
    why.className = "why";
    why.textContent = turn.note;
    item.append(why);
  }
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
}

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
  examples.forEach((button) => {
    button.disabled = busy;
  });
}
