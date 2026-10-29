#!/usr/bin/env node
// Mezo Testnet only: deploys TroveGuard and runs a live end-to-end protect demo with the 0600 testnet key.
import fs from 'node:fs';
import { createWalletClient, http, parseEther, formatEther } from 'viem';
import { client, mezoTestnet } from '../src/chain.mjs';
import { NETWORK, C } from '../src/config.mjs';
import { loadAccount } from '../src/keeper.mjs';

const [cmd] = process.argv.slice(2);
const pc = client();
const account = loadAccount();
if (!account) throw new Error('no testnet key');
if ((await pc.getChainId()) !== NETWORK.chainId) throw new Error('not Mezo Testnet');
const wc = createWalletClient({ account, chain: mezoTestnet, transport: http(NETWORK.rpc) });
const guardFile = new URL('../src/abi/TroveGuard.json', import.meta.url);
const proofsFile = new URL('../proofs.json', import.meta.url);
const TM = C.troveManager;

async function sendAndWait(label, p) {
  const hash = await p;
  const rc = await pc.waitForTransactionReceipt({ hash });
  console.log(`${label}: ${NETWORK.explorer}/tx/${hash} status=${rc.status} block=${rc.blockNumber}`);
  if (rc.status !== 'success') throw new Error(`${label} reverted`);
  return { hash, rc };
}

function addProof(label, hash) {
  const proofs = fs.existsSync(proofsFile) ? JSON.parse(fs.readFileSync(proofsFile, 'utf8')) : [];
  if (!proofs.some((p) => p.hash === hash)) proofs.push({ label, hash });
  fs.writeFileSync(proofsFile, JSON.stringify(proofs, null, 2) + '\n');
}

if (cmd === 'deploy') {
  const art = JSON.parse(fs.readFileSync(new URL('../forge-out/TroveGuard.sol/TroveGuard.json', import.meta.url)));
  console.log(`deployer ${account.address} balance ${formatEther(await pc.getBalance({ address: account.address }))} BTC`);
  const { hash, rc } = await sendAndWait('deploy', wc.deployContract({
    abi: art.abi, bytecode: art.bytecode.object,
    args: [C.borrowerOperationsSignatures.address, TM.address, C.priceFeed.address],
  }));
  fs.writeFileSync(guardFile, JSON.stringify({ address: rc.contractAddress, deployTx: hash, block: Number(rc.blockNumber), abi: art.abi }) + '\n');
  addProof(`TroveGuard deployed at ${rc.contractAddress}, block ${rc.blockNumber}`, hash);
  console.log(`TroveGuard ${rc.contractAddress}`);
} else if (cmd === 'setup') {
  const { signAddCollLadder, guardAt, protectHints } = await import('../src/guard.mjs');
  const guard = guardAt();
  const status = await pc.readContract({ address: TM.address, abi: TM.abi, functionName: 'getTroveStatus', args: [account.address] });
  if (status !== 1) {
    const coll = parseEther(process.env.DEMO_COLL || '0.03');
    const debt = parseEther(process.env.DEMO_DEBT || '1800');
    const { hash } = await sendAndWait('openTrove', wc.writeContract({
      ...C.borrowerOperations, functionName: 'openTrove', args: [debt, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000'], value: coll,
    }));
    addProof(`Demo trove opened for ${account.address}`, hash);
  }
  const trigger = parseEther(process.env.DEMO_TRIGGER || '1.30');
  const tip = parseEther('0.00001');
  const amount = parseEther(process.env.DEMO_TOPUP || '0.002');
  const rungs = Number(process.env.DEMO_RUNGS || 3);
  const reserve = (amount + tip) * BigInt(rungs);
  const c1 = await sendAndWait('configure', wc.writeContract({ ...guard, functionName: 'configure', args: [trigger, tip], value: reserve }));
  addProof('TroveGuard configure (trigger + BTC reserve)', c1.hash);
  const firstNonce = await pc.readContract({ ...C.borrowerOperationsSignatures, functionName: 'getNonce', args: [account.address] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 180 * 86400);
  const permits = await signAddCollLadder(account, { firstNonce, rungs, amount, deadline });
  const s1 = await sendAndWait('storePermits', wc.writeContract({ ...guard, functionName: 'storePermits', args: [firstNonce, permits] }));
  addProof(`TroveGuard storePermits (${rungs} pre-signed AddColl rungs from nonce ${firstNonce})`, s1.hash);
} else if (cmd === 'protect') {
  const { runProtectKeeper } = await import('../src/guard.mjs');
  const res = await runProtectKeeper(pc, account, { send: true });
  for (const r of res) if (r.tx) addProof(`TroveGuard protect: ${r.borrower} topped up at ICR ${(Number(r.icr) / 1e16).toFixed(2)} % (nonce ${r.nonce})`, r.tx);
} else {
  console.log('usage: troveguard-live.mjs deploy|setup|protect');
}
