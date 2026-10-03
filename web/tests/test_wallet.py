import json
import os
import unittest
from unittest import mock

import cards
from helpers import TempData
from pay import checkout, mandate, store, wallet


def item(price=100, currency="HKD", **extra):
    card = {"name": "Cable", "store": "Shop", "price": price, "currency": currency, "url": "https://shop.example/1", "image": None}
    return {**card, "id": card["url"], "qty": 1, "sig": cards.seal(card), **extra}


def rated(rating):
    return lambda products: [{"id": p["id"], "name": p["name"], "price": p["price"], "rating": rating, "verdict": "x"} for p in products]


SETUP = "cs_test_setupabcdefghij"
SHIP = {"name": "Chan Tai Man", "phone": "+85291234567", "line1": "1 Nathan Road", "line2": "Flat A", "city": "Tsim Sha Tsui"}


def stripe_for_setup(method, path, form=None, idempotency=None):
    if path == "/customers":
        return {"id": "cus_1"}
    if path == "/checkout/sessions":
        return {"id": SETUP, "url": "https://checkout.stripe.com/c/pay/" + SETUP}
    if path.startswith(f"/checkout/sessions/{SETUP}"):
        return {"status": "complete", "setup_intent": {"status": "succeeded", "payment_method": "pm_1"}}
    if path == "/payment_methods/pm_1":
        return {"card": {"brand": "visa", "last4": "4242"}}
    raise AssertionError(path)


def steps():
    with store.db() as conn:
        rows = conn.execute("SELECT step, payload FROM ledger ORDER BY seq").fetchall()
        assert store.chain_ok(conn)
    return [(row["step"], json.loads(row["payload"])) for row in rows]


@mock.patch.dict(os.environ, {"STRIPE_SECRET_KEY": "sk_test_dummy"})
class WalletTest(TempData):
    def save_card(self):
        with mock.patch.object(wallet.stripe_api, "call", side_effect=stripe_for_setup) as stripe:
            opened = wallet.setup(SHIP)
            saved = wallet.confirm(SETUP)
        form = dict(stripe.call_args_list[1].args[2])
        self.assertEqual(form["mode"], "setup")
        self.assertEqual(form["customer"], "cus_1")
        self.assertTrue(form["success_url"].endswith("/pay.html?card={CHECKOUT_SESSION_ID}"))
        self.assertIn(SETUP, opened["url"])
        return saved

    def test_saving_a_card_keeps_only_ids_and_last_four(self):
        saved = self.save_card()
        self.assertEqual((saved["saved"], saved["brand"], saved["last4"]), (True, "visa", "4242"))
        self.assertIn("1 Nathan Road", saved["ship_to"])
        self.assertEqual(steps()[-1], ("card_saved", {"brand": "visa", "last4": "4242"}))
        self.assertFalse(wallet.forget()["saved"])
        self.assertEqual(steps()[-1][0], "card_removed")

    def test_agent_charges_the_saved_card_inside_the_mandate(self):
        mandate.issue({"HKD": 500}, 7)
        self.save_card()
        intent = {"id": "pi_1", "status": "succeeded"}
        with mock.patch.object(checkout.verifier, "verify_products", rated(3)), mock.patch.object(checkout.stripe_api, "call", return_value=intent) as stripe:
            receipt = checkout.charge([item(price=120, qty=2)])
        method, path, form = stripe.call_args.args[:3]
        form = dict(form)
        self.assertEqual((method, path), ("POST", "/payment_intents"))
        self.assertEqual((form["amount"], form["currency"], form["payment_method"], form["off_session"]), ("24000", "hkd", "pm_1", "true"))
        self.assertEqual(form["shipping[address][country]"], "HK")
        self.assertTrue(receipt["paid"])
        self.assertEqual(receipt["amount"], 240)
        self.assertEqual(receipt["card"]["last4"], "4242")
        step, payload = steps()[-1]
        self.assertEqual((step, payload["payment"], payload["by"]), ("paid", "pi_1", "agent"))
        order = checkout.fulfilment()["orders"][0]
        self.assertEqual((order["id"], order["fulfil"]), (receipt["order"], "pending"))
        self.assertEqual(order["shipping"]["line1"], "1 Nathan Road")

    def test_each_stop_is_chained_with_its_rule(self):
        mandate.issue({"HKD": 100}, 7)
        self.save_card()
        with mock.patch.object(checkout.stripe_api, "call") as stripe:
            with self.assertRaises(checkout.CheckoutError) as over:
                checkout.charge([item(price=150)])
            mandate.revoke()
            with self.assertRaises(checkout.CheckoutError) as revoked:
                checkout.charge([item(price=50)])
        stripe.assert_not_called()
        self.assertEqual(over.exception.detail["rule"], "mandate.per_order_cap")
        self.assertEqual(revoked.exception.detail["rule"], "mandate.revoked")
        refused = [payload for step, payload in steps() if step == "refused"]
        self.assertEqual([entry["rule"] for entry in refused], ["mandate.per_order_cap", "mandate.revoked"])
        self.assertEqual((refused[0]["total"], refused[0]["cap"]), (150.0, 100.0))
        self.assertEqual(checkout.log()["entries"][0]["rule"], "mandate.revoked")

    def test_no_saved_card_is_a_stop(self):
        mandate.issue({"HKD": 500}, 7)
        with self.assertRaises(checkout.CheckoutError) as caught:
            checkout.charge([item()])
        self.assertEqual(caught.exception.detail["rule"], "card.missing")

    def test_a_declined_card_is_chained(self):
        mandate.issue({"HKD": 500}, 7)
        self.save_card()
        declined = checkout.CheckoutError("Stripe 拒絕了這次請求：Your card was declined.", 502)
        with mock.patch.object(checkout.verifier, "verify_products", rated(3)), mock.patch.object(checkout.stripe_api, "call", side_effect=declined):
            with self.assertRaises(checkout.CheckoutError) as caught:
                checkout.charge([item()])
        self.assertEqual(caught.exception.detail["rule"], "card.declined")
        self.assertEqual(checkout.recent()["orders"], [])


if __name__ == "__main__":
    unittest.main()
