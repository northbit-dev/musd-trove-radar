# 2-minute video script

Format: screen recording with voice-over or captions, 1080p, at most 2:00. Use `docs/demo/trove-radar-demo.cast` (play it with `asciinema play`) or run `scripts/demo.sh` live, plus the dashboard in a browser.
Disclosure: the voice-over is read by a person or uses TTS. If you use TTS, say so in the description. Put the AI-assistance line on the end card.

| Time | Screen | Voice-over / caption |
|---|---|---|
| 0:00–0:12 | Title card, then the dashboard header | "MUSD lets you borrow against BTC on Mezo. You can lose that BTC in three ways: liquidation, Recovery Mode and redemptions. MUSD Trove Radar shows all three before they happen." |
| 0:12–0:35 | Dashboard: system cards, ICR distribution, stress table | "It reads every trove from the MUSD contracts at one block. Right now there are 354 troves and the system ratio is 283 %. Recovery Mode would start if BTC fell 47 %. A 20 % drop would make 86 troves liquidatable." |
| 0:35–0:50 | Paste an address into "Check a trove" | "Paste any borrower address to see its ratio, its liquidation price, and where it sits in the redemption queue: here it's number one, with nothing ahead of it." |
| 0:50–1:05 | Terminal: `redemption --top 5`, `redemption --amount 25000` | "Redemptions take BTC from the lowest-ratio troves first. Trove Radar rebuilds the on-chain order exactly. A 25,000 MUSD redemption would close 12 troves." |
| 1:05–1:18 | Terminal: `watch … --webhook`, receiver prints "signature valid" | "The watcher alerts only on change: a trove turning critical, Recovery Mode, or the front of the queue. Slack, Discord, Telegram or a signed webhook." |
| 1:18–1:30 | `liquidatable --simulate`, then the explorer page of tx 0x6d0f1cdb… | "For keepers: every liquidation is simulated first. Here is a real one our keeper executed on Mezo Testnet, a trove at 106.85 %." |
| 1:30–1:52 | `node src/cli.mjs guard`, then the explorer: TroveGuard contract 0x4e5ada5a4c3095727a1259369b98dd31466b0e6d (verified source), then protect txs 0xf639ce… and 0x9f66e2… | "TroveGuard goes one step further. A borrower parks BTC and stores a ladder of pre-signed top-ups, one per MUSD signature nonce. When the ratio drops below the trigger, our keeper calls protect. On Mezo Testnet two top-ups lifted this trove from 117.9 to 125.8 to 133.7 percent." |
| 1:52–2:00 | End card: repo URL, dashboard URL, "by northbit · built with an AI coding assistant" | "MUSD Trove Radar and TroveGuard. Open source, GPL-3. Links below." |

TroveGuard proof links: contract https://explorer.test.mezo.org/address/0x4e5ada5a4c3095727a1259369b98dd31466b0e6d · protect #1 https://explorer.test.mezo.org/tx/0xf639ce7656afabdac74bc6345bb83f4eeed60c8ca76a23c98a8a22c7d3206dae · protect #2 https://explorer.test.mezo.org/tx/0x9f66e2b0b6d537b1f5bd5d4ca759a740647482e759517c74f5af6222930859da

## Checklist before recording
- [ ] Run `node src/cli.mjs dashboard` and the snapshot again so the numbers match the voice-over (update the figures in the script)
- [ ] Use a browser zoom of 125 % and hide bookmarks and personal tabs
- [ ] Use a terminal 110×40 with a large font, and no hostname or user name in the prompt (`PS1='$ '`)
- [ ] No keys, `.secrets`, e-mail or private notifications on screen
- [ ] At most 2:00; export to MP4 and upload unlisted (YouTube/Loom), then paste the link into the submission
