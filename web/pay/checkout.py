"""Payments through Stripe Checkout, from the cart or from the agent's order card.

Both paths pass the same gates: every card seal matches, the mandate covers the order total,
no cooling period is open, and the verifier rates every item 3. With a live key, an order must also
be in a currency listed in LIVE_CAPS and within that cap.
Stripe Checkout collects a Hong Kong delivery address. A paid order then waits to be placed with the store.
"""

import json
import re
from datetime import datetime, timedelta

import cards
import config
import money

from . import mandate, store, stripe_api, verifier
from .stripe_api import CheckoutError

MAX_ITEMS = 10
MAX_QTY = 10
COOLING = timedelta(minutes=10)
LIVE_CAPS = {"HKD": 100}
SHIP_TO = ("HK",)
SESSION_ID = re.compile(r"^cs_(test|live)_[A-Za-z0-9]{10,200}$")
VERDICTS = {"reject": "拒絕", "reconsider": "需重新考慮"}
RETURN_TO = {"cart": "/cart.html", "agent": "/"}
FULFIL_STEPS = {"pending", "filling", "cart_ready", "opened", "needs_login", "failed", "placed", "refunded"}
REFUND_NOTES = {"succeeded": "Stripe 已退款，款項會退回買家的卡。", "pending": "Stripe 退款處理中。"}


def quote(items):
    """Agent order card: check the order against the mandate and cooling period. Nothing is charged."""
    stripe_api.key()
    lines = _check_items(items)
    currency, total = lines[0]["currency"], _total(lines)
    _gates(currency, total, mandate.now())
    return {
        "currency": currency,
        "total": total,
        "cap": (mandate.view().get("caps") or {}).get(currency),
        "live": stripe_api.live(),
        "items": _summary(lines),
    }


def create(items, via="cart"):
    """Open a Stripe Checkout page for one currency. Returns {url, id, ratings}."""
    stripe_api.key()
    lines = _check_items(items)
    currency, total = lines[0]["currency"], _total(lines)
    live = stripe_api.live()
    at = mandate.now()
    ratings = _approve(lines, currency, total, at)
    back = f"{config.ORIGIN}{RETURN_TO.get(via, '/cart.html')}"

    form = [
        ("mode", "payment"),
        ("payment_method_types[]", "card"),
        ("adaptive_pricing[enabled]", "false"),
        ("phone_number_collection[enabled]", "true"),
        ("success_url", f"{back}?paid={{CHECKOUT_SESSION_ID}}"),
        ("cancel_url", f"{back}?canceled=1"),
        ("metadata[source]", f"hacku-{via}"),
    ]
    form += [(f"shipping_address_collection[allowed_countries][{index}]", country) for index, country in enumerate(SHIP_TO)]
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
        _record(conn, session["id"], lines, currency, total, at, via, live)
        store.append(conn, "checkout_opened", {"session": session["id"], "currency": currency, "total": total, "live": live}, at)
    return {"url": session["url"], "id": session["id"], "ratings": ratings}


def status(session_id):
    """Read a Checkout Session back from Stripe. A paid one is chained once and waits to be placed."""
    if not SESSION_ID.match(str(session_id or "")):
        raise CheckoutError("付款編號格式不對。")
    session = stripe_api.call("GET", f"/checkout/sessions/{session_id}")
    paid = session.get("payment_status") == "paid"
    currency = str(session.get("currency") or "").upper()
    shipping = _shipping(session)
    with store.db() as conn:
        order = conn.execute("SELECT * FROM orders WHERE id = ?", (session_id,)).fetchone()
        receipt = order["hash"] if order else None
        if paid and order and not order["paid"]:
            at = mandate.now()
            receipt = store.append(
                conn,
                "paid",
                {"session": session_id, "currency": currency, "total": order["total"], "by": order["via"], "live": bool(order["live"])},
                at,
            )
            conn.execute(
                "UPDATE orders SET paid = 1, hash = ?, payment = ?, shipping = ?, fulfil = 'pending' WHERE id = ?",
                (receipt, session.get("payment_intent"), json.dumps(shipping, ensure_ascii=False), session_id),
            )
    amount = session.get("amount_total")
    return {
        "paid": paid,
        "status": session.get("status"),
        "currency": currency,
        "amount": money.major(amount, currency) if isinstance(amount, int) else None,
        "items": json.loads(order["items"]) if order else [],
        "hash": receipt,
        "live": bool(session.get("livemode")),
        "ship_to": _ship_line(shipping),
    }


def recent(limit=8):
    with store.db() as conn:
        rows = conn.execute("SELECT * FROM orders WHERE paid = 1 ORDER BY created_at DESC, rowid DESC LIMIT ?", (limit,)).fetchall()
        intact = store.chain_ok(conn)
    return {"chain_ok": intact, "live": _live_or_test(), "orders": [_public(row) for row in rows]}


def _live_or_test():
    try:
        return stripe_api.live()
    except CheckoutError:
        return False


def fulfilment(limit=30):
    """Paid orders with their delivery details, for the person or browser that places them with the store."""
    with store.db() as conn:
        rows = conn.execute(
            "SELECT * FROM orders WHERE paid = 1 AND fulfil != '' ORDER BY created_at DESC, rowid DESC LIMIT ?", (limit,)
        ).fetchall()
    return {"orders": [{**_public(row), "shipping": json.loads(row["shipping"] or "null")} for row in rows]}


def order(order_id):
    with store.db() as conn:
        row = conn.execute("SELECT * FROM orders WHERE id = ? AND paid = 1", (str(order_id or ""),)).fetchone()
    if not row:
        raise CheckoutError("找不到這筆已付款的訂單。", 404)
    return {**_public(row), "shipping": json.loads(row["shipping"] or "null")}


