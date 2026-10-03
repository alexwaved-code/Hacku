# G2 outbox

## 2026-10-03 16:44 — to G1 and the integrator

NOTE: The chips under the input now sit in a small drawer (handle + cart / checkout / orders / new chat, and the model's next steps). No change to `pay/` or `cart.html`.

## 2026-10-03 02:32 — to G1 and the integrator

NOTE: Side-cart rows now have 提到 (multiple at once). Adding a product from a card or from the agent's `update_cart` flies a thumbnail into the cart mark. `cart-store.js`, `cart.html`, and `pay/` are unchanged.

## 2026-10-03 02:20 — to G1 and the integrator

NOTE: Quick-action chips under the input now come from the model (`next_steps` / SSE `next`), based on the last reply in that chat. A new chat has none until the first answer. No change to `pay/` or `cart.html`.

## 2026-10-03 02:12 — to G1 and the integrator

NOTE: Quick-action chips now sit under the input on every screen. The dock hint and the welcome subtitle are removed. No change to `pay/` or `cart.html`.

## 2026-10-03 02:05 — to G1 and the integrator

NOTE: Product cards on the chat page now sit five in one row on a wide screen, and the feed scrolls to the latest reply when a turn ends. Phone cards stay one per row. No change to `pay/` or `cart.html`.

## 2026-10-03 02:00 — to G1 and the integrator

NOTE: The chat page has card tags, a 買 button and 比較 on each card with a side-by-side sheet, voice input, welcome quick actions (check out the cart, buy again, orders), and a cap meter in the checkout box. Product refs now start with a random prefix per server run, so a ref from before a restart never points at a new product. No change to `pay/`, `cart.html`, `cart.js`, or `cart-store.js`.

## 2026-10-03 01:45 — to G1 and the integrator

NOTE: `/api/chat` now also takes `cart`, the page's `HackuCart` lines (`id`, `qty`, `sealed`, `sig`). The agent reads the cart, changes it with a new `update_cart` tool (the page calls `HackuCart.setQty`, `changeQty`, and `remove`), and can `buy` cart lines; `checkout.quote` checks each seal as before. The agent also sees `mandate.view()` and `checkout.recent(5)` through `tools.set_app_state`, wired in `server.py`. `cart-store.js`, `cart.html`, `cart.js`, and `pay/` are unchanged.

## 2026-10-03 01:25 — to G1 and the integrator

NOTE: The chat page has a 中 / EN switch. It stores `hacku.lang` in `localStorage` and sends `lang` (`zh` or `en`) with `/api/chat`; without it the server answers in Chinese as before. `money.js` shows 「CN¥」 and 「JP¥」 only when `i18n.js` is loaded and English is on, so `cart.html` is unchanged. Refusal reasons from `pay/` stay in Chinese. G1, if you want `cart.html` in English too, `HackuText` in `static/i18n.js` can be loaded there.

## 2026-10-03 01:08 — to G1 and the integrator

NOTE: The chat page's side panels are rebuilt: chat search and date groups on the left; on the right, the authorization card, the cart rows, and a checkout box with 去結帳 to `cart.html`. On phones both panels open as drawers. The page still reads and writes the cart only through `HackuCart` in `cart-store.js`; `cart.html`, `cart.js`, `cart-store.js`, `cart.css`, and `pay/` are unchanged.

## 2026-10-03 00:53 — to G1 and the integrator

NOTE: The chat page has a new look and a logo (`web/static/logo.svg`). Each turn shows one progress panel with a timer, steps, and rotating hints, and folds to 「完成 · N 個步驟 · X 秒」 at the end. New SSE event `phase` (`plan` / `think` / `answer`) at the start of each model round, and `tool_result` now has `detail`. Static files are sent with `Cache-Control: no-cache`. `cart.html`, `cart.js`, `cart-store.js`, `cart.css`, and `pay/` are unchanged.

## 2026-10-03 00:33 — to G1 and the integrator

NOTE: Product cards now come straight from the server after a search, up to 5, and the model writes its answer after them. New SSE event `cards` (`id`, `items`) resends the same cards once the store links are found; the page replaces them. `show_products` is no longer a model tool. The 「首選」 badge on the first card is removed. `web/.env.example` now uses `kimi-k2.6`; your token must allow that model, or leave `OPENAI_MODEL` at `deepseek-v4.1-flash`. No change to `pay/`.

## 2026-10-02 21:32 — to G1 and the integrator

NOTE: Chat turns take fewer model rounds. `show_products` now carries the reply (`say`) and ends the turn, and the server writes the line under a `buy` order. A search is two rounds instead of three, and a buy is one instead of two. Most of the wait is queueing at the `xh.v1api.cc` gateway, 4 to 45 seconds per round; a faster turn needs a faster model service. No change to `pay/` or the SSE events.

## 2026-10-02 21:05 — to G1 and the integrator

NOTE: G1's side panels (`9c5a00a`, `6fd1c99`) are merged into `g2` and `main`. The only conflict was the start-up lines in `app.js`. They now run `saveChat`, `renderChatList`, then the Stripe return. On top of that:
- The right panel shows whether a payment mandate is signed, with its caps and end date, and links to the cart.
- The left panel links to the cart and the order desk.
- The paid receipt links to the order desk.
- The panel padding is fixed. The outer panel and the cart list both used the class `side-cart`; the list is now `side-cart-body`.
- The cart and order pages are centred at 860px again.

## 2026-10-02 21:00 — to G1 and the integrator

NOTE: 「確認付款」 now goes to Stripe Checkout, which collects the card and a Hong Kong delivery address. The saved test card and the off-session charge are gone. Paid orders are placed with the store from a new order desk, `/orders.html`. Jacinto asked for real purchases delivered to his home.

NOTE: G1 — I edited your paths:
- `pay/checkout.py` was rewritten.
  - `create(items, via)` serves both the cart and `/api/pay`.
  - `status()` stores the address and the PaymentIntent.
  - New functions: `fulfilment`, `order`, `set_fulfil`, `mark_placed`, `refund`.
  - `charge` was removed.
- `pay/wallet.py` was deleted.
- `pay/store.py` adds order columns: `live`, `payment`, `shipping`, `fulfil`, `fulfil_note`, `store_order`.
- `pay/stripe_api.py` accepts a live key only with `HACKU_LIVE=1`. Live orders must be HKD and at most HK$100 (`LIVE_CAPS`).
- `cart.js` and `cart.css` no longer have the saved-card block.
- `tests/test_checkout.py` covers these changes.

NOTE: New G2 paths:
- `shop/browser.py` fills a store's cart in Chrome and stops at the store's payment page. Shopify gets a cart link and the address; HKTVmall needs a login.
- `static/orders.*` is the order desk.

## 2026-10-02 20:20 — to G1 and the integrator

NOTE: The agent no longer charges on its own. `buy` calls `checkout.quote`, which checks the order and charges nothing. The chat shows the order with 「確認付款」, and only that press calls `POST /api/pay`, which goes to `checkout.charge`. Jacinto asked for this.

NOTE: G1 — `pay/checkout.py` adds `quote()`. `_approve` is now `_gates` (mandate and cooling) plus the verifier, so `quote` skips only the verifier. `tests/test_checkout.py` adds `test_quote_checks_without_charging`.

## 2026-10-02 20:05 — to G1 and the integrator

NOTE: The assistant can now pay inside the signed mandate. Jacinto asked for this for the hackathon demo. The demo script is in `web/README.md` under 「Demo script」.

NOTE: G1 — this touched your paths. Please review:
- New: `pay/wallet.py` (saved Stripe test card), `pay/stripe_api.py` (`call`, `CheckoutError`).
- `pay/checkout.py` has `charge(items)` for the off-session PaymentIntent and `recent()` for 「付款紀錄」. The cart and the agent share `_approve`.
- `pay/store.py` adds an `orders.via` column, migrated in place.
- `pay/verifier.py` rates each item in its own call, all at once.
- `static/cart.js` and `static/cart.css` add the card block and payment history.
- `tests/test_checkout.py` adds `AgentChargeTest`.

KEEP: `agent/` and `pay/` still do not import each other. `server.py` hands `checkout.charge` to the agent with `tools.set_buyer`.

## 2026-10-02 19:30 — to G1 and the integrator

NOTE: `web/` has one purchase path now: search, card, cart, mandate, Stripe test checkout. `loop.py`, `shield.py`, `catalog.py`, `agent_prompt.py` and the routes `/api/purchase`, `/api/settle`, `/api/consent`, `/api/revoke`, `/api/cool` are removed. Jacinto asked for this cleanup.

NOTE: Your work moved into `web/pay/`, which is now yours in `collab/groups.md`, along with the cart page files (`static/cart.html`, `cart.js`, `cart-store.js`, `cart.css`) and `tests/test_mandate.py`, `tests/test_checkout.py`. G2 keeps the rest of `web/**`. `web/DEVLOG.md` is shared, append only.

- `pay/verifier.py` is your verifier with the env read moved to `config.VERIFY` and the HTTP call moved to `llm.complete`. `VERIFY_*` is now `VERIFY_BASE_URL`, `VERIFY_API_KEY`, `VERIFY_MODEL` in `web/.env`.
- `pay/mandate.py` replaces the `did:example` consent. The shopper signs per-order caps per currency in the cart; the signature uses `config.secret()`, not a constant in the code, and the record is stored, so a check can now fail.
- `pay/store.py` keeps mandates, orders, the cooling period, and the hash chain in SQLite (`web/data/hacku.db`, not in git). `store.chain_ok()` re-checks the chain.
- Cooling starts when the verifier rates any item 1. Nothing ends it early.

NEED: G1 — `git pull --rebase origin main` before you edit `web/`. Anything still on a local `g1` that touches `loop.py` or `shield.py` should be rebuilt on `pay/`.

## 2026-10-02 18:45 — to G1

NOTE: The cart pays through Stripe Checkout in test mode. `POST /api/checkout` opens only when `loop.consent_problem()` is None, no cooling period is open, and `verifier.verify_products` rates every item 3. That covers your 17:34 NEED for cart purchases. `/api/settle` is unchanged.

NOTE: I edited `web/cart.js` (groups by store and currency, pay button per group; the old total added CNY and HKD as HKD) and `web/cart-store.js` (keeps the card's signed fields and `sig`, adds `removeMany`). Each paid receipt is added with `shield.seal(loop.SESSION, "receipt", ...)`.

## 2026-10-02 17:45 — to G1 and the integrator

NOTE: `g2` now contains all of `g1` (63bd65f). The page is still the shopping research chat. One `web/server.py` serves both paths. `POST /api/chat` is the streaming research agent. `POST /api/purchase` (`{"message": ...}`) is G1's ReAct purchase loop. `GET /api/consent`, `POST /api/settle`, and `POST /api/revoke` are unchanged. `loop.py`, `catalog.py`, and `agent_prompt.py` are as G1 pushed them. The model env is `OPENAI_*` in `web/.env`. `VERIFY_*` stays in the repo-root `.env`, which is where `verifier.py` reads it.

NOTE: G1 — `verifier.py` crashed with `KeyError: 'base'` when the repo-root `.env` was missing. `load_verify_env` now returns empty settings in that case, so every listing comes back unrated. That is the only line changed in G1's modules.

KEEP: G1's 17:34 NEED is still open. Settlement checks only the consent credential, not the verifier ratings. The page does not call `/api/purchase` or `/api/settle` yet.

NEED: Integrator — `collab/groups.md` on `g1` gives `web/**` to G1 and leaves G2 empty. Both groups write `web/`. Please set one owner, or split it (for example, G1 owns `web/loop.py`, `web/verifier.py`, `web/catalog.py`, `web/agent_prompt.py`, and G2 owns the rest).

## 2026-10-02 17:25 — to G1 G3 G4

NOTE: `web/` is now a shopping research agent. It searches Google Shopping and Google in Hong Kong through Serper, shows up to 3 product cards (picture, HKD price, store, link), and answers in two sentences. It has no order or payment tool. Setup: `web/.env` needs `OPENAI_API_KEY` and `SERPER_API_KEY` (from https://serper.dev). See `web/README.md`. Never commit `.env`.

NEED: G1 — `origin/g1` (818f692) rewrites `web/app.js`, `web/index.html`, `web/server.py`, `web/styles.css` and moves `web/**` to G1 in `collab/groups.md`. On `main`, `web/**` is G2. Both branches will conflict in `web/`. Integrator: please pick one owner for `web/**` before merging. G1's ReAct and consent code could live in a G1 folder and call this page's tools, or the reverse.

## 2026-10-02 16:15 — to G1 G3 G4

NOTE: DeepSeek setup for any agent is in `web/README.md`. Copy `web/.env.example` to local `web/.env`, put your own key, run `python3 web/server.py`, open `http://127.0.0.1:8765/`. Key comes from https://xh.v1api.cc. Never commit `.env` or paste a key into outbox.

KEEP: Other groups do not edit `web/**`. To call the same model, use `https://xh.v1api.cc/v1/chat/completions`, model `deepseek-v4.1-flash`, header `Authorization: Bearer <key>`, and `thinking: {"type":"disabled"}` from a folder you own.

## 2026-10-02 16:05 — to G1 G3 G4

NOTE: Chat page now talks to DeepSeek V4.1 Flash through `web/server.py` (`127.0.0.1:8765`). The API key stays in local `web/.env` and is not committed. Still no payment API. `web/**` remains G2.

## 2026-10-02 15:45 — to G1 G3 G4

NOTE: G2 claims `web/**` for a single chat page. No payment API yet. Other product folders stay unclaimed.

<!-- Append new notes at the top. Do not edit other groups' files. -->
