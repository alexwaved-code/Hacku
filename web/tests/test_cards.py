import unittest

import cards
from helpers import TempData

CARD = {
    "name": "Sony WF-C710N",
    "store": "HKTVmall",
    "price": 799,
    "currency": "HKD",
    "url": "https://www.hktvmall.com/p/1",
    "image": None,
}


class CardSealTest(TempData):
    def test_whole_and_float_prices_seal_the_same(self):
        self.assertEqual(cards.seal(CARD), cards.seal({**CARD, "price": 799.0}))

    def test_changed_price_breaks_the_seal(self):
        signature = cards.seal(CARD)
        self.assertTrue(cards.valid(CARD, signature))
        self.assertFalse(cards.valid({**CARD, "price": 1}, signature))
        self.assertFalse(cards.valid(CARD, None))


if __name__ == "__main__":
    unittest.main()
