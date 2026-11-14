import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'viem';
import {
  KIND, REASON, permitTypedData, toPermit, parseStatus, parseConfig, describeRung,
  parseSteps, malformed, icrPath, rungsPerCall, reserveNeeded, musdNeeded, guardRow, debtFloorRung,
} from '../src/permits.mjs';
import { guardData } from '../src/render.mjs';

const E = (x) => parseEther(String(x));

const borrower = '0x00000000000000000000000000000000000000b0';
const base = { borrower, nonce: 7n, deadline: 99n, chainId: 31611, verifyingContract: '0xD757e3646AF370b15f32EB557F0F8380Df7D639e' };

test('v2 single-amount rungs still sign as before', () => {
  assert.deepEqual(permitTypedData({ ...base, kind: KIND.RepayMUSD, amount: 5n }).message, { amount: 5n, borrower, nonce: 7n, deadline: 99n });
  assert.deepEqual(permitTypedData({ ...base, kind: KIND.AddColl, amount: 5n }).message, { assetAmount: 5n, borrower, nonce: 7n, deadline: 99n });
});

test('toPermit builds the storePermits struct for each version', () => {
  const r = { kind: KIND.RepayMUSD, btc: 0n, musd: 9n };
  assert.deepEqual(toPermit(r, 1n, '0xab', 2), { kind: 1, amount: 9n, deadline: 1n, signature: '0xab' });
  assert.deepEqual(toPermit(r, 1n, '0xab', 3), { kind: 1, deadline: 1n, btc: 0n, musd: 9n, signature: '0xab' });
  assert.throws(() => toPermit({ kind: KIND.Adjust, btc: 1n, musd: 1n }, 1n, '0x', 2), /v3/);
});

test('parseStatus reads the v3 Status struct, empty next permit included', () => {
  const next = { kind: 2, deadline: 5n, btc: 3n, musd: 4n, signature: '0x01' };
  const s = parseStatus(borrower, { protectable: true, reason: 2, icr: 1n, musdAhead: 8n, nonce: 3n, next, reserve: 10n, musdReserve: 11n });
  assert.equal(s.version, 3);
  assert.equal(s.reason, REASON.RedemptionFront);
  assert.equal(describeRung(s), 'Adjust +0.000000 BTC −0 MUSD');
  const empty = parseStatus(borrower, { protectable: false, reason: 0, icr: 1n, musdAhead: 0n, nonce: 3n, next: { ...next, signature: '0x' }, reserve: 0n, musdReserve: 0n });
  assert.equal(empty.amount, 0n);
});

test('parseConfig maps v2 and v3 configs to one shape', () => {
  assert.deepEqual(parseConfig([1n, 2n, 3n, true]), { trigger: 1n, tip: 2n, targetICR: 0n, redemptionBuffer: 0n, generation: 3n, maxRungs: 1, active: true });
  assert.equal(parseConfig([1n, 2n, 3n, 4n, 5n, 3, true]).maxRungs, 3);
});

test('parseSteps reads the CLI ladder spec and rejects unknown kinds', () => {
  const rungs = parseSteps('adjust:0.004/150, repay:100,add:0.002', parseEther);
  assert.deepEqual(rungs, [
    { kind: KIND.Adjust, btc: parseEther('0.004'), musd: parseEther('150') },
    { kind: KIND.RepayMUSD, btc: 0n, musd: parseEther('100') },
    { kind: KIND.AddColl, btc: parseEther('0.002'), musd: 0n },
  ]);
  assert.ok(!rungs.some(malformed));
  assert.equal(reserveNeeded(rungs, 1n), parseEther('0.006') + 3n);
  assert.equal(musdNeeded(rungs), parseEther('250'));
  assert.throws(() => parseSteps('swap:1', parseEther), /unknown rung/);
});

test('a target ICR spends rungs until the estimate reaches it, capped by maxRungs', () => {
  const price = parseEther('100000');
  const trove = { coll: parseEther('0.03'), debt: parseEther('2500'), price }; // 120 %
  const rungs = parseSteps('repay:200,repay:200,repay:200,repay:200', parseEther);
  const path = icrPath(trove, rungs);
  assert.ok(path.every((v, i) => i === 0 || v > path[i - 1]));
  assert.equal(rungsPerCall(path, { targetICR: 0n, maxRungs: 5 }), 1);
  assert.equal(rungsPerCall(path, { targetICR: parseEther('1.4'), maxRungs: 5 }), 2);
  assert.equal(rungsPerCall(path, { targetICR: parseEther('1.7'), maxRungs: 3 }), 3);
  assert.equal(rungsPerCall(path, { targetICR: parseEther('9'), maxRungs: 5 }), 4);
});

test('guardRow: v3 status takes trigger, target and maxRungs from configs; dashboard shows the redemption reason', () => {
  const C3 = '0x' + 'c'.repeat(40);
  const next = { kind: 2, deadline: 9n, btc: E(0.002), musd: E(100), signature: '0x12' };
  const st = { status: 'success', result: { protectable: true, reason: 2, icr: E(1.7), musdAhead: E(1500), nonce: 3n, next, reserve: E(0.01), musdReserve: E(200) } };
  const cfg = { status: 'success', result: [E(1.6), E(0.00001), E(2.2), E(5000), 1n, 3, true] };
  const row = guardRow(C3, st, cfg);
  assert.equal(row.trigger, E(1.6));
  assert.deepEqual(guardData([row])[C3], [true, 160, 0.01, 200, 'Adjust +0.002000 BTC −100 MUSD', true, 3, 'redemption front', 220, 3, 1500]);
  assert.equal(guardRow(C3, { status: 'failure', error: { shortMessage: 'boom' } }).error, 'boom');
});

test('debtFloorRung: finds the first repayment that would take net debt under 1,800 MUSD', () => {
  const rungs = parseSteps('adjust:0.002/50,add:0.002,repay:100', parseEther);
  assert.equal(debtFloorRung({ debt: E(2102) }, rungs), 2);
  assert.equal(debtFloorRung({ debt: E(2200) }, rungs), -1);
});
