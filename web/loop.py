"""ReAct loop for one spending decision.

The server reasons, checks the mandate, compares payment rails, and settles.
A model may phrase the result. It cannot change the amounts, the rule, or the rail.
"""

import hashlib
import hmac
import json
import re
import uuid
from datetime import datetime, timedelta, timezone

from catalog import filter_products
from shield import MANDATE, judge, parse_payee, parse_qty, seal
from verifier import verify_products

TZ = timezone(timedelta(hours=8))
EXPIRES = datetime(2026, 10, 7, 23, 59, 59, tzinfo=TZ)
PROOF_SECRET = b"hacku-demo-consent-v1"
RATE_SOURCE = "scenario fixture supplied 2026-10-02, not a live network quote"

RAILS = (
    {
        "id": "mastercard",
        "name": "Mastercard",
        "grocery_cashback": 0.05,
        "general_cashback": 0.02,
    },
    {
        "id": "unionpay",
        "name": "UnionPay",
        "grocery_cashback": None,
        "general_cashback": None,
    },
)

RULES = {
    "groceries": {"id": "GROC_WEEK", "cap": 200.0, "window": "rolling_7d"},
    "entertainment": {"id": "ENT_TX", "cap": 50.0, "window": "per_transaction"},
}


class Session:
    def __init__(self):
        self.revoked = False
        self.settlements = []
        self.drafts = {}
        self.chain = []
        self.cooling_until = None


SESSION = Session()


def now_hk(now=None):
    if now is None:
        now = datetime.now(TZ)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=TZ)
    return now.astimezone(TZ)


def issue_consent(now=None):
    now = now_hk(now)
    document = {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        "type": ["VerifiableCredential", "SpendingMandate"],
        "issuer": "did:example:hacku-customer",
        "issuanceDate": now.isoformat(timespec="seconds"),
        "expirationDate": EXPIRES.isoformat(timespec="seconds"),
        "credentialSubject": {
            "id": "did:example:hacku-customer",
            "agent": "did:example:hacku-shopping-agent",
            "rules": [
                {
                    "id": "GROC_WEEK",
                    "category": "groceries",
                    "capUsd": 200,
                    "window": "rolling_7d",
                    "merchants": MANDATE["scenes"]["groceries"]["merchants"],
                },
                {
                    "id": "ENT_TX",
                    "category": "entertainment",
                    "capUsd": 50,
                    "window": "per_transaction",
                    "maxQty": 2,
                    "merchants": MANDATE["scenes"]["entertainment"]["merchants"],
                },
            ],
        },
    }
    document["proof"] = {
        "type": "HmacSha256Signature2026",
        "proofPurpose": "assertionMethod",
        "verificationMethod": "did:example:hacku-customer#demo",
        "signature": sign(document),
    }
    return document


def sign(unsigned):
    body = {key: value for key, value in unsigned.items() if key != "proof"}
    payload = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hmac.new(PROOF_SECRET, payload, hashlib.sha256).hexdigest()


def consent_problem(now=None, session=None):
    session = session or SESSION
    now = now_hk(now)
    document = issue_consent(now)
    if not hmac.compare_digest(document["proof"]["signature"], sign(document)):
        return "The consent credential signature does not match."
    if session.revoked:
        return "You revoked this consent."
    if now > EXPIRES:
        return "This consent expired at the end of 7 Oct 2026."
    return None


def consent_view(now=None, session=None):
    now = now_hk(now)
    problem = consent_problem(now, session)
    return {
        "valid": problem is None,
        "detail": problem or "Consent credential is valid through 7 Oct 2026.",
        "subject": "did:example:hacku-customer",
        "agent": "did:example:hacku-shopping-agent",
        "expires": EXPIRES.isoformat(timespec="seconds"),
        "demo": "Local did:example credential. The shield checks the signature, the mandate, and the hash log.",
    }


def revoke(session=None):
    session = session or SESSION
    session.revoked = True
    return {
        "valid": False,
        "detail": "You revoked this consent. Settlement is closed.",
        "text": "Consent revoked. The agent cannot settle until a new mandate exists.",
    }


def parse_purchase(text):
    lowered = text.lower()
    if re.search(r"\brevoke\b", lowered):
        return {"intent": "revoke"}
    category = None
    if re.search(r"grocer", lowered):
        category = "groceries"
    elif re.search(r"entertain|ticket|concert|movie", lowered):
        category = "entertainment"
    elif re.search(r"electronic|headphone|laptop|\bphone\b", lowered):
        category = "electronics"
    amount_match = re.search(r"(?:for|of)\s+\$?\s*(\d+(?:\.\d+)?)", lowered)
    if not amount_match:
        amount_match = re.search(r"\$\s*(\d+(?:\.\d+)?)", lowered)
    if not amount_match:
        amount_match = re.search(r"(\d+(?:\.\d+)?)\s*usd", lowered)
    amount = float(amount_match.group(1)) if amount_match else None
    return {
        "intent": "purchase",
        "category": category,
        "amount": amount,
        "shipping": fee(lowered, "shipping"),
        "tax": fee(lowered, "tax"),
    }


