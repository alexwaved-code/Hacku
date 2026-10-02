import unittest

import cards
from agent import harness, tools
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


def quoted(items):
    return {
        "ok": True,
        "total": 69.0,
        "currency": "HKD",
        "cap": 100,
        "live": False,
        "items": [{"name": "MOMAX 60W cable", "store": "HKTVmall", "qty": 1, "price": 69.0}],
    }


class BuyToolTest(TempData):
    def tearDown(self):
        tools.set_quoter(None)
        super().tearDown()

    def test_prepares_an_order_for_the_shopper_to_pay(self):
        seen = []

        def quote(items):
            seen.extend(items)
            return quoted(items)

        tools.set_quoter(quote)
        ref = tools._remember(offer())
        result = tools.run_tool("buy", {"items": [{"ref": ref, "qty": "1"}]})
        self.assertFalse(result["model"]["paid"])
        self.assertTrue(result["model"]["awaiting_shopper"])
        self.assertEqual(result["ui"]["kind"], "order")
        self.assertEqual(result["ui"]["total"], 69.0)
        sent = result["ui"]["items"][0]
        self.assertTrue(cards.valid({field: sent[field] for field in cards.FIELDS}, sent["sig"]))
        self.assertEqual(seen[0]["qty"], 1)

    def test_refusal_reaches_the_model(self):
        tools.set_quoter(lambda items: {"ok": False, "reason": "超過授權的每筆上限"})
        ref = tools._remember(offer())
        result = tools.run_tool("buy", {"items": [{"ref": ref}]})
        self.assertFalse(result["model"]["paid"])
        self.assertIn("上限", result["model"]["reason"])
        self.assertEqual(result["ui"]["kind"], "receipt")

    def test_unknown_ref(self):
        tools.set_quoter(quoted)
        result = tools.run_tool("buy", {"items": [{"ref": "p999999"}]})
        self.assertFalse(result["ok"])

    def test_system_prompt_renders(self):
        prompt = harness.system_prompt()
        self.assertIn("確認付款", prompt)
        self.assertNotIn("{now}", prompt)

    def test_shown_cards_carry_their_ref(self):
        ref = tools._remember({**offer(), "url": "https://www.hktvmall.com/p/2"})
        result = tools.show_products([ref])
        self.assertEqual(result["model"]["shown"][0]["ref"], ref)


if __name__ == "__main__":
    unittest.main()
