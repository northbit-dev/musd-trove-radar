# MUSD Trove Radar

**A liquidation and Recovery Mode radar, plus a permissionless liquidation keeper, for MUSD troves on Mezo.**

MUSD is minted against BTC in troves. When a trove's collateral ratio (ICR) drops below 110 % it can be liquidated. If the whole system's ratio (TCR) drops below 150 %, Mezo enters Recovery Mode. Borrowers, Stability Pool depositors and keepers each need a quick answer to the same questions:

* How close is my trove to liquidation, and at what BTC price does it happen?
* Which troves can be liquidated right now, and would the liquidation actually go through?
* How large a BTC drop would push the system into Recovery Mode?
* Can the Stability Pool absorb the liquidatable debt, or will it be redistributed to other troves?

Trove Radar reads every active trove straight from the MUSD contracts (TroveManager, SortedTroves, StabilityPool, PriceFeed and InterestRateManager) with multicall, pinned to a single block. It then answers those questions on the command line, as JSON or Markdown, and in a static HTML dashboard.

It also shows the **redemption queue**: which troves MUSD redemptions will hit first and how much MUSD sits ahead of any given trove. A **watcher** sends alerts to Slack, Discord, Telegram or any signed JSON webhook, and a **keeper** liquidates troves that fall below 110 %.

![Dashboard](docs/dashboard.png)

## Live keeper liquidation on Mezo Testnet
The keeper has liquidated a real trove on Mezo Testnet (chain ID 31611):

