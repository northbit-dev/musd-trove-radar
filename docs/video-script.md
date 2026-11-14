# 2-minute video script

Format: screen recording with voice-over or captions, 1080p, at most 2:00. Use `docs/demo/trove-radar-demo.cast` (play it with `asciinema play`) or run `scripts/demo.sh` live, plus the dashboard and `guard.html` in a browser.
Disclosure: the voice-over is read by a person or uses TTS. If you use TTS, say so in the description. Put the AI-assistance line on the end card.

| Time | Screen | Voice-over / caption |
|---|---|---|
| 0:00–0:10 | Title card, then the dashboard header | "MUSD lets you borrow against BTC on Mezo. You can lose that BTC to liquidation, Recovery Mode or redemptions. Trove Radar shows all three coming, and TroveGuard acts on them." |
| 0:10–0:28 | Dashboard: system cards, history charts, stress table | "It reads every trove at one block: 327 troves, a system ratio of 240 percent, and Recovery Mode 38 percent below today's BTC price. The charts show how that has moved, and a 20 percent drop would make 137 troves liquidatable." |
| 0:28–0:40 | Dashboard: Stability Pool cards, "Check a trove", then the watchlist | "86 million MUSD sits in the Stability Pool. Look up any trove to see its ratio, its place in the redemption queue, its guard and three days of ICR history. Add it to the watchlist and the page notifies you when its level changes." |
| 0:40–0:50 | Terminal: `redemption --amount 25000`, `history --blocks 100000` | "Redemptions hit the lowest ratios first. A 50,000 MUSD redemption would close 7 troves, and every liquidation and redemption is in the history." |
| 0:50–1:20 | `guard.html`: connect, switch to Mezo Testnet, configure trigger and target, deposit MUSD, build the step list, storePermits | "TroveGuard v3 is the web flow. Connect a wallet, set a trigger and a target ratio, put some BTC or MUSD aside, and sign a ladder of steps: Adjust adds BTC and repays MUSD at once, or top up, or repay. The preview shows the ratio after each step. Every transaction is simulated before the wallet asks you." |
| 1:20–1:38 | Terminal: `keeper --loop --min-profit 5 --log json`, then the explorer: protect tx 0xcd33fa… | "Below the trigger, any keeper calls protect. On Mezo Testnet one call ran all three steps and took the trove from 117.5 to 133.2 percent, paying the keeper a tip per step." |
| 1:38–1:52 | JSON log lines, then the explorer: liquidation tx 0xb4b1ed… | "The same daemon liquidates when it pays. It skipped three troves below its minimum profit, liquidated the fourth, and recovered from an RPC error by itself. It ships as a Docker image." |
| 1:52–2:00 | End card: repo URL, dashboard URL, "by northbit · built with an AI coding assistant" | "MUSD Trove Radar and TroveGuard. Open source, GPL-3. Links below." |

Proof links:
- TroveGuard v3 https://explorer.test.mezo.org/address/0xe96e1f552aac9828f4c24e75f4aa895dcf7f5fb9
- v3 protect, three steps in one call https://explorer.test.mezo.org/tx/0xcd33fad9ea83f6c9698ad9872ec098b9c45441b2d2a9742aa94467e3f91282eb
- v2 protect of a wallet-signed permit https://explorer.test.mezo.org/tx/0x084a2b4b964c04c722a4d10d32a04d9b8c838d0d9bd4253f7e7edbd47b052212
- daemon liquidation https://explorer.test.mezo.org/tx/0xb4b1ed7b85dc19eda5f56ff42465364111afda64361c834d637b2b1d8cb7a280

## Checklist before recording
- [ ] Run `node src/cli.mjs dashboard` and the snapshot again so the numbers match the voice-over (update the figures in the script)
- [ ] For the web flow, use a test wallet that only holds testnet funds, on Mezo Testnet
- [ ] Use a browser zoom of 125 % and hide bookmarks and personal tabs
- [ ] Use a terminal 110×40 with a large font, and no hostname or user name in the prompt (`PS1='$ '`)
- [ ] No keys, `.secrets`, e-mail or private notifications on screen
- [ ] At most 2:00; export to MP4 and upload unlisted (YouTube/Loom), then paste the link into the submission
