// Pure TroveGuard permit helpers, shared by Node and the browser bundle (no fs, no env).

/** TroveGuard.Kind: the BorrowerOperationsSignatures call a permit authorises. */
export const KIND = { AddColl: 0, RepayMUSD: 1 };
export const kindName = (k) => (Number(k) === KIND.RepayMUSD ? 'RepayMUSD' : 'AddColl');

const TYPES = {
  AddColl: [
    { name: 'assetAmount', type: 'uint256' }, { name: 'borrower', type: 'address' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
  RepayMUSD: [
    { name: 'amount', type: 'uint256' }, { name: 'borrower', type: 'address' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
};

/** EIP-712 request for one rung, signed against BorrowerOperationsSignatures. */
export function permitTypedData({ kind, amount, borrower, nonce, deadline, chainId, verifyingContract }) {
  const name = kindName(kind);
  const message = name === 'AddColl'
    ? { assetAmount: amount, borrower, nonce, deadline }
    : { amount, borrower, nonce, deadline };
  return {
    domain: { name: 'BorrowerOperationsSignatures', version: '1', chainId, verifyingContract },
    types: { [name]: TYPES[name] }, primaryType: name, message,
  };
}

/** status() of v2 returns kind and the MUSD reserve; the v1 deployment returns six fields and only knows AddColl. */
export function parseStatus(borrower, result) {
  if (result.length === 6) {
    const [protectable, icr, trigger, nonce, amount, reserve] = result;
    return { borrower, protectable, icr, trigger, nonce, kind: KIND.AddColl, amount, reserve, musdReserve: 0n };
  }
  const [protectable, icr, trigger, nonce, kind, amount, reserve, musdReserve] = result;
  return { borrower, protectable, icr, trigger, nonce, kind: Number(kind), amount, reserve, musdReserve };
}

/** "AddColl 0.002 BTC" or "RepayMUSD 100 MUSD". */
export function describeRung({ kind, amount }) {
  const repay = Number(kind) === KIND.RepayMUSD;
  const v = Number(amount) / 1e18;
  return `${kindName(kind)} ${repay ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toFixed(6)} ${repay ? 'MUSD' : 'BTC'}`;
}

/**
 * The rungs a ladder form describes: `count` rungs starting with `first`, alternating kinds if `alternate`.
 * Amounts are wei (BTC for AddColl, MUSD for RepayMUSD).
 */
export function ladderRungs({ count, first, alternate, btcAmount, musdAmount }) {
  return Array.from({ length: count }, (_, i) => {
    const kind = alternate && i % 2 ? 1 - first : first;
    return { kind, amount: kind === KIND.RepayMUSD ? musdAmount : btcAmount };
  });
}

/** BTC the reserve needs to cover every AddColl rung plus a tip per rung. */
export function reserveNeeded(rungs, tip) {
  return rungs.reduce((s, r) => s + tip + (r.kind === KIND.AddColl ? r.amount : 0n), 0n);
}
export const musdNeeded = (rungs) => rungs.reduce((s, r) => s + (r.kind === KIND.RepayMUSD ? r.amount : 0n), 0n);
