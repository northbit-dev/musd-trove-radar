import { evaluate, diff, describe } from '../alerts.mjs';

export const KEY = 'radar.watchlist.v1';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const empty = () => ({ items: [], recoveryMode: null });

export function load(storage) {
  try {
    const s = JSON.parse(storage.getItem(KEY));
    return s && Array.isArray(s.items) ? s : empty();
  } catch { return empty(); }
}

export function save(storage, state) {
  try { storage.setItem(KEY, JSON.stringify(state)); } catch {}
}

export function add(state, address, { warn = 1.5, crit = 1.2 } = {}) {
  if (!ADDRESS.test(address)) throw new Error('not an address');
  if (!(warn > crit && crit > 1.1)) throw new Error('need 110 % < critical < warning');
  const items = state.items.filter((i) => i.address.toLowerCase() !== address.toLowerCase());
  return { ...state, items: [...items, { address, warn, crit, key: null }] };
}

export function remove(state, address) {
  const items = state.items.filter((i) => i.address.toLowerCase() !== address.toLowerCase());
  return { items, recoveryMode: items.length ? state.recoveryMode : null };
}

// Same rule as `watch`: the first look is silent unless the trove is already in trouble, then only changes alert.
export function tick(state, report) {
  const alerts = [];
  const rows = [];
  const items = state.items.map((item) => {
    const cur = evaluate(report, [item.address], { warn: item.warn, crit: item.crit });
    const prev = item.key === null ? null : { borrowers: { [item.address.toLowerCase()]: item.key }, recoveryMode: false, liquidatable: 0 };
    const d = diff(prev, cur);
    alerts.push(...d.alerts.filter((a) => a.kind === 'borrower'));
    rows.push({ kind: 'borrower', ...cur.borrowers[0] });
    return { ...item, key: d.next.borrowers[item.address.toLowerCase()] };
  });
  const rm = report.system.recoveryMode;
  if (items.length && state.recoveryMode !== null && rm !== state.recoveryMode) alerts.push({ kind: 'system', severity: rm ? 'high' : 'info', recoveryMode: rm, tcr: report.system.tcr });
  return { state: { items, recoveryMode: items.length ? rm : null }, alerts, rows };
}

export function notification(a) {
  const title = a.kind === 'system' ? 'MUSD Recovery Mode' : `Trove ${a.level === 'LIQUIDATABLE' ? 'LIQUIDATABLE' : a.level}`;
  return { title, body: describe(a), tag: a.kind === 'system' ? 'recovery-mode' : a.address.toLowerCase() };
}
