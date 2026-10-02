"""The model only phrases a decision the loop already made."""

EXPLAIN_PROMPT = """Write one English sentence for the shopper. The shield already decided. Do not change the level, the amounts, the rail, or any rate. Do not use another language. Do not add a list or a heading. If a reward is missing, say it is unknown. Never invent a fee or a cashback rate."""


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
