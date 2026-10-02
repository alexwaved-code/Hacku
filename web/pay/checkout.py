"""Payments in Stripe test mode, from the cart or from the agent.

Both paths pass the same gates: every card seal matches, the mandate covers the order total,
no cooling period is open, and the verifier rates every item 3.
The cart opens a Stripe Checkout page. The agent charges the saved card with no page.
"""

import hashlib
import json
import re
import time
from datetime import datetime, timedelta

import cards
import config
import money

from . import mandate, store, stripe_api, verifier, wallet
from .stripe_api import CheckoutError

MAX_ITEMS = 10
MAX_QTY = 10
COOLING = timedelta(minutes=10)
REPEAT_WINDOW = 120
SESSION_ID = re.compile(r"^cs_test_[A-Za-z0-9]{10,200}$")
VERDICTS = {"reject": "拒絕", "reconsider": "需重新考慮"}


def create(items):
    """Cart path: open a Stripe Checkout page for one store and currency."""
    stripe_api.key()
    lines = _check_items(items)
    currency, total = lines[0]["currency"], _total(lines)
    at = mandate.now()
    ratings = _approve(lines, currency, total, at)

    form = [
        ("mode", "payment"),
        ("payment_method_types[]", "card"),
        ("adaptive_pricing[enabled]", "false"),
        ("success_url", f"{config.ORIGIN}/cart.html?paid={{CHECKOUT_SESSION_ID}}"),
        ("cancel_url", f"{config.ORIGIN}/cart.html?canceled=1"),
        ("metadata[source]", "hacku-cart"),
    ]
    for index, line in enumerate(lines):
        prefix = f"line_items[{index}]"
        form += [
            (f"{prefix}[quantity]", str(line["qty"])),
            (f"{prefix}[price_data][currency]", currency.lower()),
            (f"{prefix}[price_data][unit_amount]", str(money.minor(line["price"], currency))),
            (f"{prefix}[price_data][product_data][name]", line["name"][:250]),
            (f"{prefix}[price_data][product_data][description]", line["store"][:250] or "Store"),
        ]
        if line["image"]:
            form.append((f"{prefix}[price_data][product_data][images][0]", line["image"]))
    session = stripe_api.call("POST", "/checkout/sessions", form)

    with store.db() as conn:
        _record(conn, session["id"], lines, currency, total, at, "cart")
        store.append(conn, "checkout_opened", {"session": session["id"], "currency": currency, "total": total}, at)
    return {"url": session["url"], "id": session["id"], "ratings": ratings}


