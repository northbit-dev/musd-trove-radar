# Static analysis

**Tool:** Slither 0.11.6 (102 detectors), solc 0.8.24, optimizer 10000 runs, EVM `paris`. The settings match `foundry.toml`.
**Target:** `contracts/TroveGuard.sol` (v2). Dependencies are excluded; the contract has none besides the MUSD interfaces it declares.
**Date:** 2026-10-30

```sh
python3 -m venv .venv && .venv/bin/pip install slither-analyzer solc-select
.venv/bin/solc-select install 0.8.24 && .venv/bin/solc-select use 0.8.24
PATH=.venv/bin:$PATH slither contracts/TroveGuard.sol --compile-force-framework solc --exclude-dependencies
```

Slither reported 5 results. None is High or Medium impact. Each one is a pattern the design needs, so all five are justified rather than changed:

| # | Detector | Location | Verdict |
| --- | --- | --- | --- |
| 1 | `arbitrary-send-eth` | `_send(to, amount)` | **Justified.** `_send` has exactly three callers. `withdraw` and `cancel` send only the caller's own reserve, to `msg.sender`. `protect` sends the borrower's configured tip to `msg.sender`, the keeper. The recipient is never a parameter. The amount is always subtracted from the right reserve before the call. The fuzz test `testFuzz_protectNeverOverspendsOrMisroutes` checks that the keeper receives exactly the tip and that the borrower's EOA is never touched. |
| 2 | `timestamp` | `protect`: `block.timestamp > p.deadline` | **Justified.** The deadline is part of the borrower's MUSD signature, and MUSD checks it the same way. Deadlines are hours or days out, so a validator's few seconds of timestamp drift don't matter. |
| 3 | `timestamp` | `status`: `block.timestamp <= p.deadline` | **Justified.** This is a view that mirrors `protect`, for keepers. |
| 4 | `cyclomatic-complexity` | `protect` (13) | **Accepted.** Every branch is one precondition with its own custom error: inactive guard, inactive trove, healthy trove, missing permit, expired permit, BTC reserve, MUSD reserve, kind, ICR not improved. Splitting them into helpers would make the checks-effects-interactions order harder to audit. All of these branches are covered by `test_failureModes`, the repay tests and the fuzz test. |
| 5 | `low-level-calls` | `_send`: `to.call{value: amount}("")` | **Justified.** BTC is Mezo's native coin. `call` is how you send it without the 2300-gas limit of `transfer`, which would break smart-contract wallets. The return value is checked (`TransferFailed`). Every function that reaches `_send` is `nonReentrant` and updates state before the call. `test_blocksReentrantKeeper` checks a keeper that tries to re-enter. |

Slither found no reentrancy, unchecked-transfer, uninitialised-state, shadowing, missing-zero-check, `tx.origin`, `delegatecall` or `selfdestruct` issues. The two MUSD `transfer`/`transferFrom` calls check their return value.

## Beyond Slither

`forge test --fork-url …` runs these checks against real forked MUSD contracts:

* **Fuzz** (`contracts/test/TroveGuard.fuzz.t.sol`, 64 runs each):
  * The test generates an arbitrary trigger, tip, kind, amount, BTC and MUSD reserves, deadline, time warp and price. Whenever `protect` succeeds, the guard's BTC drops by exactly `amount + tip` (AddColl) or `tip` (Repay), and never by more than the reserve. The trove gains exactly `amount` collateral, or loses exactly `amount` of debt, and the keeper gains exactly the tip. The borrower's wallet doesn't move, and `status()` agreed beforehand. Whenever it reverts, nothing moves.
  * `configure` accepts exactly the triggers 110 %–1000 %.
  * A random caller can neither withdraw nor cancel someone else's reserves.
* **Invariants** (`contracts/test/TroveGuard.invariant.t.sol`, 16 runs × 25 calls):
  * A handler drives three borrowers with real troves through `configure`, `deposit`, `depositMUSD`, `withdraw`, `withdrawMUSD`, mixed `storePermits`, `cancel`, price moves and keeper `protect`.
  * After every call these hold:
    * The sum of BTC reserves equals the guard's balance.
    * The sum of MUSD reserves equals the guard's MUSD balance.
    * After `cancel`, no stored permit is usable, `status()` is not protectable, and no `protect` succeeds.

## TroveGuard v3

