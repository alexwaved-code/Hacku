import json
import unittest
from unittest import mock

import cards
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
    def run_turn(self, *streams, lang="zh", cart=None):
        script = list(streams)
        opened = []

        def open_stream(config, body):
            stream = script.pop(0)
            stream.body = body
            opened.append(stream)
            return stream

        events = []
        with mock.patch.object(harness.llm, "open_stream", side_effect=open_stream), mock.patch.object(harness, "run_tool", fake_tools):
            harness.run(CONFIG, [{"role": "user", "content": "買充電線"}], events.append, lang=lang, cart=cart)
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
        self.assertEqual([t["function"]["name"] for t in opened[1].body["tools"]], ["ask_user", "next_steps"])
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

    def test_each_round_announces_its_phase(self):
        events, opened = self.run_turn(FakeStream([two_searches()]), FakeStream([say("首選 A1。")]))
        self.assertEqual([e["phase"] for e in events if e["type"] == "phase"], ["plan", "answer"])

    def test_search_detail_names_a_few_stores_and_the_lowest_price(self):
        rows = [
            {"store": store, "price": price, "currency": "HKD"}
            for store, price in [("豐澤", 399), ("The Club", 125), ("豐澤", 150), ("領域", None), ("偉倫", 299)]
        ]
        self.assertEqual(tools._offers_detail(rows), "豐澤、The Club、領域 等 · 最低 HK$125")
        self.assertEqual(tools._offers_detail([]), "")

    def test_english_page_gets_english_labels_and_prompt(self):
        events, opened = self.run_turn(FakeStream([two_searches()]), FakeStream([]), lang="en")
        self.assertIn("Reply in English", opened[0].body["messages"][0]["content"])
        start = next(e for e in events if e["type"] == "tool_start" and e["name"] == "shop_search")
        self.assertEqual(start["label"], "Checking prices for “A”")
        self.assertEqual(events[-1]["messages"][-1]["content"], "Here is what I found.")
        self.assertEqual(tools.LANG.get(), "zh")

    def test_chinese_is_the_default(self):
        events, opened = self.run_turn(FakeStream([two_searches()]), FakeStream([]))
        self.assertNotIn("Reply in English", opened[0].body["messages"][0]["content"])
        start = next(e for e in events if e["type"] == "tool_start" and e["name"] == "shop_search")
        self.assertEqual(start["label"], "查價「A」")

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

    def test_next_steps_follow_the_reply(self):
        actions = {
            "actions": [
                {"label": "比較 A1 A2", "prompt": "A1 和 A2 差在哪？"},
                {"label": "買 A1", "prompt": "買第一個"},
                {"label": "換品牌", "prompt": "有沒有 Anker 的？"},
            ]
        }
        events, opened = self.run_turn(
            FakeStream([two_searches()]),
            FakeStream([say("首選 A1。"), call("next_steps", actions, "n1")]),
        )
        self.assertEqual(len(opened), 2)
        nxt = next(event for event in events if event["type"] == "next")
        self.assertEqual(nxt["actions"], actions["actions"])

    def test_next_steps_are_asked_if_the_reply_omits_them(self):
        actions = {
            "actions": [
                {"label": "買 A1", "prompt": "買第一個"},
                {"label": "更平的", "prompt": "有沒有更便宜的充電線？"},
                {"label": "加購物車", "prompt": "第一個加進購物車"},
            ]
        }
        events, opened = self.run_turn(
            FakeStream([two_searches()]),
            FakeStream([say("首選 A1。")]),
            FakeStream([call("next_steps", actions, "n1")]),
        )
        self.assertEqual(len(opened), 3)
        self.assertEqual(opened[2].body["tool_choice"], "required")
        self.assertEqual([tool["function"]["name"] for tool in opened[2].body["tools"]], ["next_steps"])
        nxt = next(event for event in events if event["type"] == "next")
        self.assertEqual(nxt["actions"], actions["actions"])

    def test_clean_actions_keeps_short_unique_prompts(self):
        raw = {
            "actions": [
                {"label": "買第一個", "prompt": "買第一個"},
                {"label": "買第一個", "prompt": "買第一個"},
                {"label": "", "prompt": "空的"},
                {"text": "比較這兩個", "message": "A1 和 A2 差在哪？"},
            ]
        }
        self.assertEqual(
            tools.clean_actions(raw),
            [
                {"label": "買第一個", "prompt": "買第一個"},
                {"label": "比較這兩個", "prompt": "A1 和 A2 差在哪？"},
            ],
        )


    def cart_line(self, sealed=True):
        item = {field: offer()[field] for field in cards.FIELDS}
        return {"id": item["url"], "qty": 2, "sealed": item, "sig": cards.seal(item) if sealed else ""}

    def test_cart_is_in_the_prompt(self):
        events, opened = self.run_turn(FakeStream([say("你的購物車有一條充電線。")]), cart=[self.cart_line()])
        prompt = opened[0].body["messages"][0]["content"]
        self.assertIn('"line": "c1"', prompt)
        self.assertIn("MOMAX 60W cable", prompt)
        self.assertNotIn("no server seal", prompt.split("cart now:")[1])
        events, opened = self.run_turn(FakeStream([say("你好")]))
        self.assertIn("did not send", opened[0].body["messages"][0]["content"])
        self.assertIsNone(tools.CART.get())

    def test_update_cart_changes_lines_and_ends_the_turn(self):
        ref = tools._remember({**offer(), "name": "Anker cable", "url": "https://www.hktvmall.com/p/2"})
        args = {"set": [{"line": "c1", "qty": 3}], "add": [{"ref": ref, "qty": 1}]}
        events, opened = self.run_turn(FakeStream([call("update_cart", args)]), cart=[self.cart_line()])
        self.assertEqual(len(opened), 1)
        result = next(e for e in events if e["type"] == "tool_result")
        ops = result["ui"]["ops"]
        self.assertEqual(ops[0], {"op": "set", "id": "https://www.hktvmall.com/p/1", "qty": 3})
        self.assertEqual(ops[1]["op"], "add")
        self.assertTrue(cards.valid({f: ops[1]["card"][f] for f in cards.FIELDS}, ops[1]["card"]["sig"]))
        text = "".join(e["text"] for e in events if e["type"] == "delta")
        self.assertIn("購物車已更新", text)
        self.assertIn("Anker cable", text)

    def test_buy_from_cart_lines_sends_the_sealed_items(self):
        seen = []
        tools.set_quoter(lambda items: seen.extend(items) or {"ok": True, "total": 138.0, "currency": "HKD", "cap": 500, "live": False, "items": [{"name": "MOMAX 60W cable", "qty": 2}]})
        events, opened = self.run_turn(FakeStream([call("buy", {"items": [{"line": "c1"}]})]), cart=[self.cart_line()])
        self.assertEqual(seen[0]["qty"], 2)
        self.assertEqual(seen[0]["sig"], cards.seal({f: offer()[f] for f in cards.FIELDS}))
        self.assertEqual(len(opened), 1)
        token = tools.set_cart([self.cart_line(sealed=False)])
        try:
            refused = tools.buy([{"line": "c1"}])
        finally:
            tools.CART.reset(token)
        self.assertFalse(refused["ok"])

    def test_refs_from_before_a_restart_never_match_new_products(self):
        ref = tools._remember(offer())
        self.assertTrue(ref.startswith(tools._run))
        with mock.patch.object(tools, "_run", "zzz" if tools._run != "zzz" else "yyy"):
            fresh = tools._remember(offer())
        self.assertNotEqual(ref[:3], fresh[:3])
        tools.set_quoter(lambda items: {"ok": True, "total": 69.0, "currency": "HKD", "items": []})
        self.assertEqual(tools.buy([{"ref": "p1"}])["model"]["error"], "That ref is unknown or expired. Search again and show the products first.")

    def test_clear_empties_the_cart(self):
        token = tools.set_cart([self.cart_line(), {**self.cart_line(), "id": "other"}])
        try:
            result = tools.update_cart({"clear": True})
        finally:
            tools.CART.reset(token)
        self.assertEqual([op["op"] for op in result["ui"]["ops"]], ["remove", "remove"])
        self.assertEqual(result["model"]["cart"], [])

    def test_page_actions_run_on_the_page_and_end_the_turn(self):
        events, opened = self.run_turn(FakeStream([call("control_page", {"action": "cart_page"})]), cart=[])
        self.assertEqual(len(opened), 1)
        result = next(e for e in events if e["type"] == "tool_result")
        self.assertEqual(result["ui"], {"kind": "page", "action": "cart_page"})
        self.assertIn("購物車頁面", "".join(e["text"] for e in events if e["type"] == "delta"))
        self.assertFalse(tools.control_page("delete_everything")["ok"])

    def test_authorization_and_orders_are_in_the_prompt(self):
        tools.set_app_state(lambda: {"payment_authorization": {"valid": True, "caps": {"HKD": 500}}, "recent_paid_orders": []})
        try:
            events, opened = self.run_turn(FakeStream([say("每筆上限 HK$500。")]), cart=[])
        finally:
            tools.set_app_state(None)
        self.assertIn('"caps": {"HKD": 500}', opened[0].body["messages"][0]["content"])

if __name__ == "__main__":
    unittest.main()
