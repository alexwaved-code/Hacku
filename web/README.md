# Shopping assistant

A chat page that researches real products, in Hong Kong by default or in one store or country the user names, and buys them through Stripe Checkout. It also answers ordinary questions. The browser talks only to `web/server.py`. Keys stay in local `web/.env`.

The shopper signs a spending mandate first: a cap per order for each currency, valid 1 to 30 days. There are two ways to pay inside it:

- **The assistant prepares, the shopper confirms.** The shopper says 「幫我買第一個」 in the chat. The assistant calls `buy` with the card's ref. The server checks the mandate and the cooling period, and the chat shows a 「確認訂單」 card with the items, the total, and the cap. Nothing is paid until the shopper presses 「確認付款」. Then the verifier rates the items and the page goes to Stripe Checkout, where the shopper enters a card and a Hong Kong delivery address. Back in the chat, the card turns into a receipt with the address. 「取消」 closes the order unpaid.
- **The shopper pays.** Cards go to the cart, and the shopper presses pay on Stripe Checkout.

With a test key, no real money moves, and the store does not get an order. With a live key and `HACKU_LIVE=1`, the shopper pays for real, and the order is placed with the store from the order desk (`/orders.html`): the assistant fills the store's cart and delivery address in a Chrome window and stops at the store's payment page, and a person pays there.

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
| `pay/` | G1 | Spending mandate, verifier, Stripe Checkout, order status and refunds (`checkout.py`), SQLite store and hash chain. |
| `shop/` | G2 | Fills a store's cart in a real Chrome window (`browser.py`) and stops before payment. |
| `static/index.html`, `app.js`, `money.js`, `styles.css` | G2 | Chat page. |
| `static/cart.html`, `cart.js`, `cart-store.js`, `cart.css` | G1 | Cart page. |
| `static/orders.html`, `orders.js`, `orders.css` | G2 | Order desk: paid orders, delivery address, cart filling, placed, refund. |
| `tests/` | both | `python3 -m unittest discover -s tests` from `web/`. |
| `data/` | | Created at run time: `hacku.db`, `cache.db`, `secret.key`, and the Chrome profile `browser/`. Not in git. |

