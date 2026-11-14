import { createPublicClient, createWalletClient, custom, http, defineChain, parseAbi, parseEther, formatEther, getAddress, isAddress } from 'viem';
import { KIND, kindName, permitTypedData, parseStatus, parseConfig, describeRung, reserveNeeded, musdNeeded, toPermit, malformed, rungAmounts, reasonName, icrPath, rungsPerCall, debtFloorRung } from '../permits.mjs';

const cfg = JSON.parse(document.getElementById('cfg').textContent);
const chain = defineChain({
  id: cfg.chainId, name: cfg.chainName,
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
  blockExplorers: { default: { name: 'Mezo Explorer', url: cfg.explorer } },
});
const pc = createPublicClient({ chain, transport: http(cfg.rpc) });
const guard = { address: cfg.guard, abi: cfg.guardAbi };
const V3 = (cfg.guardVersion ?? 2) >= 3;
const KINDS = V3 ? [KIND.AddColl, KIND.RepayMUSD, KIND.Adjust] : [KIND.AddColl, KIND.RepayMUSD];
const TM = { address: cfg.troveManager, abi: parseAbi([
  'function getTroveStatus(address) view returns (uint8)', 'function getCurrentICR(address,uint256) view returns (uint256)',
  'function getTroveColl(address) view returns (uint256)', 'function getTroveDebt(address) view returns (uint256)',
]) };
const FEED = { address: cfg.priceFeed, abi: parseAbi(['function fetchPrice() view returns (uint256)']) };
const BOS = { address: cfg.bos, abi: parseAbi(['function getNonce(address) view returns (uint256)']) };
const MUSD = { address: cfg.musd, abi: parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
]) };
const STATUS = ['none', 'active', 'closed by owner', 'closed by liquidation', 'closed by redemption'];

const $ = (id) => document.getElementById(id);
const eth = window.ethereum;
let account = null;
let wallet = null;
let walletChain = null;
let trove = null;
let armedCfg = null;

