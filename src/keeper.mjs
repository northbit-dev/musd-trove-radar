import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mezoTestnet, simulateLiquidation } from './chain.mjs';
import { NETWORK, C } from './config.mjs';
import { liquidationProfit, fmtMusd } from './profit.mjs';
import { textLog } from './log.mjs';
import { withRetry } from './guard.mjs';
export { runProtectKeeper, guardTargets } from './guard.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Load a TESTNET key from MEZO_PRIVATE_KEY (for containers) or from the chmod 600 file named by MEZO_KEY_FILE.
 * A key file inside the repo is refused so it can never be committed. Never logs the key.
 */
export function loadAccount(file = process.env.MEZO_KEY_FILE, env = process.env.MEZO_PRIVATE_KEY) {
  let pk = env?.trim();
  if (!pk) {
    if (!file || !fs.existsSync(file)) return null;
    const real = fs.realpathSync(file);
    if (real === ROOT || real.startsWith(ROOT + path.sep)) throw new Error(`${file} is inside the repository; keep the key file outside it`);
    const mode = fs.statSync(file).mode & 0o777;
    if (mode & 0o077) throw new Error(`${file} must be chmod 600 (is ${mode.toString(8)})`);
    pk = fs.readFileSync(file, 'utf8').trim();
  }
  return privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
}

/**
 * Liquidation keeper. Dry-runs every trove with ICR < MCR on its own, keeps those whose reward
 * (200 MUSD + 0.5 % of collateral) covers gas plus minProfit, and only broadcasts with send=true on chain 31611.
 */
export async function runKeeper(pc, report, { send = false, max = 10, minProfit = 0n, log = textLog } = {}) {
  const candidates = report.liquidatable.troves.slice(0, max);
  if (!candidates.length) { log('keeper: nothing liquidatable', { event: 'liquidate.none' }); return { targets: [], skipped: [], sim: null, tx: null }; }
  const account = loadAccount();
  const gasPrice = await pc.getGasPrice();
  const targets = [], skipped = [];
  for (const t of candidates) {
    const sim = await simulateLiquidation(pc, [t.owner], account?.address);
    const p = sim.ok ? liquidationProfit(t, { gas: sim.gas, gasPrice, price: report.price, minProfit }) : null;
    const reason = !sim.ok ? `dry-run revert: ${sim.reason}` : p.reason;
    const fields = { event: reason ? 'liquidate.skip' : 'liquidate.target', borrower: t.owner, icr: t.icr, gas: sim.gas, reward: p?.reward, cost: p?.cost, profit: p?.profit, reason };
    log(`keeper: ${t.owner} ICR ${(Number(t.icr) / 1e16).toFixed(2)} % ${reason ? `skipped (${reason})` : `profit ≈ ${fmtMusd(p.profit)} MUSD`}`, fields);
    (reason ? skipped : targets).push({ owner: t.owner, reason, ...p });
  }
  if (!targets.length) return { targets, skipped, sim: null, tx: null };
  const owners = targets.map((t) => t.owner);
  const sim = owners.length === 1 ? { ok: true } : await simulateLiquidation(pc, owners, account?.address);
  log(`keeper: ${owners.length} target(s); dry-run ${sim.ok ? 'OK' : `REVERT: ${sim.reason}`}`, { event: 'liquidate.dryrun', targets: owners.length, ok: sim.ok, reason: sim.reason });
  if (!send || !sim.ok) return { targets, skipped, sim, tx: null };
  if (!account) throw new Error('no testnet key: set MEZO_KEY_FILE to a chmod 600 file outside the repo, or MEZO_PRIVATE_KEY');
  const chainId = await pc.getChainId();
  if (chainId !== NETWORK.chainId) throw new Error(`refusing to send: chainId ${chainId} is not Mezo Testnet`);
  const bal = await pc.getBalance({ address: account.address });
  log(`keeper: sender ${account.address} balance ${formatEther(bal)} BTC`, { event: 'liquidate.sender', sender: account.address, balance: bal });
  const wc = createWalletClient({ account, chain: mezoTestnet, transport: http(NETWORK.rpc) });
  const hash = await withRetry(() => wc.writeContract({
    address: C.troveManager.address, abi: C.troveManager.abi,
    functionName: owners.length === 1 ? 'liquidate' : 'batchLiquidateTroves',
    args: owners.length === 1 ? [owners[0]] : [owners],
  }));
  const rc = await pc.waitForTransactionReceipt({ hash });
  log(`keeper: tx ${NETWORK.explorer}/tx/${hash} status=${rc.status}`, { event: 'liquidate.tx', tx: hash, status: rc.status, targets: owners });
  return { targets, skipped, sim, tx: hash, status: rc.status };
}
