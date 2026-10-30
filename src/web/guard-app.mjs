import { createPublicClient, createWalletClient, custom, http, defineChain, parseAbi, parseEther, formatEther, getAddress, isAddress } from 'viem';
import { permitTypedData, parseStatus, describeRung, ladderRungs, reserveNeeded, musdNeeded } from '../permits.mjs';

const cfg = JSON.parse(document.getElementById('cfg').textContent);
const chain = defineChain({
  id: cfg.chainId, name: cfg.chainName,
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
  blockExplorers: { default: { name: 'Mezo Explorer', url: cfg.explorer } },
});
const pc = createPublicClient({ chain, transport: http(cfg.rpc) });
const guard = { address: cfg.guard, abi: cfg.guardAbi };
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
    const [trigger, tip, , armed] = cfgRow;
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
      ${row('Guard', armed ? `armed · trigger ${pctFmt(trigger)} · tip ${btc(tip, 6)} BTC` : 'not armed')}
      ${row('Reserves', s ? `${btc(s.reserve)} BTC + ${musdFmt(s.musdReserve)} MUSD` : '—')}
      ${row('Next rung', s && s.amount ? `${esc(describeRung(s))}${s.protectable ? ' · <b>PROTECTABLE now</b>' : ''}` : 'none stored for this nonce')}
      ${row('Wallet', `${btc(btcBal)} BTC · ${musdFmt(musdBal)} MUSD`)}
    </div>${permits.length ? `<h3>Stored ladder</h3><table><tr><th>Nonce</th><th>Rung</th><th>Expires</th></tr>${permits.map((p) => `<tr><td>${p.nonce}</td><td>${esc(describeRung(p))}</td><td>${new Date(Number(p.deadline) * 1000).toLocaleString()}${Number(p.deadline) * 1000 < Date.now() ? ' (expired)' : ''}</td></tr>`).join('')}</table>` : ''}`;
    $('trove').dataset.nonce = nonce.toString();
    if (armed && !$('trigger').dataset.touched) $('trigger').value = (Number(trigger) / 1e16).toFixed(0);
  } catch (e) { $('trove').innerHTML = `<p class="bad">Could not read the trove: ${errMsg(e)}</p>`; }
}

async function storedPermits(who, nonce) {
  const reads = Array.from({ length: 8 }, (_, i) => ({ ...guard, functionName: 'permitOf', args: [who, nonce + BigInt(i)] }));
  const res = await pc.multicall({ contracts: reads, allowFailure: true, multicallAddress: cfg.multicall3 });
  const out = [];
  for (let i = 0; i < res.length; i++) {
    const p = res[i].result;
    if (!p || !p.amount) break;
    out.push({ nonce: nonce + BigInt(i), kind: Number(p.kind), amount: p.amount, deadline: p.deadline });
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

const ether = (id) => { const v = $(id).value.trim(); return v ? parseEther(v) : 0n; };

async function configure() {
  const trigger = BigInt(Math.round(Number($('trigger').value) * 100)) * 10n ** 14n;
  await send('configure', { functionName: 'configure', args: [trigger, ether('tip')], value: ether('reserve') });
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

function ladderFromForm() {
  return ladderRungs({
    count: Math.max(1, Math.min(8, Number($('rungs').value) || 1)),
    first: Number($('firstKind').value), alternate: $('alternate').checked,
    btcAmount: ether('rungBtc'), musdAmount: ether('rungMusd'),
  });
}

function previewLadder() {
  try {
    const rungs = ladderFromForm();
    const tip = ether('tip');
    $('ladderPreview').textContent = `${rungs.map(describeRung).join(' → ')} · reserve needed ${btc(reserveNeeded(rungs, tip))} BTC + ${musdFmt(musdNeeded(rungs))} MUSD`;
  } catch { $('ladderPreview').textContent = ''; }
}

async function signAndStore() {
  const rungs = ladderFromForm();
  if (rungs.some((r) => !r.amount)) { log('Every rung needs an amount above zero.', 'bad'); return; }
  const firstNonce = await pc.readContract({ ...BOS, functionName: 'getNonce', args: [account] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + Number($('days').value || 30) * 86400);
  const permits = [];
  setBusy(true);
  try {
    for (let i = 0; i < rungs.length; i++) {
      const { kind, amount } = rungs[i];
      log(`Sign rung ${i + 1}/${rungs.length} in your wallet: ${esc(describeRung(rungs[i]))}, nonce ${firstNonce + BigInt(i)}`);
      const signature = await wallet.signTypedData({ account, ...permitTypedData({ kind, amount, borrower: account, nonce: firstNonce + BigInt(i), deadline, chainId: cfg.chainId, verifyingContract: cfg.bos }) });
      permits.push({ kind, amount, deadline, signature });
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
$('trigger').oninput = () => { $('trigger').dataset.touched = '1'; };
$('doConfigure').onclick = configure;
$('doDeposit').onclick = () => send('deposit', { functionName: 'deposit', value: ether('btcDeposit') });
$('doDepositMUSD').onclick = depositMUSD;
$('doStore').onclick = signAndStore;
$('doWithdraw').onclick = () => send('withdraw', { functionName: 'withdraw', args: [ether('btcWithdraw')] });
$('doWithdrawMUSD').onclick = () => send('withdrawMUSD', { functionName: 'withdrawMUSD', args: [ether('musdWithdraw')] });
$('doCancel').onclick = () => { if (confirm('Cancel the guard? This refunds both reserves and invalidates every stored permit.')) send('cancel', { functionName: 'cancel' }); };
for (const id of ['rungs', 'firstKind', 'alternate', 'rungBtc', 'rungMusd', 'tip']) $(id).addEventListener('input', previewLadder);
previewLadder();
if (eth?.on) {
  eth.on('chainChanged', (c) => { walletChain = Number(c); renderWallet(); });
  eth.on('accountsChanged', (a) => { account = a[0] ? getAddress(a[0]) : null; if (account) wallet = createWalletClient({ account, chain, transport: custom(eth) }); renderWallet(); if (account) { $('addr').value = account; refresh(); } });
}
if (!eth) $('chainwarn').hidden = false, $('chainwarn').textContent = 'No browser wallet detected. You can still look up any borrower; install a wallet to configure a guard.';
renderWallet();
const q = new URLSearchParams(location.search).get('borrower');
if (q) { $('addr').value = q; refresh(); }
