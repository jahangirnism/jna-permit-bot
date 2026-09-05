import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { testDldLogin, continueAfterCaptcha, continueUaePassLogin, checkUaePassStatus, prepareSecondaryListing, finalizeSecondaryListing, inspectSecondaryListingState } from './dld.js';

const base=(process.env.COORDINATOR_URL||'').replace(/\/$/,'');
const secret=process.env.AGENT_SHARED_SECRET||'';
const MAX_DLD_FILE=1024*1024;
const LOCAL_ROOT=process.env.JNA_LOCAL_DATA_DIR||path.join(os.homedir(),'.jna-permit-bot');
const CURRENT_PERMIT_PATH=process.env.JNA_CURRENT_PERMIT_PATH||path.join(LOCAL_ROOT,'current-permit.json');
if(!base||!secret){console.error('Missing COORDINATOR_URL or AGENT_SHARED_SECRET');process.exit(1);}

async function api(pathname,options={}){
  const res=await fetch(`${base}${pathname}`,{...options,headers:{authorization:`Bearer ${secret}`,'content-type':'application/json',...(options.headers||{})}});
  if(!res.ok)throw new Error(`${pathname} failed (${res.status})`);
  return res.json();
}

function fileExt(name=''){return path.extname(name).toLowerCase().replace('.','');}
function allowed(kind,ext){return kind==='marketing'?['jpeg','jpg','bmp','gif','png','pdf'].includes(ext):['jpeg','jpg','bmp','png'].includes(ext);}
function mimeFromExt(ext){if(ext==='png')return'image/png';if(ext==='gif')return'image/gif';if(ext==='bmp')return'image/bmp';if(ext==='webp')return'image/webp';if(ext==='pdf')return'application/pdf';return'image/jpeg';}
function validPermitContext(p){return !!(p&&['RENT','SALE'].includes(p.purpose)&&p.propertyType==='UNIT'&&p.deed?.area&&p.deed?.landNo&&p.deed?.buildingName&&p.deed?.unitNo);}
async function savePermitContext(payload){if(!validPermitContext(payload))return false;await fs.mkdir(LOCAL_ROOT,{recursive:true});await fs.writeFile(CURRENT_PERMIT_PATH,JSON.stringify({purpose:payload.purpose,propertyType:payload.propertyType,deed:payload.deed,updatedAt:new Date().toISOString()},null,2));return true;}
async function loadPermitContext(){try{const p=JSON.parse(await fs.readFile(CURRENT_PERMIT_PATH,'utf8'));return validPermitContext(p)?p:null;}catch{return null;}}

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
      let scale=1,quality=.88;
      for(let attempt=0;attempt<12;attempt++){
        const w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale));
        const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
        canvas.getContext('2d',{alpha:false}).drawImage(img,0,0,w,h);
        const out=canvas.toDataURL('image/jpeg',quality),b64=out.split(',')[1]||'',bytes=Math.floor(b64.length*3/4);
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
  const ext=fileExt(file.name),size=file.size||Buffer.byteLength(file.base64,'base64');
  if(allowed(kind,ext)&&size<=MAX_DLD_FILE)return{...file,size};
  if(ext==='pdf'){
    if(kind==='marketing'&&size<=MAX_DLD_FILE)return{...file,size};
    throw new Error(kind==='advertisement'?'Advertisement format must be an image; PDF conversion is not enabled.':'PDF is larger than 1 MB and cannot be safely compressed automatically.');
  }
  return convertImageWithChrome({...file,size},kind);
}

function inMemoryUpload(file){
  const ext=fileExt(file.name);
  return{name:path.basename(file.name),mimeType:mimeFromExt(ext),buffer:Buffer.from(file.base64,'base64')};
}

