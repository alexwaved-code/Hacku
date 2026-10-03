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
| `static/index.html`, `app.js`, `i18n.js`, `money.js`, `styles.css`, `logo.svg` | G2 | Chat page. `i18n.js` holds the 中 and English text. |
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
| `OPENAI_MODEL` | `kimi-k2.6`. The fastest steady model measured on this gateway for the shopping turn; the token must allow it. Without the variable it is `deepseek-v4.1-flash`. |
| `SERPER_API_KEY` | search key from https://serper.dev |
| `STRIPE_SECRET_KEY` | Stripe key. `sk_test_...` for test mode (https://dashboard.stripe.com/test/apikeys). A live key (`sk_live_...` or `rk_live_...`) is refused unless `HACKU_LIVE=1`. |
| `HACKU_LIVE` | `1` to take real payments with a live key. Live orders must be HKD and at most HK$100 each (`LIVE_CAPS` in `pay/checkout.py`), on top of the mandate. |
| `VERIFY_BASE_URL`, `VERIFY_API_KEY`, `VERIFY_MODEL` | Optional second model for the verifier. Without all three, the chat model rates listings with the verifier's own prompt. |
| `HACKU_SECRET` | Optional signing secret. Without it, a random one is kept in `data/secret.key`. Changing it voids saved cart items and mandates. |
| `HACKU_DATA_DIR` | Optional data folder. Default `web/data/`. |
| `HACKU_HOST` | Bind address. Default `127.0.0.1`. |
| `HACKU_PORT` | Bind port. Default `8765`. |
| `HACKU_ORIGIN` | Public site URL used for Stripe return links. Default `http://127.0.0.1:8765`. Set this to the tunnel URL when the page is on the internet. |

Without `OPENAI_API_KEY`, `/api/chat` returns an error. Without `SERPER_API_KEY`, the search tools fail and the assistant says so. Without a Stripe key, checkout returns 503.

Filling a store's cart needs Google Chrome in `/Applications` and the Python package `playwright` (`pip install playwright`; it drives the installed Chrome, so no browser download is needed).

## Tools

| Tool | What it does |
|---|---|
| `ask_user` | 1 to 3 multiple-choice questions (budget, use, one key preference, or a trade-off between the shown picks). The turn pauses. The answer comes back as this tool's result: `{"answers": [...], "note": "…"}`, `{"skipped": true}`, or `{"user_reply": "…"}`. |
| `next_steps` | 3 to 5 chips under the input. Call it in the same round as the final reply. Each chip is a short `label` and the exact `prompt` the shopper will send. The chips follow this chat (last request, shown cards, cart, an open trade-off), not generic starters. If the model omits the call, the server asks for it once, silently. |
| `shop_search` | Google Shopping in `region` (default `hk`; also `tw`, `cn`, `jp`, `kr`, `sg`, `us`, `uk`, `au`). With `store` (for example `taobao`, `amazon.co.jp`, `hktvmall`, or any domain), it searches Google Images for `site:<domain>` product pages, opens up to 5, and reads the price from structured data or the price printed at the top of the page. Each offer gets a `ref`. A `null` price means the page did not show one. |
| `show_products` | Not a model tool. When a round's tools return refs, the server shows up to 5 of them as cards at once: the searches take turns, repeated names are skipped, and priced offers come first. Card data comes from the cached search result, so the model cannot change a price or link. Each card carries `sig`, the server seal. Offers that were not shown are dropped from the model's context, and the next round may only write the answer, ask one `ask_user` question, or call `next_steps`. The store link behind the first 5 offers of each search is looked up in the background; cards show after at most 0.5 s and are sent again with the store links before the turn ends. |
| `update_cart` | Changes the shopper's cart: `add` (refs from cards or `open_page`), `set` (a cart line's quantity), `remove` (cart lines), `clear`. The page applies the change through `HackuCart`, and the server writes the one-line summary, so the turn ends without another model round. |
| `control_page` | Runs the app for the shopper: `open_cart`, `cart_page`, `orders_page`, `new_chat`, `chinese`, `english`. The cart panel opens at once; the rest happen after the reply is saved. |
| `web_search` | Google search in `region`. Titles, links, snippets. |
| `open_page` | Reads one https page: JSON-LD product, price, picture, page text. Private and local addresses are refused. A store product page returns a `ref`. |
| `buy` | `{"items": [{"ref", "qty"}]}` or `{"items": [{"line": "c1"}]}`, up to 5 lines: refs from shown cards, or lines from the shopper's cart, which carry the server seal they got when added. The server rebuilds each item from its cache, seals it, and quotes it. It pays nothing. The model gets `{awaiting_shopper, total, currency, live, items}` or `{paid: false, reason}`; the page gets `ui.kind == "order"` with the sealed items, or a refusal card. After the shopper presses pay or cancel, the page adds `shopper` (`paid` with amount and record, `canceled`, or `refused`) to that tool message, so the next turn knows. The prompt allows `buy` only when the shopper clearly asks to buy a shown product. The server writes the one-line summary under the order (items, total, press 確認付款) or the refusal reason, and the turn ends without another model round. |

Each request carries the cart, so the system prompt lists it as lines `c1`, `c2`… with name, store, price, and quantity; a line whose seal does not check is marked and cannot be bought. The prompt also lists the payment authorization (valid, caps, end) and the 5 latest paid orders, read by `server.py` from `pay/` through `tools.set_app_state`. The agent answers questions about them without a tool.

