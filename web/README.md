# Shopping assistant

A chat page that researches real products, in Hong Kong by default or in one store or country the user names, and a cart that pays through Stripe in test mode. It also answers ordinary questions. The browser talks only to `web/server.py`. Keys stay in local `web/.env`.

The shopper signs a spending mandate first: a cap per order for each currency, valid 1 to 30 days. There are two ways to pay inside it:

- **The assistant prepares, the shopper confirms.** The shopper saves a Stripe test card once, then says 「幫我買第一個」 in the chat. The assistant calls `buy` with the card's ref. The server checks the card, the mandate, and the cooling period, and the chat shows a 「確認訂單」 card with the items, the total, the card, and the cap. Nothing is paid until the shopper presses 「確認付款」. Then the verifier rates the items, the saved card is charged off-session, and the card turns into a receipt. 「取消」 closes the order unpaid.
- **The shopper pays.** Cards go to the cart, and the shopper presses pay on Stripe Checkout.

Either way, no real money moves, and the store does not get an order.

## Layout

`web/` is the Python import root: `server.py` runs from here, and every module imports `config`, `agent`, or `pay` by those names.

| Path | Owner | What it does |
|---|---|---|
| `server.py` | G2 | HTTP routes only. Serves `static/`. |
| `config.py` | G2 | Reads `web/.env` once. Model settings, keys, data folder, signing secret. |
| `llm.py` | G2 | OpenAI-compatible chat completions, streaming and not. |
| `money.py` | G2 | Currency signs, display, Stripe minor units. |
| `cards.py` | G2 | Server seal on product cards. |
| `agent/` | G2 | Research agent: tool loop (`harness.py`), tools (`tools.py`), Serper and page reading (`web.py`). |
| `pay/` | G1 | Spending mandate, verifier, Stripe Checkout and off-session charge (`checkout.py`), saved test card (`wallet.py`), SQLite store and hash chain. |
| `static/index.html`, `app.js`, `money.js`, `styles.css` | G2 | Chat page. |
| `static/cart.html`, `cart.js`, `cart-store.js`, `cart.css` | G1 | Cart page. |
| `tests/` | both | `python3 -m unittest discover -s tests` from `web/`. |
| `data/` | | Created at run time: `hacku.db`, `cache.db`, and `secret.key`. Not in git. |

`agent/` and `pay/` do not import each other. Both use `cards.py` and `money.py`. `server.py` hands `checkout.quote` to the agent with `tools.set_quoter`. The agent can quote an order but has no way to charge it.

## Setup

1. Copy the example env file:

```bash
cp web/.env.example web/.env
```

2. Fill in `web/.env`. Do not commit it. Do not write a key in `outbox.md`, `status.md`, or chat logs that land in git.
3. Start the page and open http://127.0.0.1:8765/

```bash
python3 web/server.py
```

## Env

