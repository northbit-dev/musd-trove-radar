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
  if (r.redemption) {
    const q = r.redemption;
    L.push('', '## Redemption queue', '', `Redemptions ${q.enabled ? 'are possible' : 'are blocked (TCR < 110 %)'} · ${fmt(q.totalRedeemable, 0)} MUSD redeemable · ${q.skippedBelowMcr} trove(s) below MCR are skipped.`, '');
    L.push('| Redeemed MUSD | Troves hit | Troves closed |', '|---:|---:|---:|');
    for (const d of q.depth) L.push(`| ${fmt(d.musd, 0)} | ${d.troves} | ${d.closed} |`);
    L.push('', '| # | Owner | ICR | Debt (MUSD) | MUSD ahead |', '|---:|---|---:|---:|---:|');
    for (const t of q.front) L.push(`| ${t.position} | [${short(t.owner)}](${addrLink(t.owner)}) | ${pct(t.icr)} | ${fmt(t.debt)} | ${fmt(t.ahead, 0)} |`);
  }
  return L.join('\n') + '\n';
}

/** One line per activity entry, for the CLI. */
export function describeEvent(e) {
  const t = e.timestamp ? when(e.timestamp) : '';
  const troves = e.troves.map((x) => short(x.borrower)).join(', ') || '–';
  const what = e.type === 'liquidation'
    ? `LIQUIDATION  ${fmt(e.debt)} MUSD debt, ${fmt(e.coll, 6)} BTC coll`
    : `REDEMPTION   ${fmt(e.musd)} MUSD → ${fmt(e.btc, 8)} BTC (fee ${fmt(e.fee, 8)} BTC)`;
  return `${String(e.block).padEnd(9)} ${t}  ${what}  troves: ${troves}  ${NETWORK.explorer}/tx/${e.tx}`;
}

