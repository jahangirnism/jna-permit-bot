import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const sourcePath=path.join(__dirname,'local-agent.js');
const runtimePath=path.join(__dirname,'.local-agent-runtime.mjs');
let source=await fs.readFile(sourcePath,'utf8');

function replaceExact(from,to,label){
  if(!source.includes(from))throw new Error(`Local-agent startup patch failed: ${label}`);
  source=source.replace(from,to);
}

const mktgInjection = String.raw`function htmlEscape(value=''){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}

async function saveMktgImage(payload={}){
  const listingRef=safeListingRef(payload.listingRef);
  const caseDir=path.join(LISTING_ROOT,listingRef);
  await fs.mkdir(caseDir,{recursive:true});
  const target=path.join(caseDir,'MKTG.png');
  const details=payload.listing||{};
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:1600},deviceScaleFactor:1});
    const type=htmlEscape(details.listingType||'');
    const title=htmlEscape(details.title||'');
    const description=htmlEscape(details.description||'').replace(/\n/g,'<br>');
    const ref=htmlEscape(listingRef);
    const building=htmlEscape(details.building||'');
    const area=htmlEscape(details.area||'');
    const propertyType=htmlEscape(details.propertyType||'');
    const price=htmlEscape(details.price||'');
    const size=htmlEscape(details.size||'');
    const bedrooms=htmlEscape(details.bedrooms||'');
    const bathrooms=htmlEscape(details.bathrooms||'');
    const furnishing=htmlEscape(details.furnishing||'');
    const view=htmlEscape(details.view||'');
    const unitNo=htmlEscape(details.unitNo||'');
    const html='<!doctype html><html><head><meta charset="utf-8"><style>'+
      '*{box-sizing:border-box} body{margin:0;background:#f4f1ea;color:#222;font-family:Arial,Helvetica,sans-serif} .page{width:1200px;min-height:1600px;padding:56px 64px} .brand{font-size:28px;font-weight:700;letter-spacing:1px;margin-bottom:34px} .badge{display:inline-block;padding:10px 18px;border:2px solid #222;border-radius:999px;font-weight:700;margin-bottom:26px}.ref{float:right;font-size:20px;font-weight:700}.title{font-size:50px;line-height:1.08;font-weight:800;margin:12px 0 30px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:14px 34px;border-top:2px solid #222;border-bottom:2px solid #222;padding:26px 0;margin-bottom:34px}.item{font-size:23px}.label{display:block;font-size:15px;text-transform:uppercase;letter-spacing:1px;opacity:.62;margin-bottom:4px}.desc{font-size:22px;line-height:1.55}.foot{margin-top:48px;padding-top:22px;border-top:1px solid #999;font-size:16px;opacity:.7}'+
      '</style></head><body><div class="page"><div class="brand">JnA House</div><span class="badge">FOR '+(type||'LISTING')+'</span><span class="ref">'+ref+'</span><div class="title">'+title+'</div><div class="meta">'+
      '<div class="item"><span class="label">Building / Project</span>'+building+'</div><div class="item"><span class="label">Area</span>'+area+'</div>'+
      '<div class="item"><span class="label">Property Type</span>'+propertyType+'</div><div class="item"><span class="label">Unit</span>'+(unitNo||'-')+'</div>'+
      '<div class="item"><span class="label">Price</span>AED '+price+'</div><div class="item"><span class="label">Size</span>'+size+' sq ft</div>'+
      '<div class="item"><span class="label">Bedrooms</span>'+bedrooms+'</div><div class="item"><span class="label">Bathrooms</span>'+bathrooms+'</div>'+
      '<div class="item"><span class="label">Furnishing</span>'+(furnishing||'-')+'</div><div class="item"><span class="label">View</span>'+(view||'-')+'</div>'+
      '</div><div class="desc">'+description+'</div><div class="foot">Generated automatically from the exact Pixxi CRM listing data after successful listing creation.</div></div></body></html>';
    await page.setContent(html,{waitUntil:'load'});
    await page.screenshot({path:target,fullPage:true,type:'png'});
    const stat=await fs.stat(target);
    return{status:'mktg_saved',listingRef,caseDir,path:target,size:stat.size,source:'pixxi_created_listing_data'};
  }finally{await browser.close().catch(()=>{});}
}

async function convertImageWithChrome(file,kind){`;

replaceExact(
  "async function convertImageWithChrome(file,kind){",
  mktgInjection,
  'MKTG image generator'
);

replaceExact(
  "case 'sync_listing_case':return syncListingCase(task.payload||{});",
  "case 'sync_listing_case':return syncListingCase(task.payload||{});\n    case 'generate_mktg_image':return saveMktgImage(task.payload||{});",
  'MKTG task routing'
);

await fs.writeFile(runtimePath,source,'utf8');
await import(`./.local-agent-runtime.mjs?ts=${Date.now()}`);
