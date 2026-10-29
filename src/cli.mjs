#!/usr/bin/env node
import fs from 'node:fs';
import { getAddress } from 'viem';
import { client, fetchSystem, fetchTroves, simulateLiquidation } from './chain.mjs';
import { analyze, troveHealth, toJSON } from './analyze.mjs';
import { markdown, html } from './render.mjs';
import { runKeeper } from './keeper.mjs';
import { fmt } from './math.mjs';

const [cmd = 'snapshot', ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(`--${n}`);
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const out = opt('out', new URL('../out/', import.meta.url).pathname);

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
    fs.writeFileSync(`${out}/index.html`, html(report));
    console.log(`wrote ${out}/index.html (block ${report.block})`);
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
    const every = Number(opt('interval', 0));
    const tick = async () => {
      const { sys, troves } = await load();
      const map = new Map(troves.map((t) => [t.owner, t]));
      for (const a of who.length ? who : []) {
        const h = troveHealth(map.get(a), sys, { warn: Number(opt('warn', 1.5)), crit: Number(opt('crit', 1.2)) });
        const line = h.level === 'none' ? `${a}: no active trove` :
          `${a}: ${h.level.toUpperCase()} ICR ${(h.icr * 100).toFixed(1)} % · liq at $${fmt(h.liqPrice, 0)} (${(h.dropToLiq * 100).toFixed(1)} % away)`;
        console.log(`[block ${sys.blockNumber}] ${line}`);
      }
      if (!who.length) console.log('usage: watch 0xAddr [0xAddr…] [--interval 60] [--warn 1.5] [--crit 1.2]');
    };
    await tick();
    if (every > 0) setInterval(() => tick().catch((e) => console.error(e.shortMessage || e.message)), every * 1000);
  },
  async keeper() {
    const { pc, report } = await load();
    await runKeeper(pc, report, { send: flag('send'), max: Number(opt('max', 10)) });
  },
};

if (!cmds[cmd]) { console.error(`commands: ${Object.keys(cmds).join(', ')}`); process.exit(2); }
cmds[cmd]().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
