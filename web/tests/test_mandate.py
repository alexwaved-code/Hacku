import json
import unittest
from datetime import datetime, timedelta

from helpers import TempData
from pay import mandate, store

AT = datetime(2026, 10, 2, 12, 0, tzinfo=mandate.HK)


class MandateTest(TempData):
    def test_no_mandate_blocks_checkout(self):
        self.assertIn("還沒有付款授權", mandate.problem("HKD", 10, AT))

    def test_covers_orders_up_to_the_cap(self):
        mandate.issue({"HKD": 2000}, 7, AT)
        self.assertIsNone(mandate.problem("HKD", 2000, AT))
        self.assertIn("超過", mandate.problem("HKD", 2000.01, AT))

    def test_other_currency_is_not_covered(self):
        mandate.issue({"HKD": 2000}, 7, AT)
        self.assertIn("CNY", mandate.problem("CNY", 10, AT))

    def test_expires(self):
        mandate.issue({"HKD": 2000}, 1, AT)
        self.assertIsNone(mandate.problem("HKD", 10, AT + timedelta(hours=23)))
        self.assertIn("過期", mandate.problem("HKD", 10, AT + timedelta(days=1, seconds=1)))

    def test_revoke_is_stored(self):
        mandate.issue({"HKD": 2000}, 7, AT)
        mandate.revoke(AT)
        self.assertIn("撤銷", mandate.problem("HKD", 10, AT))
        self.assertFalse(mandate.view(AT)["valid"])

    def test_new_mandate_replaces_the_old_one(self):
        mandate.issue({"HKD": 100}, 7, AT)
        mandate.issue({"HKD": 500}, 7, AT + timedelta(minutes=1))
        self.assertIsNone(mandate.problem("HKD", 400, AT + timedelta(minutes=2)))

    def test_edited_record_fails_the_signature(self):
        mandate.issue({"HKD": 100}, 7, AT)
        with store.db() as conn:
            row = conn.execute("SELECT id, document FROM mandates").fetchone()
            document = json.loads(row["document"])
            document["credentialSubject"]["perOrderCaps"]["HKD"] = 100000
            conn.execute("UPDATE mandates SET document = ? WHERE id = ?", (json.dumps(document), row["id"]))
        self.assertIn("簽章", mandate.problem("HKD", 5000, AT))

    def test_rejects_bad_input(self):
        for caps, days in (({}, 7), ({"XYZ": 10}, 7), ({"HKD": -1}, 7), ({"HKD": True}, 7), ({"HKD": 10}, 0), ({"HKD": 10}, 31)):
            with self.subTest(caps=caps, days=days), self.assertRaises(mandate.MandateError):
                mandate.issue(caps, days, AT)


class LedgerTest(TempData):
    def test_chain_detects_an_edited_entry(self):
        mandate.issue({"HKD": 100}, 7, AT)
        mandate.revoke(AT)
        with store.db() as conn:
            self.assertTrue(store.chain_ok(conn))
            conn.execute("UPDATE ledger SET payload = ? WHERE seq = 1", (json.dumps({"id": "other"}),))
            self.assertFalse(store.chain_ok(conn))


if __name__ == "__main__":
    unittest.main()
