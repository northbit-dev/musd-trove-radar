import { createWalletClient, http } from 'viem';
import { mezoTestnet } from './chain.mjs';
import { NETWORK, C, GUARD } from './config.mjs';
import { protectProfit, fmtMusd } from './profit.mjs';
import { textLog } from './log.mjs';
import { KIND, permitTypedData as typedData, describeRung, parseStatus, parseConfig, toPermit, rungAmounts, reasonName, REASON } from './permits.mjs';

const TM = C.troveManager, BOS = C.borrowerOperationsSignatures;

export function guardAt(address = process.env.TROVE_GUARD || GUARD?.address, { abi = GUARD?.abi, version = GUARD?.version ?? 2 } = {}) {
  if (!address) throw new Error('no TroveGuard address (deploy first or set TROVE_GUARD)');
  return { address, abi, version };
}

export { KIND, kindName, describeRung, parseStatus } from './permits.mjs';

/** The EIP-712 request a borrower signs for one rung; also used by the browser UI. */
export const permitTypedData = (p) => typedData({ chainId: NETWORK.chainId, verifyingContract: BOS.address, ...p });

/**
 * Sign a ladder of permits for consecutive nonces, shaped for the guard `version`'s storePermits.
 * Rungs are { kind, btc, musd } (or v2's { kind, amount }); every kind shares the borrower's one nonce.
 */
export async function signLadder(account, { firstNonce, rungs, deadline, version = GUARD?.version ?? 2 }) {
  const permits = [];
  for (let i = 0; i < rungs.length; i++) {
    const signature = await account.signTypedData(permitTypedData({ ...rungs[i], borrower: account.address, nonce: firstNonce + BigInt(i), deadline }));
    permits.push(toPermit(rungs[i], deadline, signature, version));
  }
  return permits;
}

/** v1 helper: `rungs` identical AddColl permits. */
export async function signAddCollLadder(account, { firstNonce, rungs, amount, deadline }) {
  return signLadder(account, { firstNonce, deadline, rungs: Array.from({ length: rungs }, () => ({ kind: KIND.AddColl, amount })) });
}

/** Every guarded borrower with its on-chain status() and configs(); `protectable` ones are keeper targets. */
export async function guardTargets(pc, guard = guardAt()) {
  const n = await pc.readContract({ ...guard, functionName: 'guardedCount' });
  const borrowers = n ? await pc.readContract({ ...guard, functionName: 'guardedSlice', args: [0n, n] }) : [];
  if (!borrowers.length) return [];
  const res = await pc.multicall({ allowFailure: true, contracts: borrowers.flatMap((b) => [{ ...guard, functionName: 'status', args: [b] }, { ...guard, functionName: 'configs', args: [b] }]) });
  return borrowers.map((borrower, i) => {
    const [st, cfg] = [res[2 * i], res[2 * i + 1]];
    if (st.status !== 'success') return { borrower, protectable: false, error: st.error?.shortMessage };
    const s = parseStatus(borrower, st.result);
    if (cfg.status !== 'success') return { ...s, active: null, tip: null };
    const c = parseConfig(cfg.result);
    return { ...s, trigger: s.trigger ?? c.trigger, active: Boolean(c.active), tip: c.tip, targetICR: c.targetICR, redemptionBuffer: c.redemptionBuffer, maxRungs: c.maxRungs };
  });
}

/** NICR = coll / principal, so added BTC scales it by coll and a repayment by principal. Takes a rung or (kind, amount). */
export function nicrAfter({ nicr, coll, principal }, rung, amount) {
  const { btc, musd } = rungAmounts(typeof rung === 'object' ? rung : { kind: rung, amount });
  if (musd >= principal) return nicr;
  const n = coll ? (nicr * (coll + btc)) / coll : nicr;
  return (n * principal) / (principal - musd);
}

/** Insert hints for the trove's position after `rungs` (one protect may spend several); v2 callers pass (amount, kind). */
export async function protectHints(pc, borrower, rungs, kind = KIND.AddColl) {
  const list = Array.isArray(rungs) ? rungs : [{ kind, amount: rungs }];
  const read = (functionName, args) => pc.readContract({ address: TM.address, abi: TM.abi, functionName, args });
  const [nicr, coll, principal, count] = await Promise.all([
    read('getNominalICR', [borrower]), read('getTroveColl', [borrower]), read('getTrovePrincipal', [borrower]), read('getTroveOwnersCount'),
  ]);
  const sum = list.reduce((a, r) => { const x = rungAmounts(r); return { btc: a.btc + x.btc, musd: a.musd + x.musd }; }, { btc: 0n, musd: 0n });
  const newNicr = nicrAfter({ nicr, coll, principal }, sum);
  const trials = BigInt(Math.ceil(15 * Math.sqrt(Number(count) || 1)));
  const [approx] = await pc.readContract({ address: C.hintHelpers.address, abi: C.hintHelpers.abi, functionName: 'getApproxHint', args: [newNicr, trials, 42n] });
  return pc.readContract({ address: C.sortedTroves.address, abi: C.sortedTroves.abi, functionName: 'findInsertPosition', args: [newNicr, approx, approx] });
}

