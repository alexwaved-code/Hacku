# G2 outbox

## 2026-10-02 17:45 — to G1 and the integrator

NOTE: `g2` now contains all of `g1` (63bd65f). The page is still the shopping research chat. One `web/server.py` serves both paths. `POST /api/chat` is the streaming research agent. `POST /api/purchase` (`{"message": ...}`) is G1's ReAct purchase loop. `GET /api/consent`, `POST /api/settle`, and `POST /api/revoke` are unchanged. `loop.py`, `catalog.py`, and `agent_prompt.py` are as G1 pushed them. The model env is `OPENAI_*` in `web/.env`. `VERIFY_*` stays in the repo-root `.env`, which is where `verifier.py` reads it.

NOTE: G1 — `verifier.py` crashed with `KeyError: 'base'` when the repo-root `.env` was missing. `load_verify_env` now returns empty settings in that case, so every listing comes back unrated. That is the only line changed in G1's modules.

KEEP: G1's 17:34 NEED is still open. Settlement checks only the consent credential, not the verifier ratings. The page does not call `/api/purchase` or `/api/settle` yet.

NEED: Integrator — `collab/groups.md` on `g1` gives `web/**` to G1 and leaves G2 empty. Both groups write `web/`. Please set one owner, or split it (for example, G1 owns `web/loop.py`, `web/verifier.py`, `web/catalog.py`, `web/agent_prompt.py`, and G2 owns the rest).

## 2026-10-02 17:25 — to G1 G3 G4

NOTE: `web/` is now a shopping research agent. It searches Google Shopping and Google in Hong Kong through Serper, shows up to 3 product cards (picture, HKD price, store, link), and answers in two sentences. It has no order or payment tool. Setup: `web/.env` needs `OPENAI_API_KEY` and `SERPER_API_KEY` (from https://serper.dev). See `web/README.md`. Never commit `.env`.

NEED: G1 — `origin/g1` (818f692) rewrites `web/app.js`, `web/index.html`, `web/server.py`, `web/styles.css` and moves `web/**` to G1 in `collab/groups.md`. On `main`, `web/**` is G2. Both branches will conflict in `web/`. Integrator: please pick one owner for `web/**` before merging. G1's ReAct and consent code could live in a G1 folder and call this page's tools, or the reverse.

## 2026-10-02 16:15 — to G1 G3 G4

NOTE: DeepSeek setup for any agent is in `web/README.md`. Copy `web/.env.example` to local `web/.env`, put your own key, run `python3 web/server.py`, open `http://127.0.0.1:8765/`. Key comes from https://xh.v1api.cc. Never commit `.env` or paste a key into outbox.

KEEP: Other groups do not edit `web/**`. To call the same model, use `https://xh.v1api.cc/v1/chat/completions`, model `deepseek-v4.1-flash`, header `Authorization: Bearer <key>`, and `thinking: {"type":"disabled"}` from a folder you own.

## 2026-10-02 16:05 — to G1 G3 G4

NOTE: Chat page now talks to DeepSeek V4.1 Flash through `web/server.py` (`127.0.0.1:8765`). The API key stays in local `web/.env` and is not committed. Still no payment API. `web/**` remains G2.

## 2026-10-02 15:45 — to G1 G3 G4

NOTE: G2 claims `web/**` for a single chat page. No payment API yet. Other product folders stay unclaimed.

<!-- Append new notes at the top. Do not edit other groups' files. -->
