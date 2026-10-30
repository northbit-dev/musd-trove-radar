import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { liquidationReward, profitOf, liquidationProfit, protectProfit, toWei } from '../src/profit.mjs';
import { loop, backoff } from '../src/daemon.mjs';
import { makeLogger } from '../src/log.mjs';
import { runKeeper, loadAccount, runProtectKeeper } from '../src/keeper.mjs';
import { KIND } from '../src/permits.mjs';

delete process.env.MEZO_KEY_FILE;
delete process.env.MEZO_PRIVATE_KEY;
const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const PRICE = E(80000), GP = 10n ** 7n;
const owner = (c) => '0x' + c.repeat(40);

test('liquidation reward is 200 MUSD plus 0.5 % of collateral, valued against gas at the BTC price', () => {
  assert.deepEqual(liquidationReward({ coll: 29938000000000000n }), { musd: E(200), btc: 149690000000000n });
  const p = liquidationProfit({ coll: E(0.1) }, { gas: 500_000n, gasPrice: GP, price: PRICE });
  assert.equal(p.reward, E(240));
  assert.equal(p.cost, E(0.4));
  assert.equal(p.profit, E(239.6));
  assert.equal(p.ok, true);
  const tight = liquidationProfit({ coll: E(0.1) }, { gas: 500_000n, gasPrice: GP, price: PRICE, minProfit: E(240) });
  assert.equal(tight.ok, false);
  assert.match(tight.reason, /^unprofitable: reward 240\.0000 MUSD − gas 0\.4000 MUSD < min 240\.0000 MUSD$/);
  assert.equal(profitOf({ musd: E(1), gas: null, gasPrice: 1n, price: PRICE }).reason, 'no gas estimate');
  const tip = protectProfit({ tip: E(0.00001) }, { gas: 400_000n, gasPrice: GP, price: PRICE });
  assert.equal(tip.profit, E(0.8) - E(0.32));
  assert.equal(protectProfit({ tip: 0n }, { gas: 1n, gasPrice: 1n, price: PRICE }).ok, false);
  assert.equal(toWei('215'), E(215));
  assert.equal(toWei('0.25'), E(0.25));
});

const report = (troves) => ({ price: PRICE, liquidatable: { count: troves.length, troves } });
function mockPc({ revert = new Set(), gas = 450_000n, gasPrice = GP } = {}) {
  const calls = [];
  return {
    calls,
    getGasPrice: async () => gasPrice,
    simulateContract: async (req) => {
      calls.push(req);
      const who = req.args[0];
      if ((Array.isArray(who) ? who : [who]).some((a) => revert.has(a))) throw Object.assign(new Error('x'), { shortMessage: 'execution reverted: nothing to liquidate' });
      return { request: req };
    },
    estimateContractGas: async () => gas,
  };
}

test('keeper dry-run: a reverting trove and an unprofitable trove are skipped with a reason, the rest is batched', async () => {
  const A = owner('a'), B = owner('b'), Cc = owner('c');
  const pc = mockPc({ revert: new Set([B]) });
  const logs = [];
  const r = await runKeeper(pc, report([{ owner: A, icr: E(1.05), coll: E(0.05) }, { owner: B, icr: E(1.06), coll: E(1) }, { owner: Cc, icr: E(1.07), coll: E(0.5) }]), {
    minProfit: E(250), log: (msg, f) => logs.push(f),
  });
  assert.deepEqual(r.targets.map((t) => t.owner), [Cc]);
  assert.deepEqual(r.skipped.map((t) => [t.owner, t.reason.split(':')[0]]), [[A, 'unprofitable'], [B, 'dry-run revert']]);
  assert.equal(r.tx, null);
  assert.deepEqual(logs.map((l) => l.event), ['liquidate.skip', 'liquidate.skip', 'liquidate.target', 'liquidate.dryrun']);
  assert.equal(pc.calls.at(-1).functionName, 'liquidate');
  const two = await runKeeper(mockPc(), report([{ owner: A, icr: E(1.05), coll: E(0.05) }, { owner: Cc, icr: E(1.07), coll: E(0.5) }]), { log: () => {} });
  assert.equal(two.targets.length, 2);
  assert.equal(two.sim.ok, true);
  await assert.rejects(runKeeper(mockPc(), report([{ owner: A, icr: E(1.05), coll: E(0.05) }]), { send: true, log: () => {} }), /no testnet key/);
});

