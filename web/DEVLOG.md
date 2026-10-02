# Devlog — G2 chat UI

## 2026-10-02 16:05

The chat page sends the thread to `web/server.py`, which calls DeepSeek V4.1 Flash at `https://xh.v1api.cc/v1`. The model id is `deepseek-v4.1-flash`. The key lives in `web/.env`.

Run `python3 web/server.py` and open `http://127.0.0.1:8765/`.

## 2026-10-02 15:45

Built the first screen for the HKT agentic-commerce brief: one chat the user can type into. No shopping, payment, or rewards logic yet. The API is not available.

**What shipped**

- `web/index.html` — title, message list, one text field, Send.
- `web/styles.css` — single column, user messages on the right, agent messages on the left.
- `web/app.js` — appends the user's text, then calls `askAgent`.

**Decision**

`askAgent` is a stub. It echoes the message and says it cannot shop or spend. When the API arrives, only that function changes. The page stays the same.

**Checked**

Opened `http://127.0.0.1:8765/` and sent two messages. Each one showed the user text, then the stub reply, and the input cleared.

**Not in this slice**

Mandates, spend caps, payment routes, rewards, logs, and a real model. Those wait on the API and the group's next design pass.
