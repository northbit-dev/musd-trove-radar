import fs from 'node:fs';
import path from 'node:path';
import { decodeEventLog, getAbiItem } from 'viem';
import { C } from './config.mjs';

const TM = C.troveManager, SP = C.stabilityPool;
const SP_BALANCE = getAbiItem({ abi: SP.abi, name: 'StabilityPoolCollateralBalanceUpdated' });
const NAMES = ['Liquidation', 'TroveLiquidated', 'Redemption', 'TroveUpdated', 'LTermsUpdated'];
export const EVENT_ABI = NAMES.map((name) => getAbiItem({ abi: TM.abi, name }));
export const OP = { applyPendingRewards: 0, liquidate: 1, redeemCollateral: 2 };
export const MAX_WINDOW = 10_000n;
const BIG = new Set(['spGain', 'debt', 'coll', 'collGas', 'gasComp', 'attempted', 'musd', 'btc', 'fee', 'debtAfter', 'collAfter']);

export const DEFAULT_CACHE = new URL('../out/events.json', import.meta.url).pathname;

/** Decode raw TroveManager logs; anything that is not one of our events is dropped. */
export function decodeLogs(logs) {
  const out = [];
  for (const l of logs) {
    try {
      const { eventName, args } = decodeEventLog({ abi: EVENT_ABI, data: l.data, topics: l.topics });
      out.push({ name: eventName, args, block: BigInt(l.blockNumber), tx: l.transactionHash, index: Number(l.logIndex) });
    } catch {}
  }
  return out;
}

/**
 * One activity entry per liquidation or redemption transaction.
 * Redemptions do not log per-trove amounts; the hit troves come from TroveUpdated(op = redeemCollateral)
 * and carry the trove's state after the redemption.
 */
export function groupEvents(decoded) {
  const byTx = new Map();
  for (const d of [...decoded].sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1))) {
    if (!byTx.has(d.tx)) byTx.set(d.tx, []);
    byTx.get(d.tx).push(d);
  }
  const events = [];
  for (const [tx, list] of byTx) {
    const block = list[0].block;
    for (const d of list) {
      const a = d.args;
      if (d.name === 'Liquidation') {
        events.push({
          type: 'liquidation', block, tx,
          debt: a._liquidatedPrincipal + a._liquidatedInterest, coll: a._liquidatedColl,
          collGas: a._collGasCompensation, gasComp: a._gasCompensation,
          redistributed: list.some((x) => x.name === 'LTermsUpdated'),
          troves: list.filter((x) => x.name === 'TroveLiquidated').map((x) => ({ borrower: x.args._borrower, debt: x.args._debt, coll: x.args._coll })),
        });
      } else if (d.name === 'Redemption') {
        events.push({
          type: 'redemption', block, tx,
          attempted: a._attemptedAmount, musd: a._actualAmount, btc: a._collateralSent, fee: a._collateralFee,
          troves: list.filter((x) => x.name === 'TroveUpdated' && x.args._operation === OP.redeemCollateral).map((x) => ({
            borrower: x.args._borrower, debtAfter: x.args._principal + x.args._interest, collAfter: x.args._coll,
            closed: x.args._coll === 0n && x.args._principal === 0n,
          })),
        });
      }
    }
  }
  return events;
}

/** Totals over a list of activity entries. */
export function summarize(events) {
  const s = { liquidations: 0, liquidatedTroves: 0, liquidatedDebt: 0n, liquidatedColl: 0n, redemptions: 0, redeemedMusd: 0n, redeemedBtc: 0n, redeemedTroves: 0, closedByRedemption: 0 };
  const hit = new Set();
  for (const e of events) {
    if (e.type === 'liquidation') {
      s.liquidations++; s.liquidatedTroves += e.troves.length; s.liquidatedDebt += e.debt; s.liquidatedColl += e.coll;
    } else {
      s.redemptions++; s.redeemedMusd += e.musd; s.redeemedBtc += e.btc;
      for (const t of e.troves) { hit.add(t.borrower.toLowerCase()); if (t.closed) s.closedByRedemption++; }
    }
  }
  s.redeemedTroves = hit.size;
  return s;
}

const rangeError = (e) => /range|distance|too many|limit|exceed|10000|response size/i.test(`${e.shortMessage} ${e.details} ${e.message}`);

/**
 * eth_getLogs over [fromBlock, toBlock] in windows. Halves the window when the RPC rejects the range
 * and retries other errors with backoff.
 */
