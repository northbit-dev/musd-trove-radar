import fs from 'node:fs';
import path from 'node:path';
import { fmt } from './math.mjs';

const n = (x, dp = 2) => Number(fmt(x, dp).replace(/,/g, ''));

/** One history point per dashboard build. Plain numbers so the file stays readable and small. */
export function historyRow(r) {
  return {
    block: Number(r.block), ts: r.timestamp,
    tcr: n(r.system.tcr * 100n, 2), price: n(r.price, 2),
    troves: r.system.troves, debt: n(r.system.debt, 0),
    liquidatable: r.liquidatable.count, liquidatableDebt: n(r.liquidatable.debt, 0),
    sp: n(r.system.spDeposits, 0), spColl: n(r.system.spColl ?? 0n, 6),
  };
}

/** Add rows, one per block, oldest first, keeping the newest `max`. */
export function mergeHistory(rows, add, { max = 5000 } = {}) {
  const m = new Map(rows.map((x) => [x.block, x]));
  for (const x of [].concat(add)) m.set(x.block, x);
  return [...m.values()].sort((a, b) => a.block - b.block).slice(-max);
}

export function readHistory(file) {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(rows) ? rows.filter((x) => Number.isFinite(x?.block) && Number.isFinite(x?.ts)) : [];
  } catch { return []; }
}

export function writeHistory(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows) + '\n');
}

/** Evenly spaced past blocks for an archive backfill, oldest first, excluding the head itself. */
export function backfillBlocks(head, span, count) {
  if (count <= 0 || span <= 0) return [];
  const step = Math.max(1, Math.floor(span / count));
  return Array.from({ length: count }, (_, i) => head - step * (count - i)).filter((b) => b > 0);
}

const DAY = 86_400;

/** Liquidations and redemptions per UTC day from TroveManager events, including empty days. */
export function dailyActivity(events, { toTs, days = 30 } = {}) {
  const end = Math.floor((toTs ?? Math.max(0, ...events.map((e) => e.timestamp ?? 0))) / DAY);
  const out = Array.from({ length: days }, (_, i) => ({ day: (end - days + 1 + i) * DAY, redemptions: 0, redeemed: 0, liquidations: 0, liquidated: 0 }));
  const first = out[0].day / DAY;
  for (const e of events) {
    if (!e.timestamp) continue;
    const d = out[Math.floor(e.timestamp / DAY) - first];
    if (!d) continue;
    if (e.type === 'redemption') { d.redemptions++; d.redeemed += Number(e.musd) / 1e18; }
    else { d.liquidations += e.troves.length || 1; d.liquidated += Number(e.debt) / 1e18; }
  }
  return out;
}

/** BTC the Stability Pool gained from the liquidations in `events` (entries with a known gain only). */
export function spGains(events) {
  const liq = events.filter((e) => e.type === 'liquidation');
  const known = liq.filter((e) => typeof e.spGain === 'bigint');
  return { btc: known.reduce((a, e) => a + e.spGain, 0n), liquidations: liq.length, known: known.length, offset: known.filter((e) => e.spGain > 0n).length };
}
