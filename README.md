# MUSD Trove Radar

**A liquidation and Recovery Mode radar, plus a permissionless liquidation keeper, for MUSD troves on Mezo.**

MUSD is minted against BTC in troves. When a trove's collateral ratio (ICR) drops below 110 % it can be liquidated. If the whole system's ratio (TCR) drops below 150 %, Mezo enters Recovery Mode. Borrowers, Stability Pool depositors and keepers each need a quick answer to the same questions:

* How close is my trove to liquidation, and at what BTC price does it happen?
* Which troves can be liquidated right now, and would the liquidation actually go through?
* How large a BTC drop would push the system into Recovery Mode?
* Can the Stability Pool absorb the liquidatable debt, or will it be redistributed to other troves?

Trove Radar reads every active trove straight from the MUSD contracts (TroveManager, SortedTroves, StabilityPool, PriceFeed and InterestRateManager) with multicall, pinned to a single block. It then answers those questions on the command line, as JSON or Markdown, and in a static HTML dashboard.

It also shows the **redemption queue**: which troves MUSD redemptions will hit first and how much MUSD sits ahead of any given trove. A **watcher** sends alerts to Slack, Discord, Telegram or any signed JSON webhook, and a **keeper** liquidates troves that fall below 110 %. The on-chain **[TroveGuard](#troveguard)** contract, live on Mezo Testnet, lets a borrower pre-authorise BTC top-ups that the keeper triggers when their ICR dips.

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
node src/cli.mjs history [--blocks 100000] [--json]   # liquidations and redemptions from TroveManager events
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

## History
The radar's other views are a snapshot at one block. `history` adds what actually happened: it reads TroveManager's `Liquidation`, `TroveLiquidated`, `Redemption` and `TroveUpdated` events and turns them into one entry per transaction.

* **Liquidations** carry the liquidated debt and collateral, the gas compensation and every trove closed (`TroveLiquidated`).
* **Redemptions** carry the MUSD redeemed, the BTC paid out and the fee. MUSD does not log per-trove redemption amounts, so the hit troves come from `TroveUpdated` with operation `redeemCollateral`, with their debt and collateral after the redemption and whether they were closed.

Mezo's public RPC accepts at most 10,000 blocks per `eth_getLogs`, so logs are fetched in windows (`--window`, default 10,000). A window the RPC rejects is halved, and other errors are retried with backoff. Decoded events are cached in `out/events.json` together with the block range they cover, so the next run only asks for blocks it has not seen. `--blocks` sets how far back to look (default 100,000 blocks, about 4.8 days at roughly 4.2 s per block). `--json` prints totals plus every event.

```
$ node src/cli.mjs history --blocks 300000
Blocks 16158138–16458137: 1 liquidation(s) of 1 trove(s), 2,212.59 MUSD debt, 0.029788 BTC · 3 redemption(s), 3.22 MUSD for 0.00004009 BTC across 1 trove(s)
16452016  2026-10-29 22:32:18 UTC  LIQUIDATION  2,212.59 MUSD debt, 0.029788 BTC coll  troves: 0xDA04…AaAa  https://explorer.test.mezo.org/tx/0x6d0f1c…
16383114  2026-10-26 14:58:19 UTC  REDEMPTION   0.01 MUSD → 0.00000012 BTC …
```

The first line above is the keeper's own liquidation. The dashboard shows the latest 20 entries under **Recent activity**, with explorer links for every transaction and trove. If the RPC is unavailable the dashboard is still built, without that section.

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
* `src/events.mjs` fetches and decodes TroveManager events in block windows, groups them per transaction and keeps the `out/events.json` cache.
* `src/alerts.mjs` and `src/webhook.mjs` handle alert evaluation, change detection, payload formats, signing and delivery.
* `src/render.mjs` produces Markdown and a self-contained HTML dashboard: no external assets, and the trove lookup runs in the browser over the data embedded in the page.
* `contracts/TroveGuard.sol` + `src/guard.mjs`: the on-chain top-up guard and its keeper side (targets via `status()`, insert hints via `HintHelpers.getApproxHint` + `SortedTroves.findInsertPosition`, dry-run before send).
* `src/keeper.mjs` simulates liquidations first and only broadcasts with `--send`. It refuses to send unless the chain ID is 31611 (Mezo Testnet).

## Tests
`npm test` runs 29 Node tests (TroveGuard's Foundry tests are described under [TroveGuard](#troveguard)): 23 offline tests and 6 live, read-only tests against Mezo Testnet. The offline tests cover the maths, the redemption queue and simulation, alert diffing, the payload formats, signatures, webhook delivery and retries against a local HTTP server, and event decoding against real Mezo Testnet logs (`test/fixtures/`), window halving, retries and the incremental cache. The live tests check that:
* our off-chain ICR **equals** on-chain `getCurrentICR` for a random sample of troves
* the `SortedTroves` tail is among our riskiest troves
* every trove we flag as liquidatable passes an `eth_call` liquidation, and a healthy trove reverts
* our redemption order matches an on-chain `SortedTroves` walk, and our NICR equals `getNominalICR`
* `history` finds the keeper's own liquidation (block 16452016) in TroveManager's events

Use `npm run test:offline` to skip the network tests.

## TroveGuard

`contracts/TroveGuard.sol` tops up an MUSD trove automatically. The borrower parks a BTC reserve in the guard, picks a trigger ICR and stores a few pre-signed `addCollWithSignature` permits. When the trove's ICR falls below the trigger, anyone can call `protect(borrower, upperHint, lowerHint)`. The guard spends one permit, sends the signed amount of BTC into the borrower's own trove through `BorrowerOperationsSignatures`, and pays the caller a small tip from the reserve. The radar's keeper is that caller.

**Live on Mezo Testnet:** [`0x4e5ada5a4c3095727a1259369b98dd31466b0e6d`](https://explorer.test.mezo.org/address/0x4e5ada5a4c3095727a1259369b98dd31466b0e6d) (source verified on the explorer).

| Step | Transaction |
| --- | --- |
| Deploy (block 16452547) | [`0x7f8e3f…65be0`](https://explorer.test.mezo.org/tx/0x7f8e3fb51c82caa89c155c87375defe5e95b6b6721b7c50911046ffe34065be0) |
| Open a demo trove: 0.03 BTC, 1,800 MUSD | [`0x77d00a…71dbf`](https://explorer.test.mezo.org/tx/0x77d00aa4a4045eb8289634567ab4926162fdebd9aa4227d57e803cd9e5371dbf) |
| `configure`: trigger 130 %, reserve 0.00603 BTC | [`0xbca92e…879f0`](https://explorer.test.mezo.org/tx/0xbca92e1b51ec515d24b2ea42175fcbddf830f1fe4e36c9e1b16d75fa59c879f0) |
| `storePermits`: 3 rungs of 0.002 BTC, nonces 0–2 | [`0xab286c…03e`](https://explorer.test.mezo.org/tx/0xab286c9cc8faca4aaf83520d0f6b05fc609d8d7a3f2f8016a863ae70f64eb03e) |
| `protect` #1 by the keeper: ICR 117.92 % → 125.78 % | [`0xf639ce…06dae`](https://explorer.test.mezo.org/tx/0xf639ce7656afabdac74bc6345bb83f4eeed60c8ca76a23c98a8a22c7d3206dae) |
| `protect` #2 by the keeper: ICR 125.82 % → 133.68 % | [`0x9f66e2…859da`](https://explorer.test.mezo.org/tx/0x9f66e2b0b6d537b1f5bd5d4ca759a740647482e759517c74f5af6222930859da) |

After the second top-up the trove sat above its trigger, so the keeper stopped. One rung is still stored for the next dip.

### Why permits come in a ladder
`BorrowerOperationsSignatures` gives each borrower a single nonce counter. Every `*WithSignature` call uses it: add or withdraw collateral, repay, refinance, close. The signed digest is `AddColl(assetAmount, borrower, nonce, deadline)` with the **current** nonce, and a successful call increments it. Three things follow:

* **A signature works exactly once.** After a top-up the same signature no longer verifies, so a single stored signature would protect you only once.
* **Signatures work strictly in order.** A signature for nonce *n + 1* is useless until nonce *n* has been spent.
* **The signature does not bind the caller or the hints**, only the amount, borrower, nonce and deadline. Anyone who sees it can submit it, but `msg.value` has to equal the signed amount and the BTC can only land in the borrower's trove. The worst a stranger can do is gift the borrower collateral and use up one nonce.

That is why TroveGuard stores permits **keyed by nonce** (`storePermits(firstNonce, permits[])`). `protect` always looks up the borrower's current `getNonce()`. Suppose a nonce is spent somewhere else, for example by the borrower's own `withdrawCollWithSignature` or by someone front-running a stored signature. That rung is simply skipped, and the next one lines up on its own; the tests cover this. Each permit carries its own amount and deadline, because both are part of the signature.

### Guarantees
* BTC leaves the guard only into the borrower's own trove (through MUSD's signature check), as the tip to whoever called `protect`, or back to the borrower through `withdraw` or `cancel`. No arbitrary calls or calldata.
* `protect` reverts unless the trove is active and `getCurrentICR(borrower, fetchPrice())` is **strictly** below the trigger. It also reverts if no unexpired permit matches the current nonce, if the reserve can't cover the top-up plus tip, or if the ICR did not go up.
* `cancel` refunds the whole reserve and invalidates every stored permit (each one is tied to a "generation" counter that `cancel` bumps).
* `protect`, `withdraw` and `cancel` are protected against reentrancy. The trigger has to be between 110 % (MCR) and 1000 %.

### Use it
```sh
forge build
anvil --fork-url https://rpc.test.mezo.org --chain-id 31611 &
forge test --fork-url http://127.0.0.1:8545     # 9 fork tests
node src/cli.mjs guard                          # every guarded trove and whether it is protectable
node src/cli.mjs keeper --protect [--send]      # liquidations + TroveGuard top-ups (dry-run unless --send)
node scripts/troveguard-live.mjs deploy|setup|protect   # testnet-only deploy and end-to-end demo
```
Mezo's price oracle is a chain precompile that anvil can't run. The fork tests therefore mock the oracle that `PriceFeed` wraps (`latestRoundData`), and everything else runs against real forked MUSD contracts. Run without a fork, `forge test` skips the suite. The tests cover the trigger and the exact boundary, top-ups that actually raise ICR on chain, single use and replay (including a direct replay against MUSD), the ladder surviving an external nonce spend, stale nonces, foreign signatures, owner-only withdraw and cancel, an insufficient reserve, an expired permit, an inactive trove and a reentrant keeper.

## Demo
`scripts/demo.sh` runs a read-only tour of the CLI. A recording is in `docs/demo/` (asciinema `.cast`, plus a plain-text transcript).

## Credits and licence
MUSD contract addresses and ABIs come from [mezo-org/musd](https://github.com/mezo-org/musd) (`solidity/artifacts/deployments/matsnet`, commit da7888a), GPL-3.0. This project is therefore GPL-3.0-or-later. Built with [viem](https://viem.sh).

**AI disclosure:** this code and documentation were written by northbit with an AI coding assistant. Every number above comes from live chain data and is checked by the test suite.