export async function fetchLogs(pc, { fromBlock, toBlock, window = MAX_WINDOW, retries = 3, backoffMs = 1000, onWindow } = {}) {
  const logs = [];
  let w = BigInt(window);
  for (let from = fromBlock; from <= toBlock;) {
    const to = from + w - 1n > toBlock ? toBlock : from + w - 1n;
    let done = false;
    for (let attempt = 1; ; attempt++) {
      try {
        logs.push(...await pc.getLogs({ address: TM.address, events: EVENT_ABI, fromBlock: from, toBlock: to, strict: false }));
        onWindow?.(from, to);
        done = true;
        break;
      } catch (e) {
        if (rangeError(e) && to > from) { w = (to - from + 1n) / 2n; break; }
        if (attempt > retries) throw e;
        await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
      }
    }
    if (done) from = to + 1n;
  }
  return logs;
}

const replacer = (_, v) => (typeof v === 'bigint' ? v.toString() : v);
const reviver = (k, v) => (BIG.has(k) && typeof v === 'string' ? BigInt(v) : k === 'block' || k === 'fromBlock' || k === 'toBlock' ? BigInt(v) : v);

export function readCache(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'), reviver);
    return c.address?.toLowerCase() === TM.address.toLowerCase() ? c : null;
  } catch { return null; }
}

export function writeCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, replacer));
}

/** Merge two event lists, one entry per (type, tx), ordered by block. */
export function mergeEvents(a, b) {
  const m = new Map();
  for (const e of [...a, ...b]) m.set(`${e.type}:${e.tx}`, e);
  return [...m.values()].sort((x, y) => (x.block === y.block ? 0 : x.block < y.block ? -1 : 1));
}

/**
 * BTC the Stability Pool received in one liquidation: the pool's collateral balance after the liquidation
 * minus its balance just before it. Null when the pool did not take part (fully redistributed).
 */
export async function spGainOf(pc, e) {
  const logs = (await pc.getLogs({ address: SP.address, event: SP_BALANCE, fromBlock: e.block, toBlock: e.block }))
    .sort((a, b) => a.logIndex - b.logIndex);
  const at = logs.findIndex((l) => l.transactionHash === e.tx);
  if (at < 0) return null;
  const before = at > 0 ? logs[at - 1].args._newBalance
    : await pc.readContract({ address: SP.address, abi: SP.abi, functionName: 'getCollateralBalance', blockNumber: e.block - 1n });
  const after = logs.filter((l) => l.transactionHash === e.tx).at(-1).args._newBalance;
  return after - before;
}

/**
 * Events in the last `blocks` blocks (or from `fromBlock`), using the cache so a re-run only asks the RPC
 * for blocks it has not seen. The cache always covers one contiguous range.
 */
export async function syncEvents(pc, { blocks = 100_000n, fromBlock, toBlock, file = DEFAULT_CACHE, window, log = () => {} } = {}) {
  const head = toBlock ?? await pc.getBlockNumber();
  const lo = fromBlock ?? (head > BigInt(blocks) ? head - BigInt(blocks) + 1n : 0n);
  let cache = readCache(file);
  if (cache && (cache.toBlock + 1n < lo || cache.fromBlock > head + 1n)) cache = null;
  const gaps = cache
    ? [[lo, cache.fromBlock - 1n], [cache.toBlock + 1n, head]].filter(([a, b]) => a <= b)
    : [[lo, head]];
  let fresh = [];
  for (const [a, b] of gaps) {
    log(`history: fetching blocks ${a}–${b}`);
    fresh = fresh.concat(groupEvents(decodeLogs(await fetchLogs(pc, { fromBlock: a, toBlock: b, window }))));
  }
  const needTs = [...new Set(fresh.map((e) => e.block))];
  const ts = new Map();
  for (const b of needTs) ts.set(b, Number((await pc.getBlock({ blockNumber: b })).timestamp));
  for (const e of fresh) e.timestamp = ts.get(e.block);
  const all = mergeEvents(cache?.events ?? [], fresh);
  for (const e of all) if (e.type === 'liquidation' && e.spGain === undefined) e.spGain = await spGainOf(pc, e).catch(() => undefined);
  const next = {
    address: TM.address,
    fromBlock: cache && cache.fromBlock < lo ? cache.fromBlock : lo,
    toBlock: cache && cache.toBlock > head ? cache.toBlock : head,
    events: all,
  };
  writeCache(file, next);
  return { fromBlock: lo, toBlock: head, fetched: gaps, events: all.filter((e) => e.block >= lo && e.block <= head) };
}