`agent/`, `pay/`, and `shop/` do not import each other. `server.py` wires them. It hands `checkout.quote` to the agent with `tools.set_quoter`, so the agent can quote an order but has no way to charge it.

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
| `STRIPE_SECRET_KEY` | Stripe key. `sk_test_...` for test mode (https://dashboard.stripe.com/test/apikeys). A live key (`sk_live_...` or `rk_live_...`) is refused unless `HACKU_LIVE=1`. |
| `HACKU_LIVE` | `1` to take real payments with a live key. Live orders must be HKD and at most HK$100 each (`LIVE_CAPS` in `pay/checkout.py`), on top of the mandate. |
| `VERIFY_BASE_URL`, `VERIFY_API_KEY`, `VERIFY_MODEL` | Optional second model for the verifier. Without all three, the chat model rates listings with the verifier's own prompt. |
| `HACKU_SECRET` | Optional signing secret. Without it, a random one is kept in `data/secret.key`. Changing it voids saved cart items and mandates. |
| `HACKU_DATA_DIR` | Optional data folder. Default `web/data/`. |

Without `OPENAI_API_KEY`, `/api/chat` returns an error. Without `SERPER_API_KEY`, the search tools fail and the assistant says so. Without a Stripe key, checkout returns 503.

Filling a store's cart needs Google Chrome in `/Applications` and the Python package `playwright` (`pip install playwright`; it drives the installed Chrome, so no browser download is needed).

## Tools

| Tool | What it does |
|---|---|
| `ask_user` | 1 to 3 multiple-choice questions (budget, use, one key preference, or a trade-off between the shown picks). The turn pauses. The answer comes back as this tool's result: `{"answers": [...], "note": "…"}`, `{"skipped": true}`, or `{"user_reply": "…"}`. |
| `shop_search` | Google Shopping in `region` (default `hk`; also `tw`, `cn`, `jp`, `kr`, `sg`, `us`, `uk`, `au`). With `store` (for example `taobao`, `amazon.co.jp`, `hktvmall`, or any domain), it searches Google Images for `site:<domain>` product pages, opens up to 5, and reads the price from structured data or the price printed at the top of the page. Each offer gets a `ref`. A `null` price means the page did not show one. |
| `show_products` | `{"refs", "say", "follow_up"?}`. Shows up to 3 refs as cards. Card data comes from the cached search result, so the model cannot change a price or link. Each card carries `sig`, the server seal. After any tool returns refs, the next round is forced to call `show_products`. `say` is the reply under the cards, and the turn ends there without another model round. An optional `follow_up` (`{prompt, options}`) becomes a question card. The store link behind the first 3 offers of each search is looked up while the model is still choosing, so the cards rarely wait for it. |
| `web_search` | Google search in `region`. Titles, links, snippets. |
| `open_page` | Reads one https page: JSON-LD product, price, picture, page text. Private and local addresses are refused. A store product page returns a `ref`. |
| `buy` | `{"items": [{"ref", "qty"}]}`, up to 5 lines, refs from shown cards only. The server rebuilds each item from its cache, seals it, and quotes it. It pays nothing. The model gets `{awaiting_shopper, total, currency, live, items}` or `{paid: false, reason}`; the page gets `ui.kind == "order"` with the sealed items, or a refusal card. After the shopper presses pay or cancel, the page adds `shopper` (`paid` with amount and record, `canceled`, or `refused`) to that tool message, so the next turn knows. The prompt allows `buy` only when the shopper clearly asks to buy a shown product. The server writes the one-line summary under the order (items, total, press 確認付款) or the refusal reason, and the turn ends without another model round. |

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
| `POST /api/checkout` | `{"items": [{name, store, price, currency, url, image, id, qty, sig}]}` | Cart checkout. `{url, id, ratings}`. The page opens `url` and comes back to `/cart.html`. Errors: 403 mandate, live key, live cap, or cooling; 409 seal or verifier rating; 503 no key. |
| `POST /api/pay` | `{"items": [...]}`, the sealed items from an order card | Called by 「確認付款」. Same gates and result as `/api/checkout`; Stripe comes back to the chat at `/`. |
| `GET /api/checkout/status?session=cs_...` | | `{paid, status, amount, currency, items, hash, live, ship_to}`, read back from Stripe. The first paid read chains the payment and stores the delivery address. |
| `GET /api/orders` | | `{chain_ok, live, orders: [{id, currency, total, items, hash, via, live, at}]}`, newest first. `via` is `agent` or `cart`. |
| `GET /api/fulfil` | | Paid orders for the order desk, with `shipping` (name, phone, email, address), `fulfil`, `fulfil_note`, and `store_order`. |
| `POST /api/fulfil/start` | `{"id": "cs_..."}` | Starts filling the store's cart in Chrome. `fulfil` goes to `filling`, then `cart_ready`, `opened`, `needs_login`, or `failed`. |
| `POST /api/fulfil/placed` | `{"id", "store_order"}` | Records the store's order number. `fulfil` becomes `placed`. |
| `POST /api/fulfil/refund` | `{"id"}` | Refunds the whole payment in Stripe, once. `fulfil` becomes `refunded`. |

A checkout page opens only when all of these pass, in this order:

1. The Stripe key is a test key, or a live key with `HACKU_LIVE=1`. With a live key, the order is in HKD and at most HK$100.
2. Every item's seal matches, every item has a price, and all items share one currency.
3. The stored mandate's signature matches, it is not revoked or expired, it has a cap for the currency, and the order total is within that cap.
4. No cooling period is open. A verifier rating of 1 on any item starts a 10-minute cooling period.
5. The verifier rates every item 3. Each item is rated in its own call, all at once.

Stripe Checkout collects a Hong Kong delivery address and a phone number. Mandates, orders, delivery addresses, the cooling period, and the hash chain are stored in `data/hacku.db`, so a revoked mandate stays revoked after a restart. Every mandate, revocation, checkout, payment, placed order, refund, and cooling period adds one entry to the chain; a paid order shows the first 12 characters of its entry hash.

Test card on Stripe Checkout: `4242 4242 4242 4242`, any future date, any CVC. If Stripe offers Link, choose 「Pay without Link」.

## Placing the order with the store

The order desk at `/orders.html` lists paid orders with the items, the price paid, and the delivery address. 「助理代填購物車」 opens a Chrome window with its own profile in `data/browser/`:

- **Shopify stores** (for example Street Value): the product data is read from the store's page, the market is set to Hong Kong so prices are in HKD, the cart link opens checkout, and the email, name, address, region, and phone are filled in. If the store's price is now higher than what was paid, the note says so.
- **HKTVmall**: needs a logged-in account. The first time, the status is 「要先登入商店」; log in once in the Chrome window, then press 「再代填一次」. The items are added to the cart, and the cart page is left open. Pick the delivery address saved in the account.
- **Other stores**: the product page is opened.

The window always stops at the store's payment page. Whoever places the order pays there (bank one-time codes go to that person's phone), then enters the store's order number and presses 「標成已下單」. 「退款」 refunds the shopper in Stripe if the store cannot deliver.

## Demo script

1. `python3 web/server.py`, then open http://127.0.0.1:8765/cart.html
2. Enter caps (for example HKD 100 and CNY 100), pick 7 days, press 「簽署授權」.
3. Press 「返回對話」, then 「新對話」. Ask 「我想買 Street Value 的 Essential 60W USB-C 充電線」 or 「USB-C 充電線，HK$100 以內，1 米，支援 60W，直接推薦」. A search takes about 20 to 40 seconds.
4. Say 「幫我買」. A 「確認訂單」 card shows the item, the total, the cap, and test or live mode. Nothing is paid yet.
5. Press 「確認付款」. The page goes to Stripe Checkout. Enter the test card and a Hong Kong address, and pay.
6. Back in the chat, the card is green with the amount, 「送到：…」, and the record hash. Ask 「付款成功了嗎？」 and the assistant quotes the same record.
7. Ask it to buy all three at once, or the expensive one. A red card says the total is over the cap, and there is no pay button.
8. Open http://127.0.0.1:8765/orders.html. The order shows the address. Press 「助理代填購物車」. A Chrome window opens the store's checkout with the item and the address filled in, and the status becomes 「購物車已備好」. Do not pay on the store page in a test run.
9. Enter any store order number and press 「標成已下單」, then press 「退款」. The order shows 「已退款」.
10. In the cart, press 「撤銷授權」, go back, and ask it to buy again. The red card says the mandate is revoked.

## Going live

1. Activate the Stripe account for live payments (business details and a payout bank account).
2. Put the live secret key in `web/.env` as `STRIPE_SECRET_KEY`, and add `HACKU_LIVE=1`. Restart the server. The startup log says `Stripe LIVE key: real money.`
3. Sign a mandate in HKD, at most HK$100 per order.
4. Buy from the chat and pay with a real card. Then use the order desk to place the order with the store.

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