// Mezo's public RPC is load-balanced; a send right after a state change can hit a lagging node.
export async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 4000)); }
  }
}

/** The permits a v3 protect will spend: the next one plus the following nonces up to `rungs`. */
async function spentRungs(pc, guard, t, rungs) {
  const out = [t];
  for (let i = 1; i < rungs; i++) {
    const p = await pc.readContract({ ...guard, functionName: 'permitOf', args: [t.borrower, t.nonce + BigInt(i)] });
    out.push({ kind: Number(p.kind), btc: p.btc, musd: p.musd });
  }
  return out;
}

const pctOf = (v) => `${(Number(v) / 1e16).toFixed(2)} %`;
const why = (t) => (t.reason === REASON.RedemptionFront
  ? `${fmtMusd(t.musdAhead)} MUSD redeemable ahead < ${fmtMusd(t.redemptionBuffer)} buffer`
  : `ICR ${pctOf(t.icr)} < ${pctOf(t.trigger)}`);

/**
 * Protect keeper: dry-runs protect() for each target, skips it when the BTC tip (per rung spent) does not
 * cover gas plus minProfit (MUSD wei at `price`), and only broadcasts with send=true on Mezo Testnet.
 * A v3 protect returns how many rungs it spends; hints are then recomputed for the trove after all of them.
 */
export async function runProtectKeeper(pc, account, { send = false, guard = guardAt(), log = textLog, price, minProfit = 0n } = {}) {
  const targets = (await guardTargets(pc, guard)).filter((t) => t.protectable);
  if (!targets.length) { log('protect: no guarded trove needs protection', { event: 'protect.none' }); return []; }
  const from = account?.address || '0x000000000000000000000000000000000000dEaD';
  price ??= await pc.readContract({ address: C.priceFeed.address, abi: C.priceFeed.abi, functionName: 'fetchPrice' });
  const gasPrice = await pc.getGasPrice();
  const v3 = (guard.version ?? 2) >= 3;
  const out = [];
  for (const t of targets) {
    const base = { borrower: t.borrower, icr: t.icr, trigger: t.trigger, nonce: t.nonce, rung: describeRung(t), reason: reasonName(t.reason), musdAhead: t.musdAhead };
    const simulate = async (rungs) => {
      const [upper, lower] = await protectHints(pc, t.borrower, rungs);
      return pc.simulateContract({ account: account || from, ...guard, functionName: 'protect', args: [t.borrower, upper, lower] });
    };
    let request, gas = null, steps = [t];
    try {
      let sim = await simulate(steps);
      const n = v3 ? Number(sim.result ?? 1n) : 1;
      if (n > 1) { steps = await spentRungs(pc, guard, t, n); sim = await simulate(steps); }
      ({ request } = sim);
      gas = await pc.estimateContractGas(request).catch(() => null);
    } catch (e) {
      const reason = `dry-run revert: ${e.shortMessage || e.message}`;
      log(`protect ${t.borrower}: skipped (${reason})`, { event: 'protect.skip', ...base, reason });
      out.push({ ...t, ok: false, reason });
      continue;
    }
    const rungs = steps.length;
    const p = protectProfit({ tip: (t.tip ?? 0n) * BigInt(rungs) }, { gas, gasPrice, price, minProfit });
    const plan = steps.map(describeRung).join(' → ');
    if (!p.ok) {
      log(`protect ${t.borrower}: skipped (${p.reason})`, { event: 'protect.skip', ...base, rungs, reward: p.reward, cost: p.cost, reason: p.reason });
      out.push({ ...t, ok: false, rungs, reason: p.reason, ...p });
      continue;
    }
    log(`protect ${t.borrower}: ${why(t)}, nonce ${t.nonce}, ${rungs > 1 ? `${rungs} rungs ${plan}` : plan}, dry-run OK, profit ≈ ${fmtMusd(p.profit)} MUSD`, { event: 'protect.target', ...base, rungs, plan, gas, reward: p.reward, cost: p.cost, profit: p.profit });
    if (!send) { out.push({ ...t, ok: true, tx: null, rungs, ...p }); continue; }
    if (!account) throw new Error('no testnet key loaded');
    if ((await pc.getChainId()) !== NETWORK.chainId) throw new Error('refusing to send: not Mezo Testnet');
    const wc = createWalletClient({ account, chain: mezoTestnet, transport: http(NETWORK.rpc) });
    const hash = await withRetry(() => wc.writeContract(request));
    const rc = await pc.waitForTransactionReceipt({ hash });
    log(`protect ${t.borrower}: tx ${NETWORK.explorer}/tx/${hash} status=${rc.status}`, { event: 'protect.tx', ...base, rungs, tx: hash, status: rc.status });
    out.push({ ...t, ok: rc.status === 'success', tx: hash, rungs, ...p });
  }
  return out;
}
