"""One card saved with Stripe, so the agent can pay inside the mandate without a checkout page.

The shopper saves the card once on a Stripe setup page. Stripe keeps the card; this file keeps
only the Stripe customer and payment-method ids, the brand, the last four digits, and the delivery address.
"""

import json
import re

import config

from . import mandate, store, stripe_api
from .stripe_api import CheckoutError

SESSION_ID = re.compile(r"^cs_(test|live)_[A-Za-z0-9]{10,200}$")
SHIP_FIELDS = {"name": 80, "phone": 24, "line1": 120, "line2": 120, "city": 40}


def setup(ship):
    """Open a Stripe page that saves a card for later payments. Returns {url}."""
    stripe_api.key()
    ship = _clean_ship(ship)
    form = [("description", "Hack U Shop shopper")]
    if ship["name"]:
        form.append(("name", ship["name"]))
    if ship["phone"]:
        form.append(("phone", ship["phone"]))
    customer = stripe_api.call("POST", "/customers", form)
    back = f"{config.ORIGIN}/pay.html"
    session = stripe_api.call(
        "POST",
        "/checkout/sessions",
        [
            ("mode", "setup"),
            ("currency", "hkd"),
            ("payment_method_types[]", "card"),
            ("customer", customer["id"]),
            ("success_url", f"{back}?card={{CHECKOUT_SESSION_ID}}"),
            ("cancel_url", f"{back}?canceled=1"),
            ("metadata[source]", "hacku-wallet"),
        ],
    )
    with store.db() as conn:
        store.put(conn, "wallet_pending", json.dumps({"session": session["id"], "customer": customer["id"], "ship": ship}))
    return {"url": session["url"], "id": session["id"]}


def confirm(session_id):
    """Read the setup page back from Stripe and keep the saved card."""
    if not SESSION_ID.match(str(session_id or "")):
        raise CheckoutError("存卡編號格式不對。")
    with store.db() as conn:
        pending = json.loads(store.get(conn, "wallet_pending") or "null")
    if not pending or pending.get("session") != session_id:
        current = view()
        if current["saved"]:
            return current
        raise CheckoutError("找不到這次存卡，請再存一次。", 404)
    session = stripe_api.call("GET", f"/checkout/sessions/{session_id}?expand[]=setup_intent")
    intent = session.get("setup_intent") or {}
    if session.get("status") != "complete" or intent.get("status") != "succeeded":
        raise CheckoutError("Stripe 還沒有完成存卡。", 409)
    method_id = intent["payment_method"]
    method_id = method_id["id"] if isinstance(method_id, dict) else method_id
    method = stripe_api.call("GET", f"/payment_methods/{method_id}")
    card = method.get("card") or {}
    saved = {
        "customer": pending["customer"],
        "payment_method": method_id,
        "brand": card.get("brand") or "card",
        "last4": card.get("last4") or "",
        "ship": pending.get("ship") or _clean_ship(None),
    }
    with store.db() as conn:
        store.put(conn, "wallet", json.dumps(saved))
        store.put(conn, "wallet_pending", "")
        store.append(conn, "card_saved", {"brand": saved["brand"], "last4": saved["last4"]}, mandate.now())
    return view()


def forget():
    with store.db() as conn:
        found = store.get(conn, "wallet")
        if found:
            saved = json.loads(found)
            store.put(conn, "wallet", "")
            store.append(conn, "card_removed", {"brand": saved["brand"], "last4": saved["last4"]}, mandate.now())
    return view()


def saved():
    """The saved card and address, or None."""
    with store.db() as conn:
        found = store.get(conn, "wallet")
    return json.loads(found) if found else None


def view():
    card = saved()
    if not card:
        return {"saved": False}
    return {"saved": True, "brand": card["brand"], "last4": card["last4"], "ship_to": ship_line(card["ship"])}


def ship_line(ship):
    place = "，".join(part for part in (ship.get("line1"), ship.get("line2"), ship.get("city")) if part)
    return f"{ship['name']}，{place}" if ship.get("name") and place else place


def _clean_ship(raw):
    raw = raw if isinstance(raw, dict) else {}
    ship = {field: str(raw.get(field) or "").strip()[:size] for field, size in SHIP_FIELDS.items()}
    ship["country"] = "HK"
    return ship
