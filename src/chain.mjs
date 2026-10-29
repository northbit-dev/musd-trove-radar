import { createPublicClient, http, defineChain } from 'viem';
import { NETWORK, C } from './config.mjs';
import { icr, liquidationPrice } from './math.mjs';

export const mezoTestnet = defineChain({
  id: NETWORK.chainId,
  name: NETWORK.name,
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: [NETWORK.rpc] } },
  blockExplorers: { default: { name: 'Mezo Explorer', url: NETWORK.explorer } },
  contracts: { multicall3: { address: NETWORK.multicall3 } },
});

export function client(rpc = NETWORK.rpc) {
  return createPublicClient({ chain: mezoTestnet, transport: http(rpc, { timeout: 30_000, retryCount: 3 }) });
}

const call = (c, address, abi, functionName, args = []) => ({ address, abi, functionName, args });
const TM = C.troveManager, SP = C.stabilityPool;

/** System-level state in a single multicall, pinned to one block. */
export async function fetchSystem(pc) {
  const blockNumber = await pc.getBlockNumber();
  const [price, count, mcr, ccr, sysColl, sysDebt, spDeposits, musdSupply, rate] = await pc.multicall({
    blockNumber, allowFailure: false,
    contracts: [
      call(pc, C.priceFeed.address, C.priceFeed.abi, 'fetchPrice'),
      call(pc, TM.address, TM.abi, 'getTroveOwnersCount'),
      call(pc, TM.address, TM.abi, 'MCR'),
      call(pc, TM.address, TM.abi, 'CCR'),
      call(pc, TM.address, TM.abi, 'getEntireSystemColl'),
      call(pc, TM.address, TM.abi, 'getEntireSystemDebt'),
      call(pc, SP.address, SP.abi, 'getTotalMUSDDeposits'),
      call(pc, C.musd.address, C.musd.abi, 'totalSupply'),
      call(pc, C.interestRateManager.address, C.interestRateManager.abi, 'interestRate'),
    ],
  });
  const block = await pc.getBlock({ blockNumber });
  return {
    blockNumber, timestamp: Number(block.timestamp), price, troveCount: Number(count), mcr, ccr,
    coll: sysColl, debt: sysDebt, spDeposits, musdSupply, interestRateBps: Number(rate),
  };
}

/** Every active trove with coll/debt including pending redistribution rewards. */
export async function fetchTroves(pc, sys, { chunk = 200 } = {}) {
  const { blockNumber, price, mcr, troveCount } = sys;
  const idx = [...Array(troveCount).keys()];
  const owners = [];
  for (let i = 0; i < idx.length; i += chunk) {
    const res = await pc.multicall({
      blockNumber, allowFailure: false,
      contracts: idx.slice(i, i + chunk).map((j) => call(pc, TM.address, TM.abi, 'getTroveFromTroveOwnersArray', [BigInt(j)])),
    });
    owners.push(...res);
  }
  const troves = [];
  for (let i = 0; i < owners.length; i += chunk) {
    const part = owners.slice(i, i + chunk);
    const res = await pc.multicall({
      blockNumber, allowFailure: false,
      contracts: part.flatMap((o) => [
        call(pc, TM.address, TM.abi, 'getEntireDebtAndColl', [o]),
        call(pc, TM.address, TM.abi, 'getTroveInterestRate', [o]),
      ]),
    });
    part.forEach((owner, k) => {
      const [coll, principal, interest, pColl, pPrincipal, pInterest] = res[2 * k];
      const c = coll + pColl;
      const d = principal + interest + pPrincipal + pInterest;
      troves.push({
        owner, coll: c, debt: d, principal: principal + pPrincipal, interest: interest + pInterest,
        interestRateBps: Number(res[2 * k + 1]),
        icr: icr(c, d, price), liqPrice: liquidationPrice(c, d, mcr),
      });
    });
  }
  return troves;
}

/** On-chain ICR for cross-checking our off-chain maths. */
export function onchainICR(pc, owner, price, blockNumber) {
  return pc.readContract({ address: TM.address, abi: TM.abi, functionName: 'getCurrentICR', args: [owner, price], blockNumber });
}

/**
 * Dry-run a liquidation with eth_call. Liquidation in MUSD is permissionless,
 * so any `from` works; no key or gas is needed to know whether it would succeed.
 */
export async function simulateLiquidation(pc, borrowers, from = '0x000000000000000000000000000000000000dEaD') {
  try {
    const { request } = await pc.simulateContract({
      account: from, address: TM.address, abi: TM.abi,
      functionName: borrowers.length === 1 ? 'liquidate' : 'batchLiquidateTroves',
      args: borrowers.length === 1 ? [borrowers[0]] : [borrowers],
    });
    let gas = null;
    try { gas = await pc.estimateContractGas(request); } catch {}
    return { ok: true, gas };
  } catch (e) {
    return { ok: false, reason: e.shortMessage || e.message };
  }
}
