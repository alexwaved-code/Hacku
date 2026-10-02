import unittest

import money
from agent import tools, web


class MoneyTest(unittest.TestCase):
    def test_text(self):
        self.assertEqual(money.text(1299, "HKD"), "HK$1,299")
        self.assertEqual(money.text(12.5, "USD"), "US$12.50")
        self.assertEqual(money.text(299, "CNY"), "人民幣 ¥299")
        self.assertEqual(money.text(None, "HKD"), "")

    def test_minor_units(self):
        self.assertEqual(money.minor(799, "HKD"), 79900)
        self.assertEqual(money.minor(1500, "JPY"), 1500)
        self.assertEqual(money.major(79900, "HKD"), 799)
        self.assertEqual(money.major(1500, "JPY"), 1500)


class StoreTest(unittest.TestCase):
    def test_aliases(self):
        self.assertEqual(tools._store_site("淘寶")[0], "taobao.com")
        self.assertEqual(tools._store_site("Amazon JP")[0], "amazon.co.jp")
        self.assertEqual(tools._store_site("amazon")[0], "amazon.com")
        self.assertEqual(tools._store_site("https://www.ikea.com.hk/zh")[0], "ikea.com.hk")
        self.assertIsNone(tools._store_site("my local shop")[0])


class PriceTest(unittest.TestCase):
    def test_page_price(self):
        self.assertEqual(web.page_price("¥ 299.00 包郵", "cn"), (299.0, "CNY"))
        self.assertEqual(web.page_price("售價 HK$1,299", "hk"), (1299.0, "HKD"))
        self.assertEqual(web.page_price("no price here"), (None, None))

    def test_yen_follows_region(self):
        self.assertEqual(web._price("¥1,980", "jp"), (1980.0, "JPY"))
        self.assertEqual(web._price("¥1,980", "cn"), (1980.0, "CNY"))


if __name__ == "__main__":
    unittest.main()
