# Devlog — G2 chat UI

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

Mandates, spend caps, payment routes, rewards, and logs. Those wait on the next design pass.

## 2026-10-02 16:15

Pulled `main`. It was already even with `g2`.

Connected the chat to `https://xh.v1api.cc`. The only model listed there at 16:15 was `deepseek-v4.1-flash`. A one-word completion test returned `pong`.

**How it is wired**

- The key lives in the repo-root `.env`, which git already ignores.
- `web/server.py` serves the page and posts `/api/chat` to `/v1/chat/completions`.
- The browser never receives the key. `web/app.js` sends the conversation to `/api/chat` only.

The agent can advise. It is told it cannot spend or place an order.

## 2026-10-02 16:24

Replaced that limit with a mandate. `web/agent_prompt.py` builds the system message: a short decision prompt, five skills, the mandate JSON, the rate card, and the server clock in `+08:00`. `web/server.py` sends it with `temperature` 0.

The agent may allow a purchase only after `mandate.enforce` and `basket.total` pass. Entertainment over $50 is `ENT_TX`. Anything after 7 Oct 2026 is `EXPIRY`. Card A at 5% grocery cashback and 2% general, and a point at $0.01, are a scenario fixture supplied on 2026-10-02, not a live quote.

## 2026-10-02 16:31

The composer now tells the customer what a spending decision needs: category, amount, and shipping or tax if known. Two examples fill the box. If either category or amount is missing, `ask.decide` asks instead of allowing or refusing.

## 2026-10-02 16:39

This session is G1. The purchase path is a ReAct loop in `web/loop.py`, not a single chat reply.

Reason reads the category and amount. Act checks the mandate. Negotiate compares Mastercard and UnionPay. Execute stays closed until the customer authorizes, and `/api/settle` checks a `did:example` consent credential (signature, expiry, revocation, cap) before anything is recorded.

Mastercard's 5% grocery and 2% general cashback are the scenario fixture supplied on 2026-10-02. UnionPay has no cashback on that fixture, so its reward stays unknown. The model may phrase the result. It does not choose the rail or the decision.

## 2026-10-02 17:28

The shopping agent now filters a demo shelf and sends that list to a second agent in `web/verifier.py`. The verifier does not talk to the shopper. Its only tool is `rate_listing`: 3 is acceptable, 2 goes back for reconsideration, and 1 is a reject. The shopping agent drops anything that is not a 3 and will not settle an empty list.

The second model is read from `VERIFY_API_BASE`, `VERIFY_API_KEY`, and `VERIFY_MODEL`. Those are empty until the API arrives. Until then every listing is unrated, which the shopping agent treats as reconsider. The shelf prices are scenario fixtures, not observed store prices.
