"""Serve the chat page, run the ReAct loop, and settle only with consent.

The model key stays in the repo-root .env file. It is never sent to the browser.
"""

import json
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from agent_prompt import explain_messages
from loop import SESSION, consent_view, end_cooling, revoke, run_turn, settle

ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT.parent / ".env"
HOST = "127.0.0.1"
PORT = 8765


def load_env(path):
    env = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


ENV = load_env(ENV_PATH)
API_BASE = ENV.get("API_BASE", "").rstrip("/")
API_KEY = ENV.get("API_KEY", "")
MODEL = ENV.get("MODEL", "deepseek-v4.1-flash")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/consent":
            self.respond(200, consent_view())
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
            if path == "/api/chat":
                result = chat(payload)
            elif path == "/api/settle":
                result = settle(str(payload.get("draftId") or ""))
            elif path == "/api/revoke":
                result = revoke(SESSION)
            elif path == "/api/cool":
                result = end_cooling(SESSION)
            else:
                self.send_error(404)
                return
        except Exception as error:
            self.respond(400, {"error": str(error)})
            return
        self.respond(200, result)

    def respond(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def chat(payload):
    text = payload.get("message")
    if not isinstance(text, str) or not text.strip():
        messages = payload.get("messages")
        if isinstance(messages, list) and messages:
            text = messages[-1].get("content")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("message is required")
    turn = run_turn(text.strip())
    turn["note"] = explain(turn)
    return turn


def explain(turn):
    if not API_BASE or not API_KEY:
        return turn["note"]
    body = json.dumps(
        {
            "model": MODEL,
            "temperature": 0,
            "messages": explain_messages(turn),
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        API_BASE + "/v1/chat/completions",
        data=body,
        headers={
            "Authorization": "Bearer " + API_KEY,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
        sentence = data["choices"][0]["message"]["content"].strip()
    except (urllib.error.URLError, KeyError, IndexError, TypeError, json.JSONDecodeError, TimeoutError):
        return turn["note"]
    if not sentence or len(sentence) > 320 or sentence.count("\n") > 0:
        return turn["note"]
    if any("\u4e00" <= character <= "\u9fff" for character in sentence):
        return turn["note"]
    return sentence


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
