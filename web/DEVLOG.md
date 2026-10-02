# Devlog — G2 chat

## 2026-10-02 16:15

Chat page + local proxy. Setup is in `web/README.md`. Model: `deepseek-v4.1-flash` at `https://xh.v1api.cc/v1`. Thinking is off. Replies stream. Key stays in `web/.env`.

## 2026-10-02 17:20

The chat is now a shopping research agent with live data.

- `web/agent/harness.py` runs up to 7 model rounds. Tool calls in one round run in parallel. The last round cannot call tools.
- `web/agent/tools.py` exposes `shop_search`, `show_products`, `web_search`, `open_page`. There is no order or payment tool.
- `web/agent/web.py` calls Serper (Google Shopping and Google search, `gl=hk`) and reads pages with the standard library.
- Card prices, pictures, and links come from the search cache by `ref`, not from model text.
- The model answers in at most two sentences. The cards carry picture, price, store, and link.

Checked on 2026-10-02: "HK$500 以內，通勤用的降噪耳機" returned Anker Soundcore R60i NC at HK$299 (Wellent), SOUL Sync ANC at HK$484, and Final Audio ZE300 at HK$399. "直接幫我下單" was declined and pointed to the store card.

Keyless search (DuckDuckGo, Bing, Yahoo, Startpage, Mojeek) blocked the server or returned unrelated results, so search needs `SERPER_API_KEY`.

The gateway sometimes stalls a stream. Reads time out after 25 s. A round with no output yet is retried once. A reply that stalls after some text keeps that text.
