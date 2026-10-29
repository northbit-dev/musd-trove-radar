// Webhook adapter: POST alerts as JSON to any URL the user controls.
// Formats: generic JSON (signed), Slack/Discord incoming webhooks, Telegram Bot API sendMessage.
// The tool never creates bot accounts; the user supplies their own URL (and chat id for Telegram).
import crypto from 'node:crypto';
import { describe } from './alerts.mjs';

const big = (_, v) => (typeof v === 'bigint' ? v.toString() : v);

export const FORMATS = ['json', 'slack', 'discord', 'telegram'];

/** Build the request body for a format. */
export function formatPayload(alerts, { format = 'json', block, network = 'Mezo Testnet', dashboardUrl, chatId } = {}) {
  const lines = alerts.map(describe);
  const header = `MUSD Trove Radar · ${network}${block !== undefined ? ` · block ${block}` : ''}`;
  const text = [header, ...lines, dashboardUrl ? dashboardUrl : null].filter(Boolean).join('\n');
  switch (format) {
    case 'json': return { source: 'musd-trove-radar', network, block, alerts: JSON.parse(JSON.stringify(alerts, big)), text };
    case 'slack': return { text };
    case 'discord': return { content: text.slice(0, 2000), allowed_mentions: { parse: [] } };
    case 'telegram':
      if (!chatId) throw new Error('telegram format needs a chat id (--chat-id)');
      return { chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true };
    default: throw new Error(`unknown format ${format}; use one of ${FORMATS.join(', ')}`);
  }
}

/** HMAC-SHA256 over `${timestamp}.${body}`, so receivers can verify origin and reject replays. */
export function sign(body, secret, timestamp) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Verify helper for receivers (constant-time). */
export function verify(body, secret, timestamp, signature, { toleranceSec = 300, now = Date.now() / 1000 } = {}) {
  if (Math.abs(now - Number(timestamp)) > toleranceSec) return false;
  const exp = Buffer.from(sign(body, secret, timestamp));
  const got = Buffer.from(String(signature));
  return exp.length === got.length && crypto.timingSafeEqual(exp, got);
}

/**
 * POST with timeout and retry on network errors, 429 and 5xx.
 * Returns { ok, status, attempts }.
 */
export async function sendWebhook(url, payload, { secret, retries = 3, timeoutMs = 10_000, backoffMs = 500, fetchImpl = fetch } = {}) {
  const u = new URL(url);
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error('webhook URL must be http(s)');
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', 'user-agent': 'musd-trove-radar' };
  if (secret) {
    const ts = Math.floor(Date.now() / 1000).toString();
    headers['x-trove-radar-timestamp'] = ts;
    headers['x-trove-radar-signature'] = sign(body, secret, ts);
  }
  let last;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { ok: true, status: res.status, attempts: attempt };
      last = { ok: false, status: res.status, attempts: attempt };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (e) {
      last = { ok: false, status: 0, error: e.message, attempts: attempt };
    }
    if (attempt <= retries) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
  }
  return last;
}
