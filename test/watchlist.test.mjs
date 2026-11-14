import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icr, liquidationPrice } from '../src/math.mjs';
import { analyze } from '../src/analyze.mjs';
import { KEY, load, save, add, remove, tick, notification } from '../src/web/watchlist.mjs';

const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
function report(price) {
  const P = E(price);
  const tr = [[A, 1, 70000], [B, 1, 20000]].map(([owner, coll, debt]) => ({ owner, coll: E(coll), debt: E(debt), principal: E(debt), icr: icr(E(coll), E(debt), P), liqPrice: liquidationPrice(E(coll), E(debt), E(1.1)) }));
  return analyze({ blockNumber: 7n, timestamp: 1_700_000_000, price: P, mcr: E(1.1), ccr: E(1.5), coll: E(2), debt: E(90000), spDeposits: 0n, musdSupply: 0n, interestRateBps: 100 }, tr);
}
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test('a healthy trove is added silently and alerts once per level change, never on repeats', () => {
  let s = add(load(memory()), B, { warn: 4, crit: 3 });
  let t = tick(s, report(100000));
  assert.deepEqual(t.alerts, []);
  assert.equal(t.rows[0].level, 'ok');
  t = tick(t.state, report(100000));
  assert.deepEqual(t.alerts, []);
  t = tick(t.state, report(70000));
  assert.deepEqual(t.alerts.map((a) => [a.level, a.worse]), [['warning', true]]);
  t = tick(t.state, report(70000));
  assert.deepEqual(t.alerts, []);
  t = tick(t.state, report(100000));
  assert.deepEqual(t.alerts.map((a) => [a.level, a.worse]), [['ok', false]]);
});

test('a trove already in trouble alerts on the first look, with its own thresholds', () => {
  const s = add(add(empty(), A, { warn: 1.3, crit: 1.15 }), B, { warn: 6, crit: 5 });
  const t = tick(s, report(82000));
  assert.deepEqual(t.alerts.map((a) => [a.address, a.level]), [[A, 'warning'], [B, 'critical']]);
  const n = notification(t.alerts[0]);
  assert.equal(n.tag, A);
  assert.match(n.body, /WARNING · ICR 117\.1 %/);
});

test('Recovery Mode alerts on a change after the first tick, and only while something is watched', () => {
  let t = tick(add(empty(), B), report(100000));
  t = tick(t.state, report(60000));
  const sys = t.alerts.find((a) => a.kind === 'system');
  assert.equal(sys.recoveryMode, true);
  assert.equal(notification(sys).tag, 'recovery-mode');
  assert.equal(tick(remove(t.state, B.toUpperCase().replace('0X', '0x')), report(100000)).alerts.length, 0);
});

test('state survives a reload, re-adding resets the level, and bad input or storage is refused', () => {
  const st = memory();
  let s = tick(add(load(st), A), report(82000)).state;
  save(st, s);
  assert.equal(load(st).items[0].key, s.items[0].key);
  s = add(load(st), A, { warn: 1.6, crit: 1.3 });
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].key, null);
  assert.throws(() => add(s, '0x1234'), /address/);
  assert.throws(() => add(s, B, { warn: 1.2, crit: 1.3 }), /critical/);
  st.setItem(KEY, '{nope');
  assert.deepEqual(load(st), { items: [], recoveryMode: null });
});

function empty() { return load(memory()); }
