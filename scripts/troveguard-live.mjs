#!/usr/bin/env node
// Mezo Testnet only: deploys TroveGuard v2 and runs the live end-to-end demo with the 0600 testnet key.
import fs from 'node:fs';
import { createWalletClient, http, parseEther, formatEther, decodeEventLog, encodeFunctionData, zeroAddress } from 'viem';
import { client, mezoTestnet } from '../src/chain.mjs';
import { NETWORK, C, GUARD } from '../src/config.mjs';
import { loadAccount } from '../src/keeper.mjs';

const MEZO_TESTNET = 31611;
const [cmd, ...rest] = process.argv.slice(2);
const pc = client();
if (NETWORK.chainId !== MEZO_TESTNET || (await pc.getChainId()) !== MEZO_TESTNET) throw new Error(`refusing to run: RPC is not Mezo Testnet (${MEZO_TESTNET})`);
const account = loadAccount();
if (!account) throw new Error('no testnet key: set MEZO_KEY_FILE to a chmod 600 file');
const wc = createWalletClient({ account, chain: mezoTestnet, transport: http(NETWORK.rpc) });
const guardFile = new URL('../src/abi/TroveGuard.json', import.meta.url);
const proofsFile = new URL('../proofs.json', import.meta.url);
const TM = C.troveManager;
const pct = (x) => `${(Number(x) / 1e16).toFixed(2)} %`;
const read = (c, functionName, args = []) => pc.readContract({ ...c, functionName, args });

// Mezo's public RPC is load-balanced, so a read right after a write can hit a lagging node.
async function sendAndWait(label, p) {
  const hash = await p;
  const rc = await pc.waitForTransactionReceipt({ hash });
  console.log(`${label}: ${NETWORK.explorer}/tx/${hash} status=${rc.status} block=${rc.blockNumber}`);
  if (rc.status !== 'success') throw new Error(`${label} reverted`);
  await new Promise((r) => setTimeout(r, 5000));
  return { hash, rc };
}

function addProof(label, hash, extra = {}) {
  const proofs = fs.existsSync(proofsFile) ? JSON.parse(fs.readFileSync(proofsFile, 'utf8')) : [];
  if (!proofs.some((p) => p.hash === hash)) proofs.push({ label, hash, ...extra });
  fs.writeFileSync(proofsFile, JSON.stringify(proofs, null, 2) + '\n');
}

function guardEvents(rc, abi, address) {
  return rc.logs.filter((l) => l.address.toLowerCase() === address.toLowerCase()).map((l) => {
    try { return decodeEventLog({ abi, data: l.data, topics: l.topics }); } catch { return null; }
  }).filter(Boolean);
}

async function icrNow() {
  return read(TM, 'getCurrentICR', [account.address, await read(C.priceFeed, 'fetchPrice')]);
}

// DEMO_LADDER="repay:100,add:0.002,repay:100" → [{ kind, amount }]
function parseLadder(spec, KIND) {
  return spec.split(',').map((r) => {
    const [k, v] = r.split(':');
    return { kind: k === 'repay' ? KIND.RepayMUSD : KIND.AddColl, amount: parseEther(v) };
  });
}

const DEMO_LADDER = process.env.DEMO_LADDER || 'repay:100,add:0.002,repay:100';

async function storeLadder(guard, ladder) {
  const { signLadder, describeRung } = await import('../src/guard.mjs');
  const firstNonce = await read(C.borrowerOperationsSignatures, 'getNonce', [account.address]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 180 * 86400);
  const permits = await signLadder(account, { firstNonce, rungs: ladder, deadline });
  const { request } = await pc.simulateContract({ account, ...guard, functionName: 'storePermits', args: [firstNonce, permits] });
  // Mezo's eth_estimateGas ignores the EIP-7623 calldata floor, which a ladder of signatures exceeds.
  const gas = (await pc.estimateGas({ account, to: guard.address, data: encodeFunctionData(request) })) * 2n + 100_000n;
  const s1 = await sendAndWait('storePermits', wc.writeContract({ ...request, gas }));
  addProof(`TroveGuard v2 storePermits: mixed ladder from nonce ${firstNonce}: ${ladder.map(describeRung).join(' → ')}`, s1.hash);
}

