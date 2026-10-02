import unittest

import cards
from agent import tools
from helpers import TempData


def offer(price=69):
    return {
        "name": "MOMAX 60W cable",
        "store": "HKTVmall",
        "price": price,
        "currency": "HKD",
        "rating": None,
        "reviews": None,
        "image": None,
        "url": "https://www.hktvmall.com/p/1",
        "link_kind": "store",
    }


class BuyToolTest(TempData):
    def tearDown(self):
        tools.set_buyer(None)
        super().tearDown()

    def test_sends_sealed_items_and_returns_a_receipt(self):
        seen = []

        def pay(items):
            seen.extend(items)
            return {"paid": True, "amount": 69.0, "currency": "HKD", "card": "Visa •••• 4242", "hash": "a" * 64,
                    "items": [{"name": "MOMAX 60W cable", "store": "HKTVmall", "qty": 1, "price": 69.0}]}

        tools.set_buyer(pay)
        ref = tools._remember(offer())
        result = tools.run_tool("buy", {"items": [{"ref": ref, "qty": "1"}]})
        self.assertTrue(result["model"]["paid"])
        self.assertEqual(result["ui"]["kind"], "receipt")
        card = {field: seen[0][field] for field in cards.FIELDS}
        self.assertTrue(cards.valid(card, seen[0]["sig"]))
        self.assertEqual(seen[0]["qty"], 1)

    def test_refusal_reaches_the_model(self):
        tools.set_buyer(lambda items: {"paid": False, "reason": "超過授權的每筆上限"})
        ref = tools._remember(offer())
        result = tools.run_tool("buy", {"items": [{"ref": ref}]})
        self.assertFalse(result["model"]["paid"])
        self.assertIn("上限", result["model"]["reason"])

    def test_unknown_ref(self):
        tools.set_buyer(lambda items: {"paid": True})
        result = tools.run_tool("buy", {"items": [{"ref": "p999999"}]})
        self.assertFalse(result["ok"])

    def test_shown_cards_carry_their_ref(self):
        ref = tools._remember({**offer(), "url": "https://www.hktvmall.com/p/2"})
        result = tools.show_products([ref])
        self.assertEqual(result["model"]["shown"][0]["ref"], ref)


if __name__ == "__main__":
    unittest.main()
