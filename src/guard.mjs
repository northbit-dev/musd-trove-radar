import { createWalletClient, http } from 'viem';
import { mezoTestnet } from './chain.mjs';
import { NETWORK, C, GUARD } from './config.mjs';

const TM = C.troveManager, BOS = C.borrowerOperationsSignatures;

export function guardAt(address = process.env.TROVE_GUARD || GUARD?.address) {
  if (!address) throw new Error('no TroveGuard address (deploy first or set TROVE_GUARD)');
  return { address, abi: GUARD.abi };
}

/** EIP-712 AddColl permits for BorrowerOperationsSignatures, one per consecutive nonce. */
export async function signAddCollLadder(account, { firstNonce, rungs, amount, deadline }) {
  const permits = [];
  for (let i = 0; i < rungs; i++) {
    const signature = await account.signTypedData({
      domain: { name: 'BorrowerOperationsSignatures', version: '1', chainId: NETWORK.chainId, verifyingContract: BOS.address },
      types: { AddColl: [
        { name: 'assetAmount', type: 'uint256' },
        { name: 'borrower', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ] },
      primaryType: 'AddColl',
      message: { assetAmount: amount, borrower: account.address, nonce: firstNonce + BigInt(i), deadline },
    });
    permits.push({ amount, deadline, signature });
  }
  return permits;
}

/** Every guarded borrower with its on-chain status(); `protectable` ones are keeper targets. */
export async function guardTargets(pc, guard = guardAt()) {
  const n = await pc.readContract({ ...guard, functionName: 'guardedCount' });
  const borrowers = n ? await pc.readContract({ ...guard, functionName: 'guardedSlice', args: [0n, n] }) : [];
  if (!borrowers.length) return [];
  const res = await pc.multicall({ allowFailure: true, contracts: borrowers.map((b) => ({ ...guard, functionName: 'status', args: [b] })) });
  return borrowers.map((borrower, i) => {
    if (res[i].status !== 'success') return { borrower, protectable: false, error: res[i].error?.shortMessage };
    const [protectable, icr, trigger, nonce, amount, reserve] = res[i].result;
    return { borrower, protectable, icr, trigger, nonce, amount, reserve };
  });
}

/** Insert hints for the trove's position after adding `amount` collateral. */
export async function protectHints(pc, borrower, amount) {
  const [nicr, coll, count] = await Promise.all([
    pc.readContract({ address: TM.address, abi: TM.abi, functionName: 'getNominalICR', args: [borrower] }),
    pc.readContract({ address: TM.address, abi: TM.abi, functionName: 'getTroveColl', args: [borrower] }),
    pc.readContract({ address: TM.address, abi: TM.abi, functionName: 'getTroveOwnersCount' }),
  ]);
  const newNicr = coll ? (nicr * (coll + amount)) / coll : nicr;
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
    const [upper, lower] = await protectHints(pc, t.borrower, t.amount);
    let request;
    try {
      ({ request } = await pc.simulateContract({ account: account || from, ...guard, functionName: 'protect', args: [t.borrower, upper, lower] }));
    } catch (e) {
      log(`protect ${t.borrower}: dry-run REVERT ${e.shortMessage || e.message}`);
      out.push({ ...t, ok: false });
      continue;
    }
    log(`protect ${t.borrower}: ICR ${(Number(t.icr) / 1e16).toFixed(2)} % < ${(Number(t.trigger) / 1e16).toFixed(2)} %, nonce ${t.nonce}, dry-run OK`);
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