if (cmd === 'deploy') {
  const art = JSON.parse(fs.readFileSync(new URL('../forge-out/TroveGuard.sol/TroveGuard.json', import.meta.url)));
  console.log(`deployer ${account.address} balance ${formatEther(await pc.getBalance({ address: account.address }))} BTC`);
  const args = [C.borrowerOperationsSignatures.address, TM.address, C.priceFeed.address, C.musd.address];
  const { hash, rc } = await sendAndWait('deploy', wc.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args }));
  const previous = GUARD ? [...(GUARD.previous || []), { version: GUARD.version || 1, address: GUARD.address, deployTx: GUARD.deployTx, block: GUARD.block }] : [];
  fs.writeFileSync(guardFile, JSON.stringify({ version: 2, address: rc.contractAddress, deployTx: hash, block: Number(rc.blockNumber), constructorArgs: args, previous, abi: art.abi }) + '\n');
  addProof(`TroveGuard v2 deployed at ${rc.contractAddress}, block ${rc.blockNumber}`, hash);
  console.log(`TroveGuard v2 ${rc.contractAddress}`);
} else if (cmd === 'setup') {
  const { guardAt, KIND } = await import('../src/guard.mjs');
  const guard = guardAt();
  if ((await read(TM, 'getTroveStatus', [account.address])) !== 1) {
    const { hash } = await sendAndWait('openTrove', wc.writeContract({
      ...C.borrowerOperations, functionName: 'openTrove', value: parseEther(process.env.DEMO_COLL || '0.03'),
      args: [parseEther(process.env.DEMO_DEBT || '2100'), zeroAddress, zeroAddress],
    }));
    addProof(`Demo trove opened for ${account.address}`, hash);
  }
  if (process.env.DEMO_REFINANCE) {
    const { hash } = await sendAndWait('refinance', wc.writeContract({ ...C.borrowerOperations, functionName: 'refinance', args: [zeroAddress, zeroAddress] }));
    addProof('Demo trove refinance: resets maxBorrowingCapacity to the current collateral value / 110 %', hash);
  }
  if (process.env.DEMO_BORROW) {
    const before = await icrNow();
    const { hash } = await sendAndWait('withdrawMUSD', wc.writeContract({
      ...C.borrowerOperations, functionName: 'withdrawMUSD', args: [parseEther(process.env.DEMO_BORROW), zeroAddress, zeroAddress],
    }));
    const after = await icrNow();
    addProof(`Demo trove borrows ${process.env.DEMO_BORROW} MUSD more so repay rungs stay above the 1,800 MUSD minimum: ICR ${pct(before)} → ${pct(after)}`, hash);
  }
  const ladder = parseLadder(DEMO_LADDER, KIND);
  const trigger = parseEther(process.env.DEMO_TRIGGER || '2.00');
  const tip = parseEther(process.env.DEMO_TIP || '0.00001');
  const btc = ladder.reduce((s, r) => s + tip + (r.kind === KIND.AddColl ? r.amount : 0n), 0n);
  const musd = ladder.reduce((s, r) => s + (r.kind === KIND.RepayMUSD ? r.amount : 0n), 0n);
  const c1 = await sendAndWait('configure', wc.writeContract({ ...guard, functionName: 'configure', args: [trigger, tip], value: btc }));
  addProof(`TroveGuard v2 configure: trigger ${pct(trigger)}, tip ${formatEther(tip)} BTC, BTC reserve ${formatEther(btc)}`, c1.hash);
  if (musd > 0n) {
    const a = await sendAndWait('approve', wc.writeContract({ ...C.musd, functionName: 'approve', args: [guard.address, musd] }));
    addProof(`MUSD approve ${formatEther(musd)} for TroveGuard v2`, a.hash);
    const d = await sendAndWait('depositMUSD', wc.writeContract({ ...guard, functionName: 'depositMUSD', args: [musd] }));
    addProof(`TroveGuard v2 depositMUSD: ${formatEther(musd)} MUSD reserve`, d.hash);
  }
  await storeLadder(guard, ladder);
} else if (cmd === 'store') {
  const { guardAt, KIND } = await import('../src/guard.mjs');
  await storeLadder(guardAt(), parseLadder(DEMO_LADDER, KIND));
} else if (cmd === 'protect' || cmd === 'record') {
  const { runProtectKeeper, guardAt, describeRung } = await import('../src/guard.mjs');
  const guard = guardAt();
  const res = cmd === 'protect' ? await runProtectKeeper(pc, account, { send: true, guard }) : [{ tx: rest[0] }];
  for (const r of res) {
    if (!r.tx) continue;
    const rc = await pc.waitForTransactionReceipt({ hash: r.tx });
    const ev = guardEvents(rc, guard.abi, guard.address).find((e) => e.eventName === 'Protected');
    if (!ev) { console.log(`${r.tx}: no Protected event`); continue; }
    const { borrower, nonce, kind, amount, icrBefore, icrAfter } = ev.args;
    addProof(`TroveGuard v2 protect (${describeRung({ kind, amount })}, nonce ${nonce}): ${borrower} ICR ${pct(icrBefore)} → ${pct(icrAfter)}`, r.tx,
      { icrBefore: icrBefore.toString(), icrAfter: icrAfter.toString() });
  }
} else if (cmd === 'cancel') {
  const { guardAt } = await import('../src/guard.mjs');
  const guard = guardAt(rest[0]);
  const btcBefore = await pc.getBalance({ address: account.address });
  const { hash, rc } = await sendAndWait('cancel', wc.writeContract({ ...guard, functionName: 'cancel' }));
  const ev = guardEvents(rc, guard.abi, guard.address).find((e) => e.eventName === 'Cancelled');
  const musdRefund = ev?.args.musdRefunded ?? 0n;
  const left = [await read(guard, 'reserves', [account.address]), rest[0] ? 0n : await read(guard, 'musdReserves', [account.address])];
  console.log(`refunded ${formatEther(ev?.args.refunded ?? 0n)} BTC + ${formatEther(musdRefund)} MUSD; left in guard ${formatEther(left[0])} BTC + ${formatEther(left[1])} MUSD; wallet BTC ${formatEther(btcBefore)} → ${formatEther(await pc.getBalance({ address: account.address }))}`);
  addProof(`TroveGuard${rest[0] ? ` ${guard.address}` : ' v2'} cancel: refunded ${formatEther(ev?.args.refunded ?? 0n)} BTC${musdRefund ? ` + ${formatEther(musdRefund)} MUSD` : ''}, reserves now 0, stored permits invalidated`, hash);
} else {
  console.log('usage: troveguard-live.mjs deploy | setup | store | protect | record <protectTx> | cancel [guardAddress]');
}
