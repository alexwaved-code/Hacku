import os
import unittest
from unittest import mock

import cards
from helpers import TempData
from pay import checkout, mandate, store


def item(price=100, currency="HKD", **extra):
    card = {"name": "Cable", "store": "Shop", "price": price, "currency": currency, "url": "https://shop.example/1", "image": None}
    return {**card, "id": card["url"], "qty": 1, "sig": cards.seal(card), **extra}


def rated(rating):
    return lambda products: [{"id": p["id"], "name": p["name"], "price": p["price"], "rating": rating, "verdict": "x"} for p in products]


SESSION = {"id": "cs_test_abcdefghijkl", "url": "https://checkout.stripe.com/c/pay/cs_test_abcdefghijkl"}


@mock.patch.dict(os.environ, {"STRIPE_SECRET_KEY": "sk_test_dummy"})
class CheckoutTest(TempData):
    def test_live_key_needs_the_switch(self):
        with mock.patch.dict(os.environ, {"STRIPE_SECRET_KEY": "sk_live_x", "HACKU_LIVE": ""}), self.assertRaises(checkout.CheckoutError) as caught:
            checkout.create([item()])
        self.assertEqual(caught.exception.status, 403)
        self.assertIn("HACKU_LIVE", str(caught.exception))

    def test_stale_seal_still_quotes(self):
        mandate.issue({"HKD": 500}, 7)
        order = checkout.quote([{**item(), "sig": "0" * 64}])
        self.assertEqual(order["total"], 100)

    def test_mixed_currencies_are_refused(self):
        with self.assertRaises(checkout.CheckoutError):
            checkout.create([item(), item(currency="CNY", url="https://shop.example/2")])

    def test_needs_a_mandate(self):
        with self.assertRaises(checkout.CheckoutError) as caught:
            checkout.create([item()])
        self.assertEqual(caught.exception.status, 403)

    def test_over_the_cap_is_refused(self):
        mandate.issue({"HKD": 50}, 7)
        with self.assertRaises(checkout.CheckoutError) as caught:
            checkout.create([item(price=100)])
        self.assertIn("超過", str(caught.exception))

    def test_rejected_listing_starts_cooling(self):
        mandate.issue({"HKD": 500}, 7)
        with mock.patch.object(checkout.verifier, "verify_products", rated(1)), self.assertRaises(checkout.CheckoutError) as caught:
            checkout.create([item()])
        self.assertEqual(caught.exception.status, 409)
        with mock.patch.object(checkout.verifier, "verify_products", rated(3)), self.assertRaises(checkout.CheckoutError) as caught:
            checkout.create([item()])
        self.assertIn("冷靜期", str(caught.exception))

    def test_opens_stripe_and_records_the_payment(self):
        mandate.issue({"HKD": 500}, 7)
        with mock.patch.object(checkout.verifier, "verify_products", rated(3)), mock.patch.object(checkout.stripe_api, "call", return_value=SESSION) as stripe:
            result = checkout.create([item(qty=2)])
        self.assertEqual(result["id"], SESSION["id"])
        form = dict(stripe.call_args.args[2])
        self.assertEqual(form["line_items[0][price_data][unit_amount]"], "10000")
        self.assertEqual(form["line_items[0][quantity]"], "2")

        paid = {"payment_status": "paid", "status": "complete", "currency": "hkd", "amount_total": 20000}
        with mock.patch.object(checkout.stripe_api, "call", return_value=paid):
            first = checkout.status(SESSION["id"])
            again = checkout.status(SESSION["id"])
        self.assertTrue(first["paid"])
        self.assertEqual(first["amount"], 200)
        self.assertEqual(first["hash"], again["hash"])
        with store.db() as conn:
            steps = [row["step"] for row in conn.execute("SELECT step FROM ledger ORDER BY seq")]
            self.assertTrue(store.chain_ok(conn))
        self.assertEqual(steps, ["mandate_issued", "checkout_opened", "paid"])
        self.assertEqual(form["adaptive_pricing[enabled]"], "false")


