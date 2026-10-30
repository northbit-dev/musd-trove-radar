import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { historyRow, mergeHistory, readHistory, writeHistory, backfillBlocks, dailyActivity, spGains } from '../src/history.mjs';
import { lineChart, barChart } from '../src/charts.mjs';
import { analyze } from '../src/analyze.mjs';
import { html, trendCharts, guardData } from '../src/render.mjs';
import { spGainOf } from '../src/events.mjs';
import { KIND } from '../src/permits.mjs';

const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const T = (owner, coll, debt) => ({ owner, coll: E(coll), debt: E(debt), principal: E(debt), interest: 0n, interestRateBps: 100, icr: (E(coll) * E(80000)) / E(debt), liqPrice: (E(debt) * E(1.1)) / E(coll) });
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40);
const sys = { blockNumber: 100n, timestamp: 1_700_000_000, price: E(80000), mcr: E(1.1), ccr: E(1.5), coll: E(2), debt: E(80000), spDeposits: E(5000), spColl: E(0.25), musdSupply: 0n, interestRateBps: 100 };
const report = analyze(sys, [T(A, 1, 75000), T(B, 1, 5000)]);
const DAY = 86_400;

test('historyRow keeps the numbers a trend chart needs; mergeHistory dedupes by block, sorts and caps', () => {
  const row = historyRow(report);
  assert.deepEqual(row, { block: 100, ts: 1_700_000_000, tcr: 200, price: 80000, troves: 2, debt: 80000, liquidatable: 1, liquidatableDebt: 75000, sp: 5000, spColl: 0.25 });
  const rows = mergeHistory([{ block: 90, ts: 1 }, { block: 100, ts: 0 }], [row, { block: 80, ts: 0 }], { max: 2 });
  assert.deepEqual(rows.map((r) => r.block), [90, 100]);
  assert.equal(rows[1].tcr, 200);
});

test('history.json survives a round trip and a corrupt file reads as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  const f = path.join(dir, 'h.json');
  assert.deepEqual(readHistory(f), []);
  writeHistory(f, [historyRow(report)]);
  assert.equal(readHistory(f)[0].block, 100);
  fs.writeFileSync(f, '{not json');
  assert.deepEqual(readHistory(f), []);
  assert.deepEqual(backfillBlocks(1000, 300, 3), [700, 800, 900]);
});

test('dailyActivity buckets events per UTC day, including empty days; spGains sums only measured liquidations', () => {
  const day0 = 20_000 * DAY;
  const ev = [
    { type: 'redemption', timestamp: day0 + 10, musd: E(100), troves: [] },
    { type: 'redemption', timestamp: day0 + 20, musd: E(50), troves: [] },
    { type: 'liquidation', timestamp: day0 + 2 * DAY, debt: E(1000), troves: [{}, {}], spGain: E(0.01) },
    { type: 'liquidation', timestamp: day0 + 2 * DAY + 5, debt: E(1), troves: [{}], spGain: undefined },
  ];
  const d = dailyActivity(ev, { toTs: day0 + 2 * DAY + 100, days: 4 });
  assert.deepEqual(d.map((x) => [x.day - day0, x.redemptions, x.redeemed, x.liquidations]), [[-DAY, 0, 0, 0], [0, 2, 150, 0], [DAY, 0, 0, 0], [2 * DAY, 0, 0, 3]]);
  assert.deepEqual(spGains(ev), { btc: E(0.01), liquidations: 2, known: 1, offset: 1 });
});

test('charts are inline SVG with a text description; fewer than two points renders an empty state', () => {
  const pts = [{ ts: 0, y: 160 }, { ts: 3600, y: 140 }, { ts: 7200, y: 155 }];
  const svg = lineChart(pts, { title: 'TCR', unit: ' %', refs: [{ y: 150, label: 'CCR' }, { y: 1000, label: 'off-scale' }] });
  assert.match(svg, /^<figure class="chart"><svg viewBox="0 0 \d+ \d+" role="img" aria-label="TCR: 3 points/);
  assert.equal((svg.match(/[ML]\d/g) ?? []).length, 3);
  assert.match(svg, />CCR</);
  assert.doesNotMatch(svg, /off-scale/);
  assert.match(svg, /latest 155 %/);
  assert.match(lineChart(pts.slice(0, 1), { title: 'TCR' }), /Not enough history yet: 1 point\./);
  const bars = barChart([{ day: 0, y: 2 }, { day: DAY, y: 0 }], { title: 'Redeemed <b>' });
  assert.equal((bars.match(/<rect /g) ?? []).length, 2);
  assert.match(bars, /Redeemed &lt;b&gt;/);
});

test('without history the liquidatable chart falls back to liquidations per day from events', () => {
  assert.match(trendCharts({ history: [], events: [], toTs: 1_700_000_000 }), /Troves liquidated per day \(from events\)/);
  const h = [historyRow(report), { ...historyRow(report), block: 101, ts: 1_700_003_600, liquidatable: 0 }];
  assert.match(trendCharts({ history: h, events: [], toTs: 1_700_003_600 }), /aria-label="Liquidatable troves: 2 points/);
});

test('dashboard: trends, Stability Pool section and guard status embedded for the lookup', () => {
  const guards = [
    { borrower: A, active: true, protectable: true, trigger: E(1.6), nonce: 4n, kind: KIND.RepayMUSD, amount: E(100), reserve: E(0.002), musdReserve: E(100) },
    { borrower: B, active: false, protectable: false, trigger: E(2), nonce: 5n, kind: 0, amount: 0n, reserve: 0n, musdReserve: 0n },
    { borrower: '0x' + '3'.repeat(40), error: 'reverted' },
  ];
  assert.deepEqual(guardData(guards), { [A]: [true, 160, 0.002, 100, 'RepayMUSD 100 MUSD', true, 4], [B]: [false, 200, 0, 0, null, false, 5] });
  const page = html(report, { history: [historyRow(report)], guards, guardPage: true, activity: { fromBlock: 1n, toBlock: 100n, events: [] } });
  for (const id of ['trends', 'sp', 'spf', 'spres']) assert.match(page, new RegExp(`id="${id}"`));
  assert.match(page, /0\.250000 BTC/);
  assert.match(page, /guard\.html\?borrower=/);
  assert.match(page, /"g":\{"0x1111111111111111111111111111111111111111":\[true,160/);
  assert.match(page, /"sel":\{"gain":"0x[0-9a-f]{8}","dep":"0x[0-9a-f]{8}"\}/);
  assert.doesNotMatch(page, /<script[^>]+src=/);
});

test('spGainOf: pool balance after the liquidation minus the balance before it', async () => {
  const log = (tx, logIndex, v) => ({ transactionHash: tx, logIndex, args: { _newBalance: v } });
  const pc = (logs, prev) => ({ getLogs: async () => logs, readContract: async ({ blockNumber }) => { assert.equal(blockNumber, 9n); return prev; } });
  assert.equal(await spGainOf(pc([log('0xa', 3, 150n)], 100n), { block: 10n, tx: '0xa' }), 50n);
  assert.equal(await spGainOf(pc([log('0xb', 1, 120n), log('0xa', 3, 150n), log('0xa', 4, 170n)], 0n), { block: 10n, tx: '0xa' }), 50n);
  assert.equal(await spGainOf(pc([log('0xb', 1, 120n)], 0n), { block: 10n, tx: '0xa' }), null);
});
