# G2 outbox

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
