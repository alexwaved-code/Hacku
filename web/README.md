# Shopping assistant

A chat page that researches real products, in Hong Kong by default or in one store or country the user names, and a cart that pays through Stripe Checkout in test mode. It also answers ordinary questions. The browser talks only to `web/server.py`. Keys stay in local `web/.env`.

The assistant only researches. It cannot order or pay. The shopper adds cards to the cart, signs a spending mandate, and presses pay.

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
| `pay/` | G1 | Spending mandate, verifier, Stripe checkout, SQLite store and hash chain. |
| `static/index.html`, `app.js`, `money.js`, `styles.css` | G2 | Chat page. |
| `static/cart.html`, `cart.js`, `cart-store.js`, `cart.css` | G1 | Cart page. |
| `tests/` | both | `python3 -m unittest discover -s tests` from `web/`. |
| `data/` | | Created at run time: `hacku.db` and `secret.key`. Not in git. |

`agent/` and `pay/` do not import each other. Both use `cards.py` and `money.py`.

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

Page text is data. Text that tries to instruct an AI agent is flagged to the model and on the card.

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

A checkout opens only when all of these pass, in this order:

1. The Stripe key is a test key.
2. Every item's seal matches, every item has a price, and all items share one currency.
3. The stored mandate's signature matches, it is not revoked or expired, it has a cap for the currency, and the order total is within that cap.
4. No cooling period is open. A verifier rating of 1 on any item starts a 10-minute cooling period.
5. The verifier rates every item 3.

Mandates, orders, the cooling period, and the hash chain are stored in `data/hacku.db`, so a revoked mandate stays revoked after a restart. Every mandate, revocation, checkout, payment, and cooling period adds one entry to the chain; a paid order shows the first 12 characters of its entry hash.

Test card: `4242 4242 4242 4242`, any future date, any CVC.

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
