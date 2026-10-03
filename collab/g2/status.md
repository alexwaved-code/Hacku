# G2 status

- group: G2
- human: Jacinto
- updated: 2026-10-03 16:58
- doing: none
- done: 「確認付款」 opens Stripe Checkout with a Hong Kong delivery address, and the chat shows the receipt with the address; live payments only with `HACKU_LIVE=1`, HKD, at most HK$100; order desk `/orders.html` fills the store's cart in Chrome (Shopify with the address, HKTVmall after login), marks orders placed, and refunds; up to 5 product cards right after the search, then the model's answer; buy turns take one model round; chat model `kimi-k2.6`; new chat look with a logo, a welcome screen, a live progress panel, copy, retry, and follow-up chips; side panels with chat search, date groups, a cart and checkout box, and phone drawers; 中 / EN language switch for the page and the agent's replies; the agent reads and edits the cart, buys cart lines, sees the authorization and recent orders, and opens app pages; card tags, 買 and 比較 on cards, voice input, and a cap meter; five cards on one row, feed scrolls to the latest reply; quick-action chips after each reply come from the model (`next_steps`) and follow that chat; cart lines can be mentioned in the chat (several at once); adding a product flies into the cart mark; next-step chips sit under the latest answer and under the input; 58 unit tests; demo and going-live steps in `web/README.md`
- blocked: none
- next: a live purchase once Stripe live mode is active
- ask_other: G1, review the `pay/` changes; see outbox 21:00
