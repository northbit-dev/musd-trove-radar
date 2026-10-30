import fs from 'node:fs';
import { build } from 'esbuild';
import { NETWORK, C, GUARD } from './config.mjs';

const entry = new URL('./web/radar-app.mjs', import.meta.url).pathname;

/** The contract functions the live dashboard reads; everything else is left out of the bundle. */
export const LIVE_READS = {
  troveManager: ['getTroveOwnersCount', 'MCR', 'CCR', 'getEntireSystemColl', 'getEntireSystemDebt', 'getTroveFromTroveOwnersArray', 'getEntireDebtAndColl', 'getTroveInterestRate'],
  priceFeed: ['fetchPrice'],
  stabilityPool: ['getTotalMUSDDeposits', 'getCollateralBalance'],
  musd: ['totalSupply'],
  interestRateManager: ['interestRate'],
};
const GUARD_READS = ['guardedCount', 'guardedSlice', 'status', 'configs'];
const pick = (abi, names) => abi.filter((x) => x.type === 'function' && names.includes(x.name));

/** Browser stand-in for config.mjs: addresses, RPC and trimmed ABIs as constants (config.mjs reads files with node:fs). */
export function browserConfigModule() {
  const c = Object.fromEntries(Object.entries(LIVE_READS).map(([k, names]) => [k, { address: C[k].address, abi: pick(C[k].abi, names) }]));
  const g = GUARD?.address ? { address: GUARD.address, abi: pick(GUARD.abi, GUARD_READS) } : null;
  const network = { ...NETWORK };
  return `export const NETWORK = ${JSON.stringify(network)};\nexport const C = ${JSON.stringify(c)};\nexport const GUARD = ${JSON.stringify(g)};\n`;
}

const browserShims = {
  name: 'browser-shims',
  setup(b) {
    b.onResolve({ filter: /(^|\/)config\.mjs$/ }, () => ({ path: 'config', namespace: 'radar-config' }));
    b.onLoad({ filter: /.*/, namespace: 'radar-config' }, () => ({ contents: browserConfigModule(), loader: 'js' }));
    // history.mjs reads/writes history.json with fs; the browser only uses its pure helpers.
    b.onResolve({ filter: /^node:/ }, (a) => ({ path: a.path, namespace: 'node-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};

/** Bundle the live-refresh script for index.html (viem included) into one local file; no CDN. */
export async function bundleRadarApp() {
  const r = await build({ entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', minify: true, write: false, legalComments: 'none', plugins: [browserShims] });
  return r.outputFiles[0].text;
}

export async function writeRadarScript(outDir) {
  fs.writeFileSync(`${outDir}/radar.js`, await bundleRadarApp());
  return `${outDir}/radar.js`;
}
