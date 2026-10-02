"""Spending mandate.

The shopper signs per-order caps once, per currency, for a set number of days.
Checkout reads the stored mandate and refuses any order it does not cover.
"""

import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone

import config
import money

from . import store

HK = timezone(timedelta(hours=8))
SUBJECT = "did:example:hacku-customer"
AGENT = "did:example:hacku-shopping-agent"
MAX_DAYS = 30
MAX_CAP = 1_000_000


class MandateError(ValueError):
    pass


def now():
    return datetime.now(HK)


def issue(caps, days, at=None):
    """Sign a new mandate. It replaces any mandate that is still open."""
    at = at or now()
    caps = _clean_caps(caps)
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= MAX_DAYS:
        raise MandateError(f"有效天數要在 1 到 {MAX_DAYS} 天之間。")
    document = {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        "type": ["VerifiableCredential", "SpendingMandate"],
        "id": f"urn:hacku:mandate:{secrets.token_hex(8)}",
        "issuer": SUBJECT,
        "issuanceDate": _iso(at),
        "expirationDate": _iso(at + timedelta(days=days)),
        "credentialSubject": {"id": SUBJECT, "agent": AGENT, "perOrderCaps": caps},
    }
    with store.db() as conn:
        conn.execute("UPDATE mandates SET revoked_at = ? WHERE revoked_at IS NULL", (_iso(at),))
        conn.execute(
            "INSERT INTO mandates (id, document, signature, issued_at) VALUES (?, ?, ?, ?)",
            (document["id"], json.dumps(document, ensure_ascii=False), _sign(document), _iso(at)),
        )
        store.append(conn, "mandate_issued", {"id": document["id"], "caps": caps, "expires": document["expirationDate"]}, at)
    return view(at)


def revoke(at=None):
    at = at or now()
    with store.db() as conn:
        row = _latest(conn)
        if row and not row["revoked_at"]:
            conn.execute("UPDATE mandates SET revoked_at = ? WHERE id = ?", (_iso(at), row["id"]))
            store.append(conn, "mandate_revoked", {"id": row["id"]}, at)
    return view(at)


def problem(currency=None, total=None, at=None):
    """None when the current mandate covers this order, otherwise the reason in plain words."""
    at = at or now()
    with store.db() as conn:
        row = _latest(conn)
    return _problem(row, currency, total, at)


def view(at=None):
    at = at or now()
    with store.db() as conn:
        row = _latest(conn)
    reason = _problem(row, None, None, at)
    if row is None:
        return {"valid": False, "detail": reason, "caps": {}}
    document = json.loads(row["document"])
    expires = datetime.fromisoformat(document["expirationDate"])
    return {
        "valid": reason is None,
        "detail": reason or f"授權有效至 {expires:%Y-%m-%d %H:%M}。",
        "id": document["id"],
        "caps": document["credentialSubject"]["perOrderCaps"],
        "expires": document["expirationDate"],
        "subject": SUBJECT,
        "agent": AGENT,
    }


def _problem(row, currency, total, at):
    if row is None:
        return "還沒有付款授權。請先設定每筆上限並簽署。"
    document = json.loads(row["document"])
    if not hmac.compare_digest(row["signature"], _sign(document)):
        return "授權紀錄的簽章對不上，請重新簽署。"
    if row["revoked_at"]:
        return "你已撤銷授權。"
    if at > datetime.fromisoformat(document["expirationDate"]):
        return "授權已過期，請重新簽署。"
    if currency is None:
        return None
    caps = document["credentialSubject"]["perOrderCaps"]
    if currency not in caps:
        return f"授權沒有涵蓋 {currency}，請加上這個幣別的每筆上限。"
    if total is not None and total > caps[currency]:
        return f"這筆 {money.text(total, currency)} 超過授權的每筆上限 {money.text(caps[currency], currency)}。"
    return None


def _clean_caps(caps):
    if not isinstance(caps, dict) or not caps:
        raise MandateError("至少要設定一個幣別的每筆上限。")
    clean = {}
    for code, amount in caps.items():
        code = str(code).upper()
        if code not in money.SIGNS:
            raise MandateError(f"不支援 {code}。")
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not 0 < amount <= MAX_CAP:
            raise MandateError(f"{code} 的上限要大於 0，且不超過 {MAX_CAP:,}。")
        clean[code] = round(float(amount), 2)
    return clean


def _latest(conn):
    return conn.execute("SELECT * FROM mandates ORDER BY issued_at DESC, rowid DESC LIMIT 1").fetchone()


def _sign(document):
    key = hmac.new(config.secret(), b"spending-mandate", hashlib.sha256).digest()
    payload = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hmac.new(key, payload.encode("utf-8"), hashlib.sha256).hexdigest()


def _iso(at):
    return at.astimezone(HK).isoformat(timespec="seconds")
