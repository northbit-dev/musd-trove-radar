import { parseAbiItem } from 'viem';
import { C } from './config.mjs';
import { lineChart } from './charts.mjs';

// events.mjs is not imported: its file cache needs import.meta, which the browser bundle does not have.
export const MAX_WINDOW = 10_000n;

/** Operation names per emitter: the `_operation` enum differs between BorrowerOperations and TroveManager. */
export const OP_NAMES = {
  BorrowerOperations: ['open', 'close', 'adjust', 'refinance'],
  TroveManager: ['applyPendingRewards', 'liquidate', 'redeemCollateral'],
};

/** Split [from, to] into inclusive ranges of at most `size` blocks, the Mezo RPC's getLogs limit. */
export function windows(from, to, size = MAX_WINDOW) {
  const out = [];
  for (let f = BigInt(from); f <= to; f += BigInt(size)) out.push([f, f + BigInt(size) - 1n > to ? BigInt(to) : f + BigInt(size) - 1n]);
  return out;
}

const TroveUpdated = parseAbiItem('event TroveUpdated(address indexed _borrower,uint256 _principal,uint256 _interest,uint256 _coll,uint256 _stake,uint16 _interestRate,uint256 _lastInterestUpdateTime,uint8 _operation)');
const TroveLiquidated = parseAbiItem('event TroveLiquidated(address indexed _borrower,uint256 _debt,uint256 _coll,uint8 operation)');
export const HISTORY_EVENTS = [TroveUpdated, TroveLiquidated];
const E18 = 1e18;
const n18 = (x) => Number(x) / E18;

async function pool(jobs, size) {
  const out = [];
  for (let i = 0; i < jobs.length; i += size) out.push(...await Promise.all(jobs.slice(i, i + size).map((j) => j())));
  return out;
}

function emitterOf(address) {
  return address.toLowerCase() === C.troveManager.address.toLowerCase() ? 'TroveManager' : 'BorrowerOperations';
}

/** Decoded logs → one change per log, oldest first, with the op name for the emitter that logged it. */
export function toChanges(logs) {
  return [...logs]
    .sort((a, b) => (a.blockNumber === b.blockNumber ? Number(a.logIndex) - Number(b.logIndex) : a.blockNumber < b.blockNumber ? -1 : 1))
    .map((l) => {
      const emitter = emitterOf(l.address);
      const op = Number(l.args._operation ?? l.args.operation);
      const a = l.args;
      return {
        block: BigInt(l.blockNumber), tx: l.transactionHash, event: l.eventName, emitter,
        op: OP_NAMES[emitter][op] ?? String(op),
        coll: a._coll !== undefined ? n18(a._coll) : null,
        debt: a._principal !== undefined ? n18(a._principal + a._interest) : a._debt !== undefined ? n18(a._debt) : null,
      };
    });
}

/** TroveUpdated and TroveLiquidated for one borrower, from both emitters, in 10k-block windows. */
export async function scanChanges(pc, borrower, fromBlock, toBlock, { concurrency = 8 } = {}) {
  if (fromBlock > toBlock) return [];
  const jobs = [];
  for (const address of [C.troveManager.address, C.borrowerOperations.address]) {
    for (const [a, b] of windows(fromBlock, toBlock)) {
      jobs.push(() => pc.getLogs({ address, events: HISTORY_EVENTS, args: { _borrower: borrower }, fromBlock: a, toBlock: b }));
    }
  }
  return toChanges((await pool(jobs, concurrency)).flat());
}

