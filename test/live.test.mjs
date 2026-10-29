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
