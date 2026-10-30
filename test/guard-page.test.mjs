import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ladderRungs, reserveNeeded, musdNeeded, KIND } from '../src/permits.mjs';
import { guardConfig, guardHtml, bundleGuardApp } from '../src/guard-page.mjs';

test('ladderRungs alternates kinds from the first one; reserves cover every rung plus a tip each', () => {
  const rungs = ladderRungs({ count: 3, first: KIND.RepayMUSD, alternate: true, btcAmount: 2n, musdAmount: 100n });
  assert.deepEqual(rungs, [{ kind: 1, amount: 100n }, { kind: 0, amount: 2n }, { kind: 1, amount: 100n }]);
  assert.equal(reserveNeeded(rungs, 1n), 5n);
  assert.equal(musdNeeded(rungs), 200n);
  assert.deepEqual(ladderRungs({ count: 2, first: KIND.AddColl, alternate: false, btcAmount: 2n, musdAmount: 100n }).map((r) => r.kind), [0, 0]);
});

test('guard.html is static: local script, chain 31611 config, no private key and no remote scripts', async () => {
  const cfg = guardConfig();
  assert.equal(cfg.chainId, 31611);
  const page = guardHtml({ ...cfg, chainName: '</script><b>' });
  assert.ok(page.includes('<script src="guard.js"></script>'));
  assert.ok(!page.includes('"</script>'), 'embedded JSON must not close the script tag');
  const js = await bundleGuardApp();
  for (const src of [page, js]) {
    assert.doesNotMatch(src, /<script[^>]+src=["']https?:/);
    assert.doesNotMatch(src, /privateKey|PRIVATE_KEY|MEZO_KEY_FILE/);
  }
  assert.match(js, /wallet_addEthereumChain/);
  assert.match(js, /eth_signTypedData_v4|signTypedData/);
});
