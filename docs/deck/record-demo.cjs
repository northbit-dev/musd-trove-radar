// Records the captioned demo of the live dashboard and guard.html (docs/demo.mp4). Needs: npm i playwright
const {chromium}=require('playwright');
const BASE='https://northbit-dev.github.io/musd-trove-radar/';
const TROVE='0x20b854C2fCB761DF9f18b27cCBfBeD7276070D7B'; // public demo trove on Mezo Testnet
const PROTECT_TX='https://explorer.test.mezo.org/tx/0x084a2b4b964c04c722a4d10d32a04d9b8c838d0d9bd4253f7e7edbd47b052212';
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const CSS=`
#cap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);max-width:1120px;z-index:9999;background:rgba(14,20,36,.93);color:#fff;font:600 22px/1.35 Inter,system-ui,sans-serif;padding:14px 26px;border-radius:12px;border:1px solid #f7931a;box-shadow:0 8px 30px rgba(0,0,0,.35);text-align:center;transition:opacity .35s}
#cap .k{color:#ffb35c;margin-right:10px}
#card{position:fixed;inset:0;z-index:10000;background:#0e1424;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-family:Inter,system-ui,sans-serif;transition:opacity .6s}
#card h1{font-size:62px;margin:0 0 14px}#card p{font-size:26px;color:#ffd3a1;margin:6px}#card small{font-size:20px;color:#9aa3bd;margin-top:22px}
#cur{position:fixed;width:18px;height:18px;border-radius:50%;background:rgba(247,147,26,.85);border:2px solid #fff;z-index:9998;pointer-events:none;transform:translate(-50%,-50%)}
.hl{outline:3px solid #f7931a!important;outline-offset:4px;border-radius:6px}`;
(async()=>{
const b=await chromium.launch();
const ctx=await b.newContext({viewport:{width:1280,height:720},recordVideo:{dir:'vid',size:{width:1280,height:720}}});
const t0=Date.now();const p=await ctx.newPage();
let last={x:640,y:360};
const inject=async()=>{await p.addStyleTag({content:CSS});await p.evaluate(({x,y})=>{const c=document.createElement('div');c.id='cur';c.style.left=x+'px';c.style.top=y+'px';document.body.appendChild(c);
document.addEventListener('mousemove',e=>{c.style.left=e.clientX+'px';c.style.top=e.clientY+'px'});
const cap=document.createElement('div');cap.id='cap';cap.style.opacity=0;document.body.appendChild(cap)},last)};
const go=async(u)=>{await p.goto(u,{waitUntil:'networkidle',timeout:60000});await inject()};
const card=async(h,lines,ms)=>{await p.evaluate(([h,l])=>{const d=document.createElement('div');d.id='card';d.innerHTML=`<h1>${h}</h1>`+l.map((x,i)=>i==l.length-1&&l.length>2?`<small>${x}</small>`:`<p>${x}</p>`).join('');document.body.appendChild(d)},[h,lines]);await wait(ms);await p.evaluate(()=>{const d=document.getElementById('card');d.style.opacity=0;setTimeout(()=>d.remove(),700)});await wait(700)};
const cap=async(k,t,ms=2500)=>{await p.evaluate(([k,t])=>{const c=document.getElementById('cap');c.innerHTML=(k?`<span class="k">${k}</span>`:'')+t;c.style.opacity=1},[k,t]);await wait(ms)};
const capOff=()=>p.evaluate(()=>{document.getElementById('cap').style.opacity=0});
const scrollTo=async(sel,block='start',off=0)=>{await p.evaluate(([s,b,o])=>{const e=document.querySelector(s);if(b==='start'){window.scrollTo({top:e.getBoundingClientRect().top+window.scrollY-o,behavior:'smooth'})}else e.scrollIntoView({behavior:'smooth',block:b})},[sel,block,off]);await wait(1000)};
const move=async(sel)=>{const l=p.locator(sel).first();await l.scrollIntoViewIfNeeded();const bb=await l.boundingBox();last={x:bb.x+bb.width/2,y:bb.y+bb.height/2};await p.mouse.move(last.x,last.y,{steps:20});await wait(250);return l};
const click=async(sel)=>{await move(sel);await p.mouse.down();await p.mouse.up();await wait(600)};
const fill=async(sel,v,delay=35)=>{const l=await move(sel);await l.click({clickCount:3});await l.pressSequentially(String(v),{delay});await wait(300)};
const hl=async(sel,on=true)=>p.evaluate(([s,o])=>document.querySelectorAll(s).forEach(e=>e.classList.toggle('hl',o)),[sel,on]);

await go(BASE);
const tStart=Date.now();
await card('MUSD Trove Radar + TroveGuard',['See liquidations, Recovery Mode and redemptions coming,','and let a keeper protect your trove before they hit your BTC.','Live on Mezo Testnet · open source · GPL-3'],4200);
await cap('Radar','Every MUSD trove, read straight from the contracts at one pinned block.',3300);
await p.evaluate(()=>document.querySelector('.grid').classList.add('hl'));
await cap('Radar','353 troves · system ratio 280 % · Recovery Mode only if BTC falls 46.5 %.',3800);
await p.evaluate(()=>document.querySelector('.grid').classList.remove('hl'));
await scrollTo('#trends','start',10);
await cap('Trends','Every build adds a row to history.json, so the ratio and liquidations are charted over time.',3500);
await scrollTo('#sp','start',10);
await cap('Stability Pool','The pool covers today\'s liquidatable debt 11,877 times over.',3200);
await scrollTo('#stress','start',10);
await p.evaluate(()=>{const r=[...document.querySelectorAll('tr')].find(t=>t.textContent.startsWith('−20 %'));r.classList.add('hl')});
await cap('Stress test','If BTC drops 20 %, 92 troves become liquidatable. Recovery Mode starts near −50 %.',4500);
await p.evaluate(()=>document.querySelectorAll('tr.hl').forEach(e=>e.classList.remove('hl')));
await scrollTo('#redeem','start',10);
await cap('Redemptions','Redemptions take the lowest ratios first. 50,000 MUSD would close 23 troves.',3800);
await scrollTo('#check','start',10);
await cap('Check a trove','Paste any borrower address.',600);
await fill('#addr',TROVE,25);await click('#f button');await wait(2500);
await hl('#res');
await cap('Check a trove','Its ratio, liquidation price, place in the redemption queue, and whether a guard protects it.',4500);
await hl('#res',false);
await cap('TroveGuard','This trove is not armed. One click opens the guard app.',800);
await move('#res a[href^="guard.html"]');await wait(300);
await Promise.all([p.waitForNavigation({waitUntil:'networkidle'}),p.click('#res a[href^="guard.html"]')]);await inject();
await wait(2500);
await hl('#trove');
await cap('TroveGuard','guard.html reads the same trove from the Mezo RPC: ratio, signature nonce, reserves.',4000);
await hl('#trove',false);
await scrollTo('#trigger','center');
await cap('1 · Arm','Set a trigger ratio and a keeper tip, and park BTC or MUSD in the guard as a reserve.',3700);
await scrollTo('#rungs','center');
await cap('2 · Ladder','Build a ladder of rungs: add BTC, or repay MUSD debt.',600);
await fill('#rungs','4',120);await click('#alternate');await wait(400);
await hl('#ladderPreview');
await cap('2 · Ladder','Each rung is one EIP-712 permit, signed in your own wallet, stored with one transaction.',4500);
await hl('#ladderPreview',false);
await cap('Safety','Every transaction is simulated before the wallet asks. The page never sees a private key.',3800);
await capOff();
await go(PROTECT_TX);await wait(1500);
await p.evaluate(()=>window.scrollTo({top:230,behavior:'smooth'}));await wait(900);
await cap('On-chain','Below the trigger, any keeper calls protect(). A permit signed in guard.html took this trove from 131.2 % to 137.6 %.',5500);
await go(BASE+'#activity');await wait(1200);
await scrollTo('#activity','start',10);
await cap('Keeper daemon','The same daemon liquidates troves when it pays, simulated first with eth_call.',4500);
await capOff();
await card('MUSD Trove Radar + TroveGuard',['github.com/northbit-dev/musd-trove-radar','northbit-dev.github.io/musd-trove-radar','by northbit · built with an AI coding assistant'],4200);
const vpath=await p.video().path();await ctx.close();await b.close();
require('fs').writeFileSync('meta.json',JSON.stringify({vpath,offset:(tStart-t0)/1000}));console.log(vpath,(tStart-t0)/1000,(Date.now()-tStart)/1000);
})();
