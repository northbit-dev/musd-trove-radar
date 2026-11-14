# Alert worker

Alerts that keep working when the dashboard tab is closed: a Telegram bot you own, an Atom feed per trove and the
same signed webhook as `watch`. One file, `worker.mjs`, with no dependencies. It runs on the Cloudflare Workers free
tier and under Node.

| Route | What it does |
|---|---|
| `GET /feed/<address>.atom` | Atom feed: the trove's current level and ICR, then up to 19 past level changes |
| `GET /status/<address>` | The same state as JSON, with CORS open |
| `POST /telegram` | Telegram webhook: `/watch 0x… [warn %]`, `/status`, `/unwatch` (one trove per chat) |
| cron, every 5 minutes | Re-reads every watched trove and notifies on a level change |

Levels and the alert rule match `watch`: adding a healthy trove is silent, adding one already below the warning
level alerts at once, and an unchanged level never alerts twice. Critical is fixed at 120 %, liquidatable at 110 %.
The webhook body is signed with HMAC-SHA256 over `${timestamp}.${body}` in `x-trove-radar-signature` and
`x-trove-radar-timestamp`, so `verify` from `src/webhook.mjs` checks it.

## Try it locally
```bash
node worker/dev.mjs
```
This reads the live Mezo Testnet RPC, keeps KV in memory and stubs Telegram and the webhook. It checks the Atom feed
and `/status`, that a wrong Telegram secret gets a 403, that `/watch` is stored, that the first cron run alerts and the
second is quiet, and that the webhook signature verifies. `npm test` runs the same flow offline against a mocked
RPC (`test/worker.test.mjs`).

## Deploy on your own account
1. Create a bot with [@BotFather](https://t.me/BotFather) and keep its token.
2. `cd worker && cp wrangler.toml.example wrangler.toml`, then `npx wrangler kv namespace create WATCH` and put the id
   in `wrangler.toml`.
3. `npx wrangler secret put TELEGRAM_TOKEN` and `npx wrangler secret put TELEGRAM_SECRET` (any random string).
   Optionally `WEBHOOK_URL` and `WEBHOOK_SECRET`.
4. `npx wrangler deploy`, then point Telegram at it, passing the same secret so the worker can reject anything else:
   ```bash
   curl "https://api.telegram.org/bot$TOKEN/setWebhook" \
     -d url=https://musd-trove-radar.<you>.workers.dev/telegram -d secret_token=$TELEGRAM_SECRET
   ```
5. Send `/watch 0xYourTrove 150` to your bot.

Nothing in this folder holds a secret. The worker only makes read calls to the Mezo RPC; it holds no key and sends
no transactions.
