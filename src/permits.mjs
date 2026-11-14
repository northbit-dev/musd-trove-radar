// Pure TroveGuard permit helpers, shared by Node and the browser bundle (no fs, no env).

/** TroveGuard.Kind: the BorrowerOperationsSignatures call a permit authorises. Adjust exists from v3 on. */
export const KIND = { AddColl: 0, RepayMUSD: 1, Adjust: 2 };
const NAMES = ['AddColl', 'RepayMUSD', 'Adjust'];
export const kindName = (k) => NAMES[Number(k)] ?? 'AddColl';

/** TroveGuard v3 Reason for a protect: below the trigger, or too little redeemable MUSD ahead. */
export const REASON = { None: 0, LowICR: 1, RedemptionFront: 2 };
export const reasonName = (r) => ['none', 'low ICR', 'redemption front'][Number(r)] ?? 'none';

const TYPES = {
  AddColl: [
    { name: 'assetAmount', type: 'uint256' }, { name: 'borrower', type: 'address' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
  RepayMUSD: [
    { name: 'amount', type: 'uint256' }, { name: 'borrower', type: 'address' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
  AdjustTrove: [
    { name: 'collWithdrawal', type: 'uint256' }, { name: 'debtChange', type: 'uint256' },
    { name: 'isDebtIncrease', type: 'bool' }, { name: 'assetAmount', type: 'uint256' },
    { name: 'borrower', type: 'address' }, { name: 'recipient', type: 'address' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
};

/** BTC and MUSD a rung moves. v2 rungs carry one `amount`, v3 rungs carry `btc` and `musd`. */
export function rungAmounts({ kind, amount, btc, musd }) {
  if (btc != null || musd != null) return { btc: btc ?? 0n, musd: musd ?? 0n };
  return Number(kind) === KIND.RepayMUSD ? { btc: 0n, musd: amount ?? 0n } : { btc: amount ?? 0n, musd: 0n };
}

/** EIP-712 request for one rung, signed against BorrowerOperationsSignatures. */
export function permitTypedData({ kind, borrower, nonce, deadline, chainId, verifyingContract, ...amounts }) {
  const { btc, musd } = rungAmounts({ kind, ...amounts });
  const domain = { name: 'BorrowerOperationsSignatures', version: '1', chainId, verifyingContract };
  const k = Number(kind);
  // TroveGuard v3 executes Adjust as adjustTroveWithSignature(0, musd, false, …, borrower, borrower, …).
  const [primaryType, message] = k === KIND.Adjust
    ? ['AdjustTrove', { collWithdrawal: 0n, debtChange: musd, isDebtIncrease: false, assetAmount: btc, borrower, recipient: borrower, nonce, deadline }]
    : k === KIND.RepayMUSD
      ? ['RepayMUSD', { amount: musd, borrower, nonce, deadline }]
      : ['AddColl', { assetAmount: btc, borrower, nonce, deadline }];
  return { domain, types: { [primaryType]: TYPES[primaryType] }, primaryType, message };
}

/** The struct storePermits takes: v2 Permit(kind, amount, deadline, signature), v3 Permit(kind, deadline, btc, musd, signature). */
export function toPermit(rung, deadline, signature, version = 2) {
  const { btc, musd } = rungAmounts(rung);
  const kind = Number(rung.kind);
  if (version >= 3) return { kind, deadline, btc, musd, signature };
  if (kind === KIND.Adjust) throw new Error('Adjust rungs need TroveGuard v3');
  return { kind, amount: kind === KIND.RepayMUSD ? musd : btc, deadline, signature };
}

/**
 * status() per version. v1 returns six fields, v2 eight, v3 one Status struct (trigger lives in configs()).
 * Every shape is normalised to { protectable, reason, icr, nonce, kind, btc, musd, amount, reserve, musdReserve }.
 */
export function parseStatus(borrower, result) {
  if (!Array.isArray(result)) {
    const { protectable, reason, icr, musdAhead, nonce, next, reserve, musdReserve } = result;
    const has = Boolean(next?.signature && next.signature !== '0x');
    const kind = has ? Number(next.kind) : KIND.AddColl;
    const btc = has ? next.btc : 0n, musd = has ? next.musd : 0n;
    return { borrower, version: 3, protectable, reason: Number(reason), icr, musdAhead, nonce, kind, btc, musd, amount: has ? btc || musd : 0n, deadline: has ? next.deadline : 0n, reserve, musdReserve };
  }
  if (result.length === 6) {
    const [protectable, icr, trigger, nonce, amount, reserve] = result;
    return { borrower, version: 1, protectable, reason: protectable ? REASON.LowICR : REASON.None, icr, trigger, nonce, kind: KIND.AddColl, amount, ...rungAmounts({ kind: 0, amount }), reserve, musdReserve: 0n };
  }
  const [protectable, icr, trigger, nonce, kind, amount, reserve, musdReserve] = result;
  return { borrower, version: 2, protectable, reason: protectable ? REASON.LowICR : REASON.None, icr, trigger, nonce, kind: Number(kind), amount, ...rungAmounts({ kind, amount }), reserve, musdReserve };
}

/** configs(): v2 (trigger, tip, generation, active), v3 (trigger, tip, targetICR, redemptionBuffer, generation, maxRungs, active). */
export function parseConfig(result) {
  if (result.length === 7) {
    const [trigger, tip, targetICR, redemptionBuffer, generation, maxRungs, active] = result;
    return { trigger, tip, targetICR, redemptionBuffer, generation, maxRungs: Number(maxRungs), active };
  }
  const [trigger, tip, generation, active] = result;
  return { trigger, tip, targetICR: 0n, redemptionBuffer: 0n, generation, maxRungs: 1, active };
}

/** One guarded borrower from multicall results of status() and configs(); v3 status has no trigger, configs does. */
export function guardRow(borrower, st, cfg) {
  if (st.status !== 'success') return { borrower, protectable: false, error: st.error?.shortMessage || 'status() failed' };
  const s = parseStatus(borrower, st.result);
  if (cfg?.status !== 'success') return { ...s, active: null, tip: null };
  const c = parseConfig(cfg.result);
  return { ...s, trigger: s.trigger ?? c.trigger, active: Boolean(c.active), tip: c.tip, targetICR: c.targetICR, redemptionBuffer: c.redemptionBuffer, maxRungs: c.maxRungs };
}

const fmtBtc = (v) => (Number(v) / 1e18).toFixed(6);
const fmtMusd = (v) => (Number(v) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 2 });

/** "AddColl 0.002000 BTC", "RepayMUSD 100 MUSD" or "Adjust +0.004000 BTC −150 MUSD". */
export function describeRung(rung) {
  const { btc, musd } = rungAmounts(rung);
  const k = Number(rung.kind);
  if (k === KIND.Adjust) return `Adjust +${fmtBtc(btc)} BTC −${fmtMusd(musd)} MUSD`;
  return k === KIND.RepayMUSD ? `RepayMUSD ${fmtMusd(musd)} MUSD` : `AddColl ${fmtBtc(btc)} BTC`;
}

/** One rung of a given kind from the form's per-kind amounts. */
export function stepOf(kind, { btcAmount = 0n, musdAmount = 0n }) {
  const k = Number(kind);
  return { kind: k, btc: k === KIND.RepayMUSD ? 0n : btcAmount, musd: k === KIND.AddColl ? 0n : musdAmount };
}

/** A ladder from an explicit list of kinds, e.g. [Adjust, RepayMUSD, AddColl]. */
export const buildSteps = (kinds, amounts) => kinds.map((k) => stepOf(k, amounts));

/** `count` rungs starting with `first`, alternating between AddColl and RepayMUSD if `alternate`. */
export function ladderRungs({ count, first, alternate, btcAmount, musdAmount }) {
  const other = Number(first) === KIND.RepayMUSD ? KIND.AddColl : KIND.RepayMUSD;
  return buildSteps(Array.from({ length: count }, (_, i) => (alternate && i % 2 ? other : Number(first))), { btcAmount, musdAmount });
}

/** "adjust:0.004/150,repay:100,add:0.002" → rungs (BTC and MUSD in ether units). */
export function parseSteps(spec, parseUnits18) {
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [k, v = ''] = s.split(':');
    const [a, b] = v.split('/');
    if (k === 'add') return stepOf(KIND.AddColl, { btcAmount: parseUnits18(a) });
    if (k === 'repay') return stepOf(KIND.RepayMUSD, { musdAmount: parseUnits18(a) });
    if (k === 'adjust') return stepOf(KIND.Adjust, { btcAmount: parseUnits18(a), musdAmount: parseUnits18(b ?? '') });
    throw new Error(`unknown rung "${s}" (use add:BTC, repay:MUSD or adjust:BTC/MUSD)`);
  });
}

export const malformed = (r) => {
  const { btc, musd } = rungAmounts(r);
  const k = Number(r.kind);
  return k === KIND.AddColl ? !(btc > 0n && musd === 0n) : k === KIND.RepayMUSD ? !(musd > 0n && btc === 0n) : !(btc > 0n && musd > 0n);
};

/** BTC the reserve needs to cover every rung's BTC plus a tip per rung. */
export const reserveNeeded = (rungs, tip) => rungs.reduce((s, r) => s + tip + rungAmounts(r).btc, 0n);
export const musdNeeded = (rungs) => rungs.reduce((s, r) => s + rungAmounts(r).musd, 0n);

const MIN_NET_DEBT = 1800n * 10n ** 18n, GAS_COMPENSATION = 200n * 10n ** 18n;

/** Index of the first rung whose repayment would push net debt (debt − 200 MUSD gas reserve) under 1,800 MUSD, else −1; BorrowerOperations reverts it. */
export function debtFloorRung({ debt }, rungs) {
  for (let i = 0; i < rungs.length; i++) {
    debt -= rungAmounts(rungs[i]).musd;
    if (debt - GAS_COMPENSATION < MIN_NET_DEBT) return i;
  }
  return -1;
}

/** Estimated ICR after each rung, from the trove's coll and debt at `price` (repayment lowers debt). */
export function icrPath({ coll, debt, price }, rungs) {
  const out = [];
  for (const r of rungs) {
    const { btc, musd } = rungAmounts(r);
    coll += btc;
    debt = debt > musd ? debt - musd : 0n;
    out.push(debt ? (coll * price) / debt : 0n);
  }
  return out;
}

/**
 * Rungs one v3 protect spends: always the first, then more while ICR is under the target, at most maxRungs.
 * targetICR 0 means one rung per call (v2 behaviour).
 */
export function rungsPerCall(path, { targetICR = 0n, maxRungs = 1 }) {
  if (!path.length) return 0;
  let n = 1;
  while (n < Math.min(maxRungs, path.length) && targetICR && path[n - 1] < targetICR) n++;
  return n;
}
