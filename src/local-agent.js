import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testDldLogin, continueAfterCaptcha, continueUaePassLogin, checkUaePassStatus, prepareSecondaryListing, finalizeSecondaryListing } from './dld.js';

const base=(process.env.COORDINATOR_URL||'').replace(/\/$/,'');
const secret=process.env.AGENT_SHARED_SECRET||'';
if(!base||!secret){console.error('Missing COORDINATOR_URL or AGENT_SHARED_SECRET');process.exit(1);}

async function api(pathname,options={}){
  const res=await fetch(`${base}${pathname}`,{...options,headers:{authorization:`Bearer ${secret}`,'content-type':'application/json',...(options.headers||{})}});
  if(!res.ok)throw new Error(`${pathname} failed (${res.status})`);
  return res.json();
}

async function materialize(file,label){
  if(!file?.base64||!file?.name)throw new Error(`Missing ${label} file data`);
  const safe=path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g,'_');
  const target=path.join(os.tmpdir(),`jna-${Date.now()}-${Math.random().toString(36).slice(2)}-${safe}`);
  await fs.writeFile(target,Buffer.from(file.base64,'base64'));
  return target;
}

const TRANSIENT_LISTING_STATES=new Set([
  'listing_type_property_not_found',
  'listing_purpose_not_found',
  'listing_proceed_not_found'
]);

async function prepareListingWithRetry(payload){
  // Trakheesi uses ASP.NET postbacks for Property and Rent/Sell. Those controls
  // are destroyed and recreated during the postback, so a transient lookup can
  // occasionally happen while the modal is rebuilding. Restart the complete,
  // safety-checked prepare flow instead of continuing with a stale DOM element.
  let result;
  for(let attempt=1;attempt<=3;attempt++){
    result=await prepareSecondaryListing(payload);
    if(!TRANSIENT_LISTING_STATES.has(result?.status))return result;
    console.log(`Transient Trakheesi state ${result.status}; retrying prepare flow (${attempt}/3)`);
    if(attempt<3)await new Promise(r=>setTimeout(r,1800));
  }
  return result;
}

async function execute(task){
  switch(task.type){
    case 'test_login': return testDldLogin();
    case 'continue': return continueAfterCaptcha();
    case 'uae_pass': return continueUaePassLogin();
    case 'check_uae_pass': return checkUaePassStatus();
    case 'prepare_listing': return prepareListingWithRetry(task.payload||{});
    case 'finalize_listing': {
      let marketingPath,advertPath;
      try{
        marketingPath=await materialize(task.payload?.marketingContract,'marketing contract');
        advertPath=await materialize(task.payload?.advertisementFormat,'advertisement format');
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
