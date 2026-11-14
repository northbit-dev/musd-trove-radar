import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFunctionSelector } from 'viem';
import worker, { runChecks, atom, TROVE_MANAGER, PRICE_FEED, SEL } from '../worker/worker.mjs';
import { verify } from '../src/webhook.mjs';
import { C } from '../src/config.mjs';

const A = '0x' + 'a'.repeat(40), NONE = '0x' + 'b'.repeat(40);
const w = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const enc = (...xs) => '0x' + xs.map((x) => x.toString(16).padStart(64, '0')).join('');

function chain() {
  const s = { price: 100000, coll: 0.03, debt: 2000 };
  const outbox = [];
  const fetchImpl = async (url, init) => {
    if (url === 'https://rpc.test' ) {
      const { to, data } = JSON.parse(init.body).params[0];
      const sel = data.slice(0, 10);
      const owner = '0x' + data.slice(34, 74);
      let result;
      if (to === PRICE_FEED && sel === SEL.fetchPrice) result = enc(w(s.price));
      else if (sel === SEL.getTroveStatus) result = enc(owner === A ? 1n : 2n);
      else if (sel === SEL.getCurrentICR) result = enc(w((s.coll * s.price) / s.debt));
      else if (sel === SEL.getEntireDebtAndColl) result = enc(w(s.coll), w(s.debt - 10), w(10), 0n, 0n, 0n);
      else return Response.json({ jsonrpc: '2.0', id: 1, error: { message: 'unexpected call' } });
      return Response.json({ jsonrpc: '2.0', id: 1, result });
    }
    outbox.push({ url: String(url), headers: init.headers, body: init.body });
    return Response.json({ ok: true });
  };
  const kv = new Map();
  const WATCH = {
    get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k),
    list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  };
  const env = { WATCH, RPC: 'https://rpc.test', TELEGRAM_TOKEN: 't0ken', TELEGRAM_SECRET: 'tg-secret', WEBHOOK_URL: 'https://hooks.test/radar', WEBHOOK_SECRET: 'wh-secret' };
  const call = (path, init) => worker.fetch(new Request('https://radar.test' + path, init), env, {}, fetchImpl);
  const tg = (text, secret = 'tg-secret') => call('/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify({ message: { chat: { id: 42 }, text } }) });
  return { s, outbox, kv, env, call, tg, fetchImpl };
}

test('the hard-coded contracts and selectors are the ones the CLI uses', () => {
  assert.equal(TROVE_MANAGER.toLowerCase(), C.troveManager.address.toLowerCase());
  assert.equal(PRICE_FEED.toLowerCase(), C.priceFeed.address.toLowerCase());
  for (const [name, sel] of Object.entries(SEL)) {
    const abi = [...C.troveManager.abi, ...C.priceFeed.abi].find((x) => x.type === 'function' && x.name === name);
    assert.equal(toFunctionSelector(abi), sel, name);
  }
});

test('Telegram: a wrong secret is refused, /watch stores the chat, the cron alerts once per level change and signs the webhook', async () => {
  const c = chain();
  assert.equal((await c.tg('/watch ' + A, 'nope')).status, 403);
  assert.equal(c.kv.size, 0);
  await c.tg(`/watch ${A} 140`);
  assert.equal(JSON.parse(c.kv.get('tg:42')).warn, 1.4);
  c.outbox.length = 0;

  assert.deepEqual(await runChecks(c.env, { fetchImpl: c.fetchImpl }), [{ chat: '42', from: null, to: 'ok', notified: false }]);
  assert.equal(c.outbox.length, 0, 'a healthy trove is added silently');
  assert.deepEqual(await runChecks(c.env, { fetchImpl: c.fetchImpl }), []);

  c.s.price = 85000;
  const [r] = await runChecks(c.env, { fetchImpl: c.fetchImpl });
  assert.deepEqual([r.from, r.to, r.notified], ['ok', 'warning', true]);
  const [msg, hook] = c.outbox;
  assert.equal(JSON.parse(msg.body).chat_id, '42');
  assert.match(JSON.parse(msg.body).text, /warning, ICR 127\.5 %/);
  assert.equal(hook.url, 'https://hooks.test/radar');
  assert.ok(verify(hook.body, 'wh-secret', hook.headers['x-trove-radar-timestamp'], hook.headers['x-trove-radar-signature']));
  assert.ok(!verify(hook.body, 'other', hook.headers['x-trove-radar-timestamp'], hook.headers['x-trove-radar-signature']));
  assert.deepEqual(await runChecks(c.env, { fetchImpl: c.fetchImpl }), []);
});

test('the Atom feed carries the current state first, then past level changes, and escapes its input', async () => {
  const c = chain();
  await c.tg(`/watch ${A} 140`);
  await runChecks(c.env, { fetchImpl: c.fetchImpl, now: () => '2026-11-11T10:00:00.000Z' });
  c.s.price = 75000;
  await runChecks(c.env, { fetchImpl: c.fetchImpl, now: () => '2026-11-11T10:05:00.000Z' });
  const res = await c.call(`/feed/${A}.atom`);
  assert.equal(res.headers.get('content-type'), 'application/atom+xml; charset=utf-8');
  const xml = await res.text();
  const titles = [...xml.matchAll(/<entry><title>([^<]+)/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['critical · ICR 112.5 %', 'critical · ICR 112.5 %', 'ok · ICR 150.0 %']);
  assert.match(xml, /<id>urn:musd-trove-radar:0xa{40}:2026-11-11T10:05:00.000Z<\/id>/);
  assert.match(atom('<x>', { address: '<x>', level: 'none', price: 1 }), /MUSD trove &lt;x&gt;/);
  const none = await (await c.call(`/status/${NONE}`)).json();
  assert.equal(none.level, 'none');
  assert.equal((await c.call('/feed/0x123.atom')).status, 404);
});