const btc = (v, d = 6) => Number(formatEther(v)).toFixed(d);
const musdFmt = (v) => Number(formatEther(v)).toLocaleString('en-US', { maximumFractionDigits: 2 });
const pctFmt = (v) => `${(Number(v) / 1e16).toFixed(2)} %`;
const txLink = (h) => `<a href="${cfg.explorer}/tx/${h}" target="_blank" rel="noopener"><code>${h.slice(0, 10)}…${h.slice(-6)}</code></a>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function log(html, cls = '') {
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = `<time>${new Date().toLocaleTimeString()}</time> ${html}`;
  $('log').prepend(li);
}
// The public RPC is load-balanced, so a fresh receipt can be missing on one node for a few seconds.
async function receipt(hash) {
  for (let i = 1; ; i++) {
    try { return await pc.waitForTransactionReceipt({ hash, retryCount: 20, timeout: 120_000 }); } catch (e) { if (i >= 4) throw e; await new Promise((r) => setTimeout(r, 4000)); }
  }
}
const errMsg = (e) => esc(e?.shortMessage || e?.details || e?.message || String(e));

function setBusy(on) { for (const b of document.querySelectorAll('button.tx')) b.disabled = on || !account || walletChain !== cfg.chainId; }

function renderWallet() {
  $('who').textContent = account ? account : 'not connected';
  const wrong = account && walletChain !== cfg.chainId;
  $('chainwarn').hidden = !wrong;
  if (wrong) $('chainwarn').innerHTML = `Your wallet is on chain ${walletChain}. TroveGuard lives on <b>${esc(cfg.chainName)}</b> (${cfg.chainId}). <button type="button" id="switch2">Switch to ${esc(cfg.chainName)}</button>`;
  if (wrong) $('switch2').onclick = addChain;
  $('connect').textContent = account ? 'Connected' : 'Connect wallet';
  setBusy(false);
}

async function connect() {
  if (!eth) { log('No browser wallet found. Install one (for example MetaMask or Rabby) and reload.', 'bad'); return; }
  try {
    const [a] = await eth.request({ method: 'eth_requestAccounts' });
    account = getAddress(a);
    walletChain = Number(await eth.request({ method: 'eth_chainId' }));
    wallet = createWalletClient({ account, chain, transport: custom(eth) });
    $('addr').value = account;
    renderWallet();
    await refresh();
  } catch (e) { log(`Connect failed: ${errMsg(e)}`, 'bad'); }
}

async function addChain() {
  if (!eth) { log('No browser wallet found.', 'bad'); return; }
  const hex = `0x${cfg.chainId.toString(16)}`;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    if (e?.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(e?.message || '')) { log(`Switch failed: ${errMsg(e)}`, 'bad'); }
    try {
      await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: cfg.chainName, nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 }, rpcUrls: [cfg.rpc], blockExplorerUrls: [cfg.explorer] }] });
    } catch (e2) { log(`Adding ${esc(cfg.chainName)} failed: ${errMsg(e2)}`, 'bad'); return; }
  }
  walletChain = Number(await eth.request({ method: 'eth_chainId' }));
  renderWallet();
}

async function refresh() {
  const raw = $('addr').value.trim();
  if (!isAddress(raw)) { $('trove').innerHTML = '<p class="note">Enter a borrower address or connect a wallet.</p>'; return; }
  const who = getAddress(raw);
  $('trove').innerHTML = '<p class="note">Loading…</p>';
  try {
    const price = await pc.readContract({ ...FEED, functionName: 'fetchPrice' });
    const [st, coll, debt, nonce, cfgRow, st2, btcBal, musdBal] = await Promise.all([
      pc.readContract({ ...TM, functionName: 'getTroveStatus', args: [who] }),
      pc.readContract({ ...TM, functionName: 'getTroveColl', args: [who] }),
      pc.readContract({ ...TM, functionName: 'getTroveDebt', args: [who] }),
      pc.readContract({ ...BOS, functionName: 'getNonce', args: [who] }),
      pc.readContract({ ...guard, functionName: 'configs', args: [who] }),
      pc.readContract({ ...guard, functionName: 'status', args: [who] }).catch(() => null),
      pc.getBalance({ address: who }),
      pc.readContract({ ...MUSD, functionName: 'balanceOf', args: [who] }),
    ]);
    const active = Number(st) === 1;
    const icr = active ? await pc.readContract({ ...TM, functionName: 'getCurrentICR', args: [who, price] }) : 0n;
    const liq = coll ? (debt * 110n * 10n ** 16n) / coll : 0n;
    const c = parseConfig(cfgRow);
    const armed = c.active;
    trove = active ? { coll, debt, price } : null;
    armedCfg = armed ? c : null;
    const s = st2 ? parseStatus(who, st2) : null;
    const permits = await storedPermits(who, nonce);
    const cls = !active ? '' : icr < 11n * 10n ** 17n ? 'g-bad' : s?.protectable ? 'g-warn' : 'g-ok';
    const row = (k, v) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $('trove').innerHTML = `<div class="grid ${cls}">
      ${row('Trove', esc(STATUS[Number(st)] ?? st))}
      ${row('ICR', active ? pctFmt(icr) : '—')}
      ${row('Liquidation price', active ? `$${Number(formatEther(liq)).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—')}
      ${row('Collateral / debt', active ? `${btc(coll)} BTC / ${musdFmt(debt)} MUSD` : '—')}
      ${row('BTC price', `$${Number(formatEther(price)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`)}
      ${row('Signature nonce', nonce.toString())}
      ${row('Guard', armed ? `armed · trigger ${pctFmt(c.trigger)}${c.targetICR ? ` · target ${pctFmt(c.targetICR)} in up to ${c.maxRungs} rungs` : ''}${c.redemptionBuffer ? ` · redemption buffer ${musdFmt(c.redemptionBuffer)} MUSD` : ''} · tip ${btc(c.tip, 6)} BTC` : 'not armed')}
      ${row('Reserves', s ? `${btc(s.reserve)} BTC + ${musdFmt(s.musdReserve)} MUSD` : '—')}
      ${row('Next rung', s && (s.btc || s.musd) ? `${esc(describeRung(s))}${s.protectable ? ` · <b>PROTECTABLE now</b>${s.reason ? ` (${esc(reasonName(s.reason))})` : ''}` : ''}` : 'none stored for this nonce')}
      ${row('Wallet', `${btc(btcBal)} BTC · ${musdFmt(musdBal)} MUSD`)}
      ${V3 && s?.musdAhead != null ? row('Redemption queue', `${musdFmt(s.musdAhead)} MUSD ahead of you`) : ''}
    </div>${permits.length ? `<h3>Stored ladder</h3><table><tr><th>Nonce</th><th>Rung</th><th>Expires</th></tr>${permits.map((p) => `<tr><td>${p.nonce}</td><td>${esc(describeRung(p))}</td><td>${new Date(Number(p.deadline) * 1000).toLocaleString()}${Number(p.deadline) * 1000 < Date.now() ? ' (expired)' : ''}</td></tr>`).join('')}</table>` : ''}`;
    $('trove').dataset.nonce = nonce.toString();
    if (armed) {
      const put = (id, v) => { if ($(id) && !$(id).dataset.touched) $(id).value = v; };
      put('trigger', (Number(c.trigger) / 1e16).toFixed(0));
      put('target', (Number(c.targetICR) / 1e16).toFixed(0));
      put('buffer', formatEther(c.redemptionBuffer));
      put('maxRungs', String(c.maxRungs));
    }
    previewLadder();
  } catch (e) { $('trove').innerHTML = `<p class="bad">Could not read the trove: ${errMsg(e)}</p>`; }
}

async function storedPermits(who, nonce) {
  const reads = Array.from({ length: 8 }, (_, i) => ({ ...guard, functionName: 'permitOf', args: [who, nonce + BigInt(i)] }));
  const res = await pc.multicall({ contracts: reads, allowFailure: true, multicallAddress: cfg.multicall3 });
  const out = [];
  for (let i = 0; i < res.length; i++) {
    const p = res[i].result;
    if (!p || (V3 ? !p.signature || p.signature === '0x' : !p.amount)) break;
    out.push({ nonce: nonce + BigInt(i), kind: Number(p.kind), ...rungAmounts(p), deadline: p.deadline });
  }
  return out;
}

async function send(label, request) {
  setBusy(true);
  try {
    const { request: req } = await pc.simulateContract({ account, ...guard, ...request });
    const hash = await wallet.writeContract({ ...req, ...(request.gas ? { gas: request.gas } : {}) });
    log(`${esc(label)}: sent ${txLink(hash)}`);
    const rc = await receipt(hash);
    log(`${esc(label)}: ${rc.status === 'success' ? 'confirmed' : 'REVERTED'} in block ${rc.blockNumber} ${txLink(hash)}`, rc.status === 'success' ? 'ok' : 'bad');
    return rc;
  } catch (e) {
    log(`${esc(label)} failed: ${errMsg(e)}`, 'bad');
    return null;
  } finally { setBusy(false); await refresh(); }
}

const pctIn = (id) => BigInt(Math.round(Number($(id).value || 0) * 100)) * 10n ** 14n;
const ether = (id) => { const v = $(id).value.trim(); return v ? parseEther(v) : 0n; };

async function configure() {
  const trigger = pctIn('trigger');
  if (!V3) { await send('configure', { functionName: 'configure', args: [trigger, ether('tip')], value: ether('reserve') }); return; }
  const target = pctIn('target');
  if (target && target <= trigger) { log('Target ICR must be 0 or above the trigger.', 'bad'); return; }
  const maxRungs = Number($('maxRungs').value);
  if (!(maxRungs >= 1 && maxRungs <= 5)) { log('Max rungs per call must be 1 to 5.', 'bad'); return; }
  await send('configure', { functionName: 'configure', args: [trigger, ether('tip'), target, ether('buffer'), maxRungs], value: ether('reserve') });
}

async function depositMUSD() {
  const amount = ether('musdDeposit');
  if (!amount) { log('Enter an MUSD amount.', 'bad'); return; }
  const allowance = await pc.readContract({ ...MUSD, functionName: 'allowance', args: [account, guard.address] });
  if (allowance < amount) {
    setBusy(true);
    try {
      const hash = await wallet.writeContract({ ...MUSD, functionName: 'approve', args: [guard.address, amount] });
      log(`MUSD approve: sent ${txLink(hash)}`);
      await receipt(hash);
      log(`MUSD approve: confirmed ${txLink(hash)}`, 'ok');
    } catch (e) { log(`approve failed: ${errMsg(e)}`, 'bad'); setBusy(false); return; }
  }
  await send('depositMUSD', { functionName: 'depositMUSD', args: [amount] });
}

const DEFAULT_STEPS = V3
  ? [[KIND.Adjust, '0.002', '100'], [KIND.RepayMUSD, '', '100'], [KIND.AddColl, '0.002', '']]
  : [[KIND.AddColl, '0.002', ''], [KIND.RepayMUSD, '', '100'], [KIND.AddColl, '0.002', '']];

function addStep(kind = KIND.AddColl, btcV = '', musdV = '') {
  if ($('steps').children.length >= 8) return;
  const row = document.createElement('div');
  row.className = 'row step';
  row.innerHTML = `<select aria-label="kind">${KINDS.map((k) => `<option value="${k}">${kindName(k)}</option>`).join('')}</select><input aria-label="BTC" placeholder="BTC" value="${esc(btcV)}"><input aria-label="MUSD" placeholder="MUSD" value="${esc(musdV)}"><button type="button" class="alt" aria-label="remove step">×</button>`;
  const [sel, b, m, x] = row.children;
  sel.value = String(kind);
  const sync = () => { const k = Number(sel.value); b.disabled = k === KIND.RepayMUSD; m.disabled = k === KIND.AddColl; previewLadder(); };
  sel.onchange = sync;
  b.oninput = m.oninput = previewLadder;
  x.onclick = () => { row.remove(); previewLadder(); };
  $('steps').append(row);
  sync();
}

function ladderFromForm() {
  return [...$('steps').children].map((row) => {
    const [sel, b, m] = row.children;
    const kind = Number(sel.value);
    const amt = (el) => (el.disabled || !el.value.trim() ? 0n : parseEther(el.value.trim()));
    return { kind, btc: amt(b), musd: amt(m) };
  });
}

function previewLadder() {
  try {
    const rungs = ladderFromForm();
    if (!rungs.length) { $('ladderPreview').textContent = 'Add at least one step.'; return; }
    const parts = [`${rungs.map(describeRung).join(' → ')} · reserve needed ${btc(reserveNeeded(rungs, ether('tip')))} BTC + ${musdFmt(musdNeeded(rungs))} MUSD`];
    if (trove) {
      const path = icrPath(trove, rungs);
      parts.push(`ICR now ${pctFmt((trove.coll * trove.price) / trove.debt)} → ${path.map(pctFmt).join(' → ')}`);
      const bad = debtFloorRung(trove, rungs);
      if (bad >= 0) parts.push(`⚠ rung ${bad + 1} would leave net debt under 1,800 MUSD and revert`);
      if (V3) {
        const target = $('target') ? pctIn('target') : 0n, maxRungs = Number($('maxRungs')?.value) || 1;
        const n = rungsPerCall(path, { targetICR: target, maxRungs });
        parts.push(target ? `the first keeper call spends ${n} rung${n === 1 ? '' : 's'} toward ${pctFmt(target)}` : 'one rung per keeper call');
      }
    }
    $('ladderPreview').textContent = parts.join(' · ');
  } catch { $('ladderPreview').textContent = 'Amounts must be numbers.'; }
}

async function signAndStore() {
  const rungs = ladderFromForm();
  if (!rungs.length) { log('Add at least one step.', 'bad'); return; }
  if (rungs.some(malformed)) { log(V3 ? 'Every rung needs an amount above zero (Adjust needs both BTC and MUSD).' : 'Every rung needs an amount above zero.', 'bad'); return; }
  const firstNonce = await pc.readContract({ ...BOS, functionName: 'getNonce', args: [account] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + Number($('days').value || 30) * 86400);
  const permits = [];
  setBusy(true);
  try {
    for (let i = 0; i < rungs.length; i++) {
      log(`Sign rung ${i + 1}/${rungs.length} in your wallet: ${esc(describeRung(rungs[i]))}, nonce ${firstNonce + BigInt(i)}`);
      const signature = await wallet.signTypedData({ account, ...permitTypedData({ ...rungs[i], borrower: account, nonce: firstNonce + BigInt(i), deadline, chainId: cfg.chainId, verifyingContract: cfg.bos }) });
      permits.push(toPermit(rungs[i], deadline, signature, cfg.guardVersion ?? 2));
    }
  } catch (e) { log(`Signing stopped: ${errMsg(e)}`, 'bad'); setBusy(false); return; }
  setBusy(false);
  // Mezo's eth_estimateGas ignores the EIP-7623 calldata floor, so signature-heavy calldata needs headroom.
  const est = await pc.estimateContractGas({ account, ...guard, functionName: 'storePermits', args: [firstNonce, permits] });
  await send(`storePermits (${rungs.length} rungs from nonce ${firstNonce})`, { functionName: 'storePermits', args: [firstNonce, permits], gas: est * 2n + 100_000n });
}

$('connect').onclick = connect;
$('addchain').onclick = addChain;
$('refresh').onclick = refresh;
$('lookup').onsubmit = (e) => { e.preventDefault(); refresh(); };
for (const id of ['trigger', 'target', 'buffer', 'maxRungs']) if ($(id)) $(id).addEventListener('input', () => { $(id).dataset.touched = '1'; previewLadder(); });
$('doConfigure').onclick = configure;
$('doDeposit').onclick = () => send('deposit', { functionName: 'deposit', value: ether('btcDeposit') });
$('doDepositMUSD').onclick = depositMUSD;
$('doStore').onclick = signAndStore;
$('doWithdraw').onclick = () => send('withdraw', { functionName: 'withdraw', args: [ether('btcWithdraw')] });
$('doWithdrawMUSD').onclick = () => send('withdrawMUSD', { functionName: 'withdrawMUSD', args: [ether('musdWithdraw')] });
$('doCancel').onclick = () => { if (confirm('Cancel the guard? This refunds both reserves and invalidates every stored permit.')) send('cancel', { functionName: 'cancel' }); };
$('addStep').onclick = () => addStep();
$('tip').addEventListener('input', previewLadder);
for (const st of DEFAULT_STEPS) addStep(...st);
if (eth?.on) {
  eth.on('chainChanged', (c) => { walletChain = Number(c); renderWallet(); });
  eth.on('accountsChanged', (a) => { account = a[0] ? getAddress(a[0]) : null; if (account) wallet = createWalletClient({ account, chain, transport: custom(eth) }); renderWallet(); if (account) { $('addr').value = account; refresh(); } });
}
if (!eth) $('chainwarn').hidden = false, $('chainwarn').textContent = 'No browser wallet detected. You can still look up any borrower; install a wallet to configure a guard.';
renderWallet();
const q = new URLSearchParams(location.search).get('borrower');
if (q) { $('addr').value = q; refresh(); }
