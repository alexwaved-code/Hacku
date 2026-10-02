"""OpenAI-compatible chat completions over urllib."""

import http.client
import json
import re
import urllib.error
import urllib.request

BUSY = re.compile(r"retry later|reduce the request|could not be completed|rate.?limit|overload|too many requests|busy", re.IGNORECASE)


class UpstreamError(Exception):
    pass


class Busy(Exception):
    pass


def open_stream(config, body):
    """POST with stream: true. Returns the open response; the caller reads and closes it."""
    return _post(config, {**body, "stream": True}, "text/event-stream", config.get("timeout", 60))


def complete(config, body):
    """POST without streaming. Returns choices[0].message."""
    with _post(config, {**body, "stream": False}, "application/json", config.get("timeout", 30)) as response:
        try:
            data = json.loads(response.read().decode("utf-8"))
            return data["choices"][0]["message"]
        except (json.JSONDecodeError, KeyError, IndexError, TypeError) as error:
            raise UpstreamError("模型回傳的格式不對。") from error


def _post(config, body, accept, timeout):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    for attempt in range(2):
        request = urllib.request.Request(
            f"{config['base_url']}/chat/completions",
            data=data,
            method="POST",
            headers={
                "Authorization": f"Bearer {config['api_key']}",
                "Content-Type": "application/json",
                "Accept": accept,
            },
        )
        try:
            return urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            message = _read_http_error(error)
            if error.code == 429 or BUSY.search(message):
                raise Busy(message) from error
            if error.code >= 500 and attempt == 0:
                continue
            raise UpstreamError(message) from error
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError):
            if attempt == 0:
                continue
    raise UpstreamError("連不上模型，請再試一次。")


def _read_http_error(error):
    try:
        body = json.loads(error.read().decode("utf-8"))
    except Exception:
        return f"模型請求失敗（{error.code}）。"
    return error_text(body) or f"模型請求失敗（{error.code}）。"


def error_text(body):
    if not isinstance(body, dict):
        return ""
    err = body.get("error")
    if isinstance(err, dict):
        for key in ("message", "msg", "detail"):
            if isinstance(err.get(key), str) and err[key].strip():
                return err[key]
    if isinstance(err, str) and err.strip():
        return err
    for key in ("message", "msg"):
        if isinstance(body.get(key), str) and body[key].strip():
            return body[key]
    return ""