/** "Recent activity" table rows for the dashboard. */
export function activityRows(events, limit = 20) {
  return [...events].reverse().slice(0, limit).map((e) => {
    const troves = e.troves.map((x) => `<a href="${addrLink(x.borrower)}" title="${x.borrower}">${short(x.borrower)}</a>${x.closed ? ' (closed)' : ''}`).join(', ') || '–';
    const amount = e.type === 'liquidation' ? `${fmt(e.debt)} MUSD · ${fmt(e.coll, 6)} BTC` : `${fmt(e.musd)} MUSD → ${fmt(e.btc, 8)} BTC`;
    return `<tr class="${e.type === 'liquidation' ? 'liq' : ''}"><td>${e.timestamp ? when(e.timestamp) : e.block}</td><td>${e.type === 'liquidation' ? 'Liquidation' : 'Redemption'}</td><td>${amount}</td><td>${troves}</td><td><a href="${NETWORK.explorer}/tx/${e.tx}"><code>${e.tx.slice(0, 10)}…</code></a></td></tr>`;
  }).join('');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (x, dp = 2) => Number(fmt(x, dp).replace(/,/g, ''));

/** Compact per-trove rows for the in-page lookup: [owner, icr%, liqPrice, debt, coll, queuePos, musdAhead]. */
export function lookupData(r) {
  const pos = new Map((r.queue ?? []).map((t) => [t.owner.toLowerCase(), t]));
  return (r.troves ?? []).map((t) => {
    const q = pos.get(t.owner.toLowerCase());
    return [t.owner, num(t.icr * 100n, 2), num(t.liqPrice, 0), num(t.debt, 2), num(t.coll, 6), q ? q.position : null, q ? num(q.ahead, 0) : null];
  });
}

/**
 * Self-contained static dashboard: no external assets, no network calls.
 * One small inline script powers the "check your trove" lookup over embedded data.
 * opts.proofs: [{label, hash}] testnet transactions to link (e.g. keeper liquidations).
 */
export function html(r, { proofs = [], repoUrl, activity = null } = {}) {
  const s = r.system;
  const q = r.redemption;
  const maxB = Math.max(1, ...r.buckets.map((b) => b.count));
  const maxS = Math.max(1, ...r.stress.map((x) => x.liquidatable));
  const card = (k, v, cls = '', hint = '') => `<div class="card ${cls}"${hint ? ` title="${esc(hint)}"` : ''}><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
  const rowCls = (t) => (t.icr < r.mcr ? 'liq' : t.icr < r.ccr ? 'risk' : '');
  const owner = (a) => `<a href="${addrLink(a)}" title="${esc(a)}">${short(a)}</a>`;
  const rows = r.riskiest.map((t, i) => `<tr class="${rowCls(t)}"><td>${i + 1}</td><td>${owner(t.owner)}</td><td>${pct(t.icr)}</td><td>${fmt(t.coll, 4)}</td><td>${fmt(t.debt)}</td><td>$${fmt(t.liqPrice, 0)}</td></tr>`).join('');
  const bars = r.buckets.map((b, i) => `<div class="bar"><span class="lbl">${esc(b.label)}</span><span class="track"><span class="b b${i}" style="width:${(b.count / maxB) * 100}%"></span></span><span class="n">${b.count}</span></div>`).join('');
  const st = r.stress.map((x) => `<tr class="${x.recoveryMode ? 'liq' : ''}"><td>−${(x.shock * 100).toFixed(0)} %</td><td>$${fmt(x.price, 0)}</td><td><span class="mini" style="width:${(x.liquidatable / maxS) * 60}px"></span>${x.liquidatable}</td><td>${fmt(x.debt, 0)}</td><td>${pct(x.tcr)}</td><td>${x.recoveryMode ? 'yes' : 'no'}</td></tr>`).join('');
  const rq = q ? q.front.map((t) => `<tr class="${rowCls(t)}"><td>${t.position}</td><td>${owner(t.owner)}</td><td>${pct(t.icr)}</td><td>${fmt(t.debt)}</td><td>${fmt(t.ahead, 0)}</td></tr>`).join('') : '';
  const depth = q ? q.depth.map((d) => `<tr><td>${fmt(d.musd, 0)}</td><td>${d.troves}</td><td>${d.closed}</td></tr>`).join('') : '';
  const proofList = proofs.length ? `<h2 id="keeper">On-chain proof (Mezo Testnet)</h2><p class="note">Keeper liquidations and every TroveGuard step, with ICR before → after for each <code>protect</code>.</p><ul class="proofs">${proofs.map((p) => `<li>${esc(p.label)}: <a href="${NETWORK.explorer}/tx/${esc(p.hash)}"><code>${esc(p.hash.slice(0, 10))}…${esc(p.hash.slice(-6))}</code></a></li>`).join('')}</ul>` : '';
  const actRows = activity ? activityRows(activity.events) : '';
  const actSection = activity ? `<h2 id="activity">Recent activity</h2><p class="sub">Liquidations and redemptions from TroveManager events, blocks ${activity.fromBlock}–${activity.toBlock}.</p>${actRows ? `<div class="scroll"><table><tr><th>Time</th><th>Event</th><th>Amount</th><th>Troves</th><th>Tx</th></tr>${actRows}</table></div>` : '<p>No liquidations or redemptions in this range.</p>'}` : '';
  const data = JSON.stringify({ block: String(r.block), ts: r.timestamp, price: num(r.price, 2), mcr: 110, ccr: 150, explorer: NETWORK.explorer, t: lookupData(r) }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MUSD Trove Radar · ${esc(r.network)}</title><meta name="description" content="Liquidation, Recovery Mode and redemption radar for MUSD troves on Mezo.">
<style>
:root{--bg:#0d0f14;--card:#171a22;--line:#262b38;--fg:#e8e8ef;--mute:#9aa0b4;--red:#ff4d7d;--amber:#f5a524;--green:#34d399;--blue:#7cb4ff}
@media (prefers-color-scheme:light){:root{--bg:#f6f7fb;--card:#fff;--line:#e3e6ef;--fg:#141824;--mute:#5b6278;--red:#d6194b;--amber:#b86e00;--green:#08875c;--blue:#1d5fd1}}
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg);color:var(--fg)}main{max-width:1120px;margin:auto;padding:24px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px 18px;margin-bottom:6px}h1{margin:0;font-size:24px}h2{font-size:17px;margin:30px 0 10px}
.pill{font-size:12px;padding:2px 9px;border-radius:999px;border:1px solid var(--line);color:var(--mute)}.pill.ok{color:var(--green);border-color:var(--green)}.pill.bad{color:var(--red);border-color:var(--red)}
.sub{color:var(--mute);margin-bottom:16px}nav a{margin-right:14px;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.k{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.v{font-size:20px;font-weight:600;margin-top:4px}.card.red{border-color:var(--red)}.card.amber{border-color:var(--amber)}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
td:nth-child(2),th:nth-child(2){text-align:left}th{color:var(--mute);font-weight:500;font-size:13px}
tr.liq td{color:var(--red)}tr.risk td{color:var(--amber)}a{color:var(--blue)}
.bar{display:flex;align-items:center;gap:8px;margin:4px 0}.lbl{width:190px;color:var(--mute);font-size:13px}.track{flex:1;max-width:600px}
.b{display:block;height:14px;border-radius:3px;background:#3b82f6;min-width:2px}.b0{background:var(--red)}.b1{background:#f97316}.b2{background:var(--amber)}.n{font-size:13px;width:40px}
.mini{display:inline-block;height:9px;background:var(--red);border-radius:2px;margin-right:6px;vertical-align:middle;opacity:.7}
.lookup{display:flex;gap:8px;flex-wrap:wrap}.lookup input{flex:1;min-width:280px;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:14px ui-monospace,monospace}
.lookup button{padding:9px 16px;border-radius:8px;border:0;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}#res{margin-top:10px}
.res{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--green);border-radius:8px;padding:12px}.res.warning{border-left-color:var(--amber)}.res.critical,.res.LIQUIDATABLE{border-left-color:var(--red)}
details{margin-top:10px;color:var(--mute)}summary{cursor:pointer}.two{display:grid;grid-template-columns:1fr 2fr;gap:18px}@media(max-width:800px){.two{grid-template-columns:1fr}.lbl{width:120px}}
.proofs{padding-left:18px}.note{color:var(--mute)}footer{color:var(--mute);font-size:12px;margin-top:34px;border-top:1px solid var(--line);padding-top:12px}
</style></head><body><main>
<header><h1>MUSD Trove Radar</h1><span class="pill ${s.recoveryMode ? 'bad' : 'ok'}">${s.recoveryMode ? 'Recovery Mode' : 'Normal mode'}</span><span class="pill">${esc(r.network)}</span></header>
<div class="sub">Block ${r.block} · ${when(r.timestamp)} <span id="age"></span> · BTC $${fmt(r.price)}</div>
<nav aria-label="sections"><a href="#check">Check a trove</a><a href="#dist">Distribution</a><a href="#stress">Stress test</a><a href="#redeem">Redemptions</a><a href="#risk">Riskiest</a>${activity ? '<a href="#activity">Activity</a>' : ''}${proofs.length ? '<a href="#keeper">Proof</a>' : ''}</nav>
<h2 id="check">Check a trove</h2>
<form class="lookup" id="f" role="search"><label for="addr" class="k" style="width:100%">Borrower address</label><input id="addr" name="address" placeholder="0x… borrower address" autocomplete="off" spellcheck="false"><button>Check</button></form>
<div id="res" aria-live="polite"></div>
<h2>System</h2>
<div class="grid">
${card('Total collateral ratio', pct(s.tcr), s.recoveryMode ? 'red' : '', 'Recovery Mode starts below 150 %')}
${card('Recovery Mode at', `$${fmt(s.recoveryTriggerPrice, 0)} (−${(s.dropToRecovery * 100).toFixed(1)} %)`, '', 'BTC price at which TCR falls to 150 %')}
${card('Liquidatable now', `${r.liquidatable.count} · ${fmt(r.liquidatable.debt, 0)} MUSD`, r.liquidatable.count ? 'red' : '', 'Troves with ICR below 110 %')}
${card('At risk (110–150 %)', `${r.atRisk.count} · ${fmt(r.atRisk.debt, 0)} MUSD`, r.atRisk.count ? 'amber' : '')}
${card('Stability Pool', `${fmt(s.spDeposits, 0)} MUSD`, '', cov(s.spCoverage))}
${card('Redeemable MUSD', q ? `${fmt(q.totalRedeemable, 0)}` : 'n/a', q && !q.enabled ? 'red' : '', 'Debt that MUSD holders can redeem 1:1 for BTC, lowest-collateral troves first')}
${card('Active troves', s.troves)}
${card('Global borrow rate', `${(s.interestRateBps / 100).toFixed(2)} %`)}
</div>
<div class="two"><div><h2 id="dist">ICR distribution</h2>${bars}</div>
<div><h2 id="stress">BTC price-shock stress test</h2><div class="scroll"><table><tr><th>BTC drop</th><th>Price</th><th>Liquidatable</th><th>Debt (MUSD)</th><th>TCR</th><th>Recovery</th></tr>${st}</table></div></div></div>
${q ? `<h2 id="redeem">Redemption queue</h2>
<p class="sub">Anyone holding MUSD can redeem it 1:1 for BTC. Redemptions take collateral from the troves with the lowest collateral ratio first (skipping those below 110 %). Being redeemed is not a loss, but it repays debt and removes BTC exposure without the borrower's say. ${q.enabled ? '' : '<b>Redemptions are currently blocked because TCR is below 110 %.</b>'}</p>
<div class="two"><div class="scroll"><table><tr><th>MUSD redeemed</th><th>Troves hit</th><th>Closed</th></tr>${depth}</table></div>
<div class="scroll"><table><tr><th>#</th><th>Owner</th><th>ICR</th><th>Debt (MUSD)</th><th>MUSD ahead</th></tr>${rq}</table></div></div>` : ''}
<h2 id="risk">Riskiest troves</h2><div class="scroll"><table><tr><th>#</th><th>Owner</th><th>ICR</th><th>Coll (BTC)</th><th>Debt (MUSD)</th><th>Liq. price</th></tr>${rows}</table></div>
${actSection}
${proofList}
<details><summary>How to read this page</summary><p>ICR = collateral value ÷ debt for one trove; below 110 % it can be liquidated by anyone. TCR is the same ratio for the whole system; below 150 % Mezo enters Recovery Mode, where troves below 150 % can be liquidated too. The liquidation price is the BTC price at which a trove reaches 110 %. Every number is read from the MUSD contracts at one block and can be re-derived with the open-source CLI.</p></details>
<footer>Read-only data from the MUSD contracts on ${esc(r.network)} (TroveManager, SortedTroves, StabilityPool, PriceFeed, InterestRateManager). Testnet data, not financial advice. Generated by musd-trove-radar${repoUrl ? ` · <a href="${esc(repoUrl)}">source</a>` : ''}.</footer>
</main>
<script>
const D=${data};
const $=(i)=>document.getElementById(i),f=(n,d=0)=>n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const age=Math.round((Date.now()/1000-D.ts)/60);$('age').textContent=age>=0?'('+(age<90?age+' min':Math.round(age/60)+' h')+' ago)':'';
function check(a){a=(a||'').trim();const r=$('res');if(!/^0x[0-9a-fA-F]{40}$/.test(a)){r.innerHTML='<div class="res warning">Enter a 0x… address (42 characters).</div>';return}
const t=D.t.find(x=>x[0].toLowerCase()===a.toLowerCase());
if(!t){r.innerHTML='<div class="res">No active trove for this address at block '+D.block+'.</div>';return}
const [o,icr,liq,debt,coll,pos,ahead]=t,lvl=icr<D.mcr?'LIQUIDATABLE':icr<120?'critical':icr<D.ccr?'warning':'ok',drop=(D.price-liq)/D.price*100;
const e=document.createElement('div');e.className='res '+lvl;
e.innerHTML='<b>'+lvl.toUpperCase()+'</b> · ICR '+f(icr,1)+' % · '+f(coll,4)+' BTC collateral · '+f(debt,2)+' MUSD debt<br>Liquidated if BTC falls to <b>$'+f(liq)+'</b> ('+(drop>0?f(drop,1)+' % below the current price':'already below')+').<br>'+(pos?'Redemption queue: <b>#'+pos+'</b> of '+D.t.filter(x=>x[5]).length+' with '+f(ahead)+' MUSD ahead of you.':'Not in the redemption queue (below 110 %).')+' <a href="'+D.explorer+'/address/'+o+'">explorer</a>';
r.replaceChildren(e)}
$('f').addEventListener('submit',(ev)=>{ev.preventDefault();check($('addr').value);history.replaceState(null,'','?address='+$('addr').value.trim())});
const p=new URLSearchParams(location.search).get('address');if(p){$('addr').value=p;check(p)}
</script></body></html>`;
}
