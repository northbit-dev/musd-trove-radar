#!/usr/bin/env node
// Mezo Testnet only: deploys TroveGuard v3 and runs the live demo with the 0600 testnet key.
// With MEZO_RPC pointing at an anvil fork it is a rehearsal: files go to forge-out/rehearsal/ and fork-price works.
// Long timeout: the first estimateGas on a cold fork pulls state from the remote RPC.
import fs from 'node:fs';
import { createWalletClient, http, parseEther, formatEther, decodeEventLog, encodeFunctionData, zeroAddress } from 'viem';
import { client, mezoTestnet } from '../src/chain.mjs';
import { NETWORK, C, GUARD } from '../src/config.mjs';
import { loadAccount } from '../src/keeper.mjs';
import { parseSteps, reserveNeeded, musdNeeded, describeRung, reasonName } from '../src/permits.mjs';

const MEZO_TESTNET = 31611;
const ORACLE = '0x7b7c000000000000000000000000000000000015';
const [cmd, ...rest] = process.argv.slice(2);
const pc = client();
if (NETWORK.chainId !== MEZO_TESTNET || (await pc.getChainId()) !== MEZO_TESTNET) throw new Error(`refusing to run: RPC is not Mezo Testnet (${MEZO_TESTNET})`);
const rehearsal = NETWORK.rpc !== 'https://rpc.test.mezo.org';
const account = loadAccount();
if (!account) throw new Error('no testnet key: set MEZO_KEY_FILE to a chmod 600 file');
const wc = createWalletClient({ account, chain: mezoTestnet, transport: http(NETWORK.rpc, { timeout: 120_000 }) });
const dir = new URL(rehearsal ? '../forge-out/rehearsal/' : '../', import.meta.url);
fs.mkdirSync(dir, { recursive: true });
const guardFile = rehearsal ? new URL('TroveGuard.json', dir) : new URL('../src/abi/TroveGuard.json', import.meta.url);
const proofsFile = new URL('proofs.json', dir);
const TM = C.troveManager;
const pct = (x) => `${(Number(x) / 1e16).toFixed(2)} %`;
const read = (c, functionName, args = []) => pc.readContract({ ...c, functionName, args });
const STEPS = process.env.DEMO_STEPS || 'adjust:0.002/20,add:0.002,repay:20';

async function guardNow(address) {
  const { guardAt } = await import('../src/guard.mjs');
  const g = fs.existsSync(guardFile) ? JSON.parse(fs.readFileSync(guardFile, 'utf8')) : GUARD;
  if (!g || g.version !== 3) throw new Error('no TroveGuard v3 deployment yet (run deploy)');
  return guardAt(address || g.address, { abi: g.abi, version: 3 });
}

// Mezo's public RPC is load-balanced, so a read right after a write can hit a lagging node.
async function sendAndWait(label, p) {
  const hash = await p;
  const rc = await pc.waitForTransactionReceipt({ hash });
  console.log(`${label}: ${rehearsal ? `fork tx ${hash}` : `${NETWORK.explorer}/tx/${hash}`} status=${rc.status} block=${rc.blockNumber}`);
  if (rc.status !== 'success') throw new Error(`${label} reverted`);
  if (!rehearsal) await new Promise((r) => setTimeout(r, 5000));
  return { hash, rc };
}

function addProof(label, hash, extra = {}) {
  const proofs = fs.existsSync(proofsFile) ? JSON.parse(fs.readFileSync(proofsFile, 'utf8')) : [];
  if (!proofs.some((p) => p.hash === hash)) proofs.push({ label, hash, ...extra });
  fs.writeFileSync(proofsFile, JSON.stringify(proofs, null, 2) + '\n');
}

function guardEvents(rc, guard) {
  return rc.logs.filter((l) => l.address.toLowerCase() === guard.address.toLowerCase()).map((l) => {
    try { return decodeEventLog({ abi: guard.abi, data: l.data, topics: l.topics }); } catch { return null; }
  }).filter(Boolean);
}

async function storeLadder(guard, rungs) {
  const { signLadder } = await import('../src/guard.mjs');
  const firstNonce = await read(C.borrowerOperationsSignatures, 'getNonce', [account.address]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 180 * 86400);
  const permits = await signLadder(account, { firstNonce, rungs, deadline, version: 3 });
  const { request } = await pc.simulateContract({ account, ...guard, functionName: 'storePermits', args: [firstNonce, permits] });
  // Mezo's eth_estimateGas ignores the EIP-7623 calldata floor, which a ladder of signatures exceeds.
  const gas = (await pc.estimateGas({ account, to: guard.address, data: encodeFunctionData(request) })) * 2n + 100_000n;
  const s = await sendAndWait('storePermits', wc.writeContract({ ...request, gas }));
  addProof(`TroveGuard v3 storePermits from nonce ${firstNonce}: ${rungs.map(describeRung).join(' → ')}`, s.hash);
}

