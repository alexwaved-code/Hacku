import io
import json
import os
import unittest
import urllib.error
from unittest import mock

import config
from agent import web


def _http_error(code, body):
    return urllib.error.HTTPError("https://google.serper.dev/search", code, "error", {}, io.BytesIO(body.encode()))


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class SerperKeyTests(unittest.TestCase):
    def setUp(self):
        web._key_rest.clear()
        self.env = mock.patch.dict(os.environ, {"SERPER_API_KEY": "main", "SERPER_API_KEYS": "backup1, backup2,main"})
        self.env.start()
        self.cache = mock.patch.multiple(web.cache, get=mock.DEFAULT, put=mock.DEFAULT)
        mocks = self.cache.start()
        mocks["get"].return_value = None
        self.used = []

    def tearDown(self):
        self.cache.stop()
        self.env.stop()
        web._key_rest.clear()

    def serve(self, answers):
        def urlopen(request, timeout):
            key = request.get_header("X-api-key")
            self.used.append(key)
            answer = answers[key]
            if isinstance(answer, Exception):
                raise answer
            return FakeResponse(json.dumps(answer).encode())

        return mock.patch.object(web.urllib.request, "urlopen", urlopen)

    def test_key_list_keeps_order_and_drops_repeats(self):
        self.assertEqual(config.serper_keys(), ["main", "backup1", "backup2"])
        self.assertEqual(config.serper_key(), "main")

    def test_out_of_credits_moves_to_the_next_key(self):
        answers = {"main": _http_error(400, '{"message":"Not enough credits"}'), "backup1": {"organic": []}}
        with self.serve(answers):
            self.assertEqual(web._serper("search", "usb-c cable", 10), {"organic": []})
            self.assertEqual(self.used, ["main", "backup1"])
            self.used.clear()
            web._serper("search", "power bank", 10)
            self.assertEqual(self.used, ["backup1"])

    def test_refused_and_rate_limited_keys_are_skipped(self):
        answers = {"main": _http_error(403, "forbidden"), "backup1": _http_error(429, "slow down"), "backup2": {"ok": 1}}
        with self.serve(answers):
            self.assertEqual(web._serper("search", "earbuds", 10), {"ok": 1})
        self.assertEqual(self.used, ["main", "backup1", "backup2"])

    def test_all_keys_failing_reports_the_last_problem(self):
        answers = {key: _http_error(400, '{"message":"Not enough credits"}') for key in ("main", "backup1", "backup2")}
        with self.serve(answers):
            with self.assertRaisesRegex(web.FetchError, "out of credits"):
                web._serper("search", "monitor", 10)

    def test_other_errors_do_not_burn_backup_keys(self):
        with self.serve({"main": _http_error(500, "oops"), "backup1": {"ok": 1}}):
            with self.assertRaisesRegex(web.FetchError, "500"):
                web._serper("search", "laptop", 10)
        self.assertEqual(self.used, ["main"])


if __name__ == "__main__":
    unittest.main()
