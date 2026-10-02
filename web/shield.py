"""Shield in front of payment.

Three gates, then one disposition. The shield cannot pay.
Rule mismatches are a veto. The intent model is data, not an instruction.
"""

import hashlib
import json
import re

EXPIRES_TEXT = "2026-10-07T23:59:59+08:00"

MANDATE = {
    "mandate_id": "MD-20261002-0001",
    "principal": "customer",
    "agent_did": "did:example:hacku-shopping-agent",
    "valid_until": EXPIRES_TEXT,
    "human_present": False,
    "on_exceed": "ask the customer",
    "scenes": {
        "groceries": {
            "merchants": ["Official grocer"],
            "max_total_usd": 200,
            "window": "rolling_7d",
            "max_qty": None,
        },
        "entertainment": {
            "merchants": ["Official ticket platform"],
            "max_total_usd": 50,
            "window": "per_transaction",
            "max_qty": 2,
        },
    },
}

# Scenario fixture only. This is not a live fraud feed.
WATCHLIST = {
    "private account": "demo watchlist entry supplied 2026-10-02, not a live fraud feed",
    "personal account": "demo watchlist entry supplied 2026-10-02, not a live fraud feed",
}

WEIGHTS = {"overreach": 0.4, "intent": 0.3, "payee": 0.2, "behavior": 0.1}


def parse_qty(text, scene):
    lowered = text.lower()
    words = {"one": 1, "two": 2, "three": 3, "four": 4}
    match = re.search(r"\b(\d+)\s+(tickets|items|seats)\b", lowered)
    if match:
        return int(match.group(1))
    match = re.search(r"\b(one|two|three|four)\s+(tickets|items|seats)\b", lowered)
    if match:
        return words[match.group(1)]
    if scene == "entertainment":
        return 1
    return None


def parse_payee(text, scene):
    lowered = text.lower()
    for name in WATCHLIST:
        if name in lowered:
            return name
    scene_rule = MANDATE["scenes"].get(scene)
    if not scene_rule:
        return "unnamed merchant"
    return scene_rule["merchants"][0]


def judge(scene, total, qty, payee, ratings, model_down, cap_room):
    """Return the three gate results and a green, yellow, or red disposition."""
    rule_fails = []
    scene_rule = MANDATE["scenes"].get(scene)
    if scene_rule is None:
        rule_fails.append("This scene is not written in the mandate.")
    else:
        if payee not in scene_rule["merchants"]:
            rule_fails.append(f"{payee} is outside the merchant list.")
        if scene_rule["max_qty"] is not None and qty is not None and qty > scene_rule["max_qty"]:
            rule_fails.append(f"Quantity {qty} is over the mandate maximum of {scene_rule['max_qty']}.")
        if total > cap_room or total > scene_rule["max_total_usd"]:
            rule_fails.append("The amount is over the mandate cap.")
    payee_risk = 1.0 if payee.lower() in WATCHLIST else 0.0
    known = [item for item in ratings if item is not None]
    if any(item == 1 for item in known):
        intent = 1.0
    elif any(item == 2 for item in known):
        intent = 0.5
    elif model_down or any(item is None for item in ratings):
        intent = None
    elif ratings:
        intent = 0.0
    else:
        intent = None
    allowlisted = scene_rule is not None and payee in scene_rule["merchants"]
    behavior = 0.0 if allowlisted else 0.6
    overreach = 1.0 if rule_fails else 0.0

    veto = bool(rule_fails) or payee_risk == 1.0 or intent == 1.0
    if veto:
        level = "red"
        score = 1.0
    elif intent is None or intent >= 0.5 or behavior >= 0.5:
        level = "yellow"
        score = round(0.4 * overreach + 0.3 * (intent or 0.5) + 0.2 * payee_risk + 0.1 * behavior, 2)
    else:
        score = round(
            WEIGHTS["overreach"] * overreach
            + WEIGHTS["intent"] * intent
            + WEIGHTS["payee"] * payee_risk
            + WEIGHTS["behavior"] * behavior,
            2,
        )
        if score >= 0.7:
            level = "red"
        elif score >= 0.3:
            level = "yellow"
        else:
            level = "green"

    rule_text = "Rule gate passed." if not rule_fails else " ".join(rule_fails)
    if intent is None:
        intent_text = "Intent model is not connected, so this cannot pass automatically."
    elif intent == 1.0:
        intent_text = "Intent gate rejected at least one listing."
    elif intent == 0.5:
        intent_text = "Intent gate is unsure, so a person has to confirm."
    else:
        intent_text = "Intent gate accepted the listings."
    if payee_risk == 1.0:
        intel_text = f"Intel gate: {payee} is on the demo watchlist. {WATCHLIST[payee.lower()]}."
    else:
        intel_text = f"Intel gate: {payee} is not on the demo watchlist."

    return {
        "level": level,
        "score": score,
        "veto": veto,
        "rule": rule_text,
        "intent": intent_text,
        "intel": intel_text,
        "payee": payee,
        "weights": WEIGHTS,
    }


def seal(session, step, payload):
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    payload_hash = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    previous = session.chain[-1]["hash"] if session.chain else "0" * 64
    link = hashlib.sha256(f"{previous}:{payload_hash}".encode("utf-8")).hexdigest()
    entry = {"step": step, "hash": link, "payloadHash": payload_hash}
    session.chain.append(entry)
    return entry
