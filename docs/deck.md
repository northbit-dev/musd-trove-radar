# MUSD Trove Radar and TroveGuard: deck outline (10 slides)

Every number comes from Mezo Testnet at block 16775729 (2026-11-14). Run `node src/cli.mjs snapshot` again just before exporting the deck.

## 1. Title
**MUSD Trove Radar + TroveGuard**: see liquidations, Recovery Mode and redemptions coming, and let a keeper protect your trove before they hit your BTC.
Subtitle: an open-source radar, alert bot, keeper daemon and on-chain trove guard for MUSD on Mezo · by northbit
Visual: dashboard screenshot (`docs/dashboard.png`)

## 2. Problem
- MUSD borrowers can lose BTC in three ways: liquidation below 110 % ICR, Recovery Mode below 150 % TCR, and redemptions that take the lowest-ratio troves first.
- Mezo's UI shows your own trove. It does not show where you stand against the other 326 troves, or how close the system is to Recovery Mode.
- Even a borrower who gets the warning has to be awake to act on it. Keepers and Stability Pool depositors also lack a simple view of what is liquidatable and whether it pays.

## 3. Solution
One tool reading the MUSD contracts directly, pinned to a single block:
- **Radar and history**: every trove's ICR, liquidation price, stress test, Stability Pool coverage, trends over time, liquidation and redemption events, and a 3-day ICR chart per trove.
- **Redemption queue**: your position, the MUSD ahead of you, and what a redemption of X MUSD would hit.
- **Alerts**: a browser watchlist with notifications; Slack, Discord, Telegram or a signed webhook; and a Cloudflare Worker with your own Telegram bot and an Atom feed per trove.
- **TroveGuard v3**: a ladder of pre-signed Adjust, top-up and repay steps that any keeper runs below your trigger or near the redemption front, up to a target ICR in one call.
- **Keeper daemon**: liquidations and TroveGuard `protect`, simulated first and sent only when profitable.

## 4. Live on Mezo Testnet
- 327 troves · TCR 240 % · Recovery Mode at BTC $41.8k (−37.6 %)
- 65 troves between 110 and 130 %, 171 between 110 and 150 %; at −20 % BTC, 137 are liquidatable
- 86.2 M MUSD in the Stability Pool; 50k MUSD of redemptions would close 7 troves
- Keeper liquidations: [`0x6d0f1c…`](https://explorer.test.mezo.org/tx/0x6d0f1cdb2407fdc572443802dcf48c0451b713d31afb5c40aa4123a5a2a2d68e) (manual) and [`0xb4b1ed…`](https://explorer.test.mezo.org/tx/0xb4b1ed7b85dc19eda5f56ff42465364111afda64361c834d637b2b1d8cb7a280) (daemon)

## 5. TroveGuard v3: one keeper call lifts a trove to your target
- The borrower parks BTC and/or MUSD in the guard, sets a trigger, a target ICR and max steps per call, and stores a ladder of EIP-712 permits, one per MUSD signature nonce. Each step is `Adjust` (BTC in and debt down in one call), `AddColl` or `RepayMUSD`.
- Below the trigger, or when less than a set amount of MUSD sits ahead of the trove in the redemption queue, anyone calls `protect()`. Steps run until the target is reached, funds only enter the borrower's own trove, and the caller gets a tip per step. A step that would take net debt under 1,800 MUSD ends the loop instead of reverting. `cancel` refunds everything and invalidates every permit.
- Live oracle, no mocks: one `protect` ran Adjust → AddColl → Repay, ICR 117.52 % → 133.17 % ([tx](https://explorer.test.mezo.org/tx/0xcd33fad9ea83f6c9698ad9872ec098b9c45441b2d2a9742aa94467e3f91282eb))
- Contract [`0xe96e1f55…5fb9`](https://explorer.test.mezo.org/address/0xe96e1f552aac9828f4c24e75f4aa895dcf7f5fb9), verified · 25 fork tests, 5 fuzz tests, 7 invariants · Slither reviewed · threat table in SECURITY.md, review in docs/REVIEW-v3.md

## 6. The web flow
- `guard.html` works with any EIP-1193 wallet: switch to Mezo Testnet, view your trove and guard, arm it with a trigger and target, fund the reserves, build the ladder step by step with the ICR after each step and a net-debt check (one signature per step, one `storePermits` tx), withdraw or cancel.
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
- Done in Wave 2: TroveGuard v3 (Adjust steps, target ICR, redemption trigger) live and verified, multi-step keeper and guard page, per-trove ICR history, the browser watchlist, the alert worker (Telegram, Atom, signed webhook), v3 fuzz/invariants and Slither.
- Next: a hosted alert worker anyone can subscribe to; a keeper network (several operators, no duplicate sends); a mempool alert for incoming redemptions; an external audit of TroveGuard; mainnet once MUSD addresses and keeper economics are confirmed.
- Ask: feedback from the Mezo team on the guard design, and a path to mainnet addresses.
- Links: repo · live dashboard · 2-minute video
- Built by northbit with an AI coding assistant (see the README disclosure)
