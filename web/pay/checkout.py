"""Stripe test-mode checkout for the cart.

A checkout opens only when every card seal matches, the mandate covers the order total,
no cooling period is open, and the verifier rates every item 3.
Only Stripe test keys are accepted, so no real money moves.
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

import cards
import config
import money

from . import mandate, store, verifier

STRIPE_API = "https://api.stripe.com/v1"
TIMEOUT = 20
MAX_ITEMS = 10
MAX_QTY = 10
COOLING = timedelta(minutes=10)
SESSION_ID = re.compile(r"^cs_test_[A-Za-z0-9]{10,200}$")
VERDICTS = {"reject": "拒絕", "reconsider": "需重新考慮"}


class CheckoutError(Exception):
    def __init__(self, message, status=400, detail=None):
        super().__init__(message)
        self.status = status
        self.detail = detail


def create(items):
    key = _stripe_key()
    lines = _check_items(items)
    currency = lines[0]["currency"]
    total = round(sum(line["price"] * line["qty"] for line in lines), 2)
    at = mandate.now()

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

    form = [
        ("mode", "payment"),
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
    session = _stripe("POST", "/checkout/sessions", key, form)

    items = [{"id": line["id"], "name": line["name"], "store": line["store"], "qty": line["qty"]} for line in lines]
    with store.db() as conn:
        conn.execute(
            "INSERT INTO orders (id, currency, total, items, created_at) VALUES (?, ?, ?, ?, ?)",
            (session["id"], currency, total, json.dumps(items, ensure_ascii=False), at.isoformat(timespec="seconds")),
        )
        store.append(conn, "checkout_opened", {"session": session["id"], "currency": currency, "total": total}, at)
    return {"url": session["url"], "id": session["id"], "ratings": ratings}


def status(session_id):
    if not SESSION_ID.match(str(session_id or "")):
        raise CheckoutError("付款編號格式不對。")
    key = _stripe_key()
    session = _stripe("GET", f"/checkout/sessions/{session_id}", key)
    paid = session.get("payment_status") == "paid"
    currency = str(session.get("currency") or "").upper()
    with store.db() as conn:
        order = conn.execute("SELECT * FROM orders WHERE id = ?", (session_id,)).fetchone()
        receipt = order["hash"] if order else None
        if paid and order and not order["paid"]:
            receipt = store.append(
                conn, "paid", {"session": session_id, "currency": currency, "total": order["total"]}, mandate.now()
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


def cooling_until(at):
    with store.db() as conn:
        value = store.get(conn, "cooling_until")
    if not value:
        return None
    until = datetime.fromisoformat(value)
    return until if at < until else None


def _start_cooling(at):
    until = at + COOLING
    with store.db() as conn:
        store.put(conn, "cooling_until", until.isoformat(timespec="seconds"))
        store.append(conn, "cooling_started", {"until": until.isoformat(timespec="seconds")}, at)


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


def _stripe(method, path, key, form=None):
    data = urllib.parse.urlencode(form).encode("utf-8") if form is not None else None
    request = urllib.request.Request(
        f"{STRIPE_API}{path}",
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read().decode("utf-8"))["error"]["message"]
        except Exception:
            message = f"HTTP {error.code}"
        raise CheckoutError(f"Stripe 拒絕了這次請求：{message}", 502) from error
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
        raise CheckoutError("連不上 Stripe，請再試一次。", 502) from error


def _stripe_key():
    key = config.stripe_key()
    if not key:
        raise CheckoutError("web/.env 缺少 STRIPE_SECRET_KEY。請放 sk_test_ 開頭的測試金鑰。", 503)
    if not key.startswith(("sk_test_", "rk_test_")):
        raise CheckoutError("這個頁面只接受 Stripe 測試金鑰（sk_test_），不收真錢。", 403)
    return key
