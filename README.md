# Hack U Shop

**Ask. Compare. Check out.**

Hack U Shop is an AI shopping agent. You tell it what you want in one sentence, and it searches real stores, shows real products with real prices, picks one and says why, and buys it for you — but only inside a spending limit you signed, and only after you press pay.

Live site: https://hacku-production.up.railway.app

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

## 協作方式

四組人共用這一個 GitHub repo。GitHub 是唯一的工作黑板。Agent 不另外開聊天室。

### 第一次（每人一次）

1. 跟 repo 負責人要邀請，加入 `alexwaved-code/Hacku`。
2. Clone：

```bash
git clone https://github.com/alexwaved-code/Hacku.git
cd Hacku
```

3. 在 `collab/groups.md` 找到自己的組（G1–G4）。
4. 本機寫入組別（這個檔不會進 git）：

```bash
echo G1 > collab/.agent-id
```

把 `G1` 換成你的組。

### 之後每次開工

```bash
git checkout g1
git pull --rebase origin main
```

只改自己組擁有的路徑。做完一段能跑的東西：

```bash
git add …
git commit -m "[G1] 簡短說明為什麼改"
git pull --rebase origin main
git push -u origin g1
```

把 `g1` / `[G1]` 換成自己的組。

### 誰進 main

只有整合者把 `g1`–`g4` 合進 `main`。其他人不要直接 push `main`。不要 force-push。

完整規則見 [COLLAB.md](COLLAB.md)。組別與目錄見 [collab/groups.md](collab/groups.md)。
