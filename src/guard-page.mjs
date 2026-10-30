import fs from 'node:fs';
import { build } from 'esbuild';
import { NETWORK, C, GUARD } from './config.mjs';

const entry = new URL('./web/guard-app.mjs', import.meta.url).pathname;

/** Bundle the wallet app (viem included) into one local script; no CDN. */
export async function bundleGuardApp() {
  const r = await build({ entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', minify: true, write: false, legalComments: 'none' });
  return r.outputFiles[0].text;
}

/** Everything the page needs, embedded as JSON: addresses, RPC and the TroveGuard ABI. No keys. */
export function guardConfig(guard = GUARD) {
  return {
    chainId: NETWORK.chainId, chainName: NETWORK.name, rpc: NETWORK.rpc, explorer: NETWORK.explorer, multicall3: NETWORK.multicall3,
    guard: guard.address, guardAbi: guard.abi,
    troveManager: C.troveManager.address, priceFeed: C.priceFeed.address, bos: C.borrowerOperationsSignatures.address, musd: C.musd.address,
  };
}

const field = (id, label, attrs = '') => `<label>${label}<input id="${id}" ${attrs}></label>`;

export function guardHtml(cfg, { script = 'guard.js' } = {}) {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TroveGuard · ${cfg.chainName}</title><meta name="description" content="Arm TroveGuard for your MUSD trove with your own wallet: reserves, trigger and a pre-signed permit ladder.">
<style>
:root{--bg:#0d0f14;--card:#171a22;--line:#262b38;--fg:#e8e8ef;--mute:#9aa0b4;--red:#ff4d7d;--amber:#f5a524;--green:#34d399;--blue:#7cb4ff}
@media (prefers-color-scheme:light){:root{--bg:#f6f7fb;--card:#fff;--line:#e3e6ef;--fg:#141824;--mute:#5b6278;--red:#d6194b;--amber:#b86e00;--green:#08875c;--blue:#1d5fd1}}
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg);color:var(--fg)}main{max-width:1000px;margin:auto;padding:24px}
h1{margin:0 0 4px;font-size:24px}h2{font-size:17px;margin:28px 0 10px}h3{font-size:15px;margin:16px 0 6px}a{color:var(--blue)}.note{color:var(--mute)}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0}#who{font:13px ui-monospace,monospace;color:var(--mute)}
button{padding:8px 14px;border-radius:8px;border:0;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}button.alt{background:var(--card);color:var(--fg);border:1px solid var(--line)}button.danger{background:var(--red)}
.warn{border:1px solid var(--amber);color:var(--amber);border-radius:8px;padding:10px 12px;margin:10px 0}.warn button{margin-left:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.k{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.v{font-size:16px;font-weight:600;margin-top:3px}
.g-bad .card:nth-child(2){border-color:var(--red)}.g-warn .card:nth-child(2),.g-warn .card:nth-child(9){border-color:var(--amber)}.g-ok .card:nth-child(2){border-color:var(--green)}
form,fieldset{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;border:1px solid var(--line);border-radius:10px;padding:12px;margin:0}
label{display:flex;flex-direction:column;font-size:12px;color:var(--mute);gap:4px}input,select{padding:7px 9px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:14px ui-monospace,monospace;width:160px}
input[type=checkbox]{width:auto}label{min-width:0;max-width:100%}#lookup label{flex:0 1 440px}#addr{width:100%}@media (max-width:600px){main{padding:14px}}.row{display:flex;gap:10px;align-items:center}
table{border-collapse:collapse;font-variant-numeric:tabular-nums}td,th{padding:5px 10px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--mute);font-weight:500;font-size:13px}
#log{list-style:none;padding:0;font-size:14px}#log li{padding:5px 0;border-bottom:1px solid var(--line)}#log time{color:var(--mute);font-size:12px;margin-right:6px}#log .ok{color:var(--green)}#log .bad,.bad{color:var(--red)}
#ladderPreview{color:var(--mute);font-size:13px;width:100%}
footer{color:var(--mute);font-size:12px;margin-top:34px;border-top:1px solid var(--line);padding-top:12px}
</style></head><body><main>
<h1>TroveGuard</h1>
<div class="note">Automatic top-ups and repayments for your MUSD trove on ${cfg.chainName}. Contract <a href="${cfg.explorer}/address/${cfg.guard}"><code>${cfg.guard}</code></a> · <a href="index.html">Radar</a></div>
<div class="bar"><button type="button" id="connect">Connect wallet</button><button type="button" class="alt" id="addchain">Add ${cfg.chainName}</button><span id="who"></span></div>
<div class="warn" id="chainwarn" hidden></div>

<h2>Your trove</h2>
<form id="lookup"><label>Borrower address<input id="addr" placeholder="0x…" autocomplete="off" spellcheck="false"></label><button class="alt" type="button" id="refresh">Refresh</button></form>
<div id="trove" style="margin-top:10px"><p class="note">Enter a borrower address or connect a wallet.</p></div>

<h2>1 · Arm the guard</h2>
<fieldset>${field('trigger', 'Trigger ICR (%)', 'type="number" min="111" max="1000" step="1" value="130"')}${field('tip', 'Keeper tip per rung (BTC)', 'value="0.00001"')}${field('reserve', 'BTC reserve to deposit', 'value="0.00403"')}<button type="button" class="tx" id="doConfigure">configure</button></fieldset>
<p class="note">The guard fires when ICR is strictly below the trigger. It must be between 110 % (MCR) and 1000 %. The tip is paid in BTC from the reserve to whoever calls <code>protect</code>.</p>
<fieldset>${field('btcDeposit', 'Add BTC to reserve')}<button type="button" class="tx" id="doDeposit">deposit</button>${field('musdDeposit', 'Add MUSD to reserve')}<button type="button" class="tx" id="doDepositMUSD">approve + depositMUSD</button></fieldset>

<h2>2 · Sign a permit ladder</h2>
<fieldset>${field('rungs', 'Rungs', 'type="number" min="1" max="8" value="3"')}
<label>First rung<select id="firstKind"><option value="0">AddColl (BTC)</option><option value="1">RepayMUSD</option></select></label>
<label class="row"><input type="checkbox" id="alternate">alternate kinds</label>
${field('rungBtc', 'AddColl amount (BTC)', 'value="0.002"')}${field('rungMusd', 'RepayMUSD amount (MUSD)', 'value="100"')}${field('days', 'Valid for (days)', 'type="number" min="1" value="30"')}
<button type="button" class="tx" id="doStore">sign in wallet + storePermits</button><div id="ladderPreview"></div></fieldset>
<p class="note">Your wallet signs one EIP-712 message per rung (<code>AddColl</code> or <code>RepayMUSD</code> for BorrowerOperationsSignatures) for consecutive nonces from your current one. Signatures stay in your wallet until you send them; this page never sees a private key. A repayment must leave net debt at or above 1,800 MUSD.</p>

<h2>3 · Withdraw or cancel</h2>
<fieldset>${field('btcWithdraw', 'BTC')}<button type="button" class="tx alt" id="doWithdraw">withdraw</button>${field('musdWithdraw', 'MUSD')}<button type="button" class="tx alt" id="doWithdrawMUSD">withdrawMUSD</button><button type="button" class="tx danger" id="doCancel">cancel guard</button></fieldset>

<h2>Transactions</h2><ul id="log"></ul>
<footer>Testnet only, not audited. Every transaction is simulated first and then signed in your wallet.</footer>
</main><script id="cfg" type="application/json">${json}</script><script src="${script}"></script></body></html>`;
}

export async function writeGuardPage(outDir, guard = GUARD) {
  if (!guard?.address) return null;
  fs.writeFileSync(`${outDir}/guard.js`, await bundleGuardApp());
  fs.writeFileSync(`${outDir}/guard.html`, guardHtml(guardConfig(guard)));
  return `${outDir}/guard.html`;
}
