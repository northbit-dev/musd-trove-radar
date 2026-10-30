# Public links

The GitHub links go live with the first push; everything else is live on Mezo Testnet (chain 31611).

| What | Link |
|---|---|
| Repository | `https://github.com/northbit-dev/musd-trove-radar` |
| Dashboard (GitHub Pages, static snapshot) | `https://northbit-dev.github.io/musd-trove-radar/` |
| TroveGuard web app | `https://northbit-dev.github.io/musd-trove-radar/guard.html` |
| Release v0.2.0 notes | [CHANGELOG.md](../CHANGELOG.md#v020-30-october-wave-2) |

## Contracts
| Contract | Address |
|---|---|
| TroveGuard v2 (current, verified) | [0xa67c9bbcd4350b24e33e25e2ebd7c80c04409df7](https://explorer.test.mezo.org/address/0xa67c9bbcd4350b24e33e25e2ebd7c80c04409df7) |
| TroveGuard v1 (history, verified) | [0x4e5ada5a4c3095727a1259369b98dd31466b0e6d](https://explorer.test.mezo.org/address/0x4e5ada5a4c3095727a1259369b98dd31466b0e6d) |
| MUSD TroveManager | [0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0](https://explorer.test.mezo.org/address/0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0) |
| MUSD Stability Pool | [0x1CCA7E410eE41739792eA0A24e00349Dd247680e](https://explorer.test.mezo.org/address/0x1CCA7E410eE41739792eA0A24e00349Dd247680e) |

## Key transactions
| Proof | Transaction |
|---|---|
| First keeper liquidation (ICR 106.85 %) | [0x6d0f1cdb…a2d68e](https://explorer.test.mezo.org/tx/0x6d0f1cdb2407fdc572443802dcf48c0451b713d31afb5c40aa4123a5a2a2d68e) |
| Keeper daemon liquidation with `--min-profit` | [0xb4b1ed7b…b2a280](https://explorer.test.mezo.org/tx/0xb4b1ed7b85dc19eda5f56ff42465364111afda64361c834d637b2b1d8cb7a280) |
| Clean-clone QA liquidation | [0x6fbdaa8f…20d279e](https://explorer.test.mezo.org/tx/0x6fbdaa8f980aae07e97d6a97ec53d272f0c30c94c215de0eb2231b92220d279e) |
| TroveGuard v1 protect, 117.92 % → 125.78 % | [0xf639ce76…206dae](https://explorer.test.mezo.org/tx/0xf639ce7656afabdac74bc6345bb83f4eeed60c8ca76a23c98a8a22c7d3206dae) |
| TroveGuard v2 deploy | [0x19963d99…e89638](https://explorer.test.mezo.org/tx/0x19963d99d3f60d6d69417df39f90509eb59c4bfa3b6ec97a6c91fd0cdfe89638) |
| TroveGuard v2 protect, RepayMUSD 118.45 % → 123.95 % | [0x950ca982…335aa9](https://explorer.test.mezo.org/tx/0x950ca982156cc6b3dd1f6e2e69552e00aa19bba9b70765545b3764947d335aa9) |
| TroveGuard v2 protect, AddColl 123.88 % → 131.16 % | [0xc3b2dcde…dde6e554](https://explorer.test.mezo.org/tx/0xc3b2dcde9ad22ebd2d24c4aabf87d45b5e72759cc4a615565f53c65cdde6e554) |
| protect of a permit signed in guard.html, 131.23 % → 137.62 % | [0x084a2b4b…7b052212](https://explorer.test.mezo.org/tx/0x084a2b4b964c04c722a4d10d32a04d9b8c838d0d9bd4253f7e7edbd47b052212) |
| guard.html storePermits from desktop Firefox | [0x6feaa87c…207a0740](https://explorer.test.mezo.org/tx/0x6feaa87c93222721d1a51dee45563137e422645dc509d639becee26c207a0740) |
| guard.html storePermits from Chromium as a Pixel 7 | [0x4cf41276…8019c0c4](https://explorer.test.mezo.org/tx/0x4cf41276e0ee1bdf7b04a9c9a34fd3134a82630e480929a45fa507ba8019c0c4) |

Every other transaction is listed in [proofs.json](../proofs.json), and the dashboard shows it under **Proof**.
