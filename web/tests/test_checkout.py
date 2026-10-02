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


SAVED = ("cus_test", "pm_test", "Visa •••• 4242")
INTENT = {"id": "pi_test_1", "status": "succeeded"}


@mock.patch.dict(os.environ, {"STRIPE_SECRET_KEY": "sk_test_dummy"})
class AgentChargeTest(TempData):
    def test_needs_a_saved_card(self):
        mandate.issue({"HKD": 500}, 7)
        with mock.patch.object(checkout.wallet, "current", return_value=None), self.assertRaises(checkout.CheckoutError) as caught:
            checkout.charge([item()])
        self.assertIn("付款卡", str(caught.exception))

    def test_mandate_gates_the_agent(self):
        mandate.issue({"HKD": 50}, 7)
        with mock.patch.object(checkout.wallet, "current", return_value=SAVED), mock.patch.object(checkout.stripe_api, "call") as stripe:
            with self.assertRaises(checkout.CheckoutError):
                checkout.charge([item(price=100)])
        stripe.assert_not_called()

    def test_quote_checks_without_charging(self):
        mandate.issue({"HKD": 500}, 7)
        with (
            mock.patch.object(checkout.wallet, "current", return_value=SAVED),
            mock.patch.object(checkout.verifier, "verify_products") as verify,
            mock.patch.object(checkout.stripe_api, "call") as stripe,
        ):
            order = checkout.quote([item(qty=2)])
            with self.assertRaises(checkout.CheckoutError) as caught:
                checkout.quote([item(price=600)])
        self.assertEqual((order["total"], order["currency"], order["cap"]), (200.0, "HKD", 500))
        self.assertEqual(order["card"], "Visa •••• 4242")
        self.assertIn("上限", str(caught.exception))
        stripe.assert_not_called()
        verify.assert_not_called()
        self.assertEqual(checkout.recent()["orders"], [])

    def test_charges_once_and_records_it(self):
        mandate.issue({"HKD": 500}, 7)
        patches = (
            mock.patch.object(checkout.wallet, "current", return_value=SAVED),
            mock.patch.object(checkout.verifier, "verify_products", rated(3)),
            mock.patch.object(checkout.stripe_api, "call", return_value=INTENT),
        )
        with patches[0], patches[1], patches[2] as stripe:
            first = checkout.charge([item(qty=2)])
            again = checkout.charge([item(qty=2)])
        form = dict(stripe.call_args.args[2])
        self.assertEqual(form["amount"], "20000")
        self.assertEqual(form["off_session"], "true")
        self.assertEqual(stripe.call_args_list[0].kwargs["idempotency"], stripe.call_args_list[1].kwargs["idempotency"])
        self.assertTrue(first["paid"])
        self.assertEqual(first["hash"], again["hash"])
        recent = checkout.recent()
        self.assertTrue(recent["chain_ok"])
        self.assertEqual([order["via"] for order in recent["orders"]], ["agent"])


if __name__ == "__main__":
    unittest.main()
