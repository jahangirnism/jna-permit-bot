import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { testDldLogin, continueAfterCaptcha, continueUaePassLogin, checkUaePassStatus, prepareSecondaryListing, finalizeSecondaryListing, inspectSecondaryListingState } from './dld.js';

const base=(process.env.COORDINATOR_URL||'').replace(/\/$/,'');
const secret=process.env.AGENT_SHARED_SECRET||'';
const MAX_DLD_FILE=1024*1024;
if(!base||!secret){console.error('Missing COORDINATOR_URL or AGENT_SHARED_SECRET');process.exit(1);}

async function api(pathname,options={}){
  const res=await fetch(`${base}${pathname}`,{...options,headers:{authorization:`Bearer ${secret}`,'content-type':'application/json',...(options.headers||{})}});
  if(!res.ok)throw new Error(`${pathname} failed (${res.status})`);
  return res.json();
}

function fileExt(name=''){return path.extname(name).toLowerCase().replace('.','');}
function allowed(kind,ext){return kind==='marketing'?['jpeg','jpg','bmp','gif','png','pdf'].includes(ext):['jpeg','jpg','bmp','png'].includes(ext);}
function mimeFromExt(ext){if(ext==='png')return'image/png';if(ext==='gif')return'image/gif';if(ext==='bmp')return'image/bmp';if(ext==='webp')return'image/webp';return'image/jpeg';}

async function convertImageWithChrome(file,kind){
  const input=Buffer.from(file.base64,'base64');
  const ext=fileExt(file.name);
  const mime=mimeFromExt(ext);
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const p=await browser.newPage();
    const data=await p.evaluate(async({base64,mime,maxBytes})=>{
      const src=`data:${mime};base64,${base64}`;
      const img=new Image();
      await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('Image format could not be decoded'));img.src=src;});
      let scale=1;
      let quality=.88;
      for(let attempt=0;attempt<12;attempt++){
        const w=Math.max(1,Math.round(img.naturalWidth*scale));
        const h=Math.max(1,Math.round(img.naturalHeight*scale));
        const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
        canvas.getContext('2d',{alpha:false}).drawImage(img,0,0,w,h);
        const out=canvas.toDataURL('image/jpeg',quality);
        const b64=out.split(',')[1]||'';
        const bytes=Math.floor(b64.length*3/4);
        if(bytes<=maxBytes)return{base64:b64,size:bytes};
        if(quality>.55)quality-=.08;else scale*=.82;
      }
      throw new Error('Image could not be reduced below 1 MB');
    },{base64:input.toString('base64'),mime,maxBytes:MAX_DLD_FILE});
    return{name:kind==='marketing'?'marketing-contract.jpg':'advertisement-format.jpg',size:data.size,base64:data.base64,normalized:true};
  }finally{await browser.close().catch(()=>{});}
}

async function normalizeDldFile(file,kind){
  if(!file?.base64||!file?.name)throw new Error(`Missing ${kind} file data`);
  const ext=fileExt(file.name);
  const size=file.size||Buffer.byteLength(file.base64,'base64');
  if(allowed(kind,ext)&&size<=MAX_DLD_FILE)return{...file,size};
  if(ext==='pdf'){
    if(kind==='marketing'&&size<=MAX_DLD_FILE)return{...file,size};
    throw new Error(kind==='advertisement'?'Advertisement format must be an image; PDF conversion is not enabled.':'PDF is larger than 1 MB and cannot be safely compressed automatically.');
  }
  return convertImageWithChrome({...file,size},kind);
}

async function materialize(file,label){
  if(!file?.base64||!file?.name)throw new Error(`Missing ${label} file data`);
  const safe=path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g,'_');
  const target=path.join(os.tmpdir(),`jna-${Date.now()}-${Math.random().toString(36).slice(2)}-${safe}`);
  await fs.writeFile(target,Buffer.from(file.base64,'base64'));
  return target;
}

const TRANSIENT_LISTING_STATES=new Set(['listing_type_property_not_found','listing_purpose_not_found','listing_proceed_not_found']);
async function prepareListingWithRetry(payload){let result;for(let attempt=1;attempt<=3;attempt++){result=await prepareSecondaryListing(payload);if(!TRANSIENT_LISTING_STATES.has(result?.status))return result;console.log(`Transient Trakheesi state ${result.status}; retrying prepare flow (${attempt}/3)`);if(attempt<3)await new Promise(r=>setTimeout(r,1800));}return result;}

async function execute(task){
  switch(task.type){
    case 'test_login':return testDldLogin();
    case 'continue':return continueAfterCaptcha();
    case 'uae_pass':return continueUaePassLogin();
    case 'check_uae_pass':return checkUaePassStatus();
    case 'prepare_listing':return prepareListingWithRetry(task.payload||{});
    case 'resume_listing':return inspectSecondaryListingState();
    case 'finalize_listing':{
      let marketingPath,advertPath;
      try{
        let marketing,advertisement;
        try{marketing=await normalizeDldFile(task.payload?.marketingContract,'marketing');}catch(error){return{status:'file_normalization_failed',which:'marketing_contract',message:error.message};}
        try{advertisement=await normalizeDldFile(task.payload?.advertisementFormat,'advertisement');}catch(error){return{status:'file_normalization_failed',which:'advertisement_format',message:error.message};}
        marketingPath=await materialize(marketing,'marketing contract');
        advertPath=await materialize(advertisement,'advertisement format');
        return await finalizeSecondaryListing({...task.payload,marketingContract:{path:marketingPath},advertisementFormat:{path:advertPath}});
      }finally{
        if(marketingPath)await fs.rm(marketingPath,{force:true}).catch(()=>{});
        if(advertPath)await fs.rm(advertPath,{force:true}).catch(()=>{});
      }
    }
    default:return{status:'agent_error',message:`Unknown task: ${task.type}`};
  }
}

console.log('JnA local browser agent started. Keep this terminal open.');
while(true){
  try{
    const {task}=await api('/agent/poll');
    if(!task){await new Promise(r=>setTimeout(r,1500));continue;}
    console.log(`Running browser task ${task.type}`);
    let result;
    try{result=await execute(task);}catch(error){result={status:'agent_error',message:error.message};}
    await api('/agent/result',{method:'POST',body:JSON.stringify({id:task.id,result})});
  }catch(error){console.error('Agent connection error:',error.message);await new Promise(r=>setTimeout(r,3000));}
}
