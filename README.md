# MUSD Trove Radar

**A liquidation and Recovery Mode radar, plus a permissionless liquidation keeper, for MUSD troves on Mezo.**

MUSD is minted against BTC in troves. When a trove's collateral ratio (ICR) drops below 110 % it can be liquidated. If the whole system's ratio (TCR) drops below 150 %, Mezo enters Recovery Mode. Borrowers, Stability Pool depositors and keepers each need a quick answer to the same questions:

* How close is my trove to liquidation, and at what BTC price does it happen?
* Which troves can be liquidated right now, and would the liquidation actually go through?
* How large a BTC drop would push the system into Recovery Mode?
* Can the Stability Pool absorb the liquidatable debt, or will it be redistributed to other troves?

Trove Radar reads every active trove straight from the MUSD contracts (TroveManager, SortedTroves, StabilityPool, PriceFeed and InterestRateManager) with multicall, pinned to a single block. It then answers those questions on the command line, as JSON or Markdown, and in a static HTML dashboard.

## Snapshot from Mezo Testnet (block 16451865, 2026-10-29)
- 355 active troves, TCR 283.3 %; Recovery Mode would trigger at BTC $41,765 (a 47.1 % drop)
- **4 troves were liquidatable right now** (10,283 MUSD of debt). For each one, an `eth_call` liquidation **would succeed**.
- 133 troves sat between 110 % and 150 % ICR; a 20 % BTC drop would make 87 troves liquidatable

## Commands
```bash
npm install
node src/cli.mjs snapshot            # Markdown report (+ out/snapshot.json, out/snapshot.md)
node src/cli.mjs snapshot --json     # machine-readable
node src/cli.mjs dashboard           # out/index.html, self-contained static page
node src/cli.mjs liquidatable --simulate   # list ICR<MCR troves, dry-run liquidate() via eth_call
node src/cli.mjs watch 0xYourAddr --interval 60 --warn 1.5 --crit 1.2   # health alerts for given borrowers
node src/cli.mjs keeper              # dry-run batchLiquidateTroves on all liquidatable troves
node src/cli.mjs keeper --send       # broadcast (Mezo Testnet only; key from MEZO_KEY_FILE, must be chmod 600)
```
Set `MEZO_RPC` to override the RPC (default `https://rpc.test.mezo.org`).

## How it works
* `src/chain.mjs` takes the trove owner list from `TroveManager.getTroveFromTroveOwnersArray`, then fetches `getEntireDebtAndColl` and `getTroveInterestRate` per trove in multicall batches at a single block. Pending redistribution rewards are included.
* `src/math.mjs` holds pure BigInt maths: ICR, liquidation price, Recovery Mode trigger price, ICR buckets and price-shock stress tests.
* `src/analyze.mjs` builds the report, including Stability Pool coverage of liquidatable debt and the health level per borrower.
* `src/keeper.mjs` simulates liquidations first and only broadcasts with `--send`. It refuses to send unless the chain ID is 31611 (Mezo Testnet).

## Tests
`npm test` runs 11 tests: 7 unit tests and 4 live, read-only tests against Mezo Testnet. The live tests check:
* our off-chain ICR **equals** on-chain `getCurrentICR` for a random sample of troves
* the `SortedTroves` tail is among our riskiest troves
* every trove we flag as liquidatable passes an `eth_call` liquidation, and a healthy trove reverts.

Use `npm run test:offline` to skip the network tests.

## Credits and licence
MUSD contract addresses and ABIs come from [mezo-org/musd](https://github.com/mezo-org/musd) (`solidity/artifacts/deployments/matsnet`, commit da7888a), GPL-3.0. This project is therefore GPL-3.0-or-later. Built with [viem](https://viem.sh).

**AI disclosure:** this code and documentation were written by northbit with an AI coding assistant. Every number above comes from live chain data and is checked by the test suite.
