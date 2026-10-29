# MUSD Trove Radar: deck outline (7 slides)

Every number comes from Mezo Testnet at block 16452079 (2026-10-29). Run `node src/cli.mjs snapshot` again just before exporting the deck.

## 1. Title
**MUSD Trove Radar**: see liquidations, Recovery Mode and redemptions coming before they hit your BTC.
Subtitle: an open-source radar, alert bot and permissionless keeper for MUSD on Mezo · by northbit
Visual: dashboard screenshot (`docs/dashboard.png`)

## 2. Problem
- MUSD borrowers can lose BTC in three ways: liquidation below 110 % ICR, Recovery Mode below 150 % TCR, and redemptions that take the lowest-ratio troves first.
- Mezo's UI shows your own trove. It does not show where you stand against the other 353 troves, or how close the system is to Recovery Mode.
- Keepers and Stability Pool depositors have no simple view of what is liquidatable and whether the liquidation would go through.

## 3. Solution
One tool reading the MUSD contracts directly, pinned to a single block:
- **Radar**: every trove's ICR, liquidation price, ICR distribution, BTC-shock stress test and Stability Pool coverage.
- **Redemption queue**: your position, how much MUSD sits ahead of you, and what a redemption of X MUSD would hit.
- **Alerts**: Slack, Discord, Telegram or a signed JSON webhook, sent only when something changes.
- **Keeper**: simulates `liquidate()` and broadcasts only when the simulation succeeds.

## 4. Live on Mezo Testnet (proof)
- 354 troves · TCR 283 % · Recovery Mode at BTC $41.8k (−47 %)
- 3 liquidatable troves, every one verified with `eth_call`
- 133 troves between 110 and 150 %; −20 % BTC → 86 liquidatable
- 429 M MUSD redeemable; 25k MUSD would close 12 troves
- **A real keeper liquidation**: tx `0x6d0f1cdb…a2d68e`, block 16452016 (QR code / explorer link)

## 5. How it works
Diagram: RPC → multicall at one block (TroveManager, SortedTroves, StabilityPool, PriceFeed, InterestRateManager) → BigInt maths → CLI / JSON / Markdown / static dashboard / webhooks / keeper.
Trust: 22 tests. The live tests compare our ICR with `getCurrentICR` and our NICR with `getNominalICR`, and our redemption order with an on-chain `SortedTroves` walk.

## 6. Who it is for and why it matters for Mezo
- Borrowers: early warning, plus a "where am I in the redemption queue" lookup.
- Stability Pool depositors: coverage and incoming liquidations.
- Keepers: a working open-source liquidation bot, which helps keep MUSD solvent.
- Mezo: more keepers and better-informed borrowers mean fewer bad-debt surprises and more trust in MUSD as BTC-backed money.

## 7. Roadmap and ask
- Wave 2 (now): redemption queue, webhooks, keeper proof, dashboard lookup
- Next: hosted dashboard with history, Telegram bot with per-user subscriptions, an alert when a redemption tx enters the mempool, TroveGuard (an opt-in contract that tops up collateral automatically), mainnet once MUSD addresses and keeper economics are confirmed
- Links: repo · live dashboard · 2-minute video
- Built by northbit with an AI coding assistant (see the README disclosure)