def set_fulfil(order_id, step, note=""):
    if step not in FULFIL_STEPS:
        raise CheckoutError("代購狀態不對。")
    with store.db() as conn:
        found = conn.execute(
            "UPDATE orders SET fulfil = ?, fulfil_note = ? WHERE id = ? AND paid = 1", (step, str(note)[:300], str(order_id or ""))
        ).rowcount
    if not found:
        raise CheckoutError("找不到這筆已付款的訂單。", 404)
    return order(order_id)


def mark_placed(order_id, store_order):
    store_order = str(store_order or "").strip()[:80]
    if not store_order:
        raise CheckoutError("請填商店的訂單編號。")
    current = order(order_id)
    if current["fulfil"] == "refunded":
        raise CheckoutError("這筆已經退款，不能再標成已下單。", 409)
    with store.db() as conn:
        conn.execute(
            "UPDATE orders SET fulfil = 'placed', store_order = ?, fulfil_note = '' WHERE id = ?", (store_order, current["id"])
        )
        store.append(conn, "placed", {"order": current["id"], "store_order": store_order}, mandate.now())
    return order(order_id)


def refund(order_id):
    current = order(order_id)
    if current["fulfil"] == "refunded":
        return current
    with store.db() as conn:
        payment = conn.execute("SELECT payment FROM orders WHERE id = ?", (current["id"],)).fetchone()["payment"]
    if not payment:
        raise CheckoutError("這筆訂單沒有付款編號，請到 Stripe 後台退款。", 409)
    result = stripe_api.call("POST", "/refunds", [("payment_intent", payment)], idempotency=f"refund-{current['id']}")
    with store.db() as conn:
        note = REFUND_NOTES.get(result.get("status"), f"Stripe 退款狀態：{result.get('status') or '未知'}")
        conn.execute("UPDATE orders SET fulfil = 'refunded', fulfil_note = ? WHERE id = ?", (note, current["id"]))
        store.append(conn, "refunded", {"order": current["id"], "refund": result.get("id")}, mandate.now())
    return order(order_id)


def cooling_until(at):
    with store.db() as conn:
        value = store.get(conn, "cooling_until")
    if not value:
        return None
    until = datetime.fromisoformat(value)
    return until if at < until else None


def _gates(currency, total, at):
    if stripe_api.live():
        cap = LIVE_CAPS.get(currency)
        if cap is None:
            raise CheckoutError(f"正式付款只收 {'、'.join(LIVE_CAPS)}，這筆是 {currency}。", 403)
        if total > cap:
            raise CheckoutError(f"正式付款每筆最多 {money.text(cap, currency)}，這筆 {money.text(total, currency)}。", 403)
    problem = mandate.problem(currency, total, at)
    if problem:
        raise CheckoutError(f"不能付款：{problem}", 403)
    until = cooling_until(at)
    if until:
        raise CheckoutError(f"上一次結帳有商品被驗證拒絕，冷靜期到 {until:%H:%M} 才結束。", 403)


def _approve(lines, currency, total, at):
    _gates(currency, total, at)
    ratings = verifier.verify_products(_products(lines))
    if any(rating["rating"] == 1 for rating in ratings):
        _start_cooling(at)
    failed = [rating for rating in ratings if rating["rating"] != 3]
    if failed:
        names = "、".join(f"{rating['name'][:24]}（{VERDICTS.get(rating['verdict'], '未評分')}）" for rating in failed)
        raise CheckoutError(f"驗證沒有通過：{names}", 409, {"ratings": ratings})
    return ratings


def _record(conn, order_id, lines, currency, total, at, via, live):
    items = [
        {"id": line["id"], "name": line["name"], "store": line["store"], "qty": line["qty"], "price": line["price"], "url": line["url"]}
        for line in lines
    ]
    conn.execute(
        "INSERT OR IGNORE INTO orders (id, currency, total, items, created_at, via, live) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (order_id, currency, total, json.dumps(items, ensure_ascii=False), at.isoformat(timespec="seconds"), via, int(live)),
    )


def _public(row):
    return {
        "id": row["id"],
        "currency": row["currency"],
        "total": row["total"],
        "items": json.loads(row["items"]),
        "hash": row["hash"],
        "via": row["via"],
        "live": bool(row["live"]),
        "fulfil": row["fulfil"],
        "fulfil_note": row["fulfil_note"],
        "store_order": row["store_order"],
        "at": row["created_at"],
    }


def _shipping(session):
    collected = session.get("collected_information") or {}
    details = collected.get("shipping_details") or session.get("shipping_details") or {}
    customer = session.get("customer_details") or {}
    address = details.get("address") or customer.get("address") or {}
    return {
        "name": details.get("name") or customer.get("name") or "",
        "phone": customer.get("phone") or "",
        "email": customer.get("email") or "",
        "line1": address.get("line1") or "",
        "line2": address.get("line2") or "",
        "city": address.get("city") or "",
        "state": address.get("state") or "",
        "country": address.get("country") or "",
    }


def _ship_line(shipping):
    parts = [shipping.get(key) for key in ("line1", "line2", "city", "state")]
    place = "，".join(part for part in parts if part)
    return f"{shipping['name']}，{place}" if shipping.get("name") and place else place


def _start_cooling(at):
    until = at + COOLING
    with store.db() as conn:
        store.put(conn, "cooling_until", until.isoformat(timespec="seconds"))
        store.append(conn, "cooling_started", {"until": until.isoformat(timespec="seconds")}, at)


def _summary(lines):
    return [{"name": line["name"], "store": line["store"], "qty": line["qty"], "price": line["price"]} for line in lines]


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
