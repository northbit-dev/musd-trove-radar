import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWalletClient, http, parseEther, decodeEventLog, encodeFunctionData, zeroAddress, toHex, pad } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// End to end against an anvil fork of Mezo Testnet: npm run test:fork (needs forge build and MEZO_FORK_RPC).
const rpc = process.env.MEZO_FORK_RPC;
const art = (n) => new URL(`../forge-out/${n}.sol/${n}.json`, import.meta.url);
const skip = !rpc || !fs.existsSync(art('TroveGuardV3')) ? 'set MEZO_FORK_RPC and run forge build' : false;
const ORACLE = '0x7b7c000000000000000000000000000000000015';

test('v3 on a fork: Adjust, Repay and AddColl ladder protected in one keeper call, then cancel', { skip, timeout: 300_000 }, async () => {
  process.env.MEZO_RPC = rpc;
  const { client, mezoTestnet } = await import('../src/chain.mjs');
  const { C } = await import('../src/config.mjs');
  const { guardAt, signLadder, runProtectKeeper } = await import('../src/guard.mjs');
  const { parseSteps, reserveNeeded, musdNeeded } = await import('../src/permits.mjs');
  const pc = client(rpc);
  const call = (method, params) => pc.request({ method, params });
  const snap = await call('evm_snapshot', []);
  try {
    const feed = JSON.parse(fs.readFileSync(art('ForkFeed')));
    await call('anvil_setCode', [ORACLE, feed.deployedBytecode.object]);
    await call('anvil_setStorageAt', [ORACLE, pad('0x0'), pad(toHex(parseEther('100000')))]);
    const account = privateKeyToAccount(generatePrivateKey());
    await call('anvil_setBalance', [account.address, toHex(parseEther('10'))]);
    const wc = createWalletClient({ account, chain: mezoTestnet, transport: http(rpc, { timeout: 120_000 }) });
    const send = async (p) => {
      const rc = await pc.waitForTransactionReceipt({ hash: await p });
      assert.equal(rc.status, 'success');
      return rc;
    };

    const v3 = JSON.parse(fs.readFileSync(art('TroveGuardV3')));
    const args = [C.borrowerOperationsSignatures.address, C.troveManager.address, C.sortedTroves.address, C.priceFeed.address, C.musd.address];
    const { contractAddress } = await send(wc.deployContract({ abi: v3.abi, bytecode: v3.bytecode.object, args }));
    const guard = guardAt(contractAddress, { abi: v3.abi, version: 3 });

    await send(wc.writeContract({ ...C.borrowerOperations, functionName: 'openTrove', value: parseEther('0.03'), args: [parseEther('2100'), zeroAddress, zeroAddress] }));
    const rungs = parseSteps('adjust:0.002/100,repay:100,add:0.002', parseEther);
    const tip = parseEther('0.002');
    await send(wc.writeContract({ ...guard, functionName: 'configure', args: [parseEther('2'), tip, parseEther('2.5'), 0n, 3], value: reserveNeeded(rungs, tip) }));
    await send(wc.writeContract({ ...C.musd, functionName: 'approve', args: [guard.address, musdNeeded(rungs)] }));
    await send(wc.writeContract({ ...guard, functionName: 'depositMUSD', args: [musdNeeded(rungs)] }));
    const firstNonce = await pc.readContract({ ...C.borrowerOperationsSignatures, functionName: 'getNonce', args: [account.address] });
    const permits = await signLadder(account, { firstNonce, rungs, deadline: BigInt(Math.floor(Date.now() / 1000) + 86400), version: 3 });
    const data = encodeFunctionData({ abi: guard.abi, functionName: 'storePermits', args: [firstNonce, permits] });
    // Calldata floor: estimateGas undercounts a ladder of signatures.
    const gas = (await pc.estimateGas({ account, to: guard.address, data })) * 2n + 100_000n;
    await send(wc.sendTransaction({ to: guard.address, data, gas }));

    const before = await pc.readContract({ ...C.troveManager, functionName: 'getCurrentICR', args: [account.address, parseEther('100000')] });
    const [r] = await runProtectKeeper(pc, account, { send: true, guard, log: () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.rungs, 3);
    const rc = await pc.waitForTransactionReceipt({ hash: r.tx });
    const ev = rc.logs.filter((l) => l.address.toLowerCase() === guard.address.toLowerCase()).map((l) => decodeEventLog({ abi: guard.abi, data: l.data, topics: l.topics }));
    assert.deepEqual(ev.filter((e) => e.eventName === 'Protected').map((e) => Number(e.args.kind)), [2, 1, 0]);
    assert.equal(ev.find((e) => e.eventName === 'KeeperPaid').args.tip, tip * 3n);
    const after = await pc.readContract({ ...C.troveManager, functionName: 'getCurrentICR', args: [account.address, parseEther('100000')] });
    assert.ok(after > before);

    await send(wc.writeContract({ ...guard, functionName: 'cancel' }));
    const cfg = await pc.readContract({ ...guard, functionName: 'configs', args: [account.address] });
    assert.equal(cfg[6], false);
  } finally {
    await call('evm_revert', [snap]);
  }
});