/** Evenly spaced blocks plus the blocks just before and after each change, so every step in the chart is exact. */
export function sampleBlocks(fromBlock, toBlock, samples, changes = []) {
  const set = new Set([toBlock]);
  const step = (toBlock - fromBlock) / BigInt(Math.max(1, samples)) || 1n;
  for (let b = fromBlock; b <= toBlock; b += step) set.add(b);
  for (const c of changes) for (const b of [c.block - 1n, c.block + 1n]) if (b >= fromBlock && b <= toBlock) set.add(b);
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Archive reads at each block: price, ICR, debt and collateral, status and timestamp. */
export async function readPoints(pc, borrower, blocks, { concurrency = 8 } = {}) {
  const TM = C.troveManager;
  return pool(blocks.map((blockNumber) => async () => {
    const price = await pc.readContract({ ...C.priceFeed, functionName: 'fetchPrice', blockNumber });
    const [icr, entire, status, block] = await Promise.all([
      pc.readContract({ ...TM, functionName: 'getCurrentICR', args: [borrower, price], blockNumber }),
      pc.readContract({ ...TM, functionName: 'getEntireDebtAndColl', args: [borrower], blockNumber }),
      pc.readContract({ ...TM, functionName: 'getTroveStatus', args: [borrower], blockNumber }),
      pc.getBlock({ blockNumber }),
    ]);
    const active = Number(status) === 1;
    return {
      block: blockNumber, ts: Number(block.timestamp), price: n18(price), active,
      icr: active ? Number((n18(icr) * 100).toFixed(2)) : null,
      coll: n18(entire[0]), debt: n18(entire[1] + entire[2] + entire[4] + entire[5]),
    };
  }), concurrency);
}

/**
 * ICR history of one trove over [fromBlock, toBlock]. With `cache` (an earlier result for the same borrower)
 * only blocks after cache.toBlock are scanned and sampled; older points outside the range are dropped.
 */
export async function troveHistory(pc, borrower, { fromBlock, toBlock, samples = 48, cache = null, concurrency = 8 } = {}) {
  const head = toBlock ?? await pc.getBlockNumber();
  const slack = (head - fromBlock) / BigInt(Math.max(1, samples));
  const usable = cache && cache.borrower.toLowerCase() === borrower.toLowerCase() && BigInt(cache.fromBlock) <= fromBlock + slack
    && BigInt(cache.toBlock) >= fromBlock && BigInt(cache.toBlock) <= head;
  const old = usable ? revive(cache) : { changes: [], points: [] };
  const start = usable ? BigInt(cache.toBlock) + 1n : fromBlock;
  const span = head - fromBlock + 1n;
  const share = usable ? Math.max(2, Math.ceil(samples * Number(head - start + 1n) / Number(span))) : samples;
  const fresh = await scanChanges(pc, borrower, start, head, { concurrency });
  const points = start <= head ? await readPoints(pc, borrower, sampleBlocks(start, head, share, fresh), { concurrency }) : [];
  const tsAt = new Map(points.map((p) => [p.block, p.ts]));
  for (const c of fresh) c.ts = tsAt.get(c.block + 1n) ?? null;
  const keep = (x) => x.block >= fromBlock && x.block <= head;
  return {
    borrower, fromBlock, toBlock: head,
    changes: [...old.changes, ...fresh].filter(keep),
    points: [...old.points, ...points].filter(keep),
    fetched: start <= head ? [[start, head]] : [],
  };
}

export function summary(h) {
  const a = h.points.filter((p) => p.active);
  if (!a.length) return null;
  const icr = a.map((p) => p.icr);
  return { minICR: Math.min(...icr), maxICR: Math.max(...icr), latestICR: a.at(-1).icr, changes: h.changes.length, points: h.points.length };
}

/** SVG chart of ICR with MCR and CCR lines and a marker per change (adjust, refinance, guard step …). */
export function historyChart(h, { title = `ICR of ${h.borrower.slice(0, 6)}…${h.borrower.slice(-4)} (%)` } = {}) {
  const a = h.points.filter((p) => p.active);
  return lineChart(a.map((p) => ({ ts: p.ts, y: p.icr })), {
    title, unit: ' %', empty: 'No active trove in this range.',
    refs: [{ y: 110, label: 'MCR 110 %' }, { y: 150, label: 'CCR 150 %' }],
    marks: h.changes.filter((c) => c.ts).map((c) => ({ ts: c.ts, label: `${c.op} (${c.emitter})` })),
  });
}

const big = (_, v) => (typeof v === 'bigint' ? v.toString() : v);
/** JSON-safe copy (bigint blocks as strings) for a file or localStorage. */
export const freeze = (h) => JSON.parse(JSON.stringify(h, big));
export function revive(h) {
  const b = (x) => ({ ...x, block: BigInt(x.block) });
  return { ...h, fromBlock: BigInt(h.fromBlock), toBlock: BigInt(h.toBlock), changes: h.changes.map(b), points: h.points.map(b) };
}
