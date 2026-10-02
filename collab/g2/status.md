# G2 status

- group: G2
- human: Jacinto
- updated: 2026-10-02 21:32
- doing: none
- done: 「確認付款」 opens Stripe Checkout with a Hong Kong delivery address, and the chat shows the receipt with the address; live payments only with `HACKU_LIVE=1`, HKD, at most HK$100; order desk `/orders.html` fills the store's cart in Chrome (Shopify with the address, HKTVmall after login), marks orders placed, and refunds; search turns take two model rounds and buy turns one; 42 unit tests; demo and going-live steps in `web/README.md`
- blocked: none
- next: a live purchase once Stripe live mode is active
- ask_other: G1, review the `pay/` changes; see outbox 21:00
