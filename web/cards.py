"""Server seal on product cards, so the browser cannot change what checkout charges."""

import hashlib
import hmac
import json

import config

FIELDS = ("name", "store", "price", "currency", "url", "image")


def seal(card):
    values = [card.get(field) for field in FIELDS]
    values = [float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else value for value in values]
    payload = json.dumps(values, ensure_ascii=False, separators=(",", ":"))
    return hmac.new(_key(), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def valid(card, signature):
    return isinstance(signature, str) and hmac.compare_digest(seal(card), signature)


def _key():
    return hmac.new(config.secret(), b"card-seal", hashlib.sha256).digest()
