# Devlog — web

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

## 2026-10-02 16:15

Chat page + local proxy. Setup is in `web/README.md`. Model: `deepseek-v4.1-flash` at `https://xh.v1api.cc/v1`. Thinking is off. Replies stream. Key stays in `web/.env`.

## 2026-10-02 16:24 (G1)

`web/agent_prompt.py` builds the system message for a spending decision: a short decision prompt, five skills, the mandate JSON, the rate card, and the server clock in `+08:00`.

The agent may allow a purchase only after `mandate.enforce` and `basket.total` pass. Entertainment over $50 is `ENT_TX`. Anything after 7 Oct 2026 is `EXPIRY`. Card A at 5% grocery cashback and 2% general, and a point at $0.01, are a scenario fixture supplied on 2026-10-02, not a live quote.

## 2026-10-02 16:39 (G1)

The purchase path is a ReAct loop in `web/loop.py`, not a single chat reply.

Reason reads the category and amount. Act checks the mandate. Negotiate compares Mastercard and UnionPay. Execute stays closed until the customer authorizes, and `/api/settle` checks a `did:example` consent credential (signature, expiry, revocation, cap) before anything is recorded.

Mastercard's 5% grocery and 2% general cashback are the scenario fixture supplied on 2026-10-02. UnionPay has no cashback on that fixture, so its reward stays unknown. The model may phrase the result. It does not choose the rail or the decision.

## 2026-10-02 17:20

The chat is now a shopping research agent with live data.

- `web/agent/harness.py` runs up to 7 model rounds. Tool calls in one round run in parallel. The last round cannot call tools.
- `web/agent/tools.py` exposes `shop_search`, `show_products`, `web_search`, `open_page`. There is no order or payment tool.
- `web/agent/web.py` calls Serper (Google Shopping and Google search, `gl=hk`) and reads pages with the standard library.
- Card prices, pictures, and links come from the search cache by `ref`, not from model text.
- The model answers in at most two sentences. The cards carry picture, price, store, and link.

Checked on 2026-10-02: "HK$500 以內，通勤用的降噪耳機" returned Anker Soundcore R60i NC at HK$299 (Wellent), SOUL Sync ANC at HK$484, and Final Audio ZE300 at HK$399. "直接幫我下單" was declined and pointed to the store card.

Keyless search (DuckDuckGo, Bing, Yahoo, Startpage, Mojeek) blocked the server or returned unrelated results, so search needs `SERPER_API_KEY`.

Google Shopping `link` values open an empty Google redirect page outside Google. Cards now link to the store's product page (same store domain, same model number, not a category or promotion page) or, when none is found, to a Google search for the product and store. In a check of 9 cards, 7 linked straight to the store.

The model sometimes skipped `show_products` and wrote a table instead. After any tool returns refs, the next round now forces `show_products`, and replies are capped at 250 tokens.

Added `ask_user`. For an open request such as "推薦耳機", the agent first asks budget, use, and type as one card. After the cards, it may ask one trade-off question between its picks, for example "Clip 5：掛勾扣背包 / Go 4：更輕更便宜". The answer returns as the tool result, so the loop continues without a new user message. Typed text while a card is open counts as the answer. A tool call left without a reply is answered with `{"skipped": true}` before the next model call.

The gateway sometimes stalls a stream. Reads time out after 25 s. A round with no output yet is retried once. A reply that stalls after some text keeps that text.

## 2026-10-02 17:28 (G1)

The purchase loop filters a demo shelf (`web/catalog.py`) and sends that list to a second agent in `web/verifier.py`. The verifier does not talk to the shopper. Its only tool is `rate_listing`: 3 is acceptable, 2 goes back for reconsideration, and 1 is a reject. The loop drops anything that is not a 3 and will not settle an empty list.

The second model is read from `VERIFY_API_BASE`, `VERIFY_API_KEY`, and `VERIFY_MODEL`. Those are empty until the API arrives. Until then every listing is unrated, which the loop treats as reconsider. The shelf prices are scenario fixtures, not observed store prices.

## 2026-10-02 17:39

The payment path is a shield. The mandate names the agent, the scenes, the merchant list, the caps, a quantity limit of 2 entertainment tickets, and the expiry. The rule gate vetoes a mismatch. The intent gate uses `rate_listing` and cannot pay. The intel gate checks a demo watchlist from 2026-10-02, not a live fraud feed. Green settles, yellow waits for confirmation, and red blocks for 10 minutes. `POST /api/cool` ends the cooling period.

## 2026-10-02 17:45

Merged `g1` into `g2`. The page stays the shopping research chat. One server serves both paths:

- `POST /api/chat`: the streaming research agent.
- `POST /api/purchase`: the purchase shield (`{"message": "Buy groceries for 80 USD."}`).
- `GET /api/consent`, `POST /api/settle`, `POST /api/revoke`, `POST /api/cool`: consent, settlement, revocation, and cooling.

The page does not call the purchase or settlement routes yet.
