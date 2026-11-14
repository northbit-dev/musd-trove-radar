# TroveGuard v3 review

**Scope:** `contracts/TroveGuardV3.sol` as deployed by `scripts/troveguard-v3-live.mjs`, plus the parts of `src/permits.mjs` and `src/guard.mjs` that sign v3 permits and call `protect`.
**Method:** a line-by-line read against MUSD's `BorrowerOperationsSignatures`, `BorrowerOperations` and `TroveManager`, Slither ([static-analysis.md](security/static-analysis.md#troveguard-v3)), fork unit tests, fuzz tests and handler-based invariants against real Mezo Testnet contracts.
**Result:** no fund-loss or lock-up issue found. Nothing below needed a contract change; the findings are documented limits.

This is a self-review for a hackathon project on testnet, not an audit. [SECURITY.md](../SECURITY.md) has the threat model.

## What changed from v2

| Area | v2 | v3 |
| --- | --- | --- |
| Rung kinds | `AddColl`, `RepayMUSD` | plus `Adjust`: BTC in and MUSD repaid in one `adjustTroveWithSignature` |
| Rungs per `protect` | 1 | 1 to `maxRungs` (≤ 5) while ICR < `targetICR` |
| Trigger | ICR < trigger | ICR < trigger, or less than `redemptionBuffer` MUSD of redeemable debt ahead (walk ≤ 40 troves) |
| Tip | per call | per rung: debited from the reserve with each rung, paid out once at the end |
| Permit struct | `kind, amount, deadline, signature` | `kind, deadline, btc, musd, signature` (ABI break; v2 stays deployed as legacy) |

## Properties checked

| Property | How |
| --- | --- |
| BTC and MUSD only leave into the borrower's trove, as tips to the caller, or back to the borrower | Read: `_send` has three callers (withdraw, cancel, tip), all to `msg.sender`; the `Adjust` call hard-codes `collWithdrawal = 0`, `isDebtIncrease = false`, `recipient = borrower`, all inside the signed digest |
| Reserves always equal balances | `invariant_btcReservesBackedByBalance`, `invariant_musdReservesBackedByBalance` (v3 handler with multi-rung calls) |
| One call moves exactly the spent rungs plus one tip per rung, and at most `maxRungs` | `testFuzz_protectMovesExactlyWhatTheSpentRungsSay`, `invariant_rungsAndTipsStayWithinConfig` |
| Every rung raises ICR, or the whole call reverts | `_spend` reverts with `ICRNotImproved`; fork tests check ICR before and after |
| The loop stops early only when the next rung is unusable | Fuzz: below target with rungs to spare implies the next permit is missing, unfunded or would breach `minNetDebt` |
| A failed `protect` moves nothing | Fuzz `catch` branch |
| `cancel` orphans every stored permit | `invariant_noUsablePermitAfterCancel`, `test_cancelInvalidatesLadderAndRefunds` |
| Redemption walk is bounded | `MAX_WALK = 40`, early exit at `redemptionBuffer`; `test_redemptionWalkIsBounded` and the two redemption-trigger fork tests |

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | Low | **The redemption trigger counts what is ahead from the back of `SortedTroves`, not exactly as a redemption would.** It skips troves under MCR and subtracts the 200 MUSD gas compensation like `redeemCollateral`, but ignores redemption fees and partial redemptions. The count is a little high or low near the boundary. | Accepted. `redemptionBuffer` is a margin, not an exact amount; borrowers should set it well above the size of a typical redemption. |
| 2 | Low | **A trove more than 40 troves from the back never triggers on redemption**, even if those 40 troves hold less debt than the buffer. | Accepted. The bound keeps `protect` and `status` cheap. |
| 3 | Low | **Anyone can call `protect` as soon as the redemption trigger holds**, and the trigger can change because other borrowers repay or close. Rungs may then be spent earlier than the borrower expected. | Accepted. Spent rungs still land in the borrower's own trove; the cost is the tips. Same model as the ICR trigger in v2. |
| 4 | Low | **A first rung whose repayment would breach `minNetDebt` reverts the whole call**, while later rungs that would do so end the loop quietly. | Accepted. `status().protectable` is false in that case, so the keeper does not send; `test_rungUnderMinNetDebtStopsTheLoopInsteadOfRevertingIt` covers the later-rung case. |
| 5 | Info | **The trigger is evaluated once per call.** Later rungs run until `targetICR` even when ICR has already crossed the trigger. | By design: the target is what the borrower asked for. |
| 6 | Info | **`storePermits` overwrites rungs at the same nonce.** | By design: it lets a borrower replace a rung; only the borrower can write their own ladder. |
| 7 | Info | **`_guarded` only grows.** Cancelled borrowers stay in `guardedSlice`, so a keeper scan gets slower over time. | Accepted. The keeper reads the list with one `guardedSlice` call and keeps only `protectable` borrowers; paging is a small change if the list ever outgrows one `eth_call`. |
| 8 | Info | **`keeperTip` has no upper bound.** | Accepted. It only spends the borrower's own reserve: `_take` debits rung plus tip and reverts with `InsufficientReserve` when the reserve is short. |
| 9 | Info | **Zero hints are expensive.** With `upperHint = lowerHint = 0`, `SortedTroves` walks the list for each rung, and five rungs can exceed a block's gas on a long queue. | The keeper computes hints for the trove's final position with `HintHelpers.getApproxHint` and `findInsertPosition`. The fuzz and invariant tests pass zero hints with gas metering paused, because they check amounts, not gas. |

Slither's two High and one Medium results are false positives; the reasoning is in [static-analysis.md](security/static-analysis.md#troveguard-v3).

## Tests

```sh
anvil --fork-url https://rpc.test.mezo.org --chain-id 31611 &
forge test --fork-url http://127.0.0.1:8545 --match-contract TroveGuardV3   # 11 fork tests, 2 fuzz tests, 4 invariants
MEZO_FORK_RPC=http://127.0.0.1:8545 node --test test/guard-fork.test.mjs   # keeper spends several rungs in one call
```