def fee(text, name):
    match = re.search(rf"{name}(?:\s+is)?\s+\$?\s*(\d+(?:\.\d+)?)", text)
    if not match:
        return None
    return float(match.group(1))


def grocery_spent(session, now):
    start = now - timedelta(days=7)
    return round(
        sum(
            item["total"]
            for item in session.settlements
            if item["category"] == "groceries" and item["at"] >= start
        ),
        2,
    )


def rank_rails(category, total):
    ranked = []
    for rail in RAILS:
        rate = rail["grocery_cashback"] if category == "groceries" else rail["general_cashback"]
        reward = None if rate is None else round(total * rate, 2)
        kind = "grocery" if category == "groceries" else "general"
        if rate is None:
            label = f"{kind} cashback unknown"
        else:
            label = f"{int(rate * 100)}% {kind} cashback"
        ranked.append(
            {
                "id": rail["id"],
                "name": rail["name"],
                "rate": rate,
                "reward": reward,
                "rateLabel": label,
                "source": RATE_SOURCE if rate is not None else "not on the 2026-10-02 fixture",
                "recommended": False,
            }
        )
    known = [rail for rail in ranked if rail["reward"] is not None]
    if known:
        winner = max(known, key=lambda rail: rail["reward"])
        winner["recommended"] = True
    return ranked


