import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeLogs, groupEvents, summarize, fetchLogs, syncEvents, mergeEvents } from '../src/events.mjs';
import { activityRows, describeEvent } from '../src/render.mjs';

const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/trovemanager-logs.json', import.meta.url)));
const LIQ = '0x6d0f1cdb2407fdc572443802dcf48c0451b713d31afb5c40aa4123a5a2a2d68e';
const RED = '0x092903187a0c792c4fe03a46482867826468a33321f5a1f82d13239274ea4450';

function mockClient(logs, { maxRange = 10_000n, failFirst = 0 } = {}) {
  const calls = [];
  let fails = failFirst;
  return {
    calls,
    getBlockNumber: async () => 16_460_000n,
    getBlock: async ({ blockNumber }) => ({ timestamp: 1_793_000_000n + blockNumber }),
    getLogs: async ({ fromBlock, toBlock }) => {
      calls.push([fromBlock, toBlock]);
      if (fails-- > 0) throw new Error('fetch failed');
      if (toBlock - fromBlock + 1n > maxRange) throw Object.assign(new Error('bad'), { details: `maximum [from, to] blocks distance: ${maxRange}` });
      return logs.filter((l) => BigInt(l.blockNumber) >= fromBlock && BigInt(l.blockNumber) <= toBlock);
    },
  };
}

test('decodes real Mezo Testnet liquidation and redemption logs', () => {
  const ev = groupEvents(decodeLogs(raw));
  assert.deepEqual(ev.map((e) => e.type), ['redemption', 'liquidation']);
  const [red, liq] = ev;
  assert.equal(liq.tx, LIQ);
  assert.equal(liq.block, 16452016n);
  assert.equal(liq.debt, 2212591029431012025495n);
  assert.equal(liq.gasComp, 200n * 10n ** 18n);
  assert.deepEqual(liq.troves.map((t) => t.borrower), ['0xDA04759E54728B6636Fe48F7c9795c7B609bAaAa']);
  assert.equal(red.tx, RED);
  assert.equal(red.musd, 3166967792490114388n);
  assert.equal(red.btc, 39350429168694n);
  assert.equal(red.troves.length, 1);
  assert.equal(red.troves[0].closed, false);
});

test('summarize aggregates liquidations and redemptions', () => {
  const ev = groupEvents(decodeLogs(raw));
  const s = summarize([...ev, { ...ev[0], tx: '0x01', troves: [{ ...ev[0].troves[0], closed: true }] }]);
  assert.equal(s.liquidations, 1);
  assert.equal(s.liquidatedTroves, 1);
  assert.equal(s.redemptions, 2);
  assert.equal(s.redeemedMusd, 2n * 3166967792490114388n);
  assert.equal(s.redeemedTroves, 1);
  assert.equal(s.closedByRedemption, 1);
});

test('fetchLogs halves the window on a range error and retries transient errors', async () => {
  const pc = mockClient(raw, { maxRange: 3_000n, failFirst: 1 });
  const logs = await fetchLogs(pc, { fromBlock: 16_350_001n, toBlock: 16_460_000n, window: 10_000n, backoffMs: 1 });
  assert.equal(logs.length, raw.length);
  const ok = pc.calls.filter(([a, b]) => b - a + 1n <= 3_000n);
  let next = 16_350_001n;
  for (const [a, b] of ok) { assert.equal(a, next); next = b + 1n; }
  assert.equal(next, 16_460_001n);
});

test('syncEvents caches and only fetches new blocks on the next run', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), 'events.json');
  const first = mockClient(raw.filter((l) => l.transactionHash === RED));
  const a = await syncEvents(first, { blocks: 100_000n, toBlock: 16_400_000n, file });
  assert.equal(a.events.length, 1);
  assert.equal(a.events[0].timestamp, 1_793_000_000 + 16359628);
  const second = mockClient(raw);
  const b = await syncEvents(second, { blocks: 110_000n, toBlock: 16_460_000n, file });
  assert.deepEqual(b.fetched, [[16_400_001n, 16_460_000n]]);
  assert.ok(second.calls.every(([from]) => from > 16_400_000n));
  assert.deepEqual(b.events.map((e) => e.type), ['redemption', 'liquidation']);
  const c = await syncEvents(mockClient([]), { blocks: 110_000n, toBlock: 16_460_000n, file });
  assert.deepEqual(c.fetched, []);
  assert.equal(c.events.length, 2);
  assert.equal(typeof c.events[1].debt, 'bigint');
});

test('mergeEvents keeps one entry per transaction', () => {
  const ev = groupEvents(decodeLogs(raw));
  assert.equal(mergeEvents(ev, ev).length, 2);
});

test('activity rows and CLI lines link to the explorer, newest first', () => {
  const ev = groupEvents(decodeLogs(raw)).map((e) => ({ ...e, timestamp: 1_793_313_138 }));
  const rows = activityRows(ev);
  assert.ok(rows.indexOf('Liquidation') < rows.indexOf('Redemption'));
  assert.match(rows, new RegExp(`/tx/${LIQ}`));
  assert.match(describeEvent(ev[1]), /LIQUIDATION .*2,212\.59 MUSD/);
});
