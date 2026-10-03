#!/usr/bin/env python3
"""HTTP routes for the chat page and the cart. Static files come from web/static/."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
import json
import socket
import sys
import threading
import traceback

import config
import llm
from agent import harness, tools
from pay import checkout, mandate
from shop import browser

MAX_BODY = 600_000
MAX_MESSAGES = 80
PAY_ROUTES = (
    "/api/checkout",
    "/api/pay",
    "/api/mandate",
    "/api/mandate/revoke",
    "/api/fulfil/start",
    "/api/fulfil/placed",
    "/api/fulfil/refund",
)
GET_ROUTES = {
    "/api/mandate": mandate.view,
    "/api/orders": checkout.recent,
    "/api/fulfil": checkout.fulfilment,
}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(config.STATIC), **kwargs)

    def setup(self):
        super().setup()
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, format, *args):
        message = format % args
        if "Authorization" in message or "sk-" in message:
            return
        super().log_message("%s", message)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/cart.html":
            dest = "/pay.html"
            if url.query:
                dest += "?" + url.query
            self.send_response(302)
            self.send_header("Location", dest)
            self.end_headers()
            return
        if url.path == "/health":
            self.send_json(200, {"ok": True})
            return
        if url.path == "/api/checkout/status":
            session = (parse_qs(url.query).get("session") or [""])[0]
            self.pay_reply(lambda: checkout.status(session))
            return
        if url.path in GET_ROUTES:
            self.pay_reply(GET_ROUTES[url.path])
            return
        if self.is_hidden():
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        url = urlparse(self.path)
        if url.path == "/cart.html":
            dest = "/pay.html"
            if url.query:
                dest += "?" + url.query
            self.send_response(302)
            self.send_header("Location", dest)
            self.end_headers()
            return
        if self.is_hidden():
            self.send_error(404)
            return
        super().do_HEAD()

    def is_hidden(self):
        return any(part.startswith(".") for part in urlparse(self.path).path.split("/") if part)

    def do_POST(self):
        path = urlparse(self.path).path
        if path in PAY_ROUTES:
            self.pay_reply(lambda: self.pay_action(path, self.read_json()))
            return
        if path != "/api/chat":
            self.send_error(404)
            return
        if not config.CHAT["api_key"]:
            self.send_json(503, {"error": "web/.env 缺少 OPENAI_API_KEY。"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY:
            self.send_json(400, {"error": "請求是空的或太大。"})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            messages = normalize_messages(payload.get("messages"))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, AttributeError) as error:
            self.send_json(400, {"error": str(error)})
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def emit(event):
            try:
                self.wfile.write(f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError) as error:
                raise harness.Aborted() from error

        try:
            harness.run(config.CHAT, messages, emit, lang="en" if payload.get("lang") == "en" else "zh", cart=payload.get("cart"))
        except harness.Aborted:
            return
        except llm.UpstreamError as error:
            self.safe_emit(emit, {"type": "error", "message": str(error)})
        except Exception:
            traceback.print_exc(file=sys.stderr)
            self.safe_emit(emit, {"type": "error", "message": "助理發生內部錯誤。"})

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length < 0 or length > MAX_BODY:
            raise checkout.CheckoutError("請求太大。")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise checkout.CheckoutError("請求不是 JSON。") from error
        if not isinstance(payload, dict):
            raise checkout.CheckoutError("請求格式不對。")
        return payload

    def pay_action(self, path, payload):
        if path == "/api/checkout":
            return checkout.create(payload.get("items"))
        if path == "/api/pay":
            return checkout.create(payload.get("items"), via="agent")
        if path == "/api/mandate/revoke":
            return mandate.revoke()
        if path == "/api/fulfil/start":
            return start_fulfil(payload.get("id"))
        if path == "/api/fulfil/placed":
            return checkout.mark_placed(payload.get("id"), payload.get("store_order"))
        if path == "/api/fulfil/refund":
            return checkout.refund(payload.get("id"))
        try:
            return mandate.issue(payload.get("caps"), payload.get("days"))
        except mandate.MandateError as error:
            raise checkout.CheckoutError(str(error)) from error

    def pay_reply(self, action):
        try:
            result = action()
        except checkout.CheckoutError as error:
            body = {"error": str(error)}
            if error.detail:
                body.update(error.detail)
            self.send_json(error.status, body)
            return
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "付款服務發生錯誤，請再試一次。"})
            return
        self.send_json(200, result)

    def safe_emit(self, emit, event):
        try:
            emit(event)
        except harness.Aborted:
            pass

    def send_json(self, status, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)


def agent_quote(items):
    try:
        return {"ok": True, **checkout.quote(items)}
    except checkout.CheckoutError as error:
        return {"ok": False, "reason": str(error)}


tools.set_quoter(agent_quote)


def agent_app_state():
    view = mandate.view()
    orders = checkout.recent(5)["orders"]
    return {
        "payment_authorization": {key: view.get(key) for key in ("valid", "caps", "expires", "detail")},
        "recent_paid_orders": [
            {
                "at": order.get("at"),
                "total": order.get("total"),
                "currency": order.get("currency"),
                "items": [f"{item.get('name')} × {item.get('qty')}" for item in order.get("items") or []][:5],
                "status": order.get("fulfil"),
                "live": order.get("live"),
            }
            for order in orders
        ],
    }


tools.set_app_state(agent_app_state)


def start_fulfil(order_id):
    order = checkout.order(order_id)
    if order["fulfil"] in ("filling", "placed", "refunded"):
        raise checkout.CheckoutError("這筆訂單現在不能代填。", 409)
    checkout.set_fulfil(order["id"], "filling")
    threading.Thread(target=run_fulfil, args=(order,), daemon=True).start()
    return checkout.order(order["id"])


def run_fulfil(order):
    try:
        step, note = browser.fill(order)
    except Exception as error:
        traceback.print_exc()
        step, note = "failed", f"代填失敗：{type(error).__name__}"
    checkout.set_fulfil(order["id"], step, note)


def normalize_messages(raw):
    if not isinstance(raw, list) or not raw:
        raise ValueError("對話紀錄格式不對。")
    raw = raw[-MAX_MESSAGES:]

    messages = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("對話紀錄格式不對。")
        role = item.get("role")
        if role == "user":
            content = item.get("content")
            if not isinstance(content, str) or not content.strip():
                raise ValueError("訊息不能是空的。")
            if len(content) > 8000:
                raise ValueError("訊息太長了。")
            messages.append({"role": "user", "content": content.strip()})
        elif role == "assistant":
            messages.append(normalize_assistant(item))
        elif role == "tool":
            call_id = item.get("tool_call_id")
            content = item.get("content")
            if not isinstance(call_id, str) or not isinstance(content, str) or len(content) > 40000:
                raise ValueError("工具紀錄格式不對。")
            messages.append({"role": "tool", "tool_call_id": call_id, "content": content})
        else:
            raise ValueError("對話紀錄格式不對。")

    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    if not messages:
        raise ValueError("對話需要至少一則你的訊息。")
    return messages


def normalize_assistant(item):
    content = item.get("content")
    if content is not None and not isinstance(content, str):
        raise ValueError("助理紀錄格式不對。")
    if isinstance(content, str) and len(content) > 20000:
        raise ValueError("助理紀錄太長了。")
    message = {"role": "assistant", "content": content or None}

    calls = item.get("tool_calls")
    if calls:
        if not isinstance(calls, list) or len(calls) > 8:
            raise ValueError("工具紀錄格式不對。")
        clean = []
        for call in calls:
            function = call.get("function") if isinstance(call, dict) else None
            if (
                not isinstance(function, dict)
                or not isinstance(call.get("id"), str)
                or not isinstance(function.get("name"), str)
                or not isinstance(function.get("arguments", ""), str)
            ):
                raise ValueError("工具紀錄格式不對。")
            clean.append(
                {
                    "id": call["id"],
                    "type": "function",
                    "function": {"name": function["name"], "arguments": function.get("arguments") or "{}"},
                }
            )
        message["tool_calls"] = clean
    elif not content:
        message["content"] = ""
    return message


def main():
    server = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    print(f"{config.ORIGIN}/", flush=True)
    print(f"listen {config.HOST}:{config.PORT}", flush=True)
    if config.CHAT["api_key"]:
        print(f"model {config.CHAT['model']}", flush=True)
    else:
        print("Missing OPENAI_API_KEY. Copy web/.env.example to web/.env", flush=True)
    if not config.VERIFY_SEPARATE:
        print("No VERIFY_* settings. The chat model also rates listings at checkout.", flush=True)
    if not config.serper_key():
        print("Missing SERPER_API_KEY. Live product search is off.", flush=True)
    key = config.stripe_key()
    if key.startswith(("sk_live_", "rk_live_")):
        print("Stripe LIVE key: real money." if config.live_payments() else "Stripe live key without HACKU_LIVE=1. Checkout is off.", flush=True)
    elif not key.startswith(("sk_test_", "rk_test_")):
        print("No Stripe key. Checkout is off.", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
