// Borrower and system alerts. Pure functions: build events from a report,
// then keep only what changed since the previous run (so a cron job does not spam).
import { troveHealth } from './analyze.mjs';
import { queuePosition } from './redemption.mjs';
import { fmt } from './math.mjs';
import { NETWORK } from './config.mjs';

const LEVEL_RANK = { none: 0, ok: 1, warning: 2, critical: 3, LIQUIDATABLE: 4 };

/** Current state for each watched address plus system-wide flags. */
export function evaluate(report, addresses, { warn = 1.5, crit = 1.2, redeemWarn = 50_000 } = {}) {
  const byOwner = new Map((report.troves ?? []).map((t) => [t.owner.toLowerCase(), t]));
  const sys = { mcr: report.mcr, price: report.price };
  const redeemWarnWei = BigInt(Math.round(redeemWarn)) * 10n ** 18n;
  const borrowers = addresses.map((address) => {
    const t = byOwner.get(address.toLowerCase());
    const h = troveHealth(t, sys, { warn, crit });
    const q = t && report.queue ? queuePosition({ queue: report.queue }, address) : null;
    return {
      address, level: h.level,
      icr: h.icr ?? null, liqPrice: h.liqPrice ?? null, dropToLiq: h.dropToLiq ?? null,
      redemption: q ? { position: q.position, ahead: q.ahead, front: q.ahead < redeemWarnWei } : null,
    };
  });
  return {
    block: report.block, timestamp: report.timestamp, price: report.price,
    system: { recoveryMode: report.system.recoveryMode, liquidatable: report.liquidatable.count, tcr: report.system.tcr },
    borrowers,
  };
}

/** Key that changes only when something alert-worthy changes. */
const borrowerKey = (b) => `${b.level}|${b.redemption?.front ? 'front' : '-'}`;

/**
 * Compare with the previous state (from `stateFile`) and return alerts.
 * prev: { borrowers: {addr: key}, recoveryMode, liquidatable } or null (first run: alert on anything not ok).
 */
export function diff(prev, cur) {
  const alerts = [];
  const first = !prev;
  prev = prev ?? { borrowers: {}, recoveryMode: false, liquidatable: 0 };
  for (const b of cur.borrowers) {
    const key = borrowerKey(b);
    const before = prev.borrowers[b.address.toLowerCase()];
    if (before === key) continue;
    if (first && b.level === 'ok' && !b.redemption?.front) continue;
    if (first && b.level === 'none') continue;
    const wasLevel = before?.split('|')[0];
    const worse = LEVEL_RANK[b.level] > (LEVEL_RANK[wasLevel] ?? 1);
    alerts.push({ kind: 'borrower', severity: b.level === 'LIQUIDATABLE' || b.level === 'critical' ? 'high' : b.level === 'warning' || b.redemption?.front ? 'medium' : 'info', worse, ...b });
  }
  if (cur.system.recoveryMode !== prev.recoveryMode && !(first && !cur.system.recoveryMode)) {
    alerts.push({ kind: 'system', severity: cur.system.recoveryMode ? 'high' : 'info', recoveryMode: cur.system.recoveryMode, tcr: cur.system.tcr });
  }
  if (cur.system.liquidatable > 0 && cur.system.liquidatable !== prev.liquidatable) {
    alerts.push({ kind: 'keeper', severity: 'info', liquidatable: cur.system.liquidatable });
  }
  const next = {
    borrowers: Object.fromEntries(cur.borrowers.map((b) => [b.address.toLowerCase(), borrowerKey(b)])),
    recoveryMode: cur.system.recoveryMode, liquidatable: cur.system.liquidatable,
  };
  return { alerts, next };
}

const SEEN_CAP = 1000;

/**
 * Alerts for liquidation and redemption events that touch watched addresses.
 * `seen` holds `${type}:${tx}:${address}` keys from earlier ticks, so a restart never repeats an alert.
 * Redistribution alerts go only to watched borrowers with an active trove (`active`), since only they absorb the debt.
 */
