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
    def test_live_key_is_refused(self):
        with mock.patch.dict(os.environ, {"STRIPE_SECRET_KEY": "sk_live_x"}), self.assertRaises(checkout.CheckoutError) as caught:
            checkout.create([item()])
        self.assertEqual(caught.exception.status, 403)

    def test_edited_price_is_refused(self):
        with self.assertRaises(checkout.CheckoutError) as caught:
            checkout.create([{**item(), "price": 1}])
        self.assertEqual(caught.exception.status, 409)

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
        with mock.patch.object(checkout.verifier, "verify_products", rated(3)), mock.patch.object(checkout, "_stripe", return_value=SESSION) as stripe:
            result = checkout.create([item(qty=2)])
        self.assertEqual(result["id"], SESSION["id"])
        form = dict(stripe.call_args.args[3])
        self.assertEqual(form["line_items[0][price_data][unit_amount]"], "10000")
        self.assertEqual(form["line_items[0][quantity]"], "2")

        paid = {"payment_status": "paid", "status": "complete", "currency": "hkd", "amount_total": 20000}
        with mock.patch.object(checkout, "_stripe", return_value=paid):
            first = checkout.status(SESSION["id"])
            again = checkout.status(SESSION["id"])
        self.assertTrue(first["paid"])
        self.assertEqual(first["amount"], 200)
        self.assertEqual(first["hash"], again["hash"])
        with store.db() as conn:
            steps = [row["step"] for row in conn.execute("SELECT step FROM ledger ORDER BY seq")]
            self.assertTrue(store.chain_ok(conn))
        self.assertEqual(steps, ["mandate_issued", "checkout_opened", "paid"])


if __name__ == "__main__":
    unittest.main()