def run_turn(text, now=None, session=None, verify=None):
    session = session or SESSION
    verify = verify or verify_products
    now = now_hk(now)
    if session.cooling_until and now < session.cooling_until:
        return stop_turn(
            "refuse",
            "COOLING",
            "A blocked payment is still in its cooling period.",
            "The shield will not take another payment yet.",
            "No rail is compared.",
            "Nothing is charged.",
            "Cooling period is still open. End it before trying again.",
            "red",
        )

    parsed = parse_purchase(text)
    if parsed["intent"] == "revoke":
        revoke(session)
        return stop_turn(
            "revoke",
            "REVOKE",
            "You asked to revoke consent.",
            "Consent is revoked, so the agent stops.",
            "No rail is compared.",
            "Nothing is charged.",
            "You revoked consent. Settlement stays closed.",
        )

    if parsed["category"] is None or parsed["amount"] is None:
        return stop_turn(
            "ask",
            "ASK",
            "A spending decision needs a category and an amount.",
            "No mandate check yet.",
            "No payment rail is compared until the basket is known.",
            "Nothing is charged.",
            "Choose groceries (200 USD per rolling week) or entertainment (50 USD per purchase), and give the amount in USD. Add shipping and tax if you know them.",
        )

    known_fees = []
    unknown = []
    if parsed["shipping"] is None:
        unknown.append("shipping")
    else:
        known_fees.append(parsed["shipping"])
    if parsed["tax"] is None:
        unknown.append("tax")
    else:
        known_fees.append(parsed["tax"])
    total = round(parsed["amount"] + sum(known_fees), 2)
    fee_text = (
        "Shipping and tax were not stated, so they stay unknown and are not added."
        if len(unknown) == 2
        else (
            f"{' and '.join(unknown)} was not stated, so it stays unknown and is not added."
            if unknown
            else f"Shipping and tax are included. The total is {money(total)} USD."
        )
    )
    reason = f"{parsed['category'].capitalize()} for {money(parsed['amount'])} USD. {fee_text}"

    problem = consent_problem(now, session)
    if problem:
        rule = "REVOKE" if session.revoked else "EXPIRY"
        return stop_turn("refuse", rule, reason, problem, "No card is chosen.", "Settlement did not run.", problem)

    if parsed["category"] not in RULES:
        return stop_turn(
            "refuse",
            "CATEGORY",
            reason,
            f"{parsed['category'].capitalize()} is outside the mandate.",
            "No card is chosen.",
            "Settlement did not run.",
            "This mandate only covers groceries and entertainment.",
        )

    rule = RULES[parsed["category"]]
    if parsed["category"] == "groceries":
        spent = grocery_spent(session, now)
        room = round(rule["cap"] - spent, 2)
        if total > room:
            act = f"{money(total)} USD would pass the {money(rule['cap'])} USD weekly grocery cap. {money(spent)} USD is already settled in this window."
            return stop_turn("refuse", rule["id"], reason, act, "No card is chosen.", "Settlement did not run.", act, "red")
        act = f"GROC_WEEK allows it. This {money(total)} USD sits inside the {money(rule['cap'])} USD rolling week ({money(spent)} USD already settled)."
    else:
        if total > rule["cap"]:
            act = f"{money(total)} USD is over the {money(rule['cap'])} USD entertainment cap."
            return stop_turn("refuse", rule["id"], reason, act, "No card is chosen.", "Settlement did not run.", act, "red")
        act = f"ENT_TX allows it. {money(total)} USD is within the {money(rule['cap'])} USD per-transaction cap."

    room = round(rule["cap"] - grocery_spent(session, now), 2) if parsed["category"] == "groceries" else rule["cap"]
    product_room = round(room - sum(known_fees), 2)
    shortlist = filter_products(parsed["category"], parsed["amount"], product_room)
    verified = verify(shortlist)
    rejected = [item for item in verified if item["rating"] == 1]
    kept = [item for item in verified if item["rating"] != 1]
    if not shortlist:
        return stop_turn(
            "refuse",
            "CATALOG",
            reason,
            "No listing fits this amount inside the mandate.",
            "No rail is compared.",
            "Nothing is charged.",
            "Nothing in the mandate fits this amount.",
            "red",
        )
    basket = [item for item in kept if item["rating"] in (2, 3, None)]
    if not basket:
        seal(session, "shield", {"level": "red", "reason": "every listing was rejected"})
        session.cooling_until = now + timedelta(minutes=10)
        return {
            "decision": "refuse",
            "rule": "INTENT",
            "canSettle": False,
            "draftId": None,
            "disposition": "red",
            "cooling": True,
            "note": "Every listing was rejected. The payment is blocked.",
            "hash": session.chain[-1]["hash"],
            "steps": shield_steps(reason, act, verified, "Every listing rated 1, so the intent gate blocks payment.", "No merchant is paid.", "Nothing is charged.", "stop"),
        }

    goods = round(sum(item["price"] for item in basket), 2)
    total = round(goods + sum(known_fees), 2)
    payee = parse_payee(text, parsed["category"])
    qty = parse_qty(text, parsed["category"])
    model_down = any(item["rating"] is None for item in basket)
    verdict = judge(
        parsed["category"],
        total,
        qty,
        payee,
        [item["rating"] for item in basket],
        model_down,
        room,
    )
    if rejected and verdict["level"] == "green":
        verdict["level"] = "yellow"
        verdict["intent"] = "Rejected listings were removed. Confirm the remaining basket."
    entry = seal(session, "shield", {"level": verdict["level"], "score": verdict["score"], "payee": payee, "total": total})
    rails = []
    spread = "No rail is compared."
    if verdict["level"] == "red":
        session.cooling_until = now + timedelta(minutes=10)
        execute = "Blocked. A 10-minute cooling period has started. Nothing is charged."
        status = "stop"
        can_settle = False
        draft_id = None
        decision = "refuse"
    else:
        rails = rank_rails(parsed["category"], total)
        winner = next(rail for rail in rails if rail["recommended"])
        other = next(rail for rail in rails if not rail["recommended"])
        spread = (
            f"{winner['name']} returns {money(winner['reward'])} USD ({winner['rateLabel']}, {winner['source']}). "
            f"{other['name']} is not chosen because its {other['rateLabel']}."
            if winner["reward"] is not None
            else "Neither rail has a known reward on the fixture, so none is recommended."
        )
        if verdict["level"] == "green":
            record_settlement(session, parsed["category"], total, winner["id"], now)
            receipt = seal(session, "receipt", {"total": total, "rail": winner["id"], "payee": payee})
            execute = f"Cleared. Settled {money(total)} USD on {winner['name']} at {payee}. Record {receipt['hash'][:12]}."
            status = "pass"
            can_settle = False
            draft_id = None
            decision = "allow"
            entry = receipt
        else:
            draft_id = uuid.uuid4().hex
            session.drafts[draft_id] = {
                "id": draft_id,
                "category": parsed["category"],
                "total": total,
                "rail": winner["id"],
                "rule": rule["id"],
                "reward": winner["reward"],
                "payee": payee,
                "disposition": "yellow",
            }
            execute = "Yellow: confirm this payment yourself. Nothing is charged until you do."
            status = "hold"
            can_settle = True
            decision = "allow"
    note = f"{verdict['level'].capitalize()}. {verdict['rule']} {verdict['intent']} {spread}"
    return {
        "decision": decision,
        "rule": rule["id"] if verdict["level"] != "red" else "SHIELD",
        "canSettle": can_settle,
        "draftId": draft_id,
        "disposition": verdict["level"],
        "cooling": verdict["level"] == "red",
        "note": note,
        "hash": entry["hash"],
        "steps": [
            {"phase": "reason", "title": "Reason", "text": reason, "status": "pass"},
            {"phase": "act", "title": "Rule", "text": verdict["rule"], "status": "stop" if verdict["veto"] else "pass"},
            {"phase": "verify", "title": "Intent", "text": verdict["intent"], "products": verified, "status": status},
            {"phase": "intel", "title": "Intel", "text": verdict["intel"], "status": "stop" if verdict["level"] == "red" else "pass"},
            {"phase": "negotiate", "title": "Channel", "text": spread, "rails": rails, "status": status},
            {"phase": "execute", "title": verdict["level"].capitalize(), "text": execute, "status": status},
        ],
    }


