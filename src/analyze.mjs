import { redemptionSummary } from './redemption.mjs';
import { bucketize, stress, byRisk, recoveryTriggerPrice, dropTo, icr, ONE } from './math.mjs';

/** Turn raw chain state into the radar report object (pure, testable). */
export function analyze(sys, troves, { top = 15 } = {}) {
  const ranked = [...troves].sort(byRisk);
  const liquidatable = ranked.filter((t) => t.icr < sys.mcr);
  const atRisk = ranked.filter((t) => t.icr >= sys.mcr && t.icr < sys.ccr);
  const liqDebt = liquidatable.reduce((a, t) => a + t.debt, 0n);
  const tcr = icr(sys.coll, sys.debt, sys.price);
  const rmPrice = recoveryTriggerPrice(sys.coll, sys.debt, sys.ccr);
  const report = {
    network: 'Mezo Testnet', block: sys.blockNumber, timestamp: sys.timestamp,
    price: sys.price, mcr: sys.mcr, ccr: sys.ccr,
    system: {
      troves: troves.length, coll: sys.coll, debt: sys.debt, tcr,
      recoveryMode: tcr < sys.ccr, recoveryTriggerPrice: rmPrice, dropToRecovery: dropTo(sys.price, rmPrice),
      spDeposits: sys.spDeposits, spColl: sys.spColl ?? 0n, musdSupply: sys.musdSupply, interestRateBps: sys.interestRateBps,
      // Share of currently liquidatable debt the Stability Pool can absorb; the rest is redistributed.
      spCoverage: liqDebt === 0n ? null : Number((sys.spDeposits * 10_000n) / liqDebt) / 10_000,
    },
    liquidatable: { count: liquidatable.length, debt: liqDebt, troves: liquidatable.slice(0, top) },
    atRisk: { count: atRisk.length, debt: atRisk.reduce((a, t) => a + t.debt, 0n), troves: atRisk.slice(0, top) },
    riskiest: ranked.slice(0, top),
    buckets: bucketize(troves),
    stress: stress(troves, sys, sys.price, sys.mcr, sys.ccr),
  };
  const { queue, ...redemption } = redemptionSummary(troves, sys, { top });
  report.redemption = redemption;
  // Full data for lookups and alerts; non-enumerable so JSON snapshots stay small.
  Object.defineProperty(report, 'queue', { value: queue, enumerable: false });
  Object.defineProperty(report, 'troves', { value: troves, enumerable: false });
  return report;
}

/** Status for one borrower, with a traffic-light level used by `watch`. */
export function troveHealth(t, sys, { warn = 1.5, crit = 1.2 } = {}) {
  if (!t) return { level: 'none', msg: 'no active trove' };
  const r = Number((t.icr * 10_000n) / ONE) / 10_000;
  const level = t.icr < sys.mcr ? 'LIQUIDATABLE' : r < crit ? 'critical' : r < warn ? 'warning' : 'ok';
  return { level, icr: r, liqPrice: t.liqPrice, dropToLiq: dropTo(sys.price, t.liqPrice) };
}

/** BigInt-safe JSON. */
export const toJSON = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
