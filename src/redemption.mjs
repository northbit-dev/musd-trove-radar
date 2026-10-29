// Redemption queue for MUSD, mirroring TroveManager.redeemCollateral (mezo-org/musd):
//  * redemption walks SortedTroves from the tail (lowest nominal CR = coll·1e20 / principal) upwards,
//  * troves with ICR < MCR are skipped,
//  * each trove gives up at most (total debt − 200 MUSD gas compensation),
//  * redemption is only possible while TCR ≥ MCR.
// Partial-redemption cancellation (min net debt / stale hints) and fees are ignored here.
import { MAX_ICR } from './math.mjs';

export const NICR_PRECISION = 10n ** 20n;
export const MUSD_GAS_COMPENSATION = 200n * 10n ** 18n;

/** Nominal CR used to order SortedTroves. Mirrors LiquityMath._computeNominalCR. */
export function nicr(coll, principal) {
  return principal === 0n ? MAX_ICR : (coll * NICR_PRECISION) / principal;
}

/** MUSD a single trove can absorb before it is closed by redemption. */
export const redeemable = (t) => (t.debt > MUSD_GAS_COMPENSATION ? t.debt - MUSD_GAS_COMPENSATION : 0n);

/**
 * Ordered redemption queue. Each entry carries `ahead`: MUSD that must be
 * redeemed before this trove is touched, and `through`: MUSD needed to fully
 * redeem it (and close it).
 */
export function redemptionQueue(troves, { mcr }) {
  const order = troves
    .map((t) => ({ ...t, nicr: t.nicr ?? nicr(t.coll, t.principal ?? t.debt) }))
    .sort((a, b) => (a.nicr < b.nicr ? -1 : a.nicr > b.nicr ? 1 : 0));
  const queue = [];
  const skipped = [];
  let cum = 0n;
  for (const t of order) {
    if (t.icr < mcr) { skipped.push(t); continue; }
    const r = redeemable(t);
    queue.push({ ...t, position: queue.length + 1, redeemable: r, ahead: cum, through: cum + r });
    cum += r;
  }
  return { queue, skipped, totalRedeemable: cum };
}

/**
 * Which troves a redemption of `amount` MUSD would hit, and how much from each.
 * Returns [{owner, musd, coll, closes}] where coll is BTC paid out at `price`.
 */
export function simulateRedemption(queue, amount, price) {
  const hits = [];
  let left = amount;
  for (const t of queue) {
    if (left <= 0n) break;
    const lot = left < t.redeemable ? left : t.redeemable;
    if (lot === 0n) continue;
    hits.push({ owner: t.owner, musd: lot, coll: (lot * 10n ** 18n) / price, closes: lot === t.redeemable });
    left -= lot;
  }
  return { hits, unfilled: left };
}

/** Summary for the report: the front of the queue and redemption depth bands. */
export function redemptionSummary(troves, sys, { top = 15, bands = [10_000, 50_000, 100_000, 500_000] } = {}) {
  const { queue, skipped, totalRedeemable } = redemptionQueue(troves, sys);
  const E = (n) => BigInt(n) * 10n ** 18n;
  return {
    enabled: sys.coll * sys.price >= sys.mcr * sys.debt, // TCR >= MCR
    totalRedeemable,
    skippedBelowMcr: skipped.length,
    front: queue.slice(0, top),
    depth: bands.map((b) => {
      const sim = simulateRedemption(queue, E(b), sys.price);
      return { musd: E(b), troves: sim.hits.length, closed: sim.hits.filter((h) => h.closes).length };
    }),
    queue, // full queue (used by borrower lookups / alerts)
  };
}

/** Position of one owner in the queue, or null. */
export function queuePosition(summary, owner) {
  const o = owner.toLowerCase();
  return summary.queue.find((t) => t.owner.toLowerCase() === o) ?? null;
}