Page text is data. Text that tries to instruct an AI agent is flagged to the model and on the card.

Search results are cached in `data/cache.db` for 6 hours and page reads for 2 hours. A store search returns once it has a priced offer and 6 seconds have passed, and never takes more than 15 seconds.

## Chat page

- A new chat opens on a welcome screen with four example requests. After a reply, the model's next-step chips sit under the answer and under the input.
- While a turn runs, one progress panel shows a timer, each step as it finishes (with the stores found and the lowest price), and a hint that changes every 1.5 seconds. Placeholder cards hold the space until the real cards arrive. When the turn ends, the panel folds into one line, such as 「完成 · 4 個步驟 · 12.3 秒」; click it to see the steps again.
- Under the latest answer: 複製, 重新回答, and the model's next-step chips.
- Cards get tags worked out on the page: 「最便宜」 (lowest price in one currency), 「評價最多」, and 「評分最高」 (at least 20 reviews, when it is a different card). On a wide screen the five cards sit on one row. After the reply is written, the feed scrolls to the latest line.
- Pointing at a card shows 比較 and 買 (always shown on touch screens). 買 sends 「幫我買第N個（name）」, so the agent prepares that order. 比較 picks up to 3 cards; a bar above the input opens a side-by-side sheet with price, store, rating, and reviews, the best ones ticked, an add-to-cart button per product, and 「問助理哪個好」.
- The microphone button takes speech (Cantonese or English, by page language) and sends it. It shows only in browsers with speech recognition.
- After a search, the model's next-step chips follow that reply.
- The checkout box shows how much of the per-order cap the cart uses, and warns in red when the cart is over it.
- Cards are numbered 1 to 5. In the answer, 「第N個」 is highlighted; pointing at it lifts that card, and clicking scrolls to it. Prices in the answer are bold. The card the answer recommends, by number or by product name, gets a 「推薦」 badge.
- Left panel: 新對話, search (Cmd/Ctrl+K), and chats grouped by 釘選, 今天, 昨天, 過去 7 天, 更早. Pointing at a chat shows rename, pin, and delete; delete asks once before it removes the chat.
- Right panel: the payment authorization (caps and days left), the cart with pictures, a quantity stepper (at 1 the minus becomes remove), and a checkout box with the item count, the total, and 去結帳. Each line has 提到; several can sit above the input and go into the next message as `c1`, `c2`…. Adding a product from a card, the compare sheet, or the agent's cart update flies a thumbnail into the cart mark.
- Below 900 px both panels become drawers: the menu button opens the chats, and the 購物車 button opens the cart.
- Esc stops a running turn or closes a drawer. `/` focuses the input. A down-arrow button appears when you scroll up, and jumps back to the latest message.
- 中 / EN switches the page language: in the header on phones, and at the bottom of the left panel on wide screens. The choice is kept in `localStorage` (`hacku.lang`) and sent with each chat request, so step labels, summaries, the fixed replies, and the model's answer follow it. Cards already on screen are redrawn in the new language; earlier answers stay as written. In English, 「#2」, 「card 2」, and 「the second one」 point at cards like 「第二個」. `cart.html` and `orders.html` stay in Chinese.
- Static files are sent with `Cache-Control: no-cache`, so a reload always picks up a new `app.js` or `styles.css`.

## Chat route

`POST /api/chat` with `{ "messages": [...], "lang": "zh" | "en", "cart": [{"id", "qty", "sealed", "sig"}] }`. `cart` is the page's `HackuCart`. `lang` defaults to `zh`; with `en`, the prompt asks for English replies and questions, and tool labels and summaries are in English. The page sends the whole thread back each turn, including the tool messages it received. The response is SSE, one JSON object per `data:` line:

| `type` | Fields | Meaning |
|---|---|---|
| `delta` | `text` | Reply text. |
| `retract` | | Drop the text of this round. It was said before a tool call. |
| `phase` | `phase` | A model round started: `plan` (first round), `think` (after tools), or `answer` (writing the reply after the cards). The progress panel names the step. |
| `tool_start` | `id`, `name`, `label` | A tool started. |
| `tool_result` | `id`, `name`, `ok`, `summary`, `detail`, `ui` | A tool finished. `detail` is one short line for the progress panel, such as a few store names and the lowest price. `ui.kind == "products"` carries the cards. |
| `cards` | `id`, `items` | The same cards again with the store links found since. Replace the cards. |
| `ask` | `id`, `questions` | Question card. The next request sends `{"role": "tool", "tool_call_id": id, "content": "<answer JSON>"}`. |
| `next` | `actions` | Quick-action chips from the model for this turn: `{label, prompt}[]`, up to 5. The page puts them under the input and under the reply. |
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

## Public site

This Mac has to stay on. There is no login: anyone with the URL can chat and use the model and Stripe keys.

```bash
brew install cloudflared
python3 web/server.py
```

In another terminal:

```bash
cloudflared tunnel --url http://127.0.0.1:8765
```

Copy the `https://….trycloudflare.com` URL, then restart the server so Stripe returns there:

```bash
HACKU_ORIGIN=https://….trycloudflare.com python3 web/server.py
```

The quick-tunnel URL changes every run. A named tunnel with a fixed hostname needs a Cloudflare zone and `cloudflared tunnel login`. Store checkout on `/orders.html` still uses Chrome on this Mac.

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
