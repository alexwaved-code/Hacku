import unittest
from unittest import mock

from shop import browser


def order(*urls):
    return {"items": [{"url": url, "qty": 1, "price": 48, "name": "Cable"} for url in urls], "shipping": {}}


class FillTest(unittest.TestCase):
    def test_item_without_a_store_link_fails_before_opening_chrome(self):
        with mock.patch.object(browser, "_ensure_chrome") as chrome:
            step, note = browser.fill(order("https://www.hktvmall.com/p/1", ""))
        self.assertEqual(step, "failed")
        self.assertIn("連結", note)
        chrome.assert_not_called()

    def test_one_page_per_store_and_the_worst_step_wins(self):
        context = mock.MagicMock()
        playwright = mock.MagicMock()
        playwright.__enter__.return_value.chromium.connect_over_cdp.return_value.contexts = [context]
        with (
            mock.patch.object(browser, "_ensure_chrome"),
            mock.patch("playwright.sync_api.sync_playwright", return_value=playwright),
            mock.patch.object(browser, "_hktvmall", return_value=("needs_login", "HKTVmall 要先登入。")) as hktv,
            mock.patch.object(browser, "_shopify_variants", return_value=None),
            mock.patch.object(browser, "_open", return_value=("opened", "已開啟商品頁。")) as other,
        ):
            step, note = browser.fill(order("https://www.hktvmall.com/p/1", "https://www.hktvmall.com/p/2", "https://shop.example/x"))
        self.assertEqual(step, "needs_login")
        self.assertEqual(context.new_page.call_count, 2)
        self.assertEqual(len(hktv.call_args.args[1]), 2)
        other.assert_called_once()
        self.assertIn("HKTVmall", note)


if __name__ == "__main__":
    unittest.main()