export function eventAlerts(events, addresses, { seen = [], active = addresses } = {}) {
  const known = new Set(seen);
  const watched = new Map(addresses.map((a) => [a.toLowerCase(), a]));
  const open = new Set(active.map((a) => a.toLowerCase()));
  const alerts = [];
  const push = (a) => {
    const key = `${a.type}:${a.tx}:${a.address.toLowerCase()}`;
    if (known.has(key)) return;
    known.add(key);
    alerts.push(a);
  };
  for (const e of events) {
    const base = { kind: 'event', tx: e.tx, block: e.block, timestamp: e.timestamp };
    if (e.type === 'redemption') {
      for (const t of e.troves) {
        const address = watched.get(t.borrower.toLowerCase());
        if (address) push({ ...base, type: 'redeemed', severity: t.closed ? 'high' : 'medium', address, musd: e.musd, btc: e.btc, debtAfter: t.debtAfter, collAfter: t.collAfter, closed: t.closed });
      }
      continue;
    }
    const hit = new Set();
    for (const t of e.troves) {
      const address = watched.get(t.borrower.toLowerCase());
      if (!address) continue;
      hit.add(address.toLowerCase());
      push({ ...base, type: 'liquidated', severity: 'high', address, debt: t.debt, coll: t.coll });
    }
    if (!e.redistributed) continue;
    for (const [lc, address] of watched) {
      if (hit.has(lc) || !open.has(lc)) continue;
      push({ ...base, type: 'redistribution', severity: 'medium', address, liquidated: e.troves.length, debt: e.debt, coll: e.coll });
    }
  }
  return { alerts, seen: [...known].slice(-SEEN_CAP) };
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** One human-readable line per alert. */
export function describe(a) {
  if (a.kind === 'system') return a.recoveryMode
    ? `🚨 Mezo entered Recovery Mode (TCR ${fmt(a.tcr * 100n, 1)} %). Troves below 150 % can now be liquidated.`
    : `✅ Mezo left Recovery Mode (TCR ${fmt(a.tcr * 100n, 1)} %).`;
  if (a.kind === 'event') {
    const link = `${NETWORK.explorer}/tx/${a.tx}`;
    if (a.type === 'redeemed') return `${a.closed ? '🔴' : '🟠'} ${short(a.address)}: REDEEMED at block ${a.block}${a.closed ? ', trove closed' : ''} · debt now ${fmt(a.debtAfter)} MUSD, collateral ${fmt(a.collAfter, 6)} BTC (redemption of ${fmt(a.musd)} MUSD in total) · ${link}`;
    if (a.type === 'liquidated') return `🔴 ${short(a.address)}: LIQUIDATED at block ${a.block} · ${fmt(a.debt)} MUSD debt, ${fmt(a.coll, 6)} BTC collateral · ${link}`;
    return `🟡 ${short(a.address)}: REDISTRIBUTION at block ${a.block} · ${a.liquidated} trove(s) liquidated with ${fmt(a.debt)} MUSD debt that the Stability Pool could not fully absorb; part of it now sits on your trove · ${link}`;
  }
  if (a.kind === 'keeper') return `🔧 ${a.liquidatable} trove(s) are liquidatable right now.`;
  const icon = { LIQUIDATABLE: '🔴', critical: '🟠', warning: '🟡', ok: '🟢', none: '⚪' }[a.level];
  const parts = [`${icon} ${short(a.address)}: ${a.level.toUpperCase()}`];
  if (a.icr !== null) parts.push(`ICR ${(a.icr * 100).toFixed(1)} %`, `liquidation at BTC $${fmt(a.liqPrice, 0)} (${(a.dropToLiq * 100).toFixed(1)} % away)`);
  if (a.redemption) parts.push(`redemption queue #${a.redemption.position}, ${fmt(a.redemption.ahead, 0)} MUSD ahead${a.redemption.front ? ' ⚠️ near the front' : ''}`);
  return parts.join(' · ');
}