def charge(items):
    """Agent path: charge the saved card now, with no checkout page."""
    stripe_api.key()
    lines = _check_items(items)
    currency, total = lines[0]["currency"], _total(lines)
    saved = wallet.current()
    if not saved:
        raise CheckoutError("還沒有儲存付款卡。請到購物車按「儲存 Stripe 測試卡」。", 403)
    customer, method, label = saved
    at = mandate.now()
    ratings = _approve(lines, currency, total, at)

    fingerprint = json.dumps([[line["url"], line["price"], line["qty"]] for line in lines], ensure_ascii=False)
    window = int(time.time() // REPEAT_WINDOW)
    intent = stripe_api.call(
        "POST",
        "/payment_intents",
        [
            ("amount", str(money.minor(total, currency))),
            ("currency", currency.lower()),
            ("customer", customer),
            ("payment_method", method),
            ("off_session", "true"),
            ("confirm", "true"),
            ("description", "、".join(line["name"][:60] for line in lines)[:300]),
            ("metadata[source]", "hacku-agent"),
        ],
        idempotency=hashlib.sha256(f"{fingerprint}|{window}".encode("utf-8")).hexdigest(),
    )
    if intent.get("status") != "succeeded":
        raise CheckoutError(f"Stripe 沒有完成扣款（{intent.get('status')}）。", 402)

    with store.db() as conn:
        order = conn.execute("SELECT hash FROM orders WHERE id = ?", (intent["id"],)).fetchone()
        if order:
            receipt = order["hash"]
        else:
            _record(conn, intent["id"], lines, currency, total, at, "agent")
            receipt = store.append(conn, "paid", {"payment": intent["id"], "currency": currency, "total": total, "by": "agent"}, at)
            conn.execute("UPDATE orders SET paid = 1, hash = ? WHERE id = ?", (receipt, intent["id"]))
    return {
        "paid": True,
        "id": intent["id"],
        "amount": total,
        "currency": currency,
        "card": label,
        "hash": receipt,
        "items": [{"name": line["name"], "store": line["store"], "qty": line["qty"], "price": line["price"]} for line in lines],
        "ratings": ratings,
    }


def status(session_id):
    if not SESSION_ID.match(str(session_id or "")):
        raise CheckoutError("付款編號格式不對。")
    session = stripe_api.call("GET", f"/checkout/sessions/{session_id}")
    paid = session.get("payment_status") == "paid"
    currency = str(session.get("currency") or "").upper()
    with store.db() as conn:
        order = conn.execute("SELECT * FROM orders WHERE id = ?", (session_id,)).fetchone()
        receipt = order["hash"] if order else None
        if paid and order and not order["paid"]:
            receipt = store.append(
                conn, "paid", {"session": session_id, "currency": currency, "total": order["total"], "by": "cart"}, mandate.now()
            )
            conn.execute("UPDATE orders SET paid = 1, hash = ? WHERE id = ?", (receipt, session_id))
    amount = session.get("amount_total")
    return {
        "paid": paid,
        "status": session.get("status"),
        "currency": currency,
        "amount": money.major(amount, currency) if isinstance(amount, int) else None,
        "items": json.loads(order["items"]) if order else [],
        "hash": receipt,
    }


def recent(limit=8):
    with store.db() as conn:
        rows = conn.execute("SELECT * FROM orders WHERE paid = 1 ORDER BY created_at DESC, rowid DESC LIMIT ?", (limit,)).fetchall()
        intact = store.chain_ok(conn)
    return {
        "chain_ok": intact,
        "orders": [
            {
                "id": row["id"],
                "currency": row["currency"],
                "total": row["total"],
                "items": json.loads(row["items"]),
                "hash": row["hash"],
                "via": row["via"],
                "at": row["created_at"],
            }
            for row in rows
        ],
    }


def cooling_until(at):
    with store.db() as conn:
        value = store.get(conn, "cooling_until")
    if not value:
        return None
    until = datetime.fromisoformat(value)
    return until if at < until else None


def _approve(lines, currency, total, at):
    problem = mandate.problem(currency, total, at)
    if problem:
        raise CheckoutError(f"不能付款：{problem}", 403)
    until = cooling_until(at)
    if until:
        raise CheckoutError(f"上一次結帳有商品被驗證拒絕，冷靜期到 {until:%H:%M} 才結束。", 403)
    ratings = verifier.verify_products(_products(lines))
    if any(rating["rating"] == 1 for rating in ratings):
        _start_cooling(at)
    failed = [rating for rating in ratings if rating["rating"] != 3]
    if failed:
        names = "、".join(f"{rating['name'][:24]}（{VERDICTS.get(rating['verdict'], '未評分')}）" for rating in failed)
        raise CheckoutError(f"驗證沒有通過：{names}", 409, {"ratings": ratings})
    return ratings


def _record(conn, order_id, lines, currency, total, at, via):
    items = [{"id": line["id"], "name": line["name"], "store": line["store"], "qty": line["qty"]} for line in lines]
    conn.execute(
        "INSERT OR IGNORE INTO orders (id, currency, total, items, created_at, via) VALUES (?, ?, ?, ?, ?, ?)",
        (order_id, currency, total, json.dumps(items, ensure_ascii=False), at.isoformat(timespec="seconds"), via),
    )


def _start_cooling(at):
    until = at + COOLING
    with store.db() as conn:
        store.put(conn, "cooling_until", until.isoformat(timespec="seconds"))
        store.append(conn, "cooling_started", {"until": until.isoformat(timespec="seconds")}, at)


def _total(lines):
    return round(sum(line["price"] * line["qty"] for line in lines), 2)


def _check_items(items):
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS:
        raise CheckoutError(f"一次結帳要有 1 到 {MAX_ITEMS} 件商品。")
    lines = []
    for item in items:
        if not isinstance(item, dict):
            raise CheckoutError("商品資料格式不對。")
        card = {field: item.get(field) for field in cards.FIELDS}
        if not cards.valid(card, item.get("sig")):
            raise CheckoutError("商品資料已過期或被改過，請回到對話重新搜尋後再加入購物車。", 409)
        name = str(card["name"] or "商品")
        if isinstance(card["price"], bool) or not isinstance(card["price"], (int, float)) or card["price"] <= 0:
            raise CheckoutError(f"「{name[:24]}」沒有標價，請到商店頁購買。")
        currency = str(card["currency"] or "").upper()
        if currency not in money.SIGNS:
            raise CheckoutError(f"「{name[:24]}」的幣別 {currency} 不能結帳。")
        qty = item.get("qty")
        if isinstance(qty, bool) or not isinstance(qty, int) or not 1 <= qty <= MAX_QTY:
            raise CheckoutError(f"每件商品數量要在 1 到 {MAX_QTY} 之間。")
        image = card["image"] if isinstance(card["image"], str) and card["image"].startswith("https://") else None
        lines.append(
            {
                "id": str(item.get("id") or card["url"] or name)[:300],
                "name": name,
                "store": str(card["store"] or ""),
                "price": float(card["price"]),
                "currency": currency,
                "url": card["url"],
                "image": image,
                "qty": qty,
            }
        )
    if len({line["currency"] for line in lines}) > 1:
        raise CheckoutError("一次結帳只能用一種幣別，請按商店分開付款。")
    return lines


def _products(lines):
    return [
        {
            "id": f"c{index + 1}",
            "name": line["name"],
            "category": "shopping",
            "price": line["price"],
            "detail": f"Store: {line['store']}. Price: {line['currency']} {line['price']}. Page: {line['url']}",
        }
        for index, line in enumerate(lines)
    ]