| | |
|---|---|
| Transaction | [`0x6d0f1cdb…a2d68e`](https://explorer.test.mezo.org/tx/0x6d0f1cdb2407fdc572443802dcf48c0451b713d31afb5c40aa4123a5a2a2d68e) |
| Call | `TroveManager.liquidate(0xDA04759E54728B6636Fe48F7c9795c7B609bAaAa)` |
| Trove before | ICR 106.85 %, 2,212.59 MUSD debt (below the 110 % MCR) |
| Block | 16452016 (2026-10-29 22:32:18 UTC) |
| Gas used | 433,977 |
| Result | Trove status 3 (closed by liquidation); the keeper received the 200 MUSD gas compensation plus the collateral bonus |

The keeper first ran `liquidate()` as an `eth_call` and broadcast only after the simulation succeeded. The same transaction is listed on the dashboard (`proofs.json`).

## Snapshot from Mezo Testnet (block 16452079, 2026-10-29)
- 354 active troves, TCR 283.3 %; Recovery Mode would trigger at BTC $41,764 (a 47.1 % drop)
- **3 troves are liquidatable right now** (8,070 MUSD of debt), and for each one an `eth_call` liquidation succeeds
- 133 troves sit between 110 % and 150 % ICR; a 20 % BTC drop would make 86 troves liquidatable
- 429.2 M MUSD is redeemable; a 25,000 MUSD redemption would hit 13 troves and close 12 of them

## Commands
```bash
npm install
node src/cli.mjs snapshot            # Markdown report (+ out/snapshot.json, out/snapshot.md)
node src/cli.mjs snapshot --json     # machine-readable
node src/cli.mjs dashboard           # out/index.html, self-contained static page with trove lookup
node src/cli.mjs redemption          # front of the redemption queue + depth table
node src/cli.mjs redemption 0xAddr --amount 25000   # your queue position + what a 25k redemption would hit
node src/cli.mjs liquidatable --simulate   # list ICR<MCR troves, dry-run liquidate() via eth_call
node src/cli.mjs watch 0xAddr [0xAddr…] --interval 60 --warn 1.5 --crit 1.2 --redeem-warn 50000 \
  [--webhook URL --format json|slack|discord|telegram --chat-id ID] [--state file]
node src/cli.mjs keeper              # dry-run batchLiquidateTroves on all liquidatable troves
node src/cli.mjs keeper --send --max 5   # broadcast (Mezo Testnet only; key from MEZO_KEY_FILE, must be chmod 600)
```
Set `MEZO_RPC` to override the RPC (default `https://rpc.test.mezo.org`).

## Redemption queue
MUSD can be redeemed 1:1 for BTC. `TroveManager.redeemCollateral` walks `SortedTroves` from the tail, so troves with the lowest nominal collateral ratio go first, and it skips troves below 110 %. Each trove gives up at most its debt minus the 200 MUSD gas reserve, and a trove whose debt drops to the reserve is closed. Trove Radar rebuilds the same order off-chain, using NICR = coll × 1e20 / principal, just as `getNominalICR` does. For every trove it reports:
* its position in the queue, and how much MUSD has to be redeemed before it is touched
* a depth table showing how many troves 10k, 50k, 100k or 500k MUSD of redemptions would hit and close
* a simulation of a redemption of any size (`--amount`)

Redemption fees and partial-redemption hints are not modelled. A live test checks the queue against an on-chain walk of `SortedTroves.getLast/getPrev`, and against `getNominalICR`.

## Alerts and webhooks
`watch` evaluates each borrower once per interval. It sends an alert only when something changes:
* the health level moves (ok → warning → critical → LIQUIDATABLE, or back)
* the trove enters the front of the redemption queue (`--redeem-warn` MUSD or less ahead of it)
* the system enters or leaves Recovery Mode
* the number of liquidatable troves changes

Alert state is kept in `--state` (JSON), so restarts do not cause repeat alerts.

| `--format` | Body |
|---|---|
| `json` (default) | `{source, network, block, alerts:[…], text}`, signed when `TROVE_RADAR_WEBHOOK_SECRET` is set |
| `slack` | `{text}`, for an incoming webhook |
| `discord` | `{content, allowed_mentions:{parse:[]}}` |
| `telegram` | `{chat_id, text}` for `https://api.telegram.org/bot<token>/sendMessage` (`--chat-id` or `TROVE_RADAR_CHAT_ID`) |

When a secret is set, JSON deliveries carry `x-trove-radar-timestamp` and `x-trove-radar-signature: sha256=<hex>`, an HMAC-SHA256 over `${timestamp}.${body}`. Receivers can verify them with `verify()` from `src/webhook.mjs`, which uses a constant-time compare and a 5-minute window. Deliveries time out after 10 s and are retried up to 3 times on network errors, 429 or 5xx; 4xx errors are not retried. You can also set `TROVE_RADAR_WEBHOOK` and `TROVE_RADAR_DASHBOARD_URL` through the environment.

## How it works
* `src/chain.mjs` takes the trove owner list from `TroveManager.getTroveFromTroveOwnersArray`, then fetches `getEntireDebtAndColl` and `getTroveInterestRate` per trove in multicall batches at a single block. Pending redistribution rewards are included.
* `src/math.mjs` holds pure BigInt maths: ICR, liquidation price, Recovery Mode trigger price, ICR buckets and price-shock stress tests.
* `src/redemption.mjs` builds the redemption queue, the depth table and the redemption simulation.
* `src/analyze.mjs` builds the report, including Stability Pool coverage of liquidatable debt and the health level per borrower.
* `src/alerts.mjs` and `src/webhook.mjs` handle alert evaluation, change detection, payload formats, signing and delivery.
* `src/render.mjs` produces Markdown and a self-contained HTML dashboard: no external assets, and the trove lookup runs in the browser over the data embedded in the page.
* `src/keeper.mjs` simulates liquidations first and only broadcasts with `--send`. It refuses to send unless the chain ID is 31611 (Mezo Testnet).

## Tests
`npm test` runs 22 tests: 17 offline tests and 5 live, read-only tests against Mezo Testnet. The offline tests cover the maths, the redemption queue and simulation, alert diffing, the payload formats, signatures, and webhook delivery and retries against a local HTTP server. The live tests check that:
* our off-chain ICR **equals** on-chain `getCurrentICR` for a random sample of troves
* the `SortedTroves` tail is among our riskiest troves
* every trove we flag as liquidatable passes an `eth_call` liquidation, and a healthy trove reverts
* our redemption order matches an on-chain `SortedTroves` walk, and our NICR equals `getNominalICR`

Use `npm run test:offline` to skip the network tests.

## Demo
`scripts/demo.sh` runs a read-only tour of the CLI. A recording is in `docs/demo/` (asciinema `.cast`, plus a plain-text transcript).

## Credits and licence
MUSD contract addresses and ABIs come from [mezo-org/musd](https://github.com/mezo-org/musd) (`solidity/artifacts/deployments/matsnet`, commit da7888a), GPL-3.0. This project is therefore GPL-3.0-or-later. Built with [viem](https://viem.sh).

**AI disclosure:** this code and documentation were written by northbit with an AI coding assistant. Every number above comes from live chain data and is checked by the test suite.
