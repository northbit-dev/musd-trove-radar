// Borrower and system alerts. Pure functions: build events from a report,
// then keep only what changed since the previous run (so a cron job does not spam).
import { troveHealth } from './analyze.mjs';
import { queuePosition } from './redemption.mjs';
import { fmt } from './math.mjs';

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

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** One human-readable line per alert. */
export function describe(a) {
  if (a.kind === 'system') return a.recoveryMode
    ? `🚨 Mezo entered Recovery Mode (TCR ${fmt(a.tcr * 100n, 1)} %). Troves below 150 % can now be liquidated.`
    : `✅ Mezo left Recovery Mode (TCR ${fmt(a.tcr * 100n, 1)} %).`;
  if (a.kind === 'keeper') return `🔧 ${a.liquidatable} trove(s) are liquidatable right now.`;
  const icon = { LIQUIDATABLE: '🔴', critical: '🟠', warning: '🟡', ok: '🟢', none: '⚪' }[a.level];
  const parts = [`${icon} ${short(a.address)}: ${a.level.toUpperCase()}`];
  if (a.icr !== null) parts.push(`ICR ${(a.icr * 100).toFixed(1)} %`, `liquidation at BTC $${fmt(a.liqPrice, 0)} (${(a.dropToLiq * 100).toFixed(1)} % away)`);
  if (a.redemption) parts.push(`redemption queue #${a.redemption.position}, ${fmt(a.redemption.ahead, 0)} MUSD ahead${a.redemption.front ? ' ⚠️ near the front' : ''}`);
  return parts.join(' · ');
}