if (cmd === 'deploy') {
  const art = JSON.parse(fs.readFileSync(new URL('../forge-out/TroveGuardV3.sol/TroveGuardV3.json', import.meta.url)));
  console.log(`deployer ${account.address} balance ${formatEther(await pc.getBalance({ address: account.address }))} BTC`);
  const args = [C.borrowerOperationsSignatures.address, TM.address, C.sortedTroves.address, C.priceFeed.address, C.musd.address];
  const { hash, rc } = await sendAndWait('deploy', wc.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args }));
  const old = GUARD && GUARD.version !== 3 ? GUARD : null;
  if (old && !rehearsal) fs.writeFileSync(new URL('../src/abi/TroveGuardV2.json', import.meta.url), JSON.stringify(old) + '\n');
  const previous = old ? [{ version: old.version, address: old.address, deployTx: old.deployTx, block: old.block, abi: 'TroveGuardV2.json' }, ...(old.previous || [])] : GUARD?.previous || [];
  fs.writeFileSync(guardFile, JSON.stringify({ version: 3, address: rc.contractAddress, deployTx: hash, block: Number(rc.blockNumber), constructorArgs: args, previous, abi: art.abi }) + '\n');
  addProof(`TroveGuard v3 deployed at ${rc.contractAddress}, block ${rc.blockNumber}`, hash);
  console.log(`TroveGuard v3 ${rc.contractAddress}`);
} else if (cmd === 'setup') {
  const guard = await guardNow();
  if ((await read(TM, 'getTroveStatus', [account.address])) !== 1) {
    const { hash } = await sendAndWait('openTrove', wc.writeContract({
      ...C.borrowerOperations, functionName: 'openTrove', value: parseEther(process.env.DEMO_COLL || '0.03'),
      args: [parseEther(process.env.DEMO_DEBT || '2100'), zeroAddress, zeroAddress],
    }));
    addProof(`Demo trove opened for ${account.address}`, hash);
  }
  const rungs = parseSteps(STEPS, parseEther);
  const trigger = parseEther(process.env.DEMO_TRIGGER || '2.00');
  const tip = parseEther(process.env.DEMO_TIP || '0.00001');
  const target = parseEther(process.env.DEMO_TARGET || '2.50');
  const buffer = parseEther(process.env.DEMO_BUFFER || '0');
  const maxRungs = Number(process.env.DEMO_MAX_RUNGS || 3);
  const btc = reserveNeeded(rungs, tip), musd = musdNeeded(rungs);
  const c = await sendAndWait('configure', wc.writeContract({ ...guard, functionName: 'configure', args: [trigger, tip, target, buffer, maxRungs], value: btc }));
  addProof(`TroveGuard v3 configure: trigger ${pct(trigger)}, target ${pct(target)}, redemption buffer ${formatEther(buffer)} MUSD, max ${maxRungs} rungs, tip ${formatEther(tip)} BTC, BTC reserve ${formatEther(btc)}`, c.hash);
  if (musd > 0n) {
    const a = await sendAndWait('approve', wc.writeContract({ ...C.musd, functionName: 'approve', args: [guard.address, musd] }));
    addProof(`MUSD approve ${formatEther(musd)} for TroveGuard v3`, a.hash);
    const d = await sendAndWait('depositMUSD', wc.writeContract({ ...guard, functionName: 'depositMUSD', args: [musd] }));
    addProof(`TroveGuard v3 depositMUSD: ${formatEther(musd)} MUSD reserve`, d.hash);
  }
  await storeLadder(guard, rungs);
} else if (cmd === 'store') {
  await storeLadder(await guardNow(), parseSteps(STEPS, parseEther));
} else if (cmd === 'protect' || cmd === 'record') {
  const { runProtectKeeper } = await import('../src/guard.mjs');
  const guard = await guardNow();
  const res = cmd === 'protect' ? await runProtectKeeper(pc, account, { send: true, guard }) : [{ tx: rest[0] }];
  for (const r of res) {
    if (!r.tx) continue;
    const rc = await pc.waitForTransactionReceipt({ hash: r.tx });
    const ev = guardEvents(rc, guard);
    const steps = ev.filter((e) => e.eventName === 'Protected').map((e) => e.args);
    const paid = ev.find((e) => e.eventName === 'KeeperPaid')?.args;
    if (!steps.length) { console.log(`${r.tx}: no Protected event`); continue; }
    const first = steps[0], last = steps.at(-1);
    addProof(`TroveGuard v3 protect (${reasonName(first.reason)}): ${steps.map((s) => `${describeRung(s)} @${s.nonce}`).join(' → ')}; ${first.borrower} ICR ${pct(first.icrBefore)} → ${pct(last.icrAfter)}, keeper tip ${formatEther(paid?.tip ?? 0n)} BTC for ${steps.length} rungs`, r.tx,
      { icrBefore: first.icrBefore.toString(), icrAfter: last.icrAfter.toString(), rungs: steps.length });
  }
} else if (cmd === 'cancel') {
  const guard = await guardNow(rest[0]);
  const { hash, rc } = await sendAndWait('cancel', wc.writeContract({ ...guard, functionName: 'cancel' }));
  const ev = guardEvents(rc, guard).find((e) => e.eventName === 'Cancelled');
  const [btc, musd] = [ev?.args.refunded ?? 0n, ev?.args.musdRefunded ?? 0n];
  console.log(`refunded ${formatEther(btc)} BTC + ${formatEther(musd)} MUSD`);
  addProof(`TroveGuard v3 cancel: refunded ${formatEther(btc)} BTC${musd ? ` + ${formatEther(musd)} MUSD` : ''}, reserves now 0, stored permits invalidated`, hash);
} else if (cmd === 'fork-price' && rehearsal) {
  const art = JSON.parse(fs.readFileSync(new URL('../forge-out/ForkFeed.sol/ForkFeed.json', import.meta.url)));
  await pc.request({ method: 'anvil_setCode', params: [ORACLE, art.deployedBytecode.object] });
  await pc.request({ method: 'anvil_setStorageAt', params: [ORACLE, '0x0', `0x${parseEther(rest[0] || '100000').toString(16).padStart(64, '0')}`] });
  console.log(`fork BTC price ${rest[0] || '100000'}: fetchPrice ${formatEther(await read(C.priceFeed, 'fetchPrice'))}`);
} else {
  console.log('usage: troveguard-v3-live.mjs deploy | setup | store | protect | record <protectTx> | cancel [guardAddress] | fork-price <usd> (anvil only)');
}
