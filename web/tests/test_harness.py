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


def fake_tools(name, args):
    if name != "shop_search":
        return tools.run_tool(name, args)
    letter = args["query"]
    rows = []
    for number in (1, 2, 3):
        ref = tools._remember({**offer(), "name": f"{letter}{number}", "url": f"https://www.hktvmall.com/p/{letter}{number}"})
        rows.append({"ref": ref, "name": f"{letter}{number}", "price": 69})
    return {"ok": True, "summary": "3 個報價", "model": {"offers": rows}, "ui": None}


def two_searches():
    parts = [
        {"index": index, "id": f"s{index}", "function": {"name": "shop_search", "arguments": json.dumps({"query": letter})}}
        for index, letter in enumerate("AB")
    ]
    return {"choices": [{"delta": {"tool_calls": parts}}]}


class HarnessTest(TempData):
    def run_turn(self, *streams):
        script = list(streams)
        opened = []

        def open_stream(config, body):
            stream = script.pop(0)
            stream.body = body
            opened.append(stream)
            return stream

        events = []
        with mock.patch.object(harness.llm, "open_stream", side_effect=open_stream), mock.patch.object(harness, "run_tool", fake_tools):
            harness.run(CONFIG, [{"role": "user", "content": "買充電線"}], events.append)
        return events, opened

    def tearDown(self):
        tools.set_quoter(None)
        super().tearDown()

    def test_search_shows_five_cards_before_the_model_answers(self):
        events, opened = self.run_turn(
            FakeStream([two_searches()]),
            FakeStream([say("首選 A1。")]),
        )
        self.assertEqual(len(opened), 2)
        cards = next(e for e in events if e["type"] == "tool_result" and e["name"] == "show_products")
        self.assertEqual([item["name"] for item in cards["ui"]["items"]], ["A1", "B1", "A2", "B2", "A3"])
        kinds = [e["type"] for e in events]
        self.assertLess(kinds.index("tool_result"), kinds.index("delta"))
        self.assertEqual([t["function"]["name"] for t in opened[1].body["tools"]], ["ask_user"])
        seen = [json.loads(m["content"]) for m in opened[1].body["messages"] if m.get("tool_call_id") == "s1"]
        self.assertEqual([row["name"] for row in seen[0]["offers"]], ["B1", "B2"])
        self.assertEqual(events[-1]["messages"][-1], {"role": "assistant", "content": "首選 A1。"})

    def test_answer_may_end_with_a_trade_off_question(self):
        question = {"questions": [{"prompt": "更重視價錢還是耐用？", "options": ["價錢", "耐用"]}]}
        events, opened = self.run_turn(
            FakeStream([two_searches()]),
            FakeStream([say("A1 最耐用。"), call("ask_user", question, "q1")]),
        )
        ask = next(e for e in events if e["type"] == "ask")
        self.assertEqual(ask["id"], "q1")
        self.assertNotIn("retract", [e["type"] for e in events])
        self.assertEqual(events[-1]["messages"][-1]["content"], "A1 最耐用。")

    def test_found_store_links_update_the_cards_before_done(self):
        with mock.patch.object(harness, "refresh_cards", return_value=[{"name": "A1 updated"}]) as refresh:
            events, opened = self.run_turn(FakeStream([two_searches()]), FakeStream([say("首選 A1。")]))
        refs, shown = refresh.call_args.args
        self.assertEqual(len(refs), 5)
        self.assertEqual(len(shown), 5)
        self.assertEqual([e["type"] for e in events][-2:], ["cards", "done"])
        self.assertEqual(events[-2]["items"], [{"name": "A1 updated"}])

    def test_empty_answer_after_cards_still_says_something(self):
        events, opened = self.run_turn(FakeStream([two_searches()]), FakeStream([]))
        self.assertEqual(events[-1]["messages"][-1]["content"], harness.CARDS_TEXT)

    def test_pick_cards_skips_repeats_and_puts_priced_offers_first(self):
        models = [
            {"offers": [{"ref": "a", "name": "Same", "price": 1}, {"ref": "b", "name": "NoPrice", "price": None}]},
            {"offers": [{"ref": "c", "name": "same", "price": 2}, {"ref": "d", "name": "Other", "price": 3}]},
        ]
        self.assertEqual(tools.pick_cards(models), ["a", "d", "b"])

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
