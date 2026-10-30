// Integration tests against the public Mezo Testnet RPC (read-only, no key).
// Skip with OFFLINE=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, fetchSystem, fetchTroves, onchainICR, simulateLiquidation } from '../src/chain.mjs';
import { analyze } from '../src/analyze.mjs';
import { C } from '../src/config.mjs';

const skip = process.env.OFFLINE === '1';
const pc = client();
let sys, troves;

test('chain id is Mezo Testnet', { skip }, async () => {
  assert.equal(await pc.getChainId(), 31611);
});

test('fetches every trove and matches on-chain ICR exactly', { skip, timeout: 120_000 }, async () => {
  sys = await fetchSystem(pc);
  troves = await fetchTroves(pc, sys);
  assert.equal(troves.length, sys.troveCount);
  assert.ok(troves.length > 0);
  const sample = [...troves].sort(() => Math.random() - 0.5).slice(0, 10);
  for (const t of sample) {
    const onchain = await onchainICR(pc, t.owner, sys.price, sys.blockNumber);
    assert.equal(t.icr, onchain, `ICR mismatch for ${t.owner}`);
  }
});

test('riskiest trove matches SortedTroves tail (lowest NICR)', { skip, timeout: 60_000 }, async () => {
  const last = await pc.readContract({ address: C.sortedTroves.address, abi: C.sortedTroves.abi, functionName: 'getLast', blockNumber: sys.blockNumber });
  const r = analyze(sys, troves);
  // SortedTroves is ordered by nominal ICR (coll/principal); with no redistribution
  // pending the lowest ICR and lowest NICR coincide in practice — check it is in our top 5.
  assert.ok(r.riskiest.slice(0, 5).some((t) => t.owner.toLowerCase() === last.toLowerCase()), `tail ${last} not in our top 5`);
});

test('every trove we flag as liquidatable passes an eth_call liquidation', { skip, timeout: 60_000 }, async () => {
  const r = analyze(sys, troves);
  for (const t of r.liquidatable.troves.slice(0, 5)) {
    const sim = await simulateLiquidation(pc, [t.owner]);
    assert.ok(sim.ok, `${t.owner}: ${sim.reason}`);
  }
  // and a healthy one must revert
  const healthy = r.riskiest.length ? [...troves].sort((a, b) => (a.icr > b.icr ? -1 : 1))[0] : null;
  if (healthy) assert.equal((await simulateLiquidation(pc, [healthy.owner])).ok, false);
});

test('redemption queue matches the on-chain SortedTroves walk and getNominalICR', { skip, timeout: 120_000 }, async () => {
  const { redemptionQueue, nicr } = await import('../src/redemption.mjs');
  const { queue, skipped } = redemptionQueue(troves, sys);
  const at = { blockNumber: sys.blockNumber };
  const ST = C.sortedTroves, TM = C.troveManager;
  // Walk the list from the tail exactly like TroveManager.redeemCollateral does.
  let cur = await pc.readContract({ address: ST.address, abi: ST.abi, functionName: 'getLast', ...at });
  const walked = [];
  const byOwner = new Map(troves.map((t) => [t.owner.toLowerCase(), t]));
  while (walked.length < 20 && cur !== '0x0000000000000000000000000000000000000000') {
    const t = byOwner.get(cur.toLowerCase());
    if (t.icr >= sys.mcr) walked.push(t);
    cur = await pc.readContract({ address: ST.address, abi: ST.abi, functionName: 'getPrev', args: [cur], ...at });
  }
  queue.slice(0, walked.length).forEach((q, i) => {
    // Equal NICRs may be stored in either order; anything else must match exactly.
    if (q.owner !== walked[i].owner) assert.equal(q.nicr, nicr(walked[i].coll, walked[i].principal), `position ${i + 1}`);
  });
  assert.ok(skipped.every((t) => t.icr < sys.mcr));
  for (const t of queue.slice(0, 5)) {
    const onchain = await pc.readContract({ address: TM.address, abi: TM.abi, functionName: 'getNominalICR', args: [t.owner], ...at });
    assert.equal(t.nicr, onchain, `NICR mismatch for ${t.owner}`);
  }
});

test('history finds our own keeper liquidation from TroveManager events', { skip, timeout: 60_000 }, async () => {
  const { syncEvents } = await import('../src/events.mjs');
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), 'events.json');
  const { events } = await syncEvents(pc, { fromBlock: 16451000n, toBlock: 16453000n, file });
  const liq = events.find((e) => e.tx === '0x6d0f1cdb2407fdc572443802dcf48c0451b713d31afb5c40aa4123a5a2a2d68e');
  assert.ok(liq, 'keeper liquidation not found');
  assert.equal(liq.type, 'liquidation');
  assert.equal(liq.block, 16452016n);
  assert.equal(liq.troves[0].borrower, '0xDA04759E54728B6636Fe48F7c9795c7B609bAaAa');
});
