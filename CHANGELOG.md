# Changelog

All dates are 2026. Transactions are on Mezo Testnet (chain 31611); `tx` links go to explorer.test.mezo.org.
Commit links are relative to the repository on GitHub.

## v0.2.0: Wave 2

### Added
* **Event history** ([f60837f](../../commit/f60837f)): `history` reads TroveManager liquidations and redemptions in
  windowed `getLogs` calls with an incremental cache, and the dashboard shows recent activity. The live test finds the
  keeper's own liquidation ([tx 0x6d0f1c…](https://explorer.test.mezo.org/tx/0x6d0f1cdb2407fdc572443802dcf48c0451b713d31afb5c40aa4123a5a2a2d68e)).
* **Event alerts** ([1ff4385](../../commit/1ff4385)): `watch` alerts when a watched trove is redeemed, liquidated or
  hit by a redistribution, with deduplication across restarts.
* **TroveGuard v2, repay mode** ([82c6580](../../commit/82c6580)): `RepayMUSD` permits, an MUSD reserve, mixed
  AddColl/RepayMUSD ladders on one nonce counter, and `cancel` refunds both reserves.
* **Security and CI** ([49b26c3](../../commit/49b26c3)): fuzz and invariant tests, a Slither review with every
  finding justified, SECURITY.md, a contracts CI workflow and a gas snapshot.
* **TroveGuard v2 live** ([4ab7f64](../../commit/4ab7f64)): deployed and verified at
  [`0xa67c9bbc…9df7`](https://explorer.test.mezo.org/address/0xa67c9bbcd4350b24e33e25e2ebd7c80c04409df7)
  ([deploy tx](https://explorer.test.mezo.org/tx/0x19963d99d3f60d6d69417df39f90509eb59c4bfa3b6ec97a6c91fd0cdfe89638)).
  Against the live oracle, `protect` RepayMUSD took ICR from 118.45 % to 123.95 %
  ([tx](https://explorer.test.mezo.org/tx/0x950ca982156cc6b3dd1f6e2e69552e00aa19bba9b70765545b3764947d335aa9)), and
  `protect` AddColl took it from 123.88 % to 131.16 %
  ([tx](https://explorer.test.mezo.org/tx/0xc3b2dcde9ad22ebd2d24c4aabf87d45b5e72759cc4a615565f53c65cdde6e554)).
* **Guard in the browser** ([0801ec2](../../commit/0801ec2)): `out/guard.html` with a wallet for configure,
  reserves, EIP-712 ladder signing, withdraw and cancel, plus a headless end-to-end run. A wallet-signed permit was
  executed by `protect`, taking ICR from 131.23 % to 137.62 %
  ([tx](https://explorer.test.mezo.org/tx/0x084a2b4b964c04c722a4d10d32a04d9b8c838d0d9bd4253f7e7edbd47b052212)).
* **Dashboard history and Stability Pool** ([8ccfc15](../../commit/8ccfc15)): `history.json` trends kept across CI
  runs, inline SVG charts for TCR, liquidatable troves and redemptions per day, Stability Pool cards with the BTC
  gained per liquidation, a live depositor lookup, and TroveGuard status in the trove lookup.
* **Keeper daemon** ([28d9054](../../commit/28d9054)): `keeper --loop` with exponential backoff and JSON logs,
  `--min-profit` for liquidations and `protect` with logged skip reasons, a Dockerfile and
  [docs/run-a-keeper.md](docs/run-a-keeper.md). The daemon liquidated one trove and skipped three below the minimum
  ([tx 0xb4b1ed…](https://explorer.test.mezo.org/tx/0xb4b1ed7b85dc19eda5f56ff42465364111afda64361c834d637b2b1d8cb7a280)).
* **Docs**: [ARCHITECTURE.md](docs/ARCHITECTURE.md), this changelog, an updated deck and video script.

### Changed
* The dashboard is no longer offline-only: the optional Stability Pool depositor lookup calls the Mezo RPC.
* `loadAccount` also accepts `MEZO_PRIVATE_KEY` and refuses key files inside the repository.

## v0.1.0: 29 October

* **Radar, dashboard, keeper dry-run, tests** ([3d2844f](../../commit/3d2844f)): every trove read by multicall at
  one block, ICR distribution, stress test, Stability Pool coverage, and a static dashboard.
* **Redemption queue, alerts, keeper proof** ([c855ba6](../../commit/c855ba6)): redemption order and simulation,
  webhooks for Slack, Discord, Telegram and signed JSON, the dashboard trove lookup, and a real keeper liquidation
  ([tx 0x6d0f1c…](https://explorer.test.mezo.org/tx/0x6d0f1cdb2407fdc572443802dcf48c0451b713d31afb5c40aa4123a5a2a2d68e)).
* **TroveGuard v1** ([5b5e143](../../commit/5b5e143), [a679628](../../commit/a679628)): pre-signed BTC top-ups,
  deployed at [`0x4e5ada5a…6d`](https://explorer.test.mezo.org/address/0x4e5ada5a4c3095727a1259369b98dd31466b0e6d).
  Two keeper `protect` calls took ICR from 117.9 % to 125.8 % and then to 133.7 %
  ([#1](https://explorer.test.mezo.org/tx/0xf639ce7656afabdac74bc6345bb83f4eeed60c8ca76a23c98a8a22c7d3206dae),
  [#2](https://explorer.test.mezo.org/tx/0x9f66e2b0b6d537b1f5bd5d4ca759a740647482e759517c74f5af6222930859da)).
