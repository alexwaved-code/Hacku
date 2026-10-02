"""Stripe test-mode checkout for the cart.

Product cards carry a server seal, so the browser cannot change a price before checkout.
A checkout opens only while the consent credential is valid and the verifier rates every item 3.
Only Stripe test keys are accepted, so no real money moves.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request

import loop
import shield
import verifier

STRIPE_API = "https://api.stripe.com/v1"
ORIGIN = "http://127.0.0.1:8765"
TIMEOUT = 20
MAX_ITEMS = 10
MAX_QTY = 10
ZERO_DECIMAL = {"JPY", "KRW"}
CURRENCIES = {"HKD", "TWD", "USD", "SGD", "AUD", "CNY", "JPY", "KRW", "EUR", "GBP"}
SEALED_FIELDS = ("name", "store", "price", "currency", "url", "image")
SESSION_ID = re.compile(r"^cs_test_[A-Za-z0-9]{10,200}$")
VERDICTS = {"reject": "拒絕", "reconsider": "需重新考慮"}
_FALLBACK_KEY = secrets.token_bytes(32)
_orders = {}
_lock = threading.Lock()


class CheckoutError(Exception):
    def __init__(self, message, status=400, detail=None):
        super().__init__(message)
        self.status = status
        self.detail = detail


def seal(card):
    """Signature over the fields a checkout charges for."""
    values = [card.get(field) for field in SEALED_FIELDS]
    values = [float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else value for value in values]
    payload = json.dumps(values, ensure_ascii=False, separators=(",", ":"))
    return hmac.new(_card_key(), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def create(items, model_config):
    key = _stripe_key()
    lines = _check_items(items)
    currency = lines[0]["currency"]

    problem = loop.consent_problem()
    if problem:
        raise CheckoutError(f"授權無效，不能付款：{problem}", 403)
    if loop.SESSION.cooling_until and loop.now_hk() < loop.SESSION.cooling_until:
        raise CheckoutError("冷靜期還沒結束，暫時不能付款。", 403)

    ratings = _verify(lines, model_config)
    failed = [rating for rating in ratings if rating["rating"] != 3]
    if failed:
        names = "、".join(f"{rating['name'][:24]}（{VERDICTS.get(rating['verdict'], '未評分')}）" for rating in failed)
        raise CheckoutError(f"驗證沒有通過：{names}", 409, {"ratings": ratings})

    form = [
        ("mode", "payment"),
        ("success_url", f"{ORIGIN}/cart.html?paid={{CHECKOUT_SESSION_ID}}"),
        ("cancel_url", f"{ORIGIN}/cart.html?canceled=1"),
        ("metadata[source]", "hacku-cart"),
    ]
    for index, line in enumerate(lines):
        prefix = f"line_items[{index}]"
        form += [
            (f"{prefix}[quantity]", str(line["qty"])),
            (f"{prefix}[price_data][currency]", currency.lower()),
            (f"{prefix}[price_data][unit_amount]", str(_minor(line["price"], currency))),
            (f"{prefix}[price_data][product_data][name]", line["name"][:250]),
            (f"{prefix}[price_data][product_data][description]", line["store"][:250] or "Store"),
        ]
        if line["image"]:
            form.append((f"{prefix}[price_data][product_data][images][0]", line["image"]))
    session = _stripe("POST", "/checkout/sessions", key, form)

    total = round(sum(line["price"] * line["qty"] for line in lines), 2)
    order = {
        "id": session["id"],
        "currency": currency,
        "total": total,
        "items": [{"id": line["id"], "name": line["name"], "store": line["store"], "qty": line["qty"]} for line in lines],
        "paid": False,
        "hash": None,
    }
    with _lock:
        _orders[session["id"]] = order
    shield.seal(loop.SESSION, "checkout", {"session": session["id"], "currency": currency, "total": total})
    return {"url": session["url"], "id": session["id"], "ratings": ratings}


def status(session_id):
    if not SESSION_ID.match(str(session_id or "")):
        raise CheckoutError("付款編號格式不對。")
    key = _stripe_key()
    session = _stripe("GET", f"/checkout/sessions/{session_id}", key)
    paid = session.get("payment_status") == "paid"
    currency = str(session.get("currency") or "").upper()
    with _lock:
        order = _orders.get(session_id)
        if paid and order and not order["paid"]:
            order["paid"] = True
            order["hash"] = shield.seal(
                loop.SESSION, "receipt", {"session": session_id, "currency": currency, "total": order["total"]}
            )["hash"]
    amount = session.get("amount_total")
    return {
        "paid": paid,
        "status": session.get("status"),
        "currency": currency,
        "amount": _major(amount, currency) if isinstance(amount, int) else None,
        "items": order["items"] if order else [],
        "hash": order["hash"] if order else None,
    }


def _check_items(items):
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS:
        raise CheckoutError(f"一次結帳要有 1 到 {MAX_ITEMS} 件商品。")
    lines = []
    for item in items:
        if not isinstance(item, dict):
            raise CheckoutError("商品資料格式不對。")
        card = {field: item.get(field) for field in SEALED_FIELDS}
        if not isinstance(item.get("sig"), str) or not hmac.compare_digest(seal(card), item["sig"]):
            raise CheckoutError("商品資料已過期或被改過，請回到對話重新搜尋後再加入購物車。", 409)
        name = str(card["name"] or "商品")
        if not isinstance(card["price"], (int, float)) or card["price"] <= 0:
            raise CheckoutError(f"「{name[:24]}」沒有標價，請到商店頁購買。")
        currency = str(card["currency"] or "").upper()
        if currency not in CURRENCIES:
            raise CheckoutError(f"「{name[:24]}」的幣別 {currency} 不能結帳。")
        qty = item.get("qty")
        if not isinstance(qty, int) or not 1 <= qty <= MAX_QTY:
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


def _verify(lines, model_config):
    products = [
        {
            "id": f"c{index + 1}",
            "name": line["name"],
            "category": "shopping",
            "price": line["price"],
            "detail": f"Store: {line['store']}. Price: {line['currency']} {line['price']}. Page: {line['url']}",
        }
        for index, line in enumerate(lines)
    ]
    settings = verifier.load_verify_env()
    complete = None
    if not (settings["base"] and settings["key"] and settings["model"]) and model_config.get("api_key"):
        fallback = {
            "base": model_config["base_url"].removesuffix("/v1"),
            "key": model_config["api_key"],
            "model": model_config["model"],
        }

        def complete(messages):
            return verifier.call_model(fallback, messages)

    return verifier.verify_products(products, complete)


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
    key = os.environ.get("STRIPE_SECRET_KEY", "").strip()
    if not key:
        raise CheckoutError("web/.env 缺少 STRIPE_SECRET_KEY。請放 sk_test_ 開頭的測試金鑰。", 503)
    if not key.startswith(("sk_test_", "rk_test_")):
        raise CheckoutError("這個頁面只接受 Stripe 測試金鑰（sk_test_），不收真錢。", 403)
    return key


def _card_key():
    secret = os.environ.get("OPENAI_API_KEY") or os.environ.get("STRIPE_SECRET_KEY")
    if not secret:
        return _FALLBACK_KEY
    return hashlib.sha256(f"hacku-card-seal|{secret}".encode("utf-8")).digest()


def _minor(price, currency):
    return int(round(price)) if currency in ZERO_DECIMAL else int(round(price * 100))


def _major(amount, currency):
    return amount if currency in ZERO_DECIMAL else amount / 100