test('protect keeper skips a guard whose tip does not pay for gas', async () => {
  const G = { address: owner('9'), abi: [] };
  const B = owner('d');
  const reads = { guardedCount: 1n, guardedSlice: [B], getNominalICR: E(1.2), getTroveColl: E(0.05), getTrovePrincipal: E(3000), getTroveOwnersCount: 100n, getApproxHint: [B, 0n, 0n], findInsertPosition: [B, B], fetchPrice: PRICE };
  const pc = (tip) => ({
    readContract: async ({ functionName }) => reads[functionName],
    multicall: async () => [{ status: 'success', result: [true, E(1.2), E(1.3), 4n, KIND.AddColl, E(0.002), E(0.01), 0n] }, { status: 'success', result: [E(1.3), tip, 1n, true] }],
    simulateContract: async (req) => ({ request: req }),
    estimateContractGas: async () => 400_000n,
    getGasPrice: async () => GP,
  });
  const [cheap] = await runProtectKeeper(pc(E(0.000001)), null, { guard: G, minProfit: E(0.5), log: () => {} });
  assert.equal(cheap.ok, false);
  assert.match(cheap.reason, /^unprofitable/);
  const [paid] = await runProtectKeeper(pc(E(0.0001)), null, { guard: G, minProfit: E(0.5), log: () => {} });
  assert.equal(paid.ok, true);
  assert.equal(paid.tx, null);
  assert.equal(paid.profit, E(8) - E(0.32));
});

test('loop: RPC errors back off exponentially up to the cap, a success resets the delay, abort stops it', async () => {
  const sleeps = [], logs = [];
  let n = 0;
  const outcomes = ['fail', 'fail', 'fail', 'ok', 'fail', 'ok'];
  const stats = await loop(async () => { if (outcomes[n++] === 'fail') throw new Error('fetch failed'); }, {
    intervalMs: 1000, maxBackoffMs: 5000, rounds: outcomes.length, sleep: async (ms) => sleeps.push(ms), log: (m, f) => logs.push(f),
  });
  assert.deepEqual(stats, { ok: 2, failed: 4 });
  assert.deepEqual(sleeps, [2000, 4000, 5000, 1000, 2000]);
  assert.equal(logs[0].level, 'error');
  assert.equal(logs[0].retryInMs, 2000);
  assert.equal(backoff(0, 1000, 5000), 1000);
  const ctl = new AbortController();
  let rounds = 0;
  await loop(async () => { if (++rounds === 3) ctl.abort(); }, { intervalMs: 1, signal: ctl.signal, sleep: async () => {} });
  assert.equal(rounds, 3);
});

test('structured log lines are JSON with BigInts as strings', () => {
  let line = '';
  const log = makeLogger({ json: true, out: { write: (s) => { line += s; } }, now: () => 'T' });
  log('hi', { event: 'x', gas: 5n });
  assert.deepEqual(JSON.parse(line), { ts: 'T', level: 'info', msg: 'hi', event: 'x', gas: '5' });
});

test('loadAccount: key from env, refuses group-readable files and files inside the repo', () => {
  const pk = generatePrivateKey();
  assert.equal(loadAccount(undefined, pk).address, privateKeyToAccount(pk).address);
  assert.equal(loadAccount(undefined, undefined), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-'));
  const f = path.join(dir, 'k');
  fs.writeFileSync(f, pk.slice(2), { mode: 0o644 });
  assert.throws(() => loadAccount(f), /chmod 600/);
  fs.chmodSync(f, 0o600);
  assert.equal(loadAccount(f).address, privateKeyToAccount(pk).address);
  const inside = new URL('../out/.test-key', import.meta.url).pathname;
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, pk, { mode: 0o600 });
  try { assert.throws(() => loadAccount(inside), /inside the repository/); } finally { fs.rmSync(inside); }
});
