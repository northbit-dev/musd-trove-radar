import { createWalletClient, http } from 'viem';
import { mezoTestnet } from './chain.mjs';
import { NETWORK, C, GUARD } from './config.mjs';
import { KIND, permitTypedData as typedData, describeRung, parseStatus } from './permits.mjs';

const TM = C.troveManager, BOS = C.borrowerOperationsSignatures;

export function guardAt(address = process.env.TROVE_GUARD || GUARD?.address) {
  if (!address) throw new Error('no TroveGuard address (deploy first or set TROVE_GUARD)');
  return { address, abi: GUARD.abi };
}

export { KIND, kindName, describeRung, parseStatus } from './permits.mjs';

/** The EIP-712 request a borrower signs for one rung; also used by the browser UI. */
export const permitTypedData = (p) => typedData({ chainId: NETWORK.chainId, verifyingContract: BOS.address, ...p });

/**
 * Sign a ladder of permits for consecutive nonces. `rungs` is a list of { kind, amount };
 * AddColl amounts are BTC wei, RepayMUSD amounts are MUSD wei. Both kinds share the borrower's nonce.
 */
export async function signLadder(account, { firstNonce, rungs, deadline }) {
  const permits = [];
  for (let i = 0; i < rungs.length; i++) {
    const { kind, amount } = rungs[i];
    const signature = await account.signTypedData(permitTypedData({ kind, amount, borrower: account.address, nonce: firstNonce + BigInt(i), deadline }));
    permits.push({ kind, amount, deadline, signature });
  }
  return permits;
}

/** v1 helper: `rungs` identical AddColl permits. */
export async function signAddCollLadder(account, { firstNonce, rungs, amount, deadline }) {
  return signLadder(account, { firstNonce, deadline, rungs: Array.from({ length: rungs }, () => ({ kind: KIND.AddColl, amount })) });
}

/** Every guarded borrower with its on-chain status(); `protectable` ones are keeper targets. */
export async function guardTargets(pc, guard = guardAt()) {
  const n = await pc.readContract({ ...guard, functionName: 'guardedCount' });
  const borrowers = n ? await pc.readContract({ ...guard, functionName: 'guardedSlice', args: [0n, n] }) : [];
  if (!borrowers.length) return [];
  const res = await pc.multicall({ allowFailure: true, contracts: borrowers.map((b) => ({ ...guard, functionName: 'status', args: [b] })) });
  return borrowers.map((borrower, i) => {
    if (res[i].status !== 'success') return { borrower, protectable: false, error: res[i].error?.shortMessage };
    return parseStatus(borrower, res[i].result);
  });
}

/** NICR = coll / principal, so a top-up scales it by coll and a repayment by principal. */
export function nicrAfter({ nicr, coll, principal }, kind, amount) {
  if (Number(kind) === KIND.RepayMUSD) return principal > amount ? (nicr * principal) / (principal - amount) : nicr;
  return coll ? (nicr * (coll + amount)) / coll : nicr;
}

/** Insert hints for the trove's position after the next permit (`kind`, `amount`). */
export async function protectHints(pc, borrower, amount, kind = KIND.AddColl) {
  const read = (functionName, args) => pc.readContract({ address: TM.address, abi: TM.abi, functionName, args });
  const [nicr, coll, principal, count] = await Promise.all([
    read('getNominalICR', [borrower]), read('getTroveColl', [borrower]), read('getTrovePrincipal', [borrower]), read('getTroveOwnersCount'),
  ]);
  const newNicr = nicrAfter({ nicr, coll, principal }, kind, amount);
  const trials = BigInt(Math.ceil(15 * Math.sqrt(Number(count) || 1)));
  const [approx] = await pc.readContract({ address: C.hintHelpers.address, abi: C.hintHelpers.abi, functionName: 'getApproxHint', args: [newNicr, trials, 42n] });
  return pc.readContract({ address: C.sortedTroves.address, abi: C.sortedTroves.abi, functionName: 'findInsertPosition', args: [newNicr, approx, approx] });
}

// Mezo's public RPC is load-balanced; a send right after a state change can hit a lagging node.
async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 4000)); }
  }
}

/** Protect keeper: dry-runs protect() for each target and only broadcasts with send=true on Mezo Testnet. */
export async function runProtectKeeper(pc, account, { send = false, guard = guardAt(), log = console.log } = {}) {
  const targets = (await guardTargets(pc, guard)).filter((t) => t.protectable);
  if (!targets.length) { log('protect: no guarded trove below its trigger'); return []; }
  const from = account?.address || '0x000000000000000000000000000000000000dEaD';
  const out = [];
  for (const t of targets) {
    const [upper, lower] = await protectHints(pc, t.borrower, t.amount, t.kind);
    let request;
    try {
      ({ request } = await pc.simulateContract({ account: account || from, ...guard, functionName: 'protect', args: [t.borrower, upper, lower] }));
    } catch (e) {
      log(`protect ${t.borrower}: dry-run REVERT ${e.shortMessage || e.message}`);
      out.push({ ...t, ok: false });
      continue;
    }
    log(`protect ${t.borrower}: ICR ${(Number(t.icr) / 1e16).toFixed(2)} % < ${(Number(t.trigger) / 1e16).toFixed(2)} %, nonce ${t.nonce}, ${describeRung(t)}, dry-run OK`);
    if (!send) { out.push({ ...t, ok: true, tx: null }); continue; }
    if (!account) throw new Error('no testnet key loaded');
    if ((await pc.getChainId()) !== NETWORK.chainId) throw new Error('refusing to send: not Mezo Testnet');
    const wc = createWalletClient({ account, chain: mezoTestnet, transport: http(NETWORK.rpc) });
    const hash = await withRetry(() => wc.writeContract(request));
    const rc = await pc.waitForTransactionReceipt({ hash });
    log(`protect ${t.borrower}: tx ${NETWORK.explorer}/tx/${hash} status=${rc.status}`);
    out.push({ ...t, ok: rc.status === 'success', tx: hash });
  }
  return out;
}
