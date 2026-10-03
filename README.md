# Hack U Shop

**Ask. Compare. Check out.**

Hack U Shop is an AI shopping agent. You tell it what you want in one sentence, and it searches real stores, shows real products with real prices, picks one and says why, and buys it for you — but only inside a spending limit you signed, and only after you press pay.

[![Hack U Shop demo video](web/static/demo-cover.jpg)](https://github.com/alexwaved-code/Hacku-shop-oiiaii/releases/download/demo/Hack-U-Shop-Demo.mp4)

- **Live site:** https://hacku-production.up.railway.app
- **Demo video (88 s, 1080p):** [Hack-U-Shop-Demo.mp4](https://github.com/alexwaved-code/Hacku-shop-oiiaii/releases/download/demo/Hack-U-Shop-Demo.mp4)
- **Pitch deck:** [Hack-U-Shop-Pitch.pptx](https://github.com/alexwaved-code/Hacku-shop-oiiaii/releases/download/demo/Hack-U-Shop-Pitch.pptx)

## The problem

Buying something online means ten tabs, five stores, and prices you cannot compare. Chatbots can talk about products, but they invent prices, and nobody wants to hand an AI their card.

## What it does

1. **Ask in plain words.** "Noise-cancelling headphones for long flights, under US$300." Chinese or English, on desktop or phone.
2. **It searches live stores.** The agent runs Google Shopping and store searches (Hong Kong by default, or the country or store you name), reads product pages, and shows up to five product cards with picture, price, store, rating, and link.
3. **It picks one, and says why.** The answer names the best card and the trade-off. Cards are tagged "Cheapest", "Most reviewed", "Top rated", and "Pick".
4. **Compare in one click.** A side-by-side sheet for up to three cards. The agent can also ask one or two quick questions (budget, use, a key preference) when the request is vague.
5. **Cart and cap.** Add cards to the cart from the chat or by hand. The cart always shows how much of your per-order limit it uses.
6. **"Buy it."** The agent prepares an order card with the items, the total, and your cap. Nothing is paid yet.
7. **You confirm, Stripe takes the card.** Press "Confirm and pay" and the page goes to Stripe Checkout for the card and a delivery address. Hack U Shop never sees the card number.
8. **The receipt lands back in the chat,** with the amount, the delivery address, and a record hash. Ask "did it go through?" and the agent quotes the same record.

An order desk (`/orders.html`) lists paid orders. For Shopify stores and HKTVmall it can open the store's checkout in Chrome with the items and the delivery address filled in, and stop at the store's payment page so a person places the order. It can also record the store's order number or refund the shopper.

## Why you can trust it

The agent can prepare an order, but it has no way to charge one. A payment page opens only when every check passes:

| Guard | What it stops |
|---|---|
| **Sealed product cards** | Every card is signed by the server from the cached search result. The model cannot change a price, a store, or a link. |
| **Signed spending mandate** | You set a cap per order for each currency, valid 1 to 30 days. Over the cap, revoked, or expired, and the order is refused. |
| **Second-model verifier** | Before checkout, a separate model rates every listing (reject, reconsider, accept). Anything short of "accept" does not reach payment, and a reject starts a 10-minute cooling period. |
| **Human confirmation** | Only the shopper's press on "Confirm and pay" opens Stripe Checkout. |
| **Hash chain** | Every mandate, payment, refund, and cooling period is chained in SQLite, so the record cannot be quietly rewritten. |

Text on web pages is treated as data. A page that tries to instruct the agent is flagged to the model and on the card.

## How it works

```
Browser (chat, cart, order desk)
   │  SSE stream
   ▼
web/server.py ── agent/   tool loop: search, read pages, cards, cart, ask, buy (quote only)
              ├─ pay/     mandate, verifier, Stripe Checkout, order store, hash chain
              └─ shop/    fills a store's cart in Chrome, stops before payment
```

`agent/`, `pay/`, and `shop/` do not import each other. The server wires them, and hands the agent a quote function, not a charge function.

## Stack

- **Model:** Kimi K2.6 through an OpenAI-compatible gateway (any compatible model works)
- **Search:** Serper (Google Shopping, Google Images, Google Search)
- **Payments:** Stripe Checkout, test mode by default
- **Hosting:** Railway
- **Code:** Python standard-library HTTP server, SQLite, plain HTML, CSS, and JavaScript. No framework, no build step.

## Run it

```bash
cp web/.env.example web/.env   # add OPENAI_API_KEY, SERPER_API_KEY, STRIPE_SECRET_KEY (sk_test_...)
python3 web/server.py
```

Open http://127.0.0.1:8765/, sign a spending limit on the cart page, and ask for something. Test card on Stripe: `4242 4242 4242 4242`, any future date, any CVC.

Tests, from `web/`:

```bash
python3 -m unittest discover -s tests
```

Every tool, route, environment variable, and the full demo script are in [web/README.md](web/README.md).

---

## Team workflow

Four groups share this GitHub repo. GitHub is the only shared board; agents do not open a separate chat.

### First time (once per person)

1. Ask the repo owner for an invite to `alexwaved-code/Hacku-shop-oiiaii`.
2. Clone it:

```bash
git clone https://github.com/alexwaved-code/Hacku-shop-oiiaii.git
cd Hacku-shop-oiiaii
```

3. Find your group (G1–G4) in `collab/groups.md`.
4. Write your group id locally (this file is not committed):

```bash
echo G1 > collab/.agent-id
```

Replace `G1` with your group.

### Every session

```bash
git checkout g1
git pull --rebase origin main
```

Change only the paths your group owns. When a piece works:

```bash
git add …
git commit -m "[G1] Short reason for the change"
git pull --rebase origin main
git push -u origin g1
```

Replace `g1` / `[G1]` with your group.

### Who merges into main

Only the integrator merges `g1`–`g4` into `main`. Nobody else pushes `main`. No force-push.

Full rules are in [COLLAB.md](COLLAB.md). Groups and folders are in [collab/groups.md](collab/groups.md).
