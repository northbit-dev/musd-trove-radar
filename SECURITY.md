# Security

> **TroveGuard is not audited, and it runs on Mezo Testnet only.** Do not deposit mainnet funds. The contract has no owner, no admin keys, no pause and no upgrade path. Whatever is deployed is final, so a bug cannot be patched in place.

## What the guard holds and where funds can go

The guard holds each borrower's BTC reserve, MUSD reserve and stored permits. Funds can leave it in only three ways:

1. **Into the borrower's own trove**, through `BorrowerOperationsSignatures.addCollWithSignature` or `repayMUSDWithSignature`. MUSD verifies the borrower's EIP-712 signature, and the trove credited is always the signer's.
2. **As the fixed BTC tip to `msg.sender` of `protect`.** The borrower chose the tip in `configure`.
3. **Back to the borrower**, through `withdraw`, `withdrawMUSD` or `cancel`, which always pay `msg.sender` from `msg.sender`'s own reserve.

The guard makes no arbitrary calls, holds no token approvals, and takes no caller-supplied calldata. The hints are forwarded to `SortedTroves`, which validates them.

## Threat model

| Threat | What happens | Why it is acceptable / mitigation |
| --- | --- | --- |
| **Stolen or leaked signature** | Permits are stored on chain, so everybody can read them, and the signature does not bind the caller. Anyone can submit a rung straight to `BorrowerOperationsSignatures`. | The signed operation can only **help** the signer. For `AddColl`, the submitter has to send exactly `amount` of their own BTC into the borrower's trove. For `RepayMUSD`, MUSD burns the repayment from the submitter's balance. The attacker loses money, the borrower gains collateral or loses debt, and one nonce is used up. Because permits are keyed by nonce, the next rung lines up on its own (`test_ladderSurvivesExternalNonceUse`). A signature for a different borrower, or one used with the wrong kind, fails MUSD's check (`test_foreignSignatureCannotMoveFunds`, `test_kindCannotBeSwapped`). |
| **Front-running `protect`** | Keepers race for the tip, and the fastest one wins. | The borrower pays one tip per rung no matter who wins. The losing transaction reverts (the permit for that nonce is gone, or the ICR is now healthy) and moves no funds. |
| **Front-running with a direct MUSD call** | Someone submits the current rung directly before `protect`. | Same as a leaked signature: the borrower is helped at the attacker's cost, `protect` reverts with `NoPermit`, and the next dip uses the next rung. |
| **Oracle manipulation or staleness** | `protect` trusts `PriceFeed.fetchPrice()`, the same feed MUSD uses for liquidations. | A falsely low price can trigger a rung early. The rung's BTC or MUSD still goes into the borrower's own trove, so it is not lost; only the tip is spent. A falsely high price can delay protection, but then MUSD's own liquidation logic sees that same high price. The guard cannot be more wrong than MUSD itself. |
| **Nonce consumption** | Every `*WithSignature` call shares one nonce per borrower, and so does any other app the borrower signs for. | `protect` always reads `getNonce()` and uses the rung stored for that nonce. Rungs for nonces already spent become dead weight, not a risk. `storePermits` rejects nonces below the current one (`test_storePermitsRejectsStaleNonce`). If the ladder runs out, `protect` reverts with `NoPermit`, and the borrower should store more rungs. |
| **Reentrancy** | A keeper contract re-enters from the tip transfer, or the MUSD token re-enters. | `protect`, `withdraw`, `withdrawMUSD`, `depositMUSD` and `cancel` are `nonReentrant`. State (reserves, deleted permit) is written before any external call, and the tip is sent last (`test_blocksReentrantKeeper`). |
| **Replay** | The same permit is used twice. | MUSD increments the nonce on success, the guard deletes the permit before calling out, and `cancel` bumps a generation counter that orphans every stored permit (`test_permitIsSingleUse`, the `invariant_noUsablePermitAfterCancel` invariant). |
| **Draining another borrower** | One borrower's `protect` spends another borrower's reserve. | Reserves are per borrower and are debited before the call. The invariants check that the sum of reserves always equals the guard's BTC and MUSD balances. The fuzz test checks the exact amounts on every successful `protect`. |
| **Griefing by tip size** | A borrower sets an absurd tip. | That only spends the borrower's own reserve. If the reserve can't cover the tip, `protect` reverts. |

## What the guard does **not** protect against

* **No keeper running.** Protection only happens if someone calls `protect`. The radar's keeper does, but nothing guarantees uptime.
* **Price falling faster than a keeper can act.** A crash past the liquidation threshold within one block, or before any keeper reacts, liquidates the trove anyway.
* **An empty or too-small reserve, an empty ladder, or expired deadlines.** `status()` shows all of these. The CLI `guard` command prints them too.
* **Rungs that are too small.** If one rung doesn't lift ICR above MCR, the trove can still be liquidated between rungs.
* **Redemptions and redistributions.** The guard doesn't stop a redemption against your trove, and it doesn't stop debt being redistributed onto it. Repay mode moves the trove back in the redemption queue, but only after ICR has already dropped below the trigger.
* **Repay rungs that would breach the minimum net debt.** MUSD rejects a repayment that would take net debt below 1,800 MUSD, so that rung reverts.
* **Bugs in MUSD itself, or in this contract.** It is not audited.

## Verification

* 14 fork unit tests, 3 fuzz tests and 3 handler-based invariants run against real Mezo Testnet contracts on an anvil fork (`forge test --fork-url http://127.0.0.1:8545`).
* Slither: see [docs/security/static-analysis.md](docs/security/static-analysis.md). There are no High or Medium findings, and each of the remaining findings is justified.
* CI (`.github/workflows/contracts.yml`) builds the contract, runs the suite against a fork when the RPC is reachable, and reports gas.

## Reporting

This is a hackathon project on testnet. Please open a GitHub issue for anything you find. No bounty is offered.
