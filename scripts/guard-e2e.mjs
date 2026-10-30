#!/usr/bin/env node
// End-to-end run of out/guard.html on Mezo Testnet in a headless browser (E2E_BROWSER, E2E_DEVICE).
// The page talks to an injected EIP-1193 provider; every request is answered by this Node process,
// which signs with the testnet key from MEZO_KEY_FILE. The key never enters the page.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as pw from 'playwright-core';
import { createPublicClient, createWalletClient, http as rpc, hexToBigInt } from 'viem';
import { mezoTestnet } from '../src/chain.mjs';
import { NETWORK } from '../src/config.mjs';
import { loadAccount } from '../src/keeper.mjs';

const outDir = path.resolve(process.argv[2] || 'out');
const shot = path.resolve(process.argv[3] || 'docs/guard.png');
const account = loadAccount();
if (!account) throw new Error('no testnet key: set MEZO_KEY_FILE to a chmod 600 file');
const pc = createPublicClient({ chain: mezoTestnet, transport: rpc(NETWORK.rpc) });
if ((await pc.getChainId()) !== 31611) throw new Error('refusing: RPC is not Mezo Testnet');
const wc = createWalletClient({ account, chain: mezoTestnet, transport: rpc(NETWORK.rpc) });

// Mezo's public RPC is load-balanced; a send right after a state change can hit a lagging node.
async function retry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries || !/Missing or invalid parameters/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 5000)); }
  }
}

let chainId = 1;
const sent = [];
async function wallet({ method, params = [] }) {
  switch (method) {
    case 'eth_requestAccounts': case 'eth_accounts': return [account.address];
    case 'eth_chainId': return `0x${chainId.toString(16)}`;
    case 'wallet_switchEthereumChain':
      if (chainId === Number(params[0].chainId)) return null;
      throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
    case 'wallet_addEthereumChain': {
      const p = params[0];
      if (Number(p.chainId) !== 31611 || !p.rpcUrls?.length) throw new Error('unexpected chain params');
      chainId = 31611;
      return null;
    }
    case 'eth_signTypedData_v4': {
      const td = JSON.parse(params[1]);
      const { EIP712Domain, ...types } = td.types;
      return account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
    }
    case 'eth_sendTransaction': {
      if (chainId !== 31611) throw new Error('wallet is not on Mezo Testnet');
      const t = params[0];
      const big = (v) => (v == null ? undefined : hexToBigInt(v));
      const hash = await retry(() => wc.sendTransaction({ to: t.to, data: t.data, value: big(t.value), gas: big(t.gas) }));
      sent.push(hash);
      return hash;
    }
    default: return pc.request({ method, params });
  }
}

const server = http.createServer((req, res) => {
  const f = path.join(outDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(outDir) || !fs.existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/guard.html`;

const engine = pw[process.env.E2E_BROWSER || 'chromium'];
if (!engine?.launch) throw new Error('E2E_BROWSER must be chromium, firefox or webkit');
const device = process.env.E2E_DEVICE ? pw.devices[process.env.E2E_DEVICE] : { viewport: { width: 1200, height: 900 } };
if (!device) throw new Error(`unknown E2E_DEVICE ${process.env.E2E_DEVICE}`);
const browser = await engine.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage(device);
console.log(`browser: ${process.env.E2E_BROWSER || 'chromium'} ${browser.version()}${process.env.E2E_DEVICE ? `, ${process.env.E2E_DEVICE}` : ''}`);
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.exposeFunction('__wallet', async (req) => {
  try { return { ok: await wallet(req) }; } catch (e) { if (e.code !== 4902) console.error(`wallet ${req.method}: ${e.shortMessage || e.message}`); return { err: { message: e.message, code: e.code } }; }
});
await page.addInitScript(() => {
  const listeners = {};
  window.ethereum = {
    isTestWallet: true,
    async request(req) {
      const r = await window.__wallet(JSON.parse(JSON.stringify(req)));
      if (r.err) throw Object.assign(new Error(r.err.message), { code: r.err.code });
      if (req.method === 'wallet_addEthereumChain' || req.method === 'wallet_switchEthereumChain') (listeners.chainChanged || []).forEach((f) => f(req.params[0].chainId));
      return r.ok;
    },
    on(ev, f) { (listeners[ev] ||= []).push(f); },
  };
});

const logText = () => page.locator('#log').innerText();
async function step(label, button, done) {
  await page.click(button);
  try {
  await page.waitForFunction((d) => [...document.querySelectorAll('#log li')].some((li) => new RegExp(`${d}|failed|REVERTED`).test(li.textContent)), done, { timeout: 240_000 });
    if (/failed|REVERTED/.test(await logText())) throw new Error(`${label} failed`);
  } catch (e) { console.error(`${label} did not confirm; page log:\n${await logText()}`); throw e; }
  await page.waitForFunction(() => !document.querySelector('#trove').textContent.includes('Loading'), null, { timeout: 60_000 });
  console.log(`${label}: ok`);
  await page.waitForTimeout(5000);
}

await page.goto(url);
await page.click('#connect');
await page.waitForSelector('#chainwarn:not([hidden])');
console.log('wrong-chain warning:', (await page.innerText('#chainwarn')).split('.')[0]);
await page.click('#addchain');
await page.waitForSelector('#chainwarn', { state: 'hidden' });
await page.waitForFunction(() => document.querySelector('#trove').textContent.includes('ICR'));
console.log('trove:', (await page.innerText('#trove')).replace(/\s+/g, ' ').slice(0, 220));

const flow = (process.env.E2E_FLOW ?? 'configure,depositMUSD,store,withdraw,withdrawMUSD,cancel').split(',').filter(Boolean);
await page.fill('#trigger', process.env.E2E_TRIGGER || '200');
await page.fill('#tip', '0.00001');
await page.fill('#reserve', process.env.E2E_RESERVE ?? '0.00203');
await page.fill('#musdDeposit', '100');
await page.fill('#rungs', '2');
await page.selectOption('#firstKind', '1');
await page.check('#alternate');
await page.fill('#rungBtc', '0.002');
await page.fill('#rungMusd', '100');
await page.fill('#btcWithdraw', '0.00001');
await page.fill('#musdWithdraw', '10');
const steps = {
  configure: () => step('configure', '#doConfigure', 'configure: confirmed'),
  depositMUSD: () => step('approve + depositMUSD', '#doDepositMUSD', 'depositMUSD: confirmed'),
  store: () => step('sign ladder + storePermits', '#doStore', 'storePermits .*: confirmed'),
  withdraw: () => step('withdraw', '#doWithdraw', 'withdraw: confirmed'),
  withdrawMUSD: () => step('withdrawMUSD', '#doWithdrawMUSD', 'withdrawMUSD: confirmed'),
  cancel: () => step('cancel', '#doCancel', 'cancel: confirmed'),
};
for (const s of flow) {
  await steps[s]();
  if (s === 'store') { console.log('ladder:', (await page.innerText('#trove')).split('Stored ladder')[1]?.replace(/\s+/g, ' ').trim()); await page.screenshot({ path: shot, fullPage: true }); }
}
const failed = (await logText()).match(/failed|REVERTED/g);
console.log(await logText());
console.log(JSON.stringify({ sent }));
await browser.close();
server.close();
if (failed) process.exit(1);
