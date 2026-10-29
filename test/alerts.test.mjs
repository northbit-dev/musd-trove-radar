import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { icr, liquidationPrice } from '../src/math.mjs';
import { analyze } from '../src/analyze.mjs';
import { evaluate, diff, describe } from '../src/alerts.mjs';
import { formatPayload, sendWebhook, sign, verify } from '../src/webhook.mjs';

const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const MCR = E(1.1), CCR = E(1.5);
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
function report(price) {
  const P = E(price);
  const tr = [[A, 1, 70000], [B, 1, 20000]].map(([owner, coll, debt]) => ({ owner, coll: E(coll), debt: E(debt), principal: E(debt), icr: icr(E(coll), E(debt), P), liqPrice: liquidationPrice(E(coll), E(debt), MCR) }));
  const sys = { blockNumber: 7n, timestamp: 1_700_000_000, price: P, mcr: MCR, ccr: CCR, coll: E(2), debt: E(90000), spDeposits: 0n, musdSupply: 0n, interestRateBps: 100 };
  return analyze(sys, tr);
}

test('evaluate: health level + redemption position per watched address', () => {
  const cur = evaluate(report(82000), [A, B, C], { redeemWarn: 1000 });
  assert.deepEqual(cur.borrowers.map((b) => b.level), ['critical', 'ok', 'none']);
  assert.equal(cur.borrowers[0].redemption.position, 1);
  assert.equal(cur.borrowers[0].redemption.front, true);
  assert.equal(cur.borrowers[1].redemption.front, false);
  assert.equal(cur.borrowers[2].redemption, null);
});

test('diff: first run alerts only on non-ok, then only on changes', () => {
  const r1 = evaluate(report(82000), [A, B]);
  const d1 = diff(null, r1);
  assert.deepEqual(d1.alerts.map((a) => a.address), [A]);
  const d2 = diff(d1.next, evaluate(report(82000), [A, B]));
  assert.equal(d2.alerts.length, 0, 'no repeat alerts');
  const d3 = diff(d2.next, evaluate(report(60000), [A, B])); // A liquidatable, recovery mode
  const kinds = d3.alerts.map((a) => a.kind + ':' + (a.level ?? a.recoveryMode ?? a.liquidatable));
  assert.ok(kinds.includes(`borrower:LIQUIDATABLE`));
  assert.ok(kinds.includes('system:true'));
  assert.ok(kinds.includes('keeper:1'));
  assert.ok(d3.alerts.find((a) => a.level === 'LIQUIDATABLE').worse);
  assert.match(describe(d3.alerts[0]), /LIQUIDATABLE/);
});

test('formatPayload shapes for json, slack, discord, telegram', () => {
  const { alerts } = diff(null, evaluate(report(82000), [A]));
  const j = formatPayload(alerts, { format: 'json', block: '7' });
  assert.equal(j.alerts[0].address, A);
  assert.equal(typeof j.alerts[0].liqPrice, 'string', 'bigints are serialised');
  assert.match(formatPayload(alerts, { format: 'slack' }).text, /CRITICAL/);
  const d = formatPayload(alerts, { format: 'discord' });
  assert.deepEqual(d.allowed_mentions, { parse: [] });
  assert.throws(() => formatPayload(alerts, { format: 'telegram' }), /chat id/);
  assert.equal(formatPayload(alerts, { format: 'telegram', chatId: '42' }).chat_id, '42');
  assert.throws(() => formatPayload(alerts, { format: 'sms' }), /unknown format/);
});

test('signature verifies and rejects tampering or stale timestamps', () => {
  const ts = '1700000000';
  const s = sign('{"a":1}', 'k', ts);
  assert.ok(verify('{"a":1}', 'k', ts, s, { now: 1700000010 }));
  assert.ok(!verify('{"a":2}', 'k', ts, s, { now: 1700000010 }));
  assert.ok(!verify('{"a":1}', 'k', ts, s, { now: 1700009999 }));
});

test('sendWebhook posts signed JSON to a local receiver and retries on 5xx', async () => {
  const got = [];
  let calls = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls++;
      if (calls === 1) { res.writeHead(503); return res.end(); }
      got.push({ headers: req.headers, body });
      res.writeHead(204); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/hook`;
  try {
    const res = await sendWebhook(url, { hello: 'radar' }, { secret: 's3cret', backoffMs: 5 });
    assert.deepEqual([res.ok, res.status, res.attempts], [true, 204, 2]);
    const { headers, body } = got[0];
    assert.equal(headers['content-type'], 'application/json');
    assert.ok(verify(body, 's3cret', headers['x-trove-radar-timestamp'], headers['x-trove-radar-signature']));
    const bad = await sendWebhook(url.replace(/\d+\/hook$/, '1/hook'), {}, { retries: 1, backoffMs: 1, timeoutMs: 500 });
    assert.equal(bad.ok, false);
  } finally { srv.close(); }
  await assert.rejects(sendWebhook('file:///etc/passwd', {}), /http/);
});
