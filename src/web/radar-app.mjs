// Live layer for index.html: re-reads the MUSD contracts from the Mezo RPC in the browser and re-renders
// the block-dependent sections with the same code the CLI uses. The embedded snapshot stays on screen,
// clearly labelled with its block, whenever the RPC cannot be reached.
import { createPublicClient, http } from 'viem';
import { mezoTestnet, fetchSystem, fetchTroves } from '../chain.mjs';
import { analyze } from '../analyze.mjs';
import { liveParts, statusLine, lookupData, guardData, num } from '../render.mjs';
import { parseStatus } from '../permits.mjs';
import { GUARD } from '../config.mjs';
import { troveHistory, historyChart, summary, freeze } from '../trove-history.mjs';

const EVERY = 60_000;
const D = window.D;
const $ = (id) => document.getElementById(id);
// Larger multicall batches than viem's 1 KB default: one read is ~10 requests instead of ~45.
const pc = createPublicClient({ chain: mezoTestnet, batch: { multicall: { batchSize: 32_768 } }, transport: http(D.rpc, { timeout: 20_000, retryCount: 1 }) });
const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const clean = (e) => String(e?.shortMessage || e?.message || e).split('\n')[0].replace(/[<>&]/g, '').slice(0, 120);

let snapshot = { block: D.block, ts: D.ts, price: D.price };
let live = null;
let busy = false;

async function guards() {
  if (!GUARD) return null;
  const n = await pc.readContract({ ...GUARD, functionName: 'guardedCount' });
  const borrowers = n ? await pc.readContract({ ...GUARD, functionName: 'guardedSlice', args: [0n, n] }) : [];
  if (!borrowers.length) return [];
  const res = await pc.multicall({ allowFailure: true, contracts: borrowers.flatMap((b) => [{ ...GUARD, functionName: 'status', args: [b] }, { ...GUARD, functionName: 'configs', args: [b] }]) });
  return borrowers.map((borrower, i) => {
    const [st, cfg] = [res[2 * i], res[2 * i + 1]];
    if (st.status !== 'success') return { borrower, error: true };
    return { ...parseStatus(borrower, st.result), active: cfg.status === 'success' ? Boolean(cfg.result[3]) : null };
  });
}

function setStatus(html) {
  $('status').innerHTML = html;
  window.showAge?.();
}

function snapshotStatus(note) {
  const when = new Date(snapshot.ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const price = snapshot.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  setStatus(`<span class="pill amber">snapshot</span> Snapshot from block <b id="blk">${snapshot.block}</b> · ${when} <span id="age"></span> · BTC $${price} · <span class="note">${note}</span>`);
}

async function refresh() {
  if (busy || (live && document.hidden)) return;
  busy = true;
  try {
    const sys = await fetchSystem(pc);
    const r = analyze(sys, await fetchTroves(pc, sys));
    let g = null;
    try { g = await guards(); } catch {}
    const parts = liveParts(r);
    for (const [k, v] of Object.entries(parts)) { const el = $(`live-${k}`); if (el) el.innerHTML = v; }
    Object.assign(D, { block: String(r.block), ts: r.timestamp, price: num(r.price, 2), t: lookupData(r) });
    if (g) D.g = guardData(g);
    live = { block: r.block, at: clock() };
    setStatus(statusLine(r, { live: true, updated: live.at, note: `refreshes every ${EVERY / 1000} s` }));
    document.documentElement.dataset.source = 'live';
    document.documentElement.dataset.block = String(r.block);
    const a = $('addr').value.trim();
    if (a && $('res').firstChild && typeof window.check === 'function') window.check(a);
  } catch (e) {
    if (live) {
      const s = $('status').querySelector('.note');
      if (s) s.textContent = `refresh failed at ${clock()} (${clean(e)}); showing block ${live.block} from ${live.at}, retrying`;
    } else {
      document.documentElement.dataset.source = 'snapshot';
      snapshotStatus(`live read from the Mezo RPC failed (${clean(e)}); retrying every ${EVERY / 1000} s`);
    }
  } finally { busy = false; }
}

const HISTORY_DAYS = 3;
const historyBusy = new Set();
const blocksPerDay = async () => {
  const head = await pc.getBlock();
  const back = await pc.getBlock({ blockNumber: head.number - 10_000n });
  return { head, perDay: BigInt(Math.round(10_000 * 86_400 / Number(head.timestamp - back.timestamp))) };
};

// ICR history for the looked-up address; the localStorage cache means a repeat lookup only fetches new blocks.
window.showHistory = async (address) => {
  const key = `trove-history:${address.toLowerCase()}`;
  const el = $('hist');
  if (historyBusy.has(key)) return;
  historyBusy.add(key);
  const fresh = !el.dataset.address || el.dataset.address !== key;
  el.dataset.address = key;
  if (fresh) el.innerHTML = `<p class="note">Reading ${HISTORY_DAYS} days of ICR history from the Mezo RPC…</p>`;
  try {
    const { head, perDay } = await blocksPerDay();
    const fromBlock = head.number - perDay * BigInt(HISTORY_DAYS) + 1n;
    let cache = null;
    try { cache = JSON.parse(localStorage.getItem(key)); } catch {}
    const h = await troveHistory(pc, address, { fromBlock, toBlock: head.number, samples: 36, cache, concurrency: 4 });
    try { localStorage.setItem(key, JSON.stringify(freeze(h))); } catch {}
    if (el.dataset.address !== key) return;
    const s = summary(h);
    const rows = h.changes.slice(-8).reverse().map((c) => `<li>block ${c.block}: ${c.op} (${c.emitter}) · ${c.coll?.toFixed(4) ?? '–'} BTC, ${c.debt?.toFixed(2) ?? '–'} MUSD · <a href="${D.explorer}/tx/${c.tx}">tx</a></li>`).join('');
    el.innerHTML = `${historyChart(h)}<p class="note">ICR history, blocks ${h.fromBlock}–${h.toBlock}${s ? ` · min ${s.minICR.toFixed(1)} % · max ${s.maxICR.toFixed(1)} %` : ''} · ${h.changes.length} change${h.changes.length === 1 ? '' : 's'}</p>${rows ? `<ul class="changes">${rows}</ul>` : ''}`;
  } catch (e) {
    if (el.dataset.address === key) el.innerHTML = `<p class="note">ICR history unavailable: ${clean(e)}</p>`;
  } finally { historyBusy.delete(key); }
};

const first = $('addr').value.trim();
if (/^0x[0-9a-fA-F]{40}$/.test(first)) window.showHistory(first);

snapshotStatus('loading live data from the Mezo RPC…');
document.documentElement.dataset.source = 'loading';
refresh();
setInterval(refresh, EVERY);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
