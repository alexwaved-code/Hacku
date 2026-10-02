import json
import unittest
from unittest import mock

from agent import harness, tools
from helpers import TempData

CONFIG = {"model": "test", "base_url": "http://model.invalid", "api_key": "x"}


class FakeStream:
    def __init__(self, chunks):
        self.lines = [f"data: {json.dumps(chunk, ensure_ascii=False)}\n".encode() for chunk in chunks] + [b"data: [DONE]\n"]

    def __iter__(self):
        return iter(self.lines)

    def close(self):
        pass


def say(text):
    return {"choices": [{"delta": {"content": text}}]}


def call(name, arguments, call_id="c1"):
    part = {"index": 0, "id": call_id, "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)}}
    return {"choices": [{"delta": {"tool_calls": [part]}}]}


def offer():
    return {
        "name": "MOMAX 60W cable",
        "store": "HKTVmall",
        "price": 69,
        "currency": "HKD",
        "rating": None,
        "reviews": None,
        "image": None,
        "url": "https://www.hktvmall.com/p/1",
        "link_kind": "store",
    }


class HarnessTest(TempData):
    def run_turn(self, *streams):
        script = list(streams)
        opened = []

        def open_stream(config, body):
            stream = script.pop(0)
            opened.append(stream)
            return stream

        events = []
        with mock.patch.object(harness.llm, "open_stream", side_effect=open_stream):
            harness.run(CONFIG, [{"role": "user", "content": "買充電線"}], events.append)
        return events, opened

    def tearDown(self):
        tools.set_quoter(None)
        super().tearDown()

    def test_cards_and_say_end_the_turn_in_one_round(self):
        ref = tools._remember(offer())
        events, opened = self.run_turn(FakeStream([call("show_products", {"refs": [ref], "say": "這條最划算。"})]))
        self.assertEqual(len(opened), 1)
        self.assertEqual([e["text"] for e in events if e["type"] == "delta"], ["這條最划算。"])
        done = events[-1]
        self.assertEqual(done["type"], "done")
        self.assertEqual(done["messages"][-1], {"role": "assistant", "content": "這條最划算。"})

    def test_follow_up_becomes_a_question_card(self):
        ref = tools._remember(offer())
        follow = {"prompt": "更重視價錢還是耐用？", "options": ["價錢", "耐用"]}
        events, opened = self.run_turn(FakeStream([call("show_products", {"refs": [ref], "say": "兩條都可以。", "follow_up": follow})]))
        self.assertEqual(len(opened), 1)
        ask = next(e for e in events if e["type"] == "ask")
        self.assertEqual(ask["id"], "c1_ask")
        self.assertEqual(ask["questions"][0]["options"], ["價錢", "耐用"])
        last = events[-1]["messages"][-1]
        self.assertEqual(last["content"], "兩條都可以。")
        self.assertEqual(last["tool_calls"][0]["id"], "c1_ask")

    def test_cards_without_say_get_one_more_round(self):
        ref = tools._remember(offer())
        events, opened = self.run_turn(
            FakeStream([call("show_products", {"refs": [ref]})]),
            FakeStream([say("就買這條。")]),
        )
        self.assertEqual(len(opened), 2)
        self.assertEqual(events[-1]["messages"][-1]["content"], "就買這條。")

    def test_buy_ends_the_turn_with_the_order_summary(self):
        tools.set_quoter(
            lambda items: {
                "ok": True,
                "total": 69.0,
                "currency": "HKD",
                "cap": 100,
                "live": False,
                "items": [{"name": "MOMAX 60W cable", "store": "HKTVmall", "qty": 1, "price": 69.0}],
            }
        )
        ref = tools._remember(offer())
        events, opened = self.run_turn(FakeStream([call("buy", {"items": [{"ref": ref}]})]))
        self.assertEqual(len(opened), 1)
        text = "".join(e["text"] for e in events if e["type"] == "delta")
        self.assertIn("HK$69", text)
        self.assertIn("確認付款", text)

    def test_buy_refusal_is_said_without_another_round(self):
        tools.set_quoter(lambda items: {"ok": False, "reason": "這筆 HK$69 超過授權的每筆上限 HK$50。"})
        ref = tools._remember(offer())
        events, opened = self.run_turn(FakeStream([call("buy", {"items": [{"ref": ref}]})]))
        self.assertEqual(len(opened), 1)
        text = "".join(e["text"] for e in events if e["type"] == "delta")
        self.assertIn("沒有建立訂單", text)
        self.assertIn("修改付款授權", text)

    def test_plain_chat_is_one_round(self):
        events, opened = self.run_turn(FakeStream([say("你好")]))
        self.assertEqual(len(opened), 1)
        self.assertEqual(events[-1]["messages"][-1]["content"], "你好")


if __name__ == "__main__":
    unittest.main()
