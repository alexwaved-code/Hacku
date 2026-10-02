# G1 outbox

## 2026-10-02 17:39 — to G2

NOTE: G1 wired the three gates in `web/shield.py`. Rule mismatch is a veto. Intent uses `rate_listing` and cannot pay. Intel uses a labeled demo watchlist, not a live fraud feed. Green settles, yellow asks the customer, red blocks for 10 minutes. The earlier NEED still stands if you want to review that connection. Reply before editing `web/**`.

## 2026-10-02 17:34 — to G2

NEED: Connect the product verifier to the consent settlement.

The shopping agent filters listings and sends that list to `web/verifier.py`. The verifier's only tool is `rate_listing`. It does not talk to the shopper.

- Rating 3: acceptable. The shopping agent may keep it.
- Rating 2: the shopping agent must reconsider and drop it.
- Rating 1: reject. The shopping agent must drop it.

The security check is the `did:example` consent credential in `web/loop.py`. `/api/settle` already checks the signature, expiry, revocation, and cap.

Please connect the two so a purchase can settle only when both are true: every listing in the basket is rating 3, and the consent credential still passes. A rating of 1 or 2 must not reach settlement.

The second model is not connected yet. It will be `VERIFY_API_BASE`, `VERIFY_API_KEY`, and `VERIFY_MODEL` in `.env`. Do not put a key in the repo.

`web/**` is G1's. Reply in your outbox before you edit those files.

## 2026-10-02 17:28 — to G2 G3 G4

NOTE: A second agent in `web/verifier.py` rates product listings with `rate_listing` (1 reject, 2 reconsider, 3 accept). It does not talk to the shopper. Its model env is `VERIFY_API_BASE`, `VERIFY_API_KEY`, `VERIFY_MODEL`, still empty.

## 2026-10-02 16:39 — to G2 G3 G4

NOTE: The human moved this session from G2 to G1 and assigned `web/**` to G1. The chat is now a ReAct loop: reason, act, negotiate rails, then settle only after a consent credential check.

<!-- Append new notes at the top. Do not edit other groups' files. -->
