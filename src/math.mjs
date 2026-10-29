// Pure BigInt math for MUSD trove risk. All values are 1e18 fixed point
// (collateral in BTC wei, debt in MUSD wei, price in USD per BTC * 1e18).
export const ONE = 10n ** 18n;
export const MAX_ICR = 2n ** 256n - 1n;

/** Individual collateral ratio, 1e18 = 100 %. Mirrors LiquityMath._computeCR. */
export function icr(coll, debt, price) {
  if (debt === 0n) return MAX_ICR;
  return (coll * price) / debt;
}

/** BTC price at which a trove's ICR falls to `mcr` (liquidation price). */
export function liquidationPrice(coll, debt, mcr) {
  if (coll === 0n) return MAX_ICR;
  return (debt * mcr) / coll;
}

/** BTC price at which total collateral ratio hits CCR (Recovery Mode trigger). */
export function recoveryTriggerPrice(sysColl, sysDebt, ccr) {
  return liquidationPrice(sysColl, sysDebt, ccr);
}

/** Percent drop from `price` to `target` as a float (0.25 = 25 %). Negative = already below. */
export function dropTo(price, target) {
  if (price === 0n) return 0;
  return Number(((price - target) * 1_000_000n) / price) / 1_000_000;
}

/** ICR buckets for a histogram. Returns [{label, count, debt}] */
export const BUCKETS = [
  ['< 110 % (liquidatable)', 0n, 110n],
  ['110–130 %', 110n, 130n],
  ['130–150 %', 130n, 150n],
  ['150–200 %', 150n, 200n],
  ['200–300 %', 200n, 300n],
  ['≥ 300 %', 300n, null],
];
export function bucketize(troves) {
  const out = BUCKETS.map(([label]) => ({ label, count: 0, debt: 0n }));
  for (const t of troves) {
    const pct = (t.icr * 100n) / ONE;
    const i = BUCKETS.findIndex(([, lo, hi]) => pct >= lo && (hi === null || pct < hi));
    out[i].count++;
    out[i].debt += t.debt;
  }
  return out;
}

/**
 * Stress test: for each price shock, how many troves / how much debt would be
 * liquidatable (ICR < MCR), and would the system enter Recovery Mode (TCR < CCR).
 * `shocks` are fractional drops, e.g. [0.1, 0.2].
 */
export function stress(troves, sys, price, mcr, ccr, shocks = [0.05, 0.1, 0.2, 0.3, 0.5]) {
  return shocks.map((s) => {
    const p = (price * BigInt(Math.round((1 - s) * 1e6))) / 1_000_000n;
    let n = 0, debt = 0n, coll = 0n;
    for (const t of troves) {
      if (icr(t.coll, t.debt, p) < mcr) { n++; debt += t.debt; coll += t.coll; }
    }
    const tcr = icr(sys.coll, sys.debt, p);
    return { shock: s, price: p, liquidatable: n, debt, coll, tcr, recoveryMode: tcr < ccr };
  });
}

/** Rank troves riskiest first (lowest ICR). */
export const byRisk = (a, b) => (a.icr < b.icr ? -1 : a.icr > b.icr ? 1 : 0);

/** Human formatting helpers. */
export function fmt(x, dp = 2) {
  const neg = x < 0n; if (neg) x = -x;
  const s = (x * 10n ** BigInt(dp)) / ONE;
  const str = s.toString().padStart(dp + 1, '0');
  const int = str.slice(0, -dp || undefined).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + (dp ? `${int}.${str.slice(-dp)}` : int);
}
export const pct = (x, dp = 1) => (x === MAX_ICR ? '∞' : `${fmt(x * 100n, dp)} %`);
