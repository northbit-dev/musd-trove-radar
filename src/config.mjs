import fs from 'node:fs';
const here = new URL('./abi/', import.meta.url);
const load = (n) => JSON.parse(fs.readFileSync(new URL(`${n}.json`, here)));

// Mezo Testnet ("matsnet"). Addresses come from mezo-org/musd
// solidity/artifacts/deployments/matsnet (copied into src/abi/).
export const NETWORK = {
  name: 'Mezo Testnet',
  chainId: 31611,
  rpc: process.env.MEZO_RPC || 'https://rpc.test.mezo.org',
  explorer: 'https://explorer.test.mezo.org',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};
export const C = {
  troveManager: load('TroveManager'),
  sortedTroves: load('SortedTroves'),
  priceFeed: load('PriceFeed'),
  interestRateManager: load('InterestRateManager'),
  stabilityPool: load('StabilityPool'),
  musd: load('MUSD'),
};
