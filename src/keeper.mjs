import fs from 'node:fs';
import { createWalletClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mezoTestnet, simulateLiquidation } from './chain.mjs';
import { NETWORK, C } from './config.mjs';

export const DEFAULT_KEY_FILE = process.env.MEZO_KEY_FILE || `${process.env.HOME}/.secrets/mezo-testnet.key`;

/** Load a TESTNET key from a 0600 file. Never logs the key. */
export function loadAccount(file = DEFAULT_KEY_FILE) {
  if (!fs.existsSync(file)) return null;
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} must be chmod 600 (is ${mode.toString(8)})`);
  const pk = fs.readFileSync(file, 'utf8').trim();
  return privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
}

/**
 * Liquidation keeper. Picks troves with ICR < MCR, dry-runs them via eth_call,
 * and only broadcasts with send=true on chain 31611 (Mezo Testnet).
 */
export async function runKeeper(pc, report, { send = false, max = 10, log = console.log } = {}) {
  const targets = report.liquidatable.troves.slice(0, max).map((t) => t.owner);
  if (!targets.length) { log('keeper: nothing liquidatable'); return { targets, sim: null, tx: null }; }
  const account = loadAccount();
  const sim = await simulateLiquidation(pc, targets, account?.address);
  log(`keeper: ${targets.length} target(s); dry-run ${sim.ok ? `OK (gas ≈ ${sim.gas ?? '?'})` : `REVERT: ${sim.reason}`}`);
  if (!send || !sim.ok) return { targets, sim, tx: null };
  if (!account) throw new Error(`no testnet key at ${DEFAULT_KEY_FILE}`);
  const chainId = await pc.getChainId();
  if (chainId !== NETWORK.chainId) throw new Error(`refusing to send: chainId ${chainId} is not Mezo Testnet`);
  const bal = await pc.getBalance({ address: account.address });
  log(`keeper: sender ${account.address} balance ${formatEther(bal)} BTC`);
  const wc = createWalletClient({ account, chain: mezoTestnet, transport: http(NETWORK.rpc) });
  const hash = await wc.writeContract({
    address: C.troveManager.address, abi: C.troveManager.abi,
    functionName: targets.length === 1 ? 'liquidate' : 'batchLiquidateTroves',
    args: targets.length === 1 ? [targets[0]] : [targets],
  });
  const rc = await pc.waitForTransactionReceipt({ hash });
  log(`keeper: tx ${NETWORK.explorer}/tx/${hash} status=${rc.status}`);
  return { targets, sim, tx: hash, status: rc.status };
}
