#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import socket
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
                "stream": True,
                "max_tokens": 1024,
                "thinking": {"type": "disabled"},
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
            upstream = urllib.request.urlopen(request, timeout=60)
        except urllib.error.HTTPError as error:
            detail = read_upstream_error(error)
            self.send_json(error.code if 400 <= error.code < 600 else 502, {"error": detail})
            return
        except Exception:
            self.send_json(502, {"error": "The model did not respond."})
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.flush()

        try:
            while True:
                raw = upstream.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                delta = extract_delta(data)
                if not delta:
                    continue
                self.wfile.write(f"data: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
            self.wfile.write(b'data: {"done":true}\n\n')
            self.wfile.flush()
        except Exception:
            try:
                self.wfile.write(b'data: {"error":"The model stream stopped."}\n\n')
                self.wfile.flush()
            except Exception:
                pass
        finally:
            upstream.close()
            self.close_connection = True

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


def extract_delta(raw):
    try:
        payload = json.loads(raw)
        delta = payload["choices"][0]["delta"]
    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
        return ""
    content = delta.get("content")
    return content if isinstance(content, str) else ""


def read_upstream_error(error):
    try:
        body = json.loads(error.read().decode("utf-8"))
    except Exception:
        return "The model request failed."
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            for key in ("message", "msg", "detail"):
                if isinstance(err.get(key), str) and err[key].strip():
                    return err[key]
        if isinstance(err, str) and err.strip():
            return err
        if isinstance(body.get("message"), str):
            return body["message"]
        if isinstance(body.get("msg"), str):
            return body["msg"]
    return "The model request failed."


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"http://{HOST}:{PORT}/", flush=True)
    if API_KEY:
        print(f"model {MODEL}", flush=True)
    else:
        print("Missing OPENAI_API_KEY. Copy web/.env.example to web/.env", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
