import test from 'node:test';
import assert from 'node:assert/strict';
import { C } from '../src/config.mjs';
import { windows, OP_NAMES, toChanges, sampleBlocks, troveHistory, historyChart, summary, freeze, revive } from '../src/trove-history.mjs';

const BORROWER = '0x20b854C2fCB761DF9f18b27cCBfBeD7276070D7B';
const E = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const log = (address, block, index, op, coll = 1) => ({
  address, blockNumber: BigInt(block), logIndex: index, transactionHash: `0x${block.toString(16)}`, eventName: 'TroveUpdated',
  args: { _borrower: BORROWER, _principal: E(2000), _interest: E(1), _coll: E(coll), _operation: op },
});

function mockClient({ head, logs }) {
  const calls = { getLogs: [], reads: [] };
  return {
    calls,
    getBlockNumber: async () => head,
    getLogs: async ({ address, fromBlock, toBlock, args }) => {
      calls.getLogs.push([address, fromBlock, toBlock]);
      assert.equal(args._borrower, BORROWER);
      return logs.filter((l) => l.address === address && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    getBlock: async ({ blockNumber }) => ({ timestamp: 1_700_000_000n + blockNumber * 2n }),
    readContract: async ({ functionName, blockNumber }) => {
      calls.reads.push([functionName, blockNumber]);
      const c = logs.filter((l) => l.blockNumber < blockNumber).at(-1)?.args._coll ?? E(1);
      return {
        fetchPrice: E(100000),
        getCurrentICR: (c * E(100000)) / E(2001),
        getEntireDebtAndColl: [c, E(2000), E(1), 0n, 0n, 0n],
        getTroveStatus: 1,
      }[functionName];
    },
  };
}

test('windows never exceed the 10k getLogs limit and cover the range exactly once', () => {
  const w = windows(5n, 25_004n);
  assert.deepEqual(w, [[5n, 10_004n], [10_005n, 20_004n], [20_005n, 25_004n]]);
  assert.deepEqual(windows(7n, 7n), [[7n, 7n]]);
});

test('changes are sorted by block and log index and op names follow the emitter', () => {
  const tm = C.troveManager.address, bo = C.borrowerOperations.address;
  const ch = toChanges([log(tm, 20, 3, 2), log(bo, 10, 1, 3), log(bo, 20, 1, 2)]);
  assert.deepEqual(ch.map((c) => [c.block, c.emitter, c.op]), [
    [10n, 'BorrowerOperations', 'refinance'], [20n, 'BorrowerOperations', 'adjust'], [20n, 'TroveManager', 'redeemCollateral'],
  ]);
  assert.equal(OP_NAMES.TroveManager[1], 'liquidate');
  assert.equal(ch[0].debt, 2001);
});

test('sampling adds the blocks around every change and stays inside the range', () => {
  const b = sampleBlocks(100n, 200n, 4, [{ block: 130n }, { block: 200n }, { block: 50n }]);
  assert.deepEqual(b, [100n, 125n, 129n, 131n, 150n, 175n, 199n, 200n]);
});

test('history scans both emitters per window, reads each sample at its block and resumes from a cache', async () => {
  const bo = C.borrowerOperations.address;
  const pc = mockClient({ head: 25_000n, logs: [log(bo, 5_000, 0, 0, 1), log(bo, 15_000, 0, 2, 2)] });
  const h = await troveHistory(pc, BORROWER, { fromBlock: 1n, samples: 5 });
  assert.equal(pc.calls.getLogs.length, 6);
  assert.deepEqual(h.changes.map((c) => c.op), ['open', 'adjust']);
  assert.equal(h.changes[1].ts, 1_700_000_000 + 15_001 * 2);
  const after = h.points.find((p) => p.block === 15_001n);
  assert.equal(after.coll, 2);
  assert.equal(after.icr, 9995);
  assert.ok(pc.calls.reads.every(([, b]) => b !== undefined), 'every read is pinned to a block');
  assert.deepEqual(summary(h), { minICR: 4997.5, maxICR: 9995, latestICR: 9995, changes: 2, points: h.points.length });

  const stored = freeze(h);
  assert.equal(typeof stored.toBlock, 'string');
  const pc2 = mockClient({ head: 30_000n, logs: [log(bo, 5_000, 0, 0, 1), log(bo, 15_000, 0, 2, 2), log(bo, 27_000, 0, 2, 3)] });
  const h2 = await troveHistory(pc2, BORROWER, { fromBlock: 1n, samples: 5, cache: stored });
  assert.deepEqual(pc2.calls.getLogs.map(([, a, b]) => [a, b]), [[25_001n, 30_000n], [25_001n, 30_000n]], 'only the new blocks');
  assert.deepEqual(h2.changes.map((c) => c.op), ['open', 'adjust', 'adjust']);
  assert.ok(h2.points.length > h.points.length);
  assert.deepEqual(revive(stored).points.map((p) => p.block), h.points.map((p) => p.block));
});

test('chart draws ICR with MCR/CCR lines and one marker per change', async () => {
  const bo = C.borrowerOperations.address;
  const h = await troveHistory(mockClient({ head: 25_000n, logs: [log(bo, 5_000, 0, 0, 0.025), log(bo, 15_000, 0, 2, 0.03)] }), BORROWER, { fromBlock: 1n, samples: 5 });
  const svg = historyChart(h);
  assert.match(svg, /ICR of 0x20b8…0D7B/);
  assert.match(svg, /MCR 110 %/);
  assert.equal(svg.match(/class="mark"/g).length, 2);
  assert.match(svg, /adjust \(BorrowerOperations\)/);
});

test('standalone SVG carries its namespace and styles', async () => {
  const { standaloneSvg, lineChart } = await import('../src/charts.mjs');
  const svg = standaloneSvg(lineChart([{ ts: 1, y: 1 }, { ts: 2, y: 2 }], { title: 't' }));
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox/);
  assert.match(svg, /<style>.*\.line\{/);
  assert.doesNotMatch(svg, /figure|figcaption/);
});

test('a cache that starts later than the requested range is not reused', async () => {
  const bo = C.borrowerOperations.address;
  const logs = [log(bo, 5_000, 0, 0, 1)];
  const h = await troveHistory(mockClient({ head: 25_000n, logs }), BORROWER, { fromBlock: 20_000n, samples: 5 });
  const pc = mockClient({ head: 25_000n, logs });
  const wide = await troveHistory(pc, BORROWER, { fromBlock: 1n, samples: 5, cache: freeze(h) });
  assert.deepEqual(wide.fetched, [[1n, 25_000n]]);
  assert.deepEqual(wide.changes.map((c) => c.op), ['open']);
});