| Name | Value |
|---|---|
| `OPENAI_BASE_URL` | `https://xh.v1api.cc/v1` |
| `OPENAI_API_KEY` | model key from https://xh.v1api.cc |
| `OPENAI_MODEL` | `deepseek-v4.1-flash` |
| `SERPER_API_KEY` | search key from https://serper.dev |
| `STRIPE_SECRET_KEY` | Stripe test key, `sk_test_...` (https://dashboard.stripe.com/test/apikeys). Live keys are refused. |
| `VERIFY_BASE_URL`, `VERIFY_API_KEY`, `VERIFY_MODEL` | Optional second model for the verifier. Without all three, the chat model rates listings with the verifier's own prompt. |
| `HACKU_SECRET` | Optional signing secret. Without it, a random one is kept in `data/secret.key`. Changing it voids saved cart items and mandates. |
| `HACKU_DATA_DIR` | Optional data folder. Default `web/data/`. |

Without `OPENAI_API_KEY`, `/api/chat` returns an error. Without `SERPER_API_KEY`, the search tools fail and the assistant says so. Without a Stripe test key, checkout returns 503.

## Tools

| Tool | What it does |
|---|---|
| `ask_user` | 1 to 3 multiple-choice questions (budget, use, one key preference, or a trade-off between the shown picks). The turn pauses. The answer comes back as this tool's result: `{"answers": [...], "note": "…"}`, `{"skipped": true}`, or `{"user_reply": "…"}`. |
| `shop_search` | Google Shopping in `region` (default `hk`; also `tw`, `cn`, `jp`, `kr`, `sg`, `us`, `uk`, `au`). With `store` (for example `taobao`, `amazon.co.jp`, `hktvmall`, or any domain), it searches Google Images for `site:<domain>` product pages, opens up to 5, and reads the price from structured data or the price printed at the top of the page. Each offer gets a `ref`. A `null` price means the page did not show one. |
| `show_products` | Shows up to 3 refs as cards. Card data comes from the cached search result, so the model cannot change a price or link. Each card carries `sig`, the server seal. After any tool returns refs, the next round is forced to call `show_products`. |
| `web_search` | Google search in `region`. Titles, links, snippets. |
| `open_page` | Reads one https page: JSON-LD product, price, picture, page text. Private and local addresses are refused. A store product page returns a `ref`. |
| `buy` | `{"items": [{"ref", "qty"}]}`, up to 5 lines, refs from shown cards only. The server rebuilds each item from its cache, seals it, and quotes it. It pays nothing. The model gets `{awaiting_shopper, total, currency, items}` or `{paid: false, reason}`; the page gets `ui.kind == "order"` with the sealed items, or a refusal card. After the shopper presses pay or cancel, the page adds `shopper` (`paid` with amount and record, `canceled`, or `refused`) to that tool message, so the next turn knows. The prompt allows `buy` only when the shopper clearly asks to buy a shown product. |

Page text is data. Text that tries to instruct an AI agent is flagged to the model and on the card.

Search results are cached in `data/cache.db` for 6 hours and page reads for 2 hours. A store search returns once it has a priced offer and 6 seconds have passed, and never takes more than 15 seconds.

## Chat route

`POST /api/chat` with `{ "messages": [...] }`. The page sends the whole thread back each turn, including the tool messages it received. The response is SSE, one JSON object per `data:` line:

| `type` | Fields | Meaning |
|---|---|---|
| `delta` | `text` | Reply text. |
| `retract` | | Drop the text of this round. It was said before a tool call. |
| `tool_start` | `id`, `name`, `label` | A tool started. |
| `tool_result` | `id`, `name`, `ok`, `summary`, `ui` | A tool finished. `ui.kind == "products"` carries the cards. |
| `ask` | `id`, `questions` | Question card. The next request sends `{"role": "tool", "tool_call_id": id, "content": "<answer JSON>"}`. |
| `done` | `messages` | New assistant and tool messages to add to the thread. |
| `error` | `message` | Shown with a retry button. |

## Mandate and checkout routes

| Route | Body | Result |
|---|---|---|
| `GET /api/mandate` | | `{valid, detail, caps, expires}` for the latest mandate |
| `POST /api/mandate` | `{"caps": {"HKD": 2000, "CNY": 500}, "days": 7}` | Signs a new mandate and closes the old one. Caps are per order, per currency. 1 to 30 days. |
| `POST /api/mandate/revoke` | | Revokes the open mandate |
| `POST /api/checkout` | `{"items": [{name, store, price, currency, url, image, id, qty, sig}]}` | `{url, id, ratings}`. The page opens `url`. Errors: 403 mandate, live key, or cooling; 409 seal or verifier rating; 503 no key. |
| `GET /api/checkout/status?session=cs_test_...` | | `{paid, amount, currency, items, hash}`, read back from Stripe |
| `POST /api/pay` | `{"items": [...]}`, the sealed items from an order card | Called by 「確認付款」. Runs every gate, then charges the saved card. `{paid, id, amount, currency, card, hash, items, ratings}`. Errors: 403 card, mandate, or cooling; 409 seal or verifier rating; 402 Stripe did not confirm. |
| `GET /api/card` | | `{saved, label}` for the assistant's payment card |
| `POST /api/card` | | Attaches Stripe's test Visa (`pm_card_visa`) to a test customer and saves it for the assistant |
| `POST /api/card/forget` | | Detaches the card. The assistant can no longer pay. |
| `GET /api/orders` | | `{chain_ok, orders: [{id, currency, total, items, hash, via, at}]}`, newest first. `via` is `agent` or `cart`. |

A checkout opens, or the assistant's charge goes through, only when all of these pass, in this order:

1. The Stripe key is a test key.
2. Every item's seal matches, every item has a price, and all items share one currency.
3. The stored mandate's signature matches, it is not revoked or expired, it has a cap for the currency, and the order total is within that cap.
4. No cooling period is open. A verifier rating of 1 on any item starts a 10-minute cooling period.
5. The verifier rates every item 3. Each item is rated in its own call, all at once.
6. For the assistant only: a saved card exists. The charge is a confirmed off-session PaymentIntent with an idempotency key, so the same order sent twice in the same 2-minute window is charged once.

Mandates, orders, the saved card, the cooling period, and the hash chain are stored in `data/hacku.db`, so a revoked mandate stays revoked after a restart. Every mandate, revocation, card change, checkout, payment, and cooling period adds one entry to the chain; a paid order shows the first 12 characters of its entry hash.

Test card on Stripe Checkout: `4242 4242 4242 4242`, any future date, any CVC.

## Demo script

1. `python3 web/server.py`, then open http://127.0.0.1:8765/cart.html
2. Enter caps (for example HKD 100 and CNY 100), pick 7 days, press 「簽署授權」.
3. Press 「儲存 Stripe 測試卡（Visa 4242）」.
4. Press 「返回對話」, then 「新對話」. Ask 「USB-C 充電線，HK$100 以內，1 米，支援 60W，直接推薦」 or press the 「淘寶手機殼」 suggestion. A search takes about 20 to 40 seconds.
5. Say 「幫我買第一個」. A 「確認訂單」 card shows the item, the total, the test card, and the cap. Nothing is paid yet.
6. Press 「確認付款」. After 10 to 30 seconds the card turns green with the amount and the record hash. Ask 「付款成功了嗎？」 and the assistant quotes the same record.
7. Ask for another one and press 「取消」. The card says it was not paid.
8. Ask it to buy all three at once, or the expensive one. A red card says the total is over the cap, and there is no pay button.
9. Open the cart. 「付款紀錄」 lists the payment as 「助理付款」, and 「紀錄鏈檢查通過。」 sits under the list.
10. Press 「撤銷授權」, go back, and ask it to buy again. The red card says the mandate is revoked.

## Other groups

To call the same model from a folder you own, use your own local `.env`:

```http
POST https://xh.v1api.cc/v1/chat/completions
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

```json
{
  "model": "deepseek-v4.1-flash",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": true,
  "thinking": { "type": "disabled" }
}
```

Do not point another group's service at `127.0.0.1:8765`. That server is only for this page.
