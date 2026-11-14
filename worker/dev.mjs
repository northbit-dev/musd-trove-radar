// Runs the worker under Node against the live Mezo RPC, with an in-memory KV and Telegram and the webhook stubbed.
import assert from 'node:assert/strict';
import worker, { runChecks } from './worker.mjs';
import { verify } from '../src/webhook.mjs';

const demo = '0x20b854C2fCB761DF9f18b27cCBfBeD7276070D7B';
const kv = new Map();
const WATCH = {
  get: async (k) => kv.get(k) ?? null,
  put: async (k, v) => void kv.set(k, v),
  delete: async (k) => void kv.delete(k),
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
};
const outbox = [];
const fetchImpl = async (url, init) => {
  if (String(url).startsWith('https://api.telegram.org/') || String(url).startsWith('https://hooks.example/')) {
    outbox.push({ url: String(url).replace(/bot[^/]+/, 'bot<token>'), headers: init.headers, body: init.body });
    return new Response('{"ok":true}');
  }
  return fetch(url, init);
};
const env = { WATCH, TELEGRAM_TOKEN: 'test-token', TELEGRAM_SECRET: 'tg-secret', WEBHOOK_URL: 'https://hooks.example/radar', WEBHOOK_SECRET: 'wh-secret' };
const call = (path, init) => worker.fetch(new Request('https://radar.example' + path, init), env, {}, fetchImpl);

const feed = await call(`/feed/${demo}.atom`);
assert.equal(feed.status, 200);
const xml = await feed.text();
assert.match(xml, /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
assert.match(xml, /ICR \d+\.\d %/);
const st = await (await call(`/status/${demo}`)).json();
assert.ok(st.icr > 1 && st.coll > 0, 'live ICR read');

assert.equal((await call('/telegram', { method: 'POST', body: '{}' })).status, 403);
const upd = (text) => call('/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' }, body: JSON.stringify({ message: { chat: { id: 42 }, text } }) });
await upd(`/watch ${demo} 200`);
assert.equal(JSON.parse(kv.get('tg:42')).warn, 2);

const first = await runChecks(env, { fetchImpl });
assert.equal(first.length, 1);
assert.equal(first[0].to, 'warning');
const second = await runChecks(env, { fetchImpl });
assert.equal(second.length, 0, 'no repeat alert without a level change');

const hook = outbox.find((o) => o.url.startsWith('https://hooks.example/'));
assert.ok(verify(hook.body, 'wh-secret', hook.headers['x-trove-radar-timestamp'], hook.headers['x-trove-radar-signature']));

assert.equal(((await (await call(`/feed/${demo}.atom`)).text()).match(/<entry>/g) ?? []).length, 2);

console.log(JSON.stringify({ ok: true, status: st, telegramMessages: outbox.filter((o) => o.url.includes('telegram')).map((o) => JSON.parse(o.body).text) }, null, 2));
