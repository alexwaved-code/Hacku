"""Stripe REST calls in test mode only."""

import json
import urllib.error
import urllib.parse
import urllib.request

import config

STRIPE_API = "https://api.stripe.com/v1"
TIMEOUT = 20


class CheckoutError(Exception):
    def __init__(self, message, status=400, detail=None):
        super().__init__(message)
        self.status = status
        self.detail = detail


def key():
    value = config.stripe_key()
    if not value:
        raise CheckoutError("web/.env 缺少 STRIPE_SECRET_KEY。請放 sk_test_ 開頭的測試金鑰。", 503)
    if not value.startswith(("sk_test_", "rk_test_")):
        raise CheckoutError("這個頁面只接受 Stripe 測試金鑰（sk_test_），不收真錢。", 403)
    return value


def call(method, path, form=None, idempotency=None):
    data = urllib.parse.urlencode(form).encode("utf-8") if form is not None else None
    headers = {"Authorization": f"Bearer {key()}", "Content-Type": "application/x-www-form-urlencoded"}
    if idempotency:
        headers["Idempotency-Key"] = idempotency
    request = urllib.request.Request(f"{STRIPE_API}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read().decode("utf-8"))["error"]["message"]
        except Exception:
            message = f"HTTP {error.code}"
        raise CheckoutError(f"Stripe 拒絕了這次請求：{message}", 502) from error
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
        raise CheckoutError("連不上 Stripe，請再試一次。", 502) from error