def shield_steps(reason, act, verified, intent, intel, execute, status):
    return [
        {"phase": "reason", "title": "Reason", "text": reason, "status": "pass"},
        {"phase": "act", "title": "Rule", "text": act, "status": "stop"},
        {"phase": "verify", "title": "Intent", "text": intent, "products": verified, "status": status},
        {"phase": "intel", "title": "Intel", "text": intel, "status": status},
        {"phase": "negotiate", "title": "Channel", "text": "No rail is compared.", "rails": [], "status": status},
        {"phase": "execute", "title": "Red", "text": execute, "status": status},
    ]


def record_settlement(session, category, total, rail, now):
    session.settlements.append(
        {"category": category, "total": total, "rail": rail, "at": now}
    )


def end_cooling(session=None):
    session = session or SESSION
    session.cooling_until = None
    entry = seal(session, "cooling_ended", {"by": "customer"})
    return {"cooling": False, "text": f"Cooling period ended. Record {entry['hash'][:12]}."}


def stop_turn(decision, rule, reason, act, negotiate, execute, note, disposition=None):
    status = "hold" if decision == "ask" else "stop"
    return {
        "decision": decision,
        "rule": rule,
        "canSettle": False,
        "draftId": None,
        "note": note,
        "disposition": disposition,
        "steps": [
            {"phase": "reason", "title": "Reason", "text": reason, "status": status if decision == "ask" else "pass"},
            {"phase": "act", "title": "Act", "text": act, "status": status},
            {"phase": "negotiate", "title": "Negotiate", "text": negotiate, "rails": [], "status": status},
            {"phase": "execute", "title": "Execute", "text": execute, "status": status},
        ],
    }


def settle(draft_id, now=None, session=None):
    session = session or SESSION
    now = now_hk(now)
    draft = session.drafts.get(draft_id)
    if not draft:
        raise ValueError("That authorization does not match an open purchase.")
    if session.cooling_until and now < session.cooling_until:
        raise ValueError("A cooling period is open.")
    if draft.get("disposition") != "yellow":
        raise ValueError("This payment is not waiting for confirmation.")
    problem = consent_problem(now, session)
    if problem:
        raise ValueError(problem)
    if draft["category"] == "groceries":
        spent = grocery_spent(session, now)
        if spent + draft["total"] > RULES["groceries"]["cap"]:
            raise ValueError("This would pass the weekly grocery cap.")
    elif draft["category"] == "entertainment":
        if draft["total"] > RULES["entertainment"]["cap"]:
            raise ValueError("This is over the entertainment cap.")
    else:
        raise ValueError("This category is outside the mandate.")
    record_settlement(session, draft["category"], draft["total"], draft["rail"], now)
    del session.drafts[draft_id]
    rail_name = next(rail["name"] for rail in RAILS if rail["id"] == draft["rail"])
    receipt = seal(session, "receipt", {"total": draft["total"], "rail": draft["rail"], "payee": draft.get("payee")})
    reward = (
        f" Reward {money(draft['reward'])} USD is the 2026-10-02 fixture, not a live quote."
        if draft["reward"] is not None
        else " No reward was recorded because the rate is unknown."
    )
    return {
        "settled": True,
        "rail": rail_name,
        "rule": draft["rule"],
        "hash": receipt["hash"],
        "text": f"Confirmed. Settled {money(draft['total'])} USD on {rail_name}. Record {receipt['hash'][:12]}.{reward}",
    }


def verification_text(verified):
    if not verified:
        return "No listing fits this amount, so there is nothing to verify."
    parts = []
    for item in verified:
        if item["rating"] == 3:
            parts.append(f"{item['name']} rated 3 and stays.")
        elif item["rating"] == 1:
            parts.append(f"{item['name']} rated 1 and is rejected.")
        elif item["rating"] == 2:
            parts.append(f"{item['name']} rated 2 and goes back for reconsideration.")
        else:
            parts.append(f"{item['name']} was not rated, so it goes back for reconsideration.")
    return " ".join(parts)


def money(value):
    return f"{value:.2f}"