**Tool:** Slither 0.11.6 (102 detectors), the same solc and optimizer settings as above.
**Target:** `contracts/TroveGuardV3.sol`.
**Date:** 2026-11-12

```sh
PATH=.venv/bin:$PATH slither contracts/TroveGuardV3.sol --compile-force-framework solc \
  --solc-args "--optimize --optimize-runs 10000 --evm-version paris" --exclude-dependencies
```

Slither reported 20 results: 2 High, 1 Medium, 15 Low and 2 Informational. Nothing was changed in the contract. The three High and Medium results are false positives:

| # | Detector | Location | Verdict |
| --- | --- | --- | --- |
| 1 | `arbitrary-send-eth` (High) | `_send(to, amount)` | **False positive**, as for v2. The recipient is always `msg.sender`: the borrower in `withdraw` and `cancel`, the keeper for the tip in `protect`. The amount is always debited from the right reserve first. `testFuzz_protectMovesExactlyWhatTheSpentRungsSay` checks that the keeper gets exactly one tip per rung spent. |
| 2 | `reentrancy-eth` (High) | `protect`: the second and later `_spend` calls write `reserves`, `musdReserves` and `_permits` after the first call into `BorrowerOperationsSignatures` | **False positive.** The only external calls before those writes go to MUSD's own `BorrowerOperationsSignatures`, which is fixed at deploy time and does not call back into arbitrary addresses. `protect` is `nonReentrant`, and so are `withdraw`, `withdrawMUSD`, `depositMUSD` and `cancel`. A re-entrant `configure`, `deposit` or `storePermits` could only touch the caller's own entry, and the caller would be MUSD. Each rung is checked and debited in `_take` before its own external call. The keeper's tip, the only send to an untrusted address, goes last. The invariants check that reserves match balances after random sequences that include multi-rung `protect` calls. |
| 3 | `unused-return` (Medium) | `_ahead`: `getEntireDebtAndColl` | **False positive.** The collateral values are not needed; the redeemable debt is principal + interest + pending principal + pending interest minus the 200 MUSD gas compensation, as in `TroveManager.redeemCollateral`. |
| 4–14 | `calls-loop` (Low) | `_ahead` (via `protect`, `status` and `redemptionAhead`) and `_ready`/`_repayFits` (via the rung loop in `protect`) | **Justified.** The redemption walk is bounded by `MAX_WALK = 40` and stops at `redemptionBuffer`. The rung loop is bounded by `maxRungs ≤ 5`. Every callee is a MUSD view, so none of them can revert because of the guard's state. |
| 15–18 | `timestamp` (Low) | permit deadlines in `protect`, `status`, `_ready` and `_take` | **Justified**, as for v2. The deadline is part of the borrower's signature and MUSD checks it the same way. |
| 19 | `low-level-calls` (Informational) | `_send` | **Justified**, as for v2. |
| 20 | `naming-convention` (Informational) | `ITroveManagerV3.MCR()` | **Accepted.** The name is MUSD's own getter. |

### Fuzz and invariants for v3

* **Fuzz** (`contracts/test/TroveGuardV3.fuzz.t.sol`):
  * 48 runs: a five-rung ladder of random kinds (`AddColl`, `RepayMUSD`, `Adjust`) and amounts, a random tip, `maxRungs`, target ICR (or none), BTC and MUSD reserves, and a price that puts ICR between 112 % and the trigger. When `protect` succeeds, it spent between 1 and `maxRungs` rungs (exactly 1 without a target), the nonce moved by that many, the guard's BTC fell by exactly the BTC of those rungs plus one tip per rung, its MUSD fell by exactly their MUSD, the trove gained exactly that collateral, and ICR went up. If it stopped below the target with rungs to spare, the next rung was really not usable. When it reverts, nothing moved, and the first rung was really unfunded.
  * 64 runs: `configure` accepts exactly the triggers 110 %–1000 %, targets 0 or trigger–1000 %, and 1–5 rungs.
* **Invariants** (`contracts/test/TroveGuardV3.invariant.t.sol`, 16 runs × 25 calls): the v2 handler plus `Adjust` rungs, target ICR, redemption buffer and `maxRungs` in `configure`, ladders of up to five rungs, and a step that arms a borrower fully and calls `protect`, so multi-rung calls actually happen. After every call: the BTC and MUSD reserves add up to the guard's balances, no permit is usable after `cancel`, no call spent more than `maxRungs`, and the keeper holds exactly the tips it was paid.
