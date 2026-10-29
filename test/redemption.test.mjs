import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icr, liquidationPrice } from '../src/math.mjs';
import { nicr, redemptionQueue, simulateRedemption, redemptionSummary, queuePosition, MUSD_GAS_COMPENSATION } from '../src/redemption.mjs';

const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const MCR = E(1.1), PRICE = E(80000);
// principal excludes interest; debt = principal + interest (+ 200 MUSD reserve is inside principal on-chain)
const T = (owner, coll, principal, interest = 0) => ({ owner, coll: E(coll), principal: E(principal), debt: E(principal + interest), icr: icr(E(coll), E(principal + interest), PRICE), liqPrice: liquidationPrice(E(coll), E(principal + interest), MCR) });

test('nicr mirrors _computeNominalCR', () => {
  assert.equal(nicr(E(1), E(50000)), (E(1) * 10n ** 20n) / E(50000));
  assert.equal(nicr(E(1), 0n), 2n ** 256n - 1n);
});

test('queue: ordered by NICR, skips ICR < MCR, cumulative depth excludes gas reserve', () => {
  const tr = [T('c', 1, 30000), T('liq', 1, 75000), T('a', 1, 70000), T('b', 1, 50000)];
  const { queue, skipped, totalRedeemable } = redemptionQueue(tr, { mcr: MCR });
  assert.deepEqual(queue.map((t) => t.owner), ['a', 'b', 'c']);
  assert.deepEqual(skipped.map((t) => t.owner), ['liq']);
  assert.equal(queue[0].ahead, 0n);
  assert.equal(queue[1].ahead, E(70000) - MUSD_GAS_COMPENSATION);
  assert.equal(queue[2].through, totalRedeemable);
  assert.equal(totalRedeemable, E(150000) - 3n * MUSD_GAS_COMPENSATION);
});

test('interest is part of debt but not of NICR ordering', () => {
  // x has lower principal (higher NICR) but more interest, so a lower ICR.
  const tr = [T('x', 1, 40000, 15000), T('y', 1, 50000)];
  const { queue } = redemptionQueue(tr, { mcr: MCR });
  assert.deepEqual(queue.map((t) => t.owner), ['y', 'x']);
});

test('simulateRedemption fills front to back, closes fully redeemed troves', () => {
  const { queue } = redemptionQueue([T('a', 1, 2200), T('b', 1, 2100)], { mcr: MCR });
  const sim = simulateRedemption(queue, E(2500), PRICE);
  assert.deepEqual(sim.hits.map((h) => [h.owner, h.closes]), [['a', true], ['b', false]]);
  assert.equal(sim.hits[0].musd, E(2000));
  assert.equal(sim.hits[1].musd, E(500));
  assert.equal(sim.hits[0].coll, (E(2000) * 10n ** 18n) / PRICE);
  assert.equal(sim.unfilled, 0n);
  assert.equal(simulateRedemption(queue, E(10000), PRICE).unfilled, E(10000) - E(3900));
});

test('summary + position lookup', () => {
  const tr = [T('0xA', 1, 70000), T('0xB', 1, 50000)];
  const sys = { mcr: MCR, price: PRICE, coll: E(2), debt: E(120000) };
  const s = redemptionSummary(tr, sys, { bands: [10_000, 100_000] });
  assert.equal(s.enabled, true);
  assert.deepEqual(s.depth.map((d) => d.troves), [1, 2]);
  assert.equal(queuePosition(s, '0xb').position, 2);
  assert.equal(queuePosition(s, '0xC'), null);
  assert.equal(redemptionSummary(tr, { ...sys, debt: E(200000) }).enabled, false);
});
