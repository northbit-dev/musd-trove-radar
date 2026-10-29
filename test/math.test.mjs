import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ONE, MAX_ICR, icr, liquidationPrice, recoveryTriggerPrice, dropTo, bucketize, stress, byRisk, fmt } from '../src/math.mjs';
import { analyze, troveHealth } from '../src/analyze.mjs';
import { markdown, html, cov } from '../src/render.mjs';

const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // float -> 1e18
const MCR = E(1.1), CCR = E(1.5), PRICE = E(80000);
const T = (owner, coll, debt, price = PRICE) => ({ owner, coll: E(coll), debt: E(debt), icr: icr(E(coll), E(debt), price), liqPrice: liquidationPrice(E(coll), E(debt), MCR) });

test('icr: 1 BTC at $80k against 40k MUSD is 200 %', () => {
  assert.equal(icr(E(1), E(40000), PRICE), E(2));
  assert.equal(icr(E(1), 0n, PRICE), MAX_ICR);
});

test('liquidation price makes ICR exactly MCR', () => {
  const lp = liquidationPrice(E(0.5), E(20000), MCR);
  assert.equal(lp, E(44000));
  assert.equal(icr(E(0.5), E(20000), lp), MCR);
});

test('recovery trigger and drop', () => {
  const rp = recoveryTriggerPrice(E(10), E(400000), CCR); // 400k*1.5/10 = 60k
  assert.equal(rp, E(60000));
  assert.equal(dropTo(PRICE, rp), 0.25);
  assert.ok(dropTo(PRICE, E(90000)) < 0);
});

test('bucketize puts troves at the right ICR band, edges inclusive-low', () => {
  const tr = [T('a', 1, 80000 / 1.05), T('b', 1, 80000 / 1.1), T('c', 1, 80000 / 1.6), T('d', 1, 10000)];
  const b = bucketize(tr);
  assert.deepEqual(b.map((x) => x.count), [1, 1, 0, 1, 0, 1]);
});

test('stress: deeper shocks never reduce liquidations and flip recovery mode', () => {
  const tr = [T('a', 1, 60000), T('b', 1, 50000), T('c', 2, 40000)];
  const sys = { coll: E(4), debt: E(150000) };
  const s = stress(tr, sys, PRICE, MCR, CCR, [0, 0.1, 0.3, 0.5]);
  for (let i = 1; i < s.length; i++) assert.ok(s[i].liquidatable >= s[i - 1].liquidatable);
  assert.equal(s[0].liquidatable, 0);
  assert.equal(s[0].recoveryMode, false); // TCR 213 %
  assert.equal(s[3].recoveryMode, true); // TCR 106 %
});

test('analyze + health + render on synthetic state', () => {
  const tr = [T('0x' + '1'.repeat(40), 1, 75000), T('0x' + '2'.repeat(40), 1, 60000), T('0x' + '3'.repeat(40), 1, 20000)];
  const sys = { blockNumber: 1n, timestamp: 1_700_000_000, price: PRICE, mcr: MCR, ccr: CCR, coll: E(3), debt: E(155000), spDeposits: E(1000), musdSupply: E(155000), interestRateBps: 100 };
  const r = analyze(sys, tr);
  assert.equal(r.liquidatable.count, 1);
  assert.equal(r.atRisk.count, 1);
  assert.equal(r.riskiest[0].owner, '0x' + '1'.repeat(40));
  assert.ok(r.system.spCoverage < 1);
  assert.match(cov(r.system.spCoverage), /redistributed/);
  assert.equal(troveHealth(tr[0], sys).level, 'LIQUIDATABLE');
  assert.equal(troveHealth(tr[1], sys).level, 'warning');
  assert.equal(troveHealth(tr[2], sys).level, 'ok');
  assert.equal(troveHealth(undefined, sys).level, 'none');
  assert.match(markdown(r), /Liquidatable now \| 1 troves/);
  assert.match(html(r), /<!doctype html>/);
  assert.ok(!/<script/i.test(html(r)), 'dashboard is static');
});

test('sort and format helpers', () => {
  const a = [{ icr: 3n }, { icr: 1n }, { icr: 2n }].sort(byRisk);
  assert.deepEqual(a.map((x) => x.icr), [1n, 2n, 3n]);
  assert.equal(fmt(E(1234567.891)), '1,234,567.89');
  assert.equal(fmt(ONE / 2n, 0), '0');
});
