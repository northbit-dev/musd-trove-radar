import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.mjs';
import { html, liveParts, statusLine } from '../src/render.mjs';
import { bundleRadarApp, browserConfigModule, LIVE_READS } from '../src/radar-page.mjs';
import { NETWORK } from '../src/config.mjs';

const E = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const T = (owner, coll, debt, price = E(100000)) => ({ owner, coll: E(coll), debt: E(debt), principal: E(debt), interest: 0n, interestRateBps: 100, icr: (E(coll) * price) / E(debt), liqPrice: (E(debt) * E(1.1)) / E(coll) });
const sys = { blockNumber: 42n, timestamp: 1_700_000_000, price: E(100000), mcr: E(1.1), ccr: E(1.5), coll: E(3), debt: E(155000), spDeposits: E(1000), musdSupply: E(155000), interestRateBps: 100 };
const r = analyze(sys, [T('0x' + '1'.repeat(40), 1, 75000), T('0x' + '2'.repeat(40), 1, 60000), T('0x' + '3'.repeat(40), 1, 20000)]);

test('every live part has a wrapper in the page, filled with the same HTML the browser re-renders', () => {
  const page = html(r);
  for (const [k, v] of Object.entries(liveParts(r))) {
    const open = new RegExp(`id="live-${k}"[^>]*>`);
    assert.match(page, open, `wrapper live-${k}`);
    assert.ok(page.includes(v), `server render of ${k} matches liveParts`);
  }
  assert.match(statusLine(r, { live: true, updated: '10:00' }), /Live from the Mezo RPC · block <b id="blk">42<\/b>.*updated 10:00/);
  assert.match(statusLine(r), /snapshot<\/span> Snapshot from block <b id="blk">42<\/b>/);
});

test('radar.js bundles without node built-ins, only reads, and talks to the Mezo RPC only', async () => {
  const cfg = browserConfigModule();
  assert.ok(cfg.includes(NETWORK.rpc));
  for (const names of Object.values(LIVE_READS)) for (const n of names) assert.ok(cfg.includes(`"name":"${n}"`), n);
  assert.doesNotMatch(cfg, /"stateMutability":"(nonpayable|payable)"/, 'browser config carries view functions only');
  const js = await bundleRadarApp();
  assert.doesNotMatch(js, /readFileSync|node:fs/);
  assert.doesNotMatch(js, /privateKey|PRIVATE_KEY|MEZO_KEY_FILE|eth_sendTransaction/);
  assert.match(js, /live-/);
});
