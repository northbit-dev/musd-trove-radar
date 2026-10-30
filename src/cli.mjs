#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { getAddress } from 'viem';
import { client, fetchSystem, fetchTroves, simulateLiquidation } from './chain.mjs';
import { analyze, toJSON } from './analyze.mjs';
import { markdown, html } from './render.mjs';
import { runKeeper, loadAccount, runProtectKeeper, guardTargets } from './keeper.mjs';
import { describeRung } from './guard.mjs';
import { writeGuardPage } from './guard-page.mjs';
import { fmt } from './math.mjs';
import { queuePosition, simulateRedemption } from './redemption.mjs';
import { evaluate, diff, describe, eventAlerts } from './alerts.mjs';
import { formatPayload, sendWebhook } from './webhook.mjs';
import { syncEvents, summarize } from './events.mjs';
import { describeEvent } from './render.mjs';

const [cmd = 'snapshot', ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(`--${n}`);
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const out = opt('out', new URL('../out', import.meta.url).pathname);
const shown = (p) => path.relative(process.cwd(), p) || '.';

async function load() {
  const pc = client();
  const sys = await fetchSystem(pc);
  const troves = await fetchTroves(pc, sys);
  return { pc, sys, troves, report: analyze(sys, troves, { top: Number(opt('top', 15)) }) };
}

const cmds = {
  async snapshot() {
    const { report } = await load();
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(`${out}/snapshot.json`, toJSON(report));
    fs.writeFileSync(`${out}/snapshot.md`, markdown(report));
    process.stdout.write(flag('json') ? toJSON(report) + '\n' : markdown(report));
  },
  async dashboard() {
    const { report } = await load();
    fs.mkdirSync(out, { recursive: true });
    const proofsFile = new URL('../proofs.json', import.meta.url);
    const proofs = fs.existsSync(proofsFile) ? JSON.parse(fs.readFileSync(proofsFile, 'utf8')) : [];
    let activity = null;
    try {
      activity = await syncEvents(client(), { blocks: BigInt(opt('blocks', 100_000)), toBlock: report.block, file: `${out}/events.json` });
    } catch (e) { console.error(`history unavailable: ${e.shortMessage || e.message}`); }
    const g = await writeGuardPage(out);
    fs.writeFileSync(`${out}/index.html`, html(report, { proofs, repoUrl: process.env.TROVE_RADAR_REPO_URL, activity, guardPage: Boolean(g) }));
    console.log(`wrote ${shown(out)}/index.html (block ${report.block})`);
    if (g) console.log(`wrote ${shown(g)} and guard.js`);
  },
  async history() {
    const pc = client();
    const h = await syncEvents(pc, { blocks: BigInt(opt('blocks', 100_000)), file: `${out}/events.json`, window: opt('window') ? BigInt(opt('window')) : undefined, log: flag('json') ? () => {} : console.error });
    const events = [...h.events].reverse();
    if (flag('json')) { process.stdout.write(JSON.stringify({ fromBlock: h.fromBlock, toBlock: h.toBlock, summary: summarize(h.events), events }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n'); return; }
    const s = summarize(h.events);
    console.log(`Blocks ${h.fromBlock}–${h.toBlock}: ${s.liquidations} liquidation(s) of ${s.liquidatedTroves} trove(s), ${fmt(s.liquidatedDebt)} MUSD debt, ${fmt(s.liquidatedColl, 6)} BTC · ${s.redemptions} redemption(s), ${fmt(s.redeemedMusd)} MUSD for ${fmt(s.redeemedBtc, 8)} BTC across ${s.redeemedTroves} trove(s)`);
    for (const e of events.slice(0, Number(opt('top', 50)))) console.log(describeEvent(e));
  },
  async liquidatable() {
    const { pc, report } = await load();
    console.log(`${report.liquidatable.count} liquidatable trove(s), ${fmt(report.liquidatable.debt)} MUSD`);
    for (const t of report.liquidatable.troves) {
      const sim = flag('simulate') ? await simulateLiquidation(pc, [t.owner]) : null;
      console.log(`${t.owner}  ICR ${fmt(t.icr * 100n)} %  debt ${fmt(t.debt)}${sim ? `  eth_call: ${sim.ok ? 'would succeed' : 'revert ' + sim.reason}` : ''}`);
    }
  },
  async watch() {
    const who = rest.filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x)).map((a) => getAddress(a));
    if (!who.length) { console.log('usage: watch 0xAddr [0xAddr…] [--interval 60] [--warn 1.5] [--crit 1.2] [--redeem-warn 50000] [--lookback 1000] [--webhook URL --format json|slack|discord|telegram --chat-id ID] [--state file]'); return; }
    const every = Number(opt('interval', 0));
    const webhook = opt('webhook', process.env.TROVE_RADAR_WEBHOOK);
    const format = opt('format', 'json');
    const stateFile = opt('state', null);
    let prev = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
    const tick = async () => {
      const { report } = await load();
      const cur = evaluate(report, who, { warn: Number(opt('warn', 1.5)), crit: Number(opt('crit', 1.2)), redeemWarn: Number(opt('redeem-warn', 50_000)) });
      for (const b of cur.borrowers) console.log(`[block ${report.block}] ${describe({ kind: 'borrower', ...b })}`);
      const { alerts, next } = diff(prev, cur);
      const from = prev?.eventsBlock !== undefined ? BigInt(prev.eventsBlock) + 1n : report.block - BigInt(opt('lookback', 1000)) + 1n;
      let seen = prev?.seen ?? [];
      let eventsBlock = prev?.eventsBlock;
      if (from <= report.block) {
        try {
          const h = await syncEvents(client(), { fromBlock: from, toBlock: report.block, file: `${out}/events.json` });
          const active = cur.borrowers.filter((b) => b.level !== 'none').map((b) => b.address);
          const ev = eventAlerts(h.events, who, { seen, active });
          alerts.push(...ev.alerts);
          seen = ev.seen;
          eventsBlock = String(report.block);
        } catch (e) { console.error(`[block ${report.block}] events unavailable: ${e.shortMessage || e.message}`); }
      }
      next.eventsBlock = eventsBlock;
      next.seen = seen;
      prev = next;
      if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(next));
      if (!alerts.length) { console.log(`[block ${report.block}] no changes to alert on`); return; }
      console.log(`[block ${report.block}] ${alerts.length} alert(s)`);
      for (const a of alerts.filter((x) => x.kind === 'event')) console.log(`  ${describe(a)}`);
      if (webhook) {
        const body = formatPayload(alerts, { format, block: String(report.block), chatId: opt('chat-id', process.env.TROVE_RADAR_CHAT_ID), dashboardUrl: process.env.TROVE_RADAR_DASHBOARD_URL });
        const res = await sendWebhook(webhook, body, { secret: process.env.TROVE_RADAR_WEBHOOK_SECRET });
        console.log(`webhook (${format}): ${res.ok ? 'delivered' : 'failed'} status=${res.status} attempts=${res.attempts}`);
      }
    };
    await tick();
    if (every > 0) setInterval(() => tick().catch((e) => console.error(e.shortMessage || e.message)), every * 1000);
  },
  async redemption() {
    const { report } = await load();
    const r = report.redemption;
    console.log(`Redemptions ${r.enabled ? 'possible (TCR ≥ 110 %)' : 'BLOCKED (TCR < 110 %)'} · ${fmt(r.totalRedeemable, 0)} MUSD redeemable · ${r.skippedBelowMcr} trove(s) below MCR skipped`);
    const who = rest.find((x) => /^0x[0-9a-fA-F]{40}$/.test(x));
    if (who) {
      const q = queuePosition({ queue: report.queue }, who);
      console.log(q ? `${getAddress(who)}: #${q.position} of ${report.queue.length} · ${fmt(q.ahead, 0)} MUSD ahead · fully redeemed after ${fmt(q.through, 0)} MUSD` : `${getAddress(who)}: not in the redemption queue`);
    }
    const amount = opt('amount', null);
    if (amount) {
      const sim = simulateRedemption(report.queue, BigInt(Math.round(Number(amount))) * 10n ** 18n, report.price);
      console.log(`Redeeming ${fmt(BigInt(Math.round(Number(amount))) * 10n ** 18n, 0)} MUSD would hit ${sim.hits.length} trove(s), closing ${sim.hits.filter((h) => h.closes).length}${sim.unfilled ? `; ${fmt(sim.unfilled, 0)} MUSD unfilled` : ''}`);
      for (const h of sim.hits.slice(0, Number(opt('top', 15)))) console.log(`  ${h.owner}  ${fmt(h.musd)} MUSD → ${fmt(h.coll, 6)} BTC${h.closes ? '  (closed)' : ''}`);
      return;
    }
    console.log('#   owner                                               ICR   debt (MUSD)   MUSD ahead');
    for (const t of r.front) console.log(`${String(t.position).padEnd(3)} ${t.owner}  ${fmt(t.icr * 100n).padStart(8)} %  ${fmt(t.debt).padStart(12)}  ${fmt(t.ahead, 0).padStart(10)}`);
  },
  async keeper() {
    const { pc, report } = await load();
    await runKeeper(pc, report, { send: flag('send'), max: Number(opt('max', 10)) });
    if (flag('protect')) await runProtectKeeper(pc, loadAccount(), { send: flag('send') });
  },
  async guard() {
    const pc = client();
    const rows = await guardTargets(pc);
    if (!rows.length) { console.log('TroveGuard: no guarded troves'); return; }
    for (const t of rows) {
      console.log(t.error ? `${t.borrower}  status() failed: ${t.error}` : `${t.borrower}  ICR ${fmt(t.icr * 100n)} %  trigger ${fmt(t.trigger * 100n)} %  nonce ${t.nonce}  next ${t.amount ? describeRung(t) : 'none'}  reserve ${fmt(t.reserve, 6)} BTC${t.musdReserve ? ` + ${fmt(t.musdReserve)} MUSD` : ''}${t.protectable ? '  → PROTECTABLE' : ''}`);
    }
  },
};

if (!cmds[cmd]) { console.error(`commands: ${Object.keys(cmds).join(', ')}`); process.exit(2); }
cmds[cmd]().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