const RECOVERABLE_LISTING_STATES=new Set([
  'listing_type_property_not_found','listing_purpose_not_found','listing_proceed_not_found',
  'area_option_not_found','unit_tab_not_found','unit_tab_not_ready','permit_edit_not_found',
  'permit_page_unconfirmed','property_search_fields_not_found','property_search_button_not_found',
  'property_search_no_results','property_selected_but_value_field_not_found','unit_listing_open'
]);
async function prepareListingWithRetry(payload){
  if(validPermitContext(payload))await savePermitContext(payload).catch(e=>console.error('Could not persist permit context:',e.message));
  let result;
  for(let attempt=1;attempt<=6;attempt++){
    result=await prepareSecondaryListing(payload);
    if(result?.status==='property_selected')return result;
    const inspected=await inspectSecondaryListingState().catch(()=>null);
    if(inspected?.status==='listing_value_ready')return{status:'property_selected',permit:'150273',unitNo:payload?.deed?.unitNo,buildingName:payload?.deed?.buildingName,area:payload?.deed?.area,selectedResult:inspected.selectedResult||'',recovered:true};
    if(!RECOVERABLE_LISTING_STATES.has(result?.status))return result;
    console.log(`Recoverable Trakheesi state ${result.status}; inspecting and retrying (${attempt}/6)`);
    if(attempt<6)await new Promise(r=>setTimeout(r,result.status==='area_option_not_found'?2500:1400));
  }
  return result;
}

const MANUAL_STATES=new Set(['login_form','captcha_required','authentication_code','uae_pass','uae_pass_approval_required','uae_pass_approval_timeout']);
const SELF_HEAL_STATES=new Set(['login_form_not_found','post_login_unknown','trakheesi_not_found','trakheesi_session_required','continue_error']);
async function resumeWorkflowState(taskPayload={}){
  const supplied=taskPayload?.workflow;
  if(validPermitContext(supplied))await savePermitContext(supplied).catch(()=>{});
  const contextPayload=validPermitContext(supplied)?supplied:await loadPermitContext();
  let listing=await inspectSecondaryListingState();
  if(listing?.status==='listing_value_ready')return listing;
  let last=listing;
  for(let attempt=1;attempt<=5;attempt++){
    let general=await testDldLogin();last=general||last;
    if(MANUAL_STATES.has(general?.status))return general;
    if(['session_active','real_estate_admin_profile_selected'].includes(general?.status)){
      if(contextPayload){const resumed=await prepareListingWithRetry(contextPayload);if(resumed?.status)return{...resumed,recoveredFrom:'local_permit_context'};}
      return{...general,needsPermitContext:true};
    }
    if(SELF_HEAL_STATES.has(general?.status)){
      await new Promise(r=>setTimeout(r,1200));
      const continued=await continueAfterCaptcha();last=continued||last;
      if(MANUAL_STATES.has(continued?.status))return continued;
      if(['session_active','real_estate_admin_profile_selected'].includes(continued?.status)){
        if(contextPayload){const resumed=await prepareListingWithRetry(contextPayload);if(resumed?.status)return{...resumed,recoveredFrom:'local_permit_context'};}
        return{...continued,needsPermitContext:true};
      }
    }
    listing=await inspectSecondaryListingState();
    if(listing?.status==='listing_value_ready')return listing;
    if(attempt<5)await new Promise(r=>setTimeout(r,1500));
  }
  return last||listing||{status:'post_login_unknown'};
}

async function execute(task){
  switch(task.type){
    case 'test_login':return resumeWorkflowState(task.payload||{});
    case 'continue':return continueAfterCaptcha();
    case 'uae_pass':return continueUaePassLogin();
    case 'check_uae_pass':return checkUaePassStatus();
    case 'check_ua_pass':return checkUaePassStatus();
    case 'prepare_listing':return prepareListingWithRetry(task.payload||{});
    case 'resume_listing':return resumeWorkflowState(task.payload||{});
    case 'finalize_listing':{
      let marketing,advertisement;
      try{marketing=await normalizeDldFile(task.payload?.marketingContract,'marketing');}catch(error){return{status:'file_normalization_failed',which:'marketing_contract',message:error.message};}
      try{advertisement=await normalizeDldFile(task.payload?.advertisementFormat,'advertisement');}catch(error){return{status:'file_normalization_failed',which:'advertisement_format',message:error.message};}
      const finalPayload={...task.payload,marketingContract:{path:inMemoryUpload(marketing)},advertisementFormat:{path:inMemoryUpload(advertisement)}};

      // Upload each document only once. Re-running finalizeSecondaryListing resets Telerik's
      // async upload controls and can make an already-green attachment disappear.
      const result=await finalizeSecondaryListing(finalPayload);
      if(result?.status!=='listing_saved')return result;
      await new Promise(r=>setTimeout(r,1200));
      const inspected=await inspectSecondaryListingState().catch(()=>null);
      if(inspected?.status!=='listing_value_ready')return result;
      return{status:'listing_save_not_confirmed',permit:'150273',url:inspected?.url||result?.url||'',reason:'save_button_clicked_but_listing_modal_remained_open_no_document_reupload'};
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
