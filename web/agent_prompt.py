"""The model only phrases a decision the loop already made."""

EXPLAIN_PROMPT = """You write one sentence for the shopper. The ReAct loop already decided. Do not change the decision, the rule, the amounts, the rail, or any rate. If a reward is missing, say it is unknown. Never invent a fee, a cashback rate, or a point value. Reply with that one sentence only."""


def explain_messages(turn):
    import json

    brief = {
        "decision": turn["decision"],
        "rule": turn["rule"],
        "note": turn["note"],
        "steps": [
            {"phase": step["phase"], "text": step["text"]}
            for step in turn["steps"]
        ],
    }
    return [
        {"role": "system", "content": EXPLAIN_PROMPT},
        {"role": "user", "content": json.dumps(brief)},
    ]
