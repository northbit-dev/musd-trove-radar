const {chromium}=require('playwright');const path=require('path');
const [src,pdf,pngdir]=process.argv.slice(2);
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1920,height:1080}});
await p.goto('file://'+path.resolve(src));await p.evaluate(()=>document.fonts.ready);
const n=await p.locator('.slide').count();const fs=require('fs');fs.mkdirSync(pngdir,{recursive:true});
const issues=await p.evaluate(()=>{const out=[];document.querySelectorAll('.slide').forEach((s,i)=>{const sr=s.getBoundingClientRect();s.querySelectorAll('*').forEach(e=>{const r=e.getBoundingClientRect();if(r.width&&(r.bottom>sr.bottom-30||r.right>sr.right+1)&&!e.closest('.foot'))out.push(`slide ${i+1}: ${e.tagName}.${e.className} bottom ${Math.round(r.bottom-sr.top)}`);if(e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflow!=='visible')out.push(`slide ${i+1}: overflow ${e.tagName}`)})});return out});
console.log(issues.join('\n')||'no overflow');
for(let i=0;i<n;i++){await p.locator('.slide').nth(i).screenshot({path:`${pngdir}/slide-${i+1}.png`});}
await p.pdf({path:pdf,width:'1920px',height:'1080px',printBackground:true,preferCSSPageSize:true});
await b.close();console.log(n,'slides');})();
