# MUSD Trove Radar and TroveGuard: deck outline (10 slides)

Every number comes from Mezo Testnet at block 16458901 (2026-10-30). Run `node src/cli.mjs snapshot` again just before exporting the deck.

## 1. Title
**MUSD Trove Radar + TroveGuard**: see liquidations, Recovery Mode and redemptions coming, and let a keeper protect your trove before they hit your BTC.
Subtitle: an open-source radar, alert bot, keeper daemon and on-chain trove guard for MUSD on Mezo · by northbit
Visual: dashboard screenshot (`docs/dashboard.png`)

## 2. Problem
- MUSD borrowers can lose BTC in three ways: liquidation below 110 % ICR, Recovery Mode below 150 % TCR, and redemptions that take the lowest-ratio troves first.
- Mezo's UI shows your own trove. It does not show where you stand against the other 353 troves, or how close the system is to Recovery Mode.
- Even a borrower who gets the warning has to be awake to act on it. Keepers and Stability Pool depositors also lack a simple view of what is liquidatable and whether it pays.

## 3. Solution
One tool reading the MUSD contracts directly, pinned to a single block:
- **Radar and history**: every trove's ICR, liquidation price, stress test, Stability Pool coverage, plus trends over time and liquidation and redemption events.
- **Redemption queue**: your position, the MUSD ahead of you, and what a redemption of X MUSD would hit.
- **Alerts**: Slack, Discord, Telegram or a signed webhook, on threshold changes and when your trove is redeemed or liquidated.
- **TroveGuard**: pre-signed top-ups or debt repayments that any keeper can execute below your trigger.
- **Keeper daemon**: liquidations and TroveGuard `protect`, simulated first and sent only when profitable.

## 4. Live on Mezo Testnet
- 354 troves · TCR 282 % · Recovery Mode at BTC $41.8k (−47 %)
- 3 liquidatable troves, each verified with `eth_call`; the Stability Pool covers them 13,788×
- 136 troves between 110 and 150 %; at −20 % BTC, 91 are liquidatable
- 429 M MUSD redeemable; 25k MUSD would close 12 troves
- Keeper liquidations: [`0x6d0f1c…`](https://explorer.test.mezo.org/tx/0x6d0f1cdb2407fdc572443802dcf48c0451b713d31afb5c40aa4123a5a2a2d68e) (manual) and [`0xb4b1ed…`](https://explorer.test.mezo.org/tx/0xb4b1ed7b85dc19eda5f56ff42465364111afda64361c834d637b2b1d8cb7a280) (daemon)

## 5. TroveGuard v2: top up or repay, automatically
- The borrower parks BTC and/or MUSD in the guard, sets a trigger ICR and stores a ladder of EIP-712 permits, one per MUSD signature nonce. Each rung is `AddColl` (BTC in) or `RepayMUSD` (debt down).
- Below the trigger, anyone calls `protect()`. One rung is spent, funds can only enter the borrower's own trove, and the caller gets a small BTC tip. `cancel` refunds everything and invalidates every permit.
- Live oracle, no mocks: RepayMUSD 118.45 % → 123.95 % ([tx](https://explorer.test.mezo.org/tx/0x950ca982156cc6b3dd1f6e2e69552e00aa19bba9b70765545b3764947d335aa9)), then AddColl 123.88 % → 131.16 % ([tx](https://explorer.test.mezo.org/tx/0xc3b2dcde9ad22ebd2d24c4aabf87d45b5e72759cc4a615565f53c65cdde6e554))
- Contract [`0xa67c9bbc…9df7`](https://explorer.test.mezo.org/address/0xa67c9bbcd4350b24e33e25e2ebd7c80c04409df7), verified · 14 fork tests, 3 fuzz tests, 3 invariants · Slither reviewed · SECURITY.md

## 6. The web flow
- `guard.html` works with any EIP-1193 wallet: switch to Mezo Testnet, view your trove and guard, arm it, fund the reserves, sign the ladder (one signature per rung, one `storePermits` tx), withdraw or cancel.
- Every transaction is simulated before the wallet prompt. The page holds no keys and loads nothing from other origins.
- Proof: a permit signed in the page was executed by `protect`, 131.23 % → 137.62 % ([tx](https://explorer.test.mezo.org/tx/0x084a2b4b964c04c722a4d10d32a04d9b8c838d0d9bd4253f7e7edbd47b052212))
- Visual: `docs/guard.png`

## 7. History and the Stability Pool
- `history.json` keeps one row per build, so the dashboard charts TCR, liquidatable troves and redemptions per day as inline SVG.
- Stability Pool cards: size, coverage, and the BTC gained per liquidation, measured from events. A live lookup shows any depositor's deposit and pending BTC.
- The trove lookup shows whether a trove is guarded and how much reserve it has left.

## 8. Running a keeper
- `keeper --loop --min-profit 5 --send`: liquidations plus TroveGuard `protect`, an `eth_call` before every send, exponential backoff, and JSON logs.
- Profit check: 200 MUSD + 0.5 % of collateral (or the guard tip) against estimated gas, with the reason logged for every skipped target.
- Docker image (non-root, no dev dependencies), the key in a chmod 600 file or an env var, and the chain is refused unless it is 31611. Guide: `docs/run-a-keeper.md`.
- Proof: the daemon liquidated a trove worth ≈220.8 MUSD, skipped three worth ≈211 MUSD under `--min-profit 215`, and recovered from an RPC error by itself.

## 9. Business case and who it is for
- **Borrowers**: early warning, the redemption queue, and a guard that acts while they sleep.
- **Keepers**: an open-source, profit-aware daemon. Liquidations and guard tips are its revenue.
- **Stability Pool depositors**: coverage and expected BTC gains.
- **Mezo**: more keepers and safer troves mean less bad debt and more trust in MUSD as BTC-backed money.
- Revenue paths: a hosted alert service (free tier plus paid per-trove alerts and Telegram subscriptions), an optional protocol fee on guard tips, and a keeper network sharing a hosted RPC and mempool feed.

## 10. Roadmap and ask
- Done in Wave 2: event history, event alerts, TroveGuard v2 (repay mode) live, fuzz/invariants and Slither, the browser guard page, dashboard history and the Stability Pool view, the keeper daemon and Docker image.
- Next: a hosted alert service with per-user subscriptions; a keeper network (several operators, no duplicate sends); a mempool alert for incoming redemptions; an external audit of TroveGuard; mainnet once MUSD addresses and keeper economics are confirmed.
- Ask: feedback from the Mezo team on the guard design, and a path to mainnet addresses.
- Links: repo · live dashboard · 2-minute video
- Built by northbit with an AI coding assistant (see the README disclosure)
