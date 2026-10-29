# MUSD Trove Radar: deck outline (8 slides)

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
- **TroveGuard**: an opt-in contract that tops up collateral automatically before liquidation.

## 4. Live on Mezo Testnet (proof)
- 354 troves · TCR 283 % · Recovery Mode at BTC $41.8k (−47 %)
- 3 liquidatable troves, every one verified with `eth_call`
- 133 troves between 110 and 150 %; −20 % BTC → 86 liquidatable
- 429 M MUSD redeemable; 25k MUSD would close 12 troves
- **A real keeper liquidation**: tx `0x6d0f1cdb…a2d68e`, block 16452016 (QR code / explorer link)

## 5. TroveGuard: automatic collateral top-up (live on Mezo Testnet)
- Opt-in contract: the borrower parks a BTC reserve, sets a trigger ICR and stores pre-signed `addCollWithSignature` permits.
- When ICR drops below the trigger, anyone (our keeper) calls `protect()`: one permit is spent, BTC goes only into the borrower's own trove, the caller gets a small tip.
- **Permit ladder per nonce**: MUSD's `BorrowerOperationsSignatures` has one nonce counter per borrower, so a signature works exactly once and in order. TroveGuard stores permits keyed by nonce and skips rungs spent elsewhere; `cancel` refunds the reserve and invalidates all stored permits.
- **Demo on-chain**: trigger 130 %, two keeper top-ups lifted the trove's ICR **117.9 % → 125.8 % → 133.7 %**.
- Contract: [`0x4e5ada5a4c3095727a1259369b98dd31466b0e6d`](https://explorer.test.mezo.org/address/0x4e5ada5a4c3095727a1259369b98dd31466b0e6d) (source verified on the explorer) · 9 fork tests
- Txs: [deploy](https://explorer.test.mezo.org/tx/0x7f8e3fb51c82caa89c155c87375defe5e95b6b6721b7c50911046ffe34065be0) · [configure](https://explorer.test.mezo.org/tx/0xbca92e1b51ec515d24b2ea42175fcbddf830f1fe4e36c9e1b16d75fa59c879f0) · [storePermits](https://explorer.test.mezo.org/tx/0xab286c9cc8faca4aaf83520d0f6b05fc609d8d7a3f2f8016a863ae70f64eb03e) · [protect #1](https://explorer.test.mezo.org/tx/0xf639ce7656afabdac74bc6345bb83f4eeed60c8ca76a23c98a8a22c7d3206dae) · [protect #2](https://explorer.test.mezo.org/tx/0x9f66e2b0b6d537b1f5bd5d4ca759a740647482e759517c74f5af6222930859da)

## 6. How it works
Diagram: RPC → multicall at one block (TroveManager, SortedTroves, StabilityPool, PriceFeed, InterestRateManager) → BigInt maths → CLI / JSON / Markdown / static dashboard / webhooks / keeper.
Trust: 22 tests. The live tests compare our ICR with `getCurrentICR` and our NICR with `getNominalICR`, and our redemption order with an on-chain `SortedTroves` walk.

## 7. Who it is for and why it matters for Mezo
- Borrowers: early warning, plus a "where am I in the redemption queue" lookup.
- Stability Pool depositors: coverage and incoming liquidations.
- Keepers: a working open-source liquidation bot, which helps keep MUSD solvent.
- Mezo: more keepers and better-informed borrowers mean fewer bad-debt surprises and more trust in MUSD as BTC-backed money.

## 8. Roadmap and ask
- Wave 2 (now): redemption queue, webhooks, keeper proof, dashboard lookup, TroveGuard live on testnet
- Next: hosted dashboard with history, Telegram bot with per-user subscriptions, an alert when a redemption tx enters the mempool, TroveGuard repay-MUSD mode and audit, mainnet once MUSD addresses and keeper economics are confirmed
- Links: repo · live dashboard · 2-minute video
- Built by northbit with an AI coding assistant (see the README disclosure)
