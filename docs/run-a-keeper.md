# Run your own keeper

MUSD gets safer with every independent keeper. Anyone can liquidate a trove below 110 % or call
TroveGuard's `protect` for a borrower below their trigger. The radar's keeper does both in one loop,
and it only sends a transaction when the reward covers the gas.

This guide is for **Mezo Testnet** (chain ID 31611). The keeper refuses to broadcast on any other chain.

## What the keeper earns

| Action | Reward | Paid by |
|---|---|---|
| `liquidate` / `batchLiquidateTroves` | 200 MUSD gas compensation + 0.5 % of the trove's BTC collateral, per trove | TroveManager (gas pool and the trove's collateral) |
| TroveGuard `protect` | the borrower's `keeperTip` in BTC | the borrower's BTC reserve in the guard |

Before sending, the keeper dry-runs every target on its own with `eth_call`, estimates its gas and values
reward and gas cost in MUSD at the PriceFeed price:

```
profit = reward − gas × gasPrice × price
```

A target is sent only if `profit ≥ --min-profit` (MUSD, default 0). Every skipped trove is logged with
the reason: `dry-run revert: …`, `unprofitable: reward … − gas … < min …` or `no gas estimate`.
Profitable liquidations go out together in one `batchLiquidateTroves` call, after a dry-run of the batch.

The estimate is a little conservative. A batch costs less gas than its troves run one at a time, and
Mezo's `eth_estimateGas` leaves out the EIP-7623 calldata floor, which is small for these calls.

## Quick start (Node 20+)

```bash
git clone --recursive https://github.com/northbit-dev/musd-trove-radar && cd musd-trove-radar && npm ci
node src/cli.mjs keeper --protect            # one dry-run round: what would be sent, and why not
node src/cli.mjs keeper --loop --interval 60  # dry-run daemon, JSON logs on stdout
```

To send, give it a **testnet** key that has a little BTC for gas, using one of these:

* `MEZO_KEY_FILE=/path/outside/the/repo/keeper.key` with the file `chmod 600`. The keeper refuses a group- or world-readable file and any file inside the repository.
* `MEZO_PRIVATE_KEY=0x…`, for containers and secret managers.

```bash
MEZO_KEY_FILE=$HOME/.secrets/keeper.key node src/cli.mjs keeper --loop --interval 30 --min-profit 5 --send
```

With `--send` the keeper checks the key and the chain ID before the first round and exits if either is wrong.

## Docker

```bash
docker build -t trove-radar-keeper .
docker run --rm trove-radar-keeper                                   # dry-run daemon, every 60 s
docker run -d --restart unless-stopped --name keeper \
  -v $HOME/.secrets/keeper.key:/run/secrets/keeper.key:ro -e MEZO_KEY_FILE=/run/secrets/keeper.key \
  trove-radar-keeper --loop --interval 30 --min-profit 5 --send
docker logs -f keeper
```

The image holds only `src/`, the package files and production dependencies (`.dockerignore` is an
allowlist), and it runs as the unprivileged `node` user. A bind-mounted key file must be readable by
UID 1000 and still `chmod 600`, or you can pass `-e MEZO_PRIVATE_KEY` from your secret store.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--loop` | off | run forever; without it the keeper does one round |
| `--interval S` | 60 | seconds between rounds |
| `--min-profit M` | 0 | minimum profit per target in MUSD |
| `--max N` | 10 | liquidatable troves considered per round, riskiest first |
| `--send` | off | broadcast; otherwise dry-run only |
| `--protect` / `--no-protect` | one round: off · loop: on | include TroveGuard `protect` |
| `--log json\|text` | loop: json · one round: text | log format |
| `--max-backoff S` | 900 | cap on the retry delay after failed rounds |
| `--rounds N` | ∞ | stop after N rounds (smoke tests) |
| `MEZO_RPC` | `https://rpc.test.mezo.org` | RPC endpoint |

## Failures and logs

A round that throws, for example on an RPC timeout or a lagging load-balanced node, does not stop the
daemon. It is logged as `round.error` with `retryInMs`, and the next round waits `interval × 2^failures`,
capped at `--max-backoff`. One successful round resets the delay. A broadcast that the RPC rejects is
retried twice before the round fails. SIGINT or SIGTERM stops the daemon cleanly after the current round.

Every line is one JSON object with `ts`, `level`, `msg` and `event`:

| `event` | When |
|---|---|
| `daemon.start` / `daemon.stop` | settings and sender address at start; signal received |
| `round.start` / `round.ok` / `round.error` | block, liquidatable count, price; duration; error and retry delay |
| `liquidate.target` / `liquidate.skip` | per trove: ICR, gas, reward, cost, profit, or the skip reason |
| `liquidate.dryrun` / `liquidate.tx` | batch dry-run result; tx hash and receipt status |
| `protect.target` / `protect.skip` / `protect.tx` / `protect.none` | the same for TroveGuard |

BigInt fields (wei, gas) are decimal strings. For example, with `--min-profit 215` against the live testnet:

```json
{"ts":"2026-10-30T06:23:30.433Z","level":"info","msg":"keeper: 0x03ff…62d2 ICR 107.17 % skipped (unprofitable: reward 211.7717 MUSD − gas 0.0000054 MUSD < min 215.0000 MUSD)","event":"liquidate.skip", …}
{"ts":"2026-10-30T06:23:31.132Z","level":"error","msg":"round 1 failed (1 in a row): Missing or invalid parameters. …","event":"round.error","round":1,"fails":1,"retryInMs":40000}
{"ts":"2026-10-30T06:24:17.797Z","level":"info","msg":"keeper: tx https://explorer.test.mezo.org/tx/0xb4b1ed…a280 status=success","event":"liquidate.tx", …}
```

That run is on the explorer as [`0xb4b1ed…a280`](https://explorer.test.mezo.org/tx/0xb4b1ed7b85dc19eda5f56ff42465364111afda64361c834d637b2b1d8cb7a280).
The keeper liquidated one trove, which had 3,873 MUSD of debt, and received 200 MUSD plus 0.000265 BTC,
matching its estimate. It skipped three troves worth about 211 MUSD each. The first round hit a lagging
RPC node and the daemon backed off and recovered on its own.
