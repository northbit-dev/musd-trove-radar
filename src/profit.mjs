const ONE = 10n ** 18n;
export const MUSD_GAS_COMPENSATION = 200n * ONE;
export const COLL_GAS_DIVISOR = 200n;

/** What TroveManager pays the liquidator for one trove: 200 MUSD from the gas pool plus 0.5 % of its collateral. */
export const liquidationReward = ({ coll }) => ({ musd: MUSD_GAS_COMPENSATION, btc: coll / COLL_GAS_DIVISOR });

/**
 * Everything in MUSD wei at `price` (MUSD per BTC, 1e18). `gas` is the estimate for the tx, `gasPrice` in BTC wei.
 * The keeper only sends when profit >= minProfit.
 */
export function profitOf({ musd = 0n, btc = 0n, gas, gasPrice, price, minProfit = 0n }) {
  const reward = musd + (btc * price) / ONE;
  const cost = gas == null ? null : (gas * gasPrice * price) / ONE;
  const profit = cost == null ? null : reward - cost;
  const ok = profit != null && profit >= minProfit;
  const reason = cost == null ? 'no gas estimate' : ok ? null : `unprofitable: reward ${fmtMusd(reward)} MUSD − gas ${fmtMusd(cost)} MUSD < min ${fmtMusd(minProfit)} MUSD`;
  return { reward, cost, profit, ok, reason };
}

export const liquidationProfit = (trove, o) => profitOf({ ...liquidationReward(trove), ...o });
export const protectProfit = ({ tip }, o) => profitOf({ btc: tip ?? 0n, ...o });

export const toWei = (s) => {
  const [i, f = ''] = String(s).split('.');
  return BigInt(i || 0) * ONE + BigInt((f + '0'.repeat(18)).slice(0, 18));
};
export const fmtMusd = (v) => {
  if (v == null) return '?';
  const x = Number(v) / 1e18;
  return x !== 0 && Math.abs(x) < 0.001 ? x.toPrecision(2) : x.toFixed(4);
};
