# Changelog

All dates are 2026. Transactions are on Mezo Testnet (chain 31611); `tx` links go to explorer.test.mezo.org.
Commit links are relative to the repository on GitHub.

## v0.2.0: 30 October (Wave 2)

### Added
* **Event history** ([3e0f5c8](../../commit/3e0f5c8)): `history` reads TroveManager liquidations and redemptions in
  windowed `getLogs` calls with an incremental cache, and the dashboard shows recent activity. The live test finds the
  keeper's own liquidation ([tx 0x6d0f1c…](https://explorer.test.mezo.org/tx/0x6d0f1cdb2407fdc572443802dcf48c0451b713d31afb5c40aa4123a5a2a2d68e)).
* **Event alerts** ([5dc81be](../../commit/5dc81be)): `watch` alerts when a watched trove is redeemed, liquidated or
  hit by a redistribution, with deduplication across restarts.
* **TroveGuard v2, repay mode** ([f9e0541](../../commit/f9e0541)): `RepayMUSD` permits, an MUSD reserve, mixed
  AddColl/RepayMUSD ladders on one nonce counter, and `cancel` refunds both reserves.
* **Security and CI** ([e2399d9](../../commit/e2399d9)): fuzz and invariant tests, a Slither review with every
  finding justified, SECURITY.md, a contracts CI workflow and a gas snapshot.
* **TroveGuard v2 live** ([2fba134](../../commit/2fba134)): deployed and verified at
  [`0xa67c9bbc…9df7`](https://explorer.test.mezo.org/address/0xa67c9bbcd4350b24e33e25e2ebd7c80c04409df7)
  ([deploy tx](https://explorer.test.mezo.org/tx/0x19963d99d3f60d6d69417df39f90509eb59c4bfa3b6ec97a6c91fd0cdfe89638)).
  Against the live oracle, `protect` RepayMUSD took ICR from 118.45 % to 123.95 %
  ([tx](https://explorer.test.mezo.org/tx/0x950ca982156cc6b3dd1f6e2e69552e00aa19bba9b70765545b3764947d335aa9)), and
  `protect` AddColl took it from 123.88 % to 131.16 %
  ([tx](https://explorer.test.mezo.org/tx/0xc3b2dcde9ad22ebd2d24c4aabf87d45b5e72759cc4a615565f53c65cdde6e554)).
* **Guard in the browser** ([491018d](../../commit/491018d)): `out/guard.html` with a wallet for configure,
  reserves, EIP-712 ladder signing, withdraw and cancel, plus a headless end-to-end run. A wallet-signed permit was
  executed by `protect`, taking ICR from 131.23 % to 137.62 %
  ([tx](https://explorer.test.mezo.org/tx/0x084a2b4b964c04c722a4d10d32a04d9b8c838d0d9bd4253f7e7edbd47b052212)).
* **Dashboard history and Stability Pool** ([4f981d5](../../commit/4f981d5)): `history.json` trends kept across CI
  runs, inline SVG charts for TCR, liquidatable troves and redemptions per day, Stability Pool cards with the BTC
  gained per liquidation, a live depositor lookup, and TroveGuard status in the trove lookup.
* **Keeper daemon** ([ef6cc72](../../commit/ef6cc72)): `keeper --loop` with exponential backoff and JSON logs,
  `--min-profit` for liquidations and `protect` with logged skip reasons, a Dockerfile and
  [docs/run-a-keeper.md](docs/run-a-keeper.md). The daemon liquidated one trove and skipped three below the minimum
  ([tx 0xb4b1ed…](https://explorer.test.mezo.org/tx/0xb4b1ed7b85dc19eda5f56ff42465364111afda64361c834d637b2b1d8cb7a280)).
* **Docs**: [ARCHITECTURE.md](docs/ARCHITECTURE.md), this changelog, an updated deck and video script.

* **Release QA**: a clean clone passes `npm ci`, `npm test` (47 tests, 41 offline), `forge test` against an anvil
  fork (18 tests), every README command and the Docker dry-run. `keeper --send --max 1` from the clone liquidated a trove
  ([tx 0x6fbdaa…](https://explorer.test.mezo.org/tx/0x6fbdaa8f980aae07e97d6a97ec53d272f0c30c94c215de0eb2231b92220d279e)).
  The full `guard.html` flow ran in desktop Firefox
  ([storePermits](https://explorer.test.mezo.org/tx/0x6feaa87c93222721d1a51dee45563137e422645dc509d639becee26c207a0740))
  and in Chromium as a Pixel 7
  ([storePermits](https://explorer.test.mezo.org/tx/0x4cf41276e0ee1bdf7b04a9c9a34fd3134a82630e480929a45fa507ba8019c0c4)).
  `scripts/guard-e2e.mjs` gained `E2E_BROWSER` and `E2E_DEVICE`. There is a new demo recording, and links are in
  [docs/links.md](docs/links.md).

### Changed
* The dashboard is no longer offline-only: the optional Stability Pool depositor lookup calls the Mezo RPC.
* `guard.html` no longer overflows on narrow screens (the borrower field is fluid).
* `loadAccount` also accepts `MEZO_PRIVATE_KEY` and refuses key files inside the repository.

## v0.1.0: 29 October

* **Radar, dashboard, keeper dry-run, tests** ([aaabe47](../../commit/aaabe47)): every trove read by multicall at
  one block, ICR distribution, stress test, Stability Pool coverage, and a static dashboard.
* **Redemption queue, alerts, keeper proof** ([3fe612c](../../commit/3fe612c)): redemption order and simulation,
  webhooks for Slack, Discord, Telegram and signed JSON, the dashboard trove lookup, and a real keeper liquidation
  ([tx 0x6d0f1c…](https://explorer.test.mezo.org/tx/0x6d0f1cdb2407fdc572443802dcf48c0451b713d31afb5c40aa4123a5a2a2d68e)).
* **TroveGuard v1** ([4e678f2](../../commit/4e678f2), [e5ccc6b](../../commit/e5ccc6b)): pre-signed BTC top-ups,
  deployed at [`0x4e5ada5a…6d`](https://explorer.test.mezo.org/address/0x4e5ada5a4c3095727a1259369b98dd31466b0e6d).
  Two keeper `protect` calls took ICR from 117.9 % to 125.8 % and then to 133.7 %
  ([#1](https://explorer.test.mezo.org/tx/0xf639ce7656afabdac74bc6345bb83f4eeed60c8ca76a23c98a8a22c7d3206dae),
  [#2](https://explorer.test.mezo.org/tx/0x9f66e2b0b6d537b1f5bd5d4ca759a740647482e759517c74f5af6222930859da)).
