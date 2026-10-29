import { fmt, pct } from './math.mjs';
import { NETWORK } from './config.mjs';

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const addrLink = (a) => `${NETWORK.explorer}/address/${a}`;
const when = (ts) => new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const p = (x) => `${(x * 100).toFixed(1)} %`;
export const cov = (c) => (c === null ? 'n/a (nothing liquidatable)' : c >= 1 ? `fully covered (${c.toFixed(0)}× liquidatable debt)` : `${p(c)} — remainder redistributed to other troves`);

export function markdown(r) {
  const s = r.system;
  const L = [];
  L.push(`# MUSD Trove Radar — ${r.network}`, '', `Block ${r.block} · ${when(r.timestamp)} · BTC $${fmt(r.price)}`, '');
  L.push('| Metric | Value |', '|---|---|');
  L.push(`| Active troves | ${s.troves} |`, `| System collateral | ${fmt(s.coll, 4)} BTC |`, `| System debt | ${fmt(s.debt)} MUSD |`);
  L.push(`| TCR | ${pct(s.tcr)} ${s.recoveryMode ? '⚠️ RECOVERY MODE' : ''} |`);
  L.push(`| Recovery Mode trigger | BTC $${fmt(s.recoveryTriggerPrice)} (${p(s.dropToRecovery)} drop) |`);
  L.push(`| Stability Pool | ${fmt(s.spDeposits)} MUSD |`, `| Global borrow rate | ${(s.interestRateBps / 100).toFixed(2)} % |`);
  L.push(`| Liquidatable now | ${r.liquidatable.count} troves · ${fmt(r.liquidatable.debt)} MUSD |`);
  L.push(`| SP coverage of liquidatable debt | ${cov(s.spCoverage)} |`);
  L.push(`| At risk (MCR ≤ ICR < CCR) | ${r.atRisk.count} troves · ${fmt(r.atRisk.debt)} MUSD |`, '');
  L.push('## ICR distribution', '', '| ICR | Troves | Debt (MUSD) |', '|---|---:|---:|');
  for (const b of r.buckets) L.push(`| ${b.label} | ${b.count} | ${fmt(b.debt, 0)} |`);
  L.push('', '## Price-shock stress test', '', '| BTC drop | Price | Liquidatable | Debt (MUSD) | TCR | Recovery |', '|---:|---:|---:|---:|---:|:-:|');
  for (const x of r.stress) L.push(`| ${p(x.shock)} | $${fmt(x.price, 0)} | ${x.liquidatable} | ${fmt(x.debt, 0)} | ${pct(x.tcr)} | ${x.recoveryMode ? 'yes' : 'no'} |`);
  L.push('', '## Riskiest troves', '', '| # | Owner | ICR | Coll (BTC) | Debt (MUSD) | Liq. price |', '|---:|---|---:|---:|---:|---:|');
  r.riskiest.forEach((t, i) => L.push(`| ${i + 1} | [${short(t.owner)}](${addrLink(t.owner)}) | ${pct(t.icr)} | ${fmt(t.coll, 4)} | ${fmt(t.debt)} | $${fmt(t.liqPrice, 0)} |`));
  return L.join('\n') + '\n';
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Self-contained static dashboard (no external assets) — can be hosted anywhere. */
export function html(r) {
  const s = r.system;
  const maxB = Math.max(1, ...r.buckets.map((b) => b.count));
  const card = (k, v, cls = '') => `<div class="card ${cls}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
  const rows = r.riskiest.map((t, i) => `<tr class="${t.icr < r.mcr ? 'liq' : t.icr < r.ccr ? 'risk' : ''}"><td>${i + 1}</td><td><a href="${addrLink(t.owner)}">${short(t.owner)}</a></td><td>${pct(t.icr)}</td><td>${fmt(t.coll, 4)}</td><td>${fmt(t.debt)}</td><td>$${fmt(t.liqPrice, 0)}</td></tr>`).join('');
  const bars = r.buckets.map((b, i) => `<div class="bar"><span class="lbl">${esc(b.label)}</span><span class="b b${i}" style="width:${(b.count / maxB) * 100}%"></span><span class="n">${b.count}</span></div>`).join('');
  const st = r.stress.map((x) => `<tr class="${x.recoveryMode ? 'liq' : ''}"><td>−${(x.shock * 100).toFixed(0)} %</td><td>$${fmt(x.price, 0)}</td><td>${x.liquidatable}</td><td>${fmt(x.debt, 0)}</td><td>${pct(x.tcr)}</td><td>${x.recoveryMode ? 'yes' : 'no'}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MUSD Trove Radar · ${esc(r.network)}</title><style>
body{font:15px/1.45 system-ui,sans-serif;margin:0;background:#0d0f14;color:#e8e8ef}main{max-width:1100px;margin:auto;padding:24px}
h1{margin:0 0 4px;font-size:24px}h2{font-size:17px;margin:28px 0 10px}.sub{color:#9aa0b4;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}.card{background:#171a22;border:1px solid #262b38;border-radius:10px;padding:12px}
.k{color:#9aa0b4;font-size:12px;text-transform:uppercase;letter-spacing:.04em}.v{font-size:20px;font-weight:600;margin-top:4px}.card.red{border-color:#ff004d}.card.amber{border-color:#f5a524}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}td,th{padding:6px 8px;border-bottom:1px solid #222736;text-align:right}td:nth-child(2),th:nth-child(2){text-align:left}
tr.liq td{color:#ff5c8a}tr.risk td{color:#f5a524}a{color:#7cb4ff}.bar{display:flex;align-items:center;gap:8px;margin:4px 0}.lbl{width:190px;color:#9aa0b4;font-size:13px}
.b{height:14px;border-radius:3px;background:#3b82f6}.b0{background:#ff004d}.b1{background:#f97316}.b2{background:#f5a524}.n{font-size:13px}footer{color:#6b7189;font-size:12px;margin-top:30px}
</style></head><body><main>
<h1>MUSD Trove Radar</h1><div class="sub">${esc(r.network)} · block ${r.block} · ${when(r.timestamp)} · BTC $${fmt(r.price)}</div>
<div class="grid">
${card('Total collateral ratio', pct(s.tcr), s.recoveryMode ? 'red' : '')}
${card('Recovery Mode at', `$${fmt(s.recoveryTriggerPrice, 0)} (−${(s.dropToRecovery * 100).toFixed(1)} %)`)}
${card('Liquidatable now', `${r.liquidatable.count} · ${fmt(r.liquidatable.debt, 0)} MUSD`, r.liquidatable.count ? 'red' : '')}
${card('At risk (<150 %)', `${r.atRisk.count} · ${fmt(r.atRisk.debt, 0)} MUSD`, r.atRisk.count ? 'amber' : '')}
${card('Stability Pool', `${fmt(s.spDeposits, 0)} MUSD`)}
${card('Active troves', s.troves)}
${card('System debt', `${fmt(s.debt, 0)} MUSD`)}
${card('Global borrow rate', `${(s.interestRateBps / 100).toFixed(2)} %`)}
</div>
<h2>ICR distribution</h2>${bars}
<h2>Price-shock stress test</h2><table><tr><th>BTC drop</th><th>Price</th><th>Liquidatable</th><th>Debt (MUSD)</th><th>TCR</th><th>Recovery</th></tr>${st}</table>
<h2>Riskiest troves</h2><table><tr><th>#</th><th>Owner</th><th>ICR</th><th>Coll (BTC)</th><th>Debt (MUSD)</th><th>Liq. price</th></tr>${rows}</table>
<footer>Read-only data from MUSD contracts on Mezo Testnet (TroveManager, SortedTroves, StabilityPool, PriceFeed). Generated by musd-trove-radar.</footer>
</main></body></html>`;
}
