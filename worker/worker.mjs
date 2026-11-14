// Dependency-free (raw JSON-RPC and WebCrypto) so the same file runs on Cloudflare Workers and under Node 20+.
export const RPC = 'https://rpc.test.mezo.org';
export const TROVE_MANAGER = '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0';
export const PRICE_FEED = '0x86bCF0841622a5dAC14A313a15f96A95421b9366';
export const SEL = { fetchPrice: '0x0fdb11cf', getCurrentICR: '0xd293c710', getTroveStatus: '0x21e37801', getEntireDebtAndColl: '0xb91af97c' };
const DASHBOARD = 'https://northbit-dev.github.io/musd-trove-radar/';
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HISTORY = 20;

const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const word = (data, i) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64));

async function ethCall(rpc, to, data, fetchImpl) {
  const r = await fetchImpl(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`rpc: ${j.error.message}`);
  return j.result;
}

/** Live state of one trove, with the level names of src/alerts.mjs. */
export async function troveState(address, { warn = 1.5, crit = 1.2, rpc = RPC, fetchImpl = fetch } = {}) {
  const call = (to, data) => ethCall(rpc, to, data, fetchImpl);
  const price = word(await call(PRICE_FEED, SEL.fetchPrice), 0);
  const status = Number(word(await call(TROVE_MANAGER, SEL.getTroveStatus + pad(address)), 0));
  if (status !== 1) return { address, level: 'none', price: Number(price) / 1e18 };
  const icrWei = word(await call(TROVE_MANAGER, SEL.getCurrentICR + pad(address) + pad(price.toString(16))), 0);
  const ed = await call(TROVE_MANAGER, SEL.getEntireDebtAndColl + pad(address));
  const coll = Number(word(ed, 0)) / 1e18;
  const debt = Number(word(ed, 1) + word(ed, 2) + word(ed, 4) + word(ed, 5)) / 1e18;
  const icr = Number(icrWei) / 1e18;
  const level = icr < 1.1 ? 'LIQUIDATABLE' : icr < crit ? 'critical' : icr < warn ? 'warning' : 'ok';
  return { address, level, icr, coll, debt, price: Number(price) / 1e18, liqPrice: (1.1 * debt) / coll };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const describe = (s) => s.level === 'none'
  ? `${s.address}: no active trove`
  : `${s.address}: ${s.level}, ICR ${(s.icr * 100).toFixed(1)} %, liquidation at $${s.liqPrice.toFixed(0)} (BTC $${s.price.toFixed(0)})`;

/** The newest entry is the current state; older entries are past level changes. */
export function atom(address, current, history = [], now = new Date().toISOString()) {
  const id = `urn:musd-trove-radar:${address.toLowerCase()}`;
  const entries = [{ ...current, at: now, id: `${id}:now` }, ...history.map((h) => ({ ...h, id: `${id}:${h.at}` }))].slice(0, HISTORY);
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>MUSD trove ${esc(address)}</title>
<id>${esc(id)}</id>
<updated>${esc(now)}</updated>
<author><name>musd-trove-radar</name></author>
<link href="${DASHBOARD}?address=${esc(address)}#check"/>
${entries.map((e) => `<entry><title>${esc(e.level)}${e.icr ? ` · ICR ${(e.icr * 100).toFixed(1)} %` : ''}</title><id>${esc(e.id)}</id><updated>${esc(e.at)}</updated><summary>${esc(describe(e))}</summary></entry>`).join('\n')}
</feed>`;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
/** Same scheme and headers as src/webhook.mjs, so one receiver verifies both. */
export async function sign(body, secret, timestamp) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return 'sha256=' + hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
}

const telegram = (env, chatId, text, fetchImpl) => fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
});

async function handleTelegram(req, env, fetchImpl) {
  if (!env.TELEGRAM_SECRET || req.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_SECRET) return new Response('forbidden', { status: 403 });
  const msg = (await req.json()).message;
  if (!msg?.text) return new Response('ok');
  const chat = String(msg.chat.id);
  const [cmd, arg, warnArg] = msg.text.trim().split(/\s+/);
  const key = `tg:${chat}`;
  let reply;
  if (cmd === '/watch' && ADDR.test(arg ?? '')) {
    const warn = warnArg ? Math.max(1.21, Number(warnArg) / 100 || 1.5) : 1.5;
    await env.WATCH.put(key, JSON.stringify({ chat, address: arg, warn, last: null }));
    reply = `Watching ${arg}. You get a message when it crosses ${(warn * 100).toFixed(0)} % ICR or another level.`;
  } else if (cmd === '/unwatch') {
    await env.WATCH.delete(key);
    reply = 'Stopped.';
  } else if (cmd === '/status') {
    const sub = JSON.parse((await env.WATCH.get(key)) ?? 'null');
    reply = sub ? describe(await troveState(sub.address, { warn: sub.warn, rpc: env.RPC, fetchImpl })) : 'Nothing watched. Send /watch 0x… [warn %]';
  } else {
    reply = 'Commands: /watch 0x<trove owner> [warn %], /status, /unwatch';
  }
  await telegram(env, chat, reply, fetchImpl);
  return new Response('ok');
}

/** Cron: re-check every subscription and notify only on a level change, like `watch`. */
export async function runChecks(env, { fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  const sent = [];
  const { keys } = await env.WATCH.list({ prefix: 'tg:' });
  for (const { name } of keys) {
    const sub = JSON.parse(await env.WATCH.get(name));
    const s = await troveState(sub.address, { warn: sub.warn, rpc: env.RPC, fetchImpl });
    if (s.level === sub.last) continue;
    const text = `MUSD Trove Radar · ${describe(s)}\n${DASHBOARD}`;
    const notify = sub.last !== null || !['ok', 'none'].includes(s.level);
    if (notify) await telegram(env, sub.chat, text, fetchImpl);
    if (notify && env.WEBHOOK_URL && env.WEBHOOK_SECRET) {
      const body = JSON.stringify({ source: 'musd-trove-radar', network: 'Mezo Testnet', alerts: [s], text });
      const ts = String(Math.floor(Date.now() / 1000));
      await fetchImpl(env.WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'musd-trove-radar', 'x-trove-radar-timestamp': ts, 'x-trove-radar-signature': await sign(body, env.WEBHOOK_SECRET, ts) }, body });
    }
    const hkey = `h:${sub.address.toLowerCase()}`;
    const hist = JSON.parse((await env.WATCH.get(hkey)) ?? '[]');
    await env.WATCH.put(hkey, JSON.stringify([{ ...s, at: now() }, ...hist].slice(0, HISTORY)));
    await env.WATCH.put(name, JSON.stringify({ ...sub, last: s.level }));
    sent.push({ chat: sub.chat, from: sub.last, to: s.level, notified: notify });
  }
  return sent;
}

export default {
  async fetch(req, env, ctx, fetchImpl = fetch) {
    const url = new URL(req.url);
    const cors = { 'access-control-allow-origin': '*' };
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/feed\/(0x[0-9a-fA-F]{40})\.atom$/))) {
      const s = await troveState(m[1], { rpc: env.RPC, fetchImpl });
      const hist = JSON.parse((await env.WATCH?.get(`h:${m[1].toLowerCase()}`)) ?? '[]');
      return new Response(atom(m[1], s, hist), { headers: { 'content-type': 'application/atom+xml; charset=utf-8', 'cache-control': 'max-age=60', ...cors } });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/status\/(0x[0-9a-fA-F]{40})$/))) {
      return Response.json(await troveState(m[1], { rpc: env.RPC, fetchImpl }), { headers: { 'cache-control': 'max-age=30', ...cors } });
    }
    if (req.method === 'POST' && url.pathname === '/telegram') return handleTelegram(req, env, fetchImpl);
    return new Response('musd-trove-radar worker: GET /feed/<address>.atom, GET /status/<address>, POST /telegram', { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runChecks(env));
  },
};
