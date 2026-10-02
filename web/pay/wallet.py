"""The shopper's saved card, which the agent may charge inside the mandate.

In Stripe test mode the saved card is Stripe's Visa test card (pm_card_visa) on a test customer.
"""

import json

from . import mandate, store, stripe_api

TEST_CARD = "pm_card_visa"


def view():
    with store.db() as conn:
        saved = _saved(conn)
    if not saved:
        return {"saved": False}
    return {"saved": True, "label": saved["label"]}


def current():
    """(customer id, payment method id, label), or None."""
    with store.db() as conn:
        saved = _saved(conn)
    return (saved["customer"], saved["payment_method"], saved["label"]) if saved else None


def save_test_card():
    with store.db() as conn:
        customer = store.get(conn, "stripe_customer")
    if not customer:
        customer = stripe_api.call("POST", "/customers", [("description", "Hacku shopper (test mode)")])["id"]
    method = stripe_api.call("POST", f"/payment_methods/{TEST_CARD}/attach", [("customer", customer)])
    card = method.get("card") or {}
    label = f"{str(card.get('brand') or 'card').title()} •••• {card.get('last4') or '????'}"
    at = mandate.now()
    with store.db() as conn:
        store.put(conn, "stripe_customer", customer)
        store.put(conn, "card", json.dumps({"customer": customer, "payment_method": method["id"], "label": label}))
        store.append(conn, "card_saved", {"label": label}, at)
    return view()


def forget():
    with store.db() as conn:
        saved = _saved(conn)
    if saved:
        try:
            stripe_api.call("POST", f"/payment_methods/{saved['payment_method']}/detach", [])
        except stripe_api.CheckoutError:
            pass
        with store.db() as conn:
            conn.execute("DELETE FROM settings WHERE key = 'card'")
            store.append(conn, "card_removed", {"label": saved["label"]}, mandate.now())
    return view()


def _saved(conn):
    value = store.get(conn, "card")
    return json.loads(value) if value else None
