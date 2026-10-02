# Shopping assistant

A chat page that researches real products sold in Hong Kong. The browser talks only to `web/server.py`. That process runs a tool loop with DeepSeek V4.1 Flash and live Google Shopping and Google search through Serper. Keys stay in local `web/.env`.

The assistant only researches. It cannot order, pay, or contact a store. The user buys from the store link on each card.

## Setup (every machine / every agent)

1. Work on branch `g2`, or on `main` after the integrator merges `g2`.
2. Copy the example env file:

```bash
cp web/.env.example web/.env
```

3. Fill in `web/.env`:
   - `OPENAI_API_KEY`: model key from https://xh.v1api.cc
   - `SERPER_API_KEY`: search key from https://serper.dev
   Do not commit `web/.env`. Do not write a key in `outbox.md`, `status.md`, or chat logs that land in git.
4. Start the page:

```bash
python3 web/server.py
```

5. Open http://127.0.0.1:8765/

Without `OPENAI_API_KEY`, `/api/chat` returns an error. Without `SERPER_API_KEY`, the search tools fail and the assistant says so.

## Env

| Name | Value |
|---|---|
| `OPENAI_BASE_URL` | `https://xh.v1api.cc/v1` |
| `OPENAI_API_KEY` | model key |
| `OPENAI_MODEL` | `deepseek-v4.1-flash` |
| `SERPER_API_KEY` | search key |

Model requests use `Authorization: Bearer <key>`, `stream: true`, `max_tokens: 400`, and `thinking: {"type": "disabled"}`.

## Tools

| Tool | What it does |
|---|---|
| `shop_search` | Google Shopping, Hong Kong (`gl=hk`). Real offers: name, store, HKD price, rating, picture. Each offer gets a `ref`. |
| `show_products` | Shows up to 3 refs as cards. Card data comes from the cached search result, so the model cannot change a price or link. |
| `web_search` | Google search, Hong Kong. Titles, links, snippets. |
| `open_page` | Reads one https page now: JSON-LD product, price, picture, page text. Private and local addresses are refused. A store product page returns a `ref`. |

Page text is treated as data. Text that tries to instruct an AI agent is flagged to the model and on the card.

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
  "thinking": { "type": "disabled" }
}
```

Do not point at `127.0.0.1:8765` from another group's service. That server is only for this page.

## Page route

`POST /api/chat` with `{ "messages": [...] }`. The page sends the whole thread back each turn, including the tool messages it received.

The response is SSE (`text/event-stream`), one JSON object per `data:` line:

| `type` | Fields | Meaning |
|---|---|---|
| `delta` | `text` | Reply text. The page types it out. |
| `retract` | | Drop the text of this round. It was said before a tool call. |
| `tool_start` | `id`, `name`, `label` | A tool started. The page shows the label. |
| `tool_result` | `id`, `name`, `ok`, `summary`, `ui` | A tool finished. `ui.kind == "products"` carries the cards. |
| `done` | `messages` | New assistant and tool messages to add to the thread. |
| `error` | `message` | Shown with a retry button. |
