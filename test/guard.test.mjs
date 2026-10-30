import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverTypedDataAddress, hashTypedData, keccak256, toHex, encodeAbiParameters } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { KIND, signLadder, permitTypedData, parseStatus, nicrAfter, describeRung } from '../src/guard.mjs';

test('signLadder: mixed AddColl/RepayMUSD rungs on consecutive nonces, digests match the Solidity typehashes', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const rungs = [{ kind: KIND.AddColl, amount: 2n * 10n ** 15n }, { kind: KIND.RepayMUSD, amount: 100n * 10n ** 18n }, { kind: KIND.AddColl, amount: 10n ** 15n }];
  const permits = await signLadder(account, { firstNonce: 7n, rungs, deadline: 1_900_000_000n });
  assert.deepEqual(permits.map((p) => p.kind), [0, 1, 0]);
  for (const [i, p] of permits.entries()) {
    const td = permitTypedData({ ...p, borrower: account.address, nonce: 7n + BigInt(i) });
    assert.equal(await recoverTypedDataAddress({ ...td, signature: p.signature }), account.address);
    const typeString = p.kind === KIND.RepayMUSD ? 'RepayMUSD(uint256 amount,address borrower,uint256 nonce,uint256 deadline)' : 'AddColl(uint256 assetAmount,address borrower,uint256 nonce,uint256 deadline)';
    const structHash = keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
      [keccak256(toHex(typeString)), p.amount, account.address, 7n + BigInt(i), p.deadline],
    ));
    const domain = keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), keccak256(toHex('BorrowerOperationsSignatures')), keccak256(toHex('1')), BigInt(td.domain.chainId), td.domain.verifyingContract],
    ));
    assert.equal(hashTypedData(td), keccak256(`0x1901${domain.slice(2)}${structHash.slice(2)}`));
  }
});

test('parseStatus reads both the v1 and v2 status() shapes; hints follow the rung kind', () => {
  const B = '0x' + 'b'.repeat(40);
  const v1 = parseStatus(B, [true, 12n, 13n, 2n, 5n, 6n]);
  assert.equal(v1.kind, KIND.AddColl);
  assert.equal(v1.musdReserve, 0n);
  const v2 = parseStatus(B, [false, 12n, 13n, 2n, 1, 100n, 6n, 300n]);
  assert.deepEqual([v2.kind, v2.amount, v2.musdReserve], [KIND.RepayMUSD, 100n, 300n]);
  assert.equal(describeRung(v2), 'RepayMUSD 0 MUSD');
  assert.equal(describeRung({ kind: 1, amount: 100n * 10n ** 18n }), 'RepayMUSD 100 MUSD');
  assert.equal(describeRung({ kind: 0, amount: 2n * 10n ** 15n }), 'AddColl 0.002000 BTC');

  const t = { nicr: 1000n, coll: 10n, principal: 2000n };
  assert.equal(nicrAfter(t, KIND.AddColl, 5n), 1500n);
  assert.equal(nicrAfter(t, KIND.RepayMUSD, 1000n), 2000n);
});
