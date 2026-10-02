#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import json
import os
import socket
import sys
import traceback
import urllib.error
import urllib.request

import loop
from agent import harness
from agent_prompt import explain_messages

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8765
MAX_BODY = 600_000
MAX_MESSAGES = 80
HIDDEN_PREFIXES = ("/agent", "/server.py")
PURCHASE_ROUTES = ("/api/purchase", "/api/settle", "/api/revoke", "/api/cool")


def load_env(path):
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ[key.strip()] = value.strip()


load_env(ROOT / ".env")

CONFIG = {
    "base_url": os.environ.get("OPENAI_BASE_URL", "https://xh.v1api.cc/v1").rstrip("/"),
    "api_key": os.environ.get("OPENAI_API_KEY", ""),
    "model": os.environ.get("OPENAI_MODEL", "deepseek-v4.1-flash"),
    "timeout": 25,
}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def setup(self):
        super().setup()
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

    def log_message(self, format, *args):
        message = format % args
        if "Authorization" in message or "sk-" in message:
            return
        super().log_message("%s", message)

    def do_GET(self):
        if urlparse(self.path).path == "/api/consent":
            self.send_json(200, loop.consent_view())
            return
        if self.is_hidden():
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if self.is_hidden():
            self.send_error(404)
            return
        super().do_HEAD()

    def is_hidden(self):
        path = urlparse(self.path).path
        if any(part.startswith(".") for part in path.split("/") if part):
            return True
        return path.startswith(HIDDEN_PREFIXES) or path.endswith(".py")

    def do_POST(self):
        path = urlparse(self.path).path
        if path in PURCHASE_ROUTES:
            self.purchase_route(path)
            return
        if path != "/api/chat":
            self.send_error(404)
            return
        if not CONFIG["api_key"]:
            self.send_json(503, {"error": "web/.env 缺少 OPENAI_API_KEY。"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY:
            self.send_json(400, {"error": "Request is empty or too large."})
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
            harness.run(CONFIG, messages, emit)
        except harness.Aborted:
            return
        except harness.UpstreamError as error:
            self.safe_emit(emit, {"type": "error", "message": str(error)})
        except Exception:
            traceback.print_exc(file=sys.stderr)
            self.safe_emit(emit, {"type": "error", "message": "助理發生內部錯誤。"})

    def purchase_route(self, path):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length < 0 or length > MAX_BODY:
            self.send_json(400, {"error": "Request is too large."})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            if path == "/api/purchase":
                result = purchase(payload)
            elif path == "/api/settle":
                result = loop.settle(str(payload.get("draftId") or ""))
            elif path == "/api/cool":
                result = loop.end_cooling(loop.SESSION)
            else:
                result = loop.revoke(loop.SESSION)
        except Exception as error:
            self.send_json(400, {"error": str(error)})
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


def purchase(payload):
    text = payload.get("message")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("message is required")
    turn = loop.run_turn(text.strip())
    turn["note"] = explain(turn)
    return turn


def explain(turn):
    if not CONFIG["api_key"]:
        return turn["note"]
    body = json.dumps(
        {
            "model": CONFIG["model"],
            "temperature": 0,
            "thinking": {"type": "disabled"},
            "messages": explain_messages(turn),
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{CONFIG['base_url']}/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {CONFIG['api_key']}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
        sentence = data["choices"][0]["message"]["content"].strip()
    except (urllib.error.URLError, KeyError, IndexError, TypeError, json.JSONDecodeError, TimeoutError, OSError):
        return turn["note"]
    if not sentence or len(sentence) > 320 or sentence.count("\n") > 0:
        return turn["note"]
    if any("\u4e00" <= character <= "\u9fff" for character in sentence):
        return turn["note"]
    return sentence


def normalize_messages(raw):
    if not isinstance(raw, list) or not raw:
        raise ValueError("messages must be a non-empty list.")
    raw = raw[-MAX_MESSAGES:]

    messages = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("Each message must be an object.")
        role = item.get("role")
        if role == "user":
            content = item.get("content")
            if not isinstance(content, str) or not content.strip():
                raise ValueError("Each user message needs text.")
            if len(content) > 8000:
                raise ValueError("A message is too long.")
            messages.append({"role": "user", "content": content.strip()})
        elif role == "assistant":
            messages.append(normalize_assistant(item))
        elif role == "tool":
            call_id = item.get("tool_call_id")
            content = item.get("content")
            if not isinstance(call_id, str) or not isinstance(content, str) or len(content) > 40000:
                raise ValueError("Invalid tool message.")
            messages.append({"role": "tool", "tool_call_id": call_id, "content": content})
        else:
            raise ValueError("Invalid message role.")

    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    if not messages:
        raise ValueError("The conversation needs a user message.")
    return messages


def normalize_assistant(item):
    content = item.get("content")
    if content is not None and not isinstance(content, str):
        raise ValueError("Invalid assistant message.")
    if isinstance(content, str) and len(content) > 20000:
        raise ValueError("An assistant message is too long.")
    message = {"role": "assistant", "content": content or None}

    calls = item.get("tool_calls")
    if calls:
        if not isinstance(calls, list) or len(calls) > 8:
            raise ValueError("Invalid tool calls.")
        clean = []
        for call in calls:
            function = call.get("function") if isinstance(call, dict) else None
            if (
                not isinstance(function, dict)
                or not isinstance(call.get("id"), str)
                or not isinstance(function.get("name"), str)
                or not isinstance(function.get("arguments", ""), str)
            ):
                raise ValueError("Invalid tool call.")
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
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"http://{HOST}:{PORT}/", flush=True)
    if CONFIG["api_key"]:
        print(f"model {CONFIG['model']}", flush=True)
    else:
        print("Missing OPENAI_API_KEY. Copy web/.env.example to web/.env", flush=True)
    if not os.environ.get("SERPER_API_KEY"):
        print("Missing SERPER_API_KEY. Live product search is off.", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
