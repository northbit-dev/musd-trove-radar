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
