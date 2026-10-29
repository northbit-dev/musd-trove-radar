#!/usr/bin/env bash
# Read-only tour of MUSD Trove Radar on Mezo Testnet. Sends no transactions.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n\033[1;36m$ %s\033[0m\n' "$*"; sleep "${DEMO_PAUSE:-1}"; "$@"; }

echo "MUSD Trove Radar · live demo on Mezo Testnet (chain 31611), read-only"
step node src/cli.mjs snapshot
step node src/cli.mjs redemption --top 5
step node src/cli.mjs redemption --amount 25000 --top 0
step node src/cli.mjs liquidatable --simulate
step node src/cli.mjs keeper

# Alerts: a throwaway local receiver that checks the HMAC signature.
RECV=$(mktemp); PORT=${DEMO_PORT:-8799}; export TROVE_RADAR_WEBHOOK_SECRET=demo-secret
node -e "
const http=require('http');import('./src/webhook.mjs').then(({verify})=>http.createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{const j=JSON.parse(b);console.log('  receiver: signature '+(verify(b,'demo-secret',q.headers['x-trove-radar-timestamp'],q.headers['x-trove-radar-signature'])?'valid':'INVALID')+', '+j.alerts.length+' alert(s)');s.writeHead(204);s.end()})}).listen($PORT,'127.0.0.1'))" > "$RECV" 2>&1 &
RPID=$!; trap 'kill $RPID 2>/dev/null; rm -f "$RECV"' EXIT; sleep 0.5
WATCH=$(node -e "import('./src/chain.mjs').then(async m=>{const pc=m.client();const s=await m.fetchSystem(pc);const t=await m.fetchTroves(pc,s);t.sort((a,b)=>a.icr<b.icr?-1:1);console.log(t.find(x=>x.icr>=s.mcr).owner)})")
step node src/cli.mjs watch "$WATCH" --webhook "http://127.0.0.1:$PORT/hook" --format json
sleep 0.5; cat "$RECV"
step node src/cli.mjs dashboard
echo; echo "Keeper liquidation already executed on testnet: https://explorer.test.mezo.org/tx/0x6d0f1cdb2407fdc572443802dcf48c0451b713d31afb5c40aa4123a5a2a2d68e"
