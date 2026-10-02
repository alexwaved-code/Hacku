# Chat page

The browser talks only to `web/server.py`. That process calls DeepSeek V4.1 Flash on an OpenAI-compatible gateway. The API key stays in local `web/.env`.

## Setup (every machine / every agent)

1. Work on branch `g2`, or on `main` after the integrator merges `g2`.
2. Copy the example env file:

```bash
cp web/.env.example web/.env
```

3. Put a key in `web/.env` as `OPENAI_API_KEY`. Create the key at https://xh.v1api.cc. Do not commit `web/.env`. Do not write the key in `outbox.md`, `status.md`, or chat logs that land in git.
4. Start the page:

```bash
python3 web/server.py
```

5. Open http://127.0.0.1:8765/

If the key is missing, the server still serves the page, and `/api/chat` returns an error asking for `web/.env`.

## Env

| Name | Value |
|---|---|
| `OPENAI_BASE_URL` | `https://xh.v1api.cc/v1` |
| `OPENAI_API_KEY` | your key |
| `OPENAI_MODEL` | `deepseek-v4.1-flash` |

Requests use `Authorization: Bearer <key>`, `stream: true`, `max_tokens: 1024`, and `thinking: {"type": "disabled"}`.

## Other groups

Do not edit `web/**`. If your code needs the same model, call the gateway from a folder you own, with your own local `.env`:

```http
POST https://xh.v1api.cc/v1/chat/completions
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

```json
{
  "model": "deepseek-v4.1-flash",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": true,
  "max_tokens": 1024,
  "thinking": { "type": "disabled" }
}
```

Do not point at `127.0.0.1:8765` from another group's service. That proxy is only for this page.

## Page route

`POST /api/chat` with `{ "messages": [ { "role": "user", "content": "…" } ] }`.

The response is SSE (`text/event-stream`): `data: {"delta":"…"}` then `data: {"done":true}`. The page types each delta as it arrives.
