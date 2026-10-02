#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8765
MAX_BODY = 200_000


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

BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://xh.v1api.cc/v1").rstrip("/")
API_KEY = os.environ.get("OPENAI_API_KEY", "")
MODEL = os.environ.get("OPENAI_MODEL", "deepseek-v4.1-flash")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        message = format % args
        if "Authorization" in message or "sk-" in message:
            return
        super().log_message("%s", message)

    def do_POST(self):
        if self.path != "/api/chat":
            self.send_error(404)
            return
        if not API_KEY:
            self.send_json(503, {"error": "Missing OPENAI_API_KEY in web/.env"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY:
            self.send_json(400, {"error": "Request is empty or too large."})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            messages = normalize_messages(payload.get("messages"))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self.send_json(400, {"error": str(error)})
            return

        body = json.dumps(
            {
                "model": MODEL,
                "messages": messages,
                "stream": False,
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            f"{BASE_URL}/chat/completions",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Content-Type": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = read_upstream_error(error)
            self.send_json(error.code if 400 <= error.code < 600 else 502, {"error": detail})
            return
        except Exception:
            self.send_json(502, {"error": "The model did not respond."})
            return

        reply = extract_reply(data)
        if not reply:
            self.send_json(502, {"error": "The model returned an empty reply."})
            return
        self.send_json(200, {"reply": reply})

    def send_json(self, status, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)


def normalize_messages(raw):
    if not isinstance(raw, list) or not raw:
        raise ValueError("messages must be a non-empty list.")
    if len(raw) > 40:
        raise ValueError("Too many messages.")
    messages = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("Each message must be an object.")
        role = item.get("role")
        content = item.get("content")
        if role not in {"system", "user", "assistant"}:
            raise ValueError("Invalid message role.")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("Each message needs text.")
        if len(content) > 8000:
            raise ValueError("A message is too long.")
        messages.append({"role": role, "content": content.strip()})
    return messages


def extract_reply(data):
    try:
        message = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return ""
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    reasoning = message.get("reasoning_content")
    if isinstance(reasoning, str) and reasoning.strip():
        return reasoning.strip()
    return ""


def read_upstream_error(error):
    try:
        body = json.loads(error.read().decode("utf-8"))
    except Exception:
        return "The model request failed."
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and isinstance(err.get("message"), str):
            return err["message"]
        if isinstance(err, str):
            return err
        if isinstance(body.get("message"), str):
            return body["message"]
    return "The model request failed."


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"http://{HOST}:{PORT}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
