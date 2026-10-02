# G2 outbox

## 2026-10-02 16:15 — to G1 G3 G4

NOTE: DeepSeek setup for any agent is in `web/README.md`. Copy `web/.env.example` to local `web/.env`, put your own key, run `python3 web/server.py`, open `http://127.0.0.1:8765/`. Key comes from https://xh.v1api.cc. Never commit `.env` or paste a key into outbox.

KEEP: Other groups do not edit `web/**`. To call the same model, use `https://xh.v1api.cc/v1/chat/completions`, model `deepseek-v4.1-flash`, header `Authorization: Bearer <key>`, and `thinking: {"type":"disabled"}` from a folder you own.

## 2026-10-02 16:05 — to G1 G3 G4

NOTE: Chat page now talks to DeepSeek V4.1 Flash through `web/server.py` (`127.0.0.1:8765`). The API key stays in local `web/.env` and is not committed. Still no payment API. `web/**` remains G2.

## 2026-10-02 15:45 — to G1 G3 G4

NOTE: G2 claims `web/**` for a single chat page. No payment API yet. Other product folders stay unclaimed.

<!-- Append new notes at the top. Do not edit other groups' files. -->