LIVE = {"STRIPE_SECRET_KEY": "sk_live_dummy", "HACKU_LIVE": "1"}
PAID = {
    "payment_status": "paid",
    "status": "complete",
    "currency": "hkd",
    "amount_total": 4800,
    "livemode": True,
    "payment_intent": "pi_live_1",
    "customer_details": {"email": "a@example.com", "name": "Chan Tai Man", "phone": "+85291234567"},
    "collected_information": {
        "shipping_details": {"name": "Chan Tai Man", "address": {"line1": "1 Nathan Road", "line2": "Flat A", "city": "Tsim Sha Tsui", "state": "Kowloon", "country": "HK"}}
    },
}
LIVE_SESSION = {"id": "cs_live_abcdefghijkl", "url": "https://checkout.stripe.com/c/pay/cs_live_abcdefghijkl"}


@mock.patch.dict(os.environ, {"STRIPE_SECRET_KEY": "sk_test_dummy"})
class AgentOrderTest(TempData):
    def test_quote_checks_without_charging(self):
        mandate.issue({"HKD": 500}, 7)
        with mock.patch.object(checkout.verifier, "verify_products") as verify, mock.patch.object(checkout.stripe_api, "call") as stripe:
            order = checkout.quote([item(qty=2)])
            with self.assertRaises(checkout.CheckoutError) as caught:
                checkout.quote([item(price=600)])
        self.assertEqual((order["total"], order["currency"], order["cap"], order["live"]), (200.0, "HKD", 500, False))
        self.assertIn("上限", str(caught.exception))
        stripe.assert_not_called()
        verify.assert_not_called()
        self.assertEqual(checkout.recent()["orders"], [])

    def test_agent_checkout_asks_for_a_hong_kong_address_and_returns_to_the_chat(self):
        mandate.issue({"HKD": 500}, 7)
        with mock.patch.object(checkout.verifier, "verify_products", rated(3)), mock.patch.object(checkout.stripe_api, "call", return_value=SESSION) as stripe:
            checkout.create([item()], via="agent")
        form = dict(stripe.call_args.args[2])
        self.assertEqual(form["shipping_address_collection[allowed_countries][0]"], "HK")
        self.assertEqual(form["phone_number_collection[enabled]"], "true")
        self.assertTrue(form["success_url"].endswith("/pay.html?paid={CHECKOUT_SESSION_ID}"))

    @mock.patch.dict(os.environ, LIVE)
    def test_live_orders_are_hkd_and_capped(self):
        mandate.issue({"HKD": 500, "CNY": 500}, 7)
        with mock.patch.object(checkout.stripe_api, "call") as stripe:
            with self.assertRaises(checkout.CheckoutError) as over:
                checkout.quote([item(price=101)])
            with self.assertRaises(checkout.CheckoutError) as currency:
                checkout.quote([item(price=20, currency="CNY")])
            fine = checkout.quote([item(price=48)])
        stripe.assert_not_called()
        self.assertIn("HK$100", str(over.exception))
        self.assertIn("HKD", str(currency.exception))
        self.assertTrue(fine["live"])

    @mock.patch.dict(os.environ, LIVE)
    def test_paid_order_keeps_the_address_then_is_placed_or_refunded(self):
        mandate.issue({"HKD": 100}, 7)
        with mock.patch.object(checkout.verifier, "verify_products", rated(3)), mock.patch.object(checkout.stripe_api, "call", return_value=LIVE_SESSION):
            checkout.create([item(price=48)], via="agent")
        with mock.patch.object(checkout.stripe_api, "call", return_value=PAID):
            result = checkout.status(LIVE_SESSION["id"])
        self.assertTrue(result["live"])
        self.assertIn("1 Nathan Road", result["ship_to"])
        order = checkout.fulfilment()["orders"][0]
        self.assertEqual(order["fulfil"], "pending")
        self.assertEqual(order["shipping"]["phone"], "+85291234567")
        self.assertEqual(order["items"][0]["url"], "https://shop.example/1")

        with self.assertRaises(checkout.CheckoutError):
            checkout.mark_placed(order["id"], " ")
        self.assertEqual(checkout.mark_placed(order["id"], "HK123456")["fulfil"], "placed")
        with mock.patch.object(checkout.stripe_api, "call", return_value={"id": "re_1", "status": "succeeded"}) as stripe:
            refunded = checkout.refund(order["id"])
        self.assertEqual(dict(stripe.call_args.args[2])["payment_intent"], "pi_live_1")
        self.assertEqual(refunded["fulfil"], "refunded")
        self.assertIn("已退款", refunded["fulfil_note"])
        with self.assertRaises(checkout.CheckoutError):
            checkout.mark_placed(order["id"], "HK999")
        with store.db() as conn:
            self.assertTrue(store.chain_ok(conn))


if __name__ == "__main__":
    unittest.main()
