import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractTitleDeedFromFile } from './titleDeed.js';
import { startAgentRelay, runBrowserTask } from './agentRelay.js';
import { getPixxiCurrentUser } from './pixxi.js';

const token=process.env.TELEGRAM_BOT_TOKEN;
if(!token){console.error('Missing TELEGRAM_BOT_TOKEN environment variable');process.exit(1);}
const apiBase=`https://api.telegram.org/bot${token}`;
let offset=0;
let loginTestRunning=false;
const permitState=new Map();
const autoResumeWatchers=new Map();
const MANUAL_BROWSER_STATES=new Set(['login_form','captcha_required','authentication_code','uae_pass','uae_pass_approval_required','uae_pass_approval_timeout','post_login_unknown']);

async function telegram(method,body={}){
  const response=await fetch(`${apiBase}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!data.ok)throw new Error(`${method} failed (${data.error_code||response.status}): ${data.description||'Unknown Telegram error'}`);
  return data.result;
}
async function sendMessage(chatId,text){return telegram('sendMessage',{chat_id:chatId,text,disable_web_page_preview:true});}
function workflowPayload(state){return state?.deed&&state?.purpose&&state?.propertyType?{deed:state.deed,purpose:state.purpose,propertyType:state.propertyType,step:state.step}:null;}

function resultMessage(result){
  switch(result.status){
    case 'agent_not_configured':return 'Local browser agent is not configured yet. Add AGENT_SHARED_SECRET on Railway and start the office agent with the same secret.';
    case 'agent_offline':return 'The office browser agent is offline. Start it on the office computer, keep Chrome available, then try again.';
    case 'agent_error':return `Office browser agent error: ${result.message||'unknown error'}`;
    case 'missing_credentials':return 'The office browser agent is missing DLD_USERNAME or DLD_PASSWORD in its local environment.';
    case 'login_form':return 'DLD login/verification is open in the office Chrome window. Complete the required manual step there; I will keep checking and continue automatically.';
    case 'captcha_required':return 'CAPTCHA is showing in the office Chrome window. Complete it manually there; I will keep checking and continue automatically.';
    case 'authentication_code':return 'DLD reached an authentication-code screen. Enter the code manually in the office Chrome window; I will keep checking and continue automatically.';
    case 'uae_pass':return 'UAE PASS is open in the office Chrome window. Complete the required manual step; I will keep checking and continue automatically.';
    case 'uae_pass_id_required':return 'The office browser agent is missing UAE_PASS_EMIRATES_ID in its local environment.';
    case 'uae_pass_id_field_not_found':return 'UAE PASS opened, but the Emirates ID field was not detected in the office Chrome window.';
    case 'uae_pass_login_button_not_found':return 'The Emirates ID was filled, but the UAE PASS Login button was not detected.';
    case 'uae_pass_approval_required':return `UAE PASS APPROVAL REQUIRED\n\nSelect number ${result.challenge} in your UAE PASS app.\n\nI will keep checking automatically after approval.`;
    case 'real_estate_admin_profile_selected':return result.needsPermitContext?'REAL ESTATE OFFICE ADMIN is active. The browser session is recovered, but the local agent does not yet have this permit’s property context.':'REAL ESTATE OFFICE ADMIN profile selected successfully. Continuing from the current Trakheesi session.';
    case 'session_active':return result.needsPermitContext?'DLD/Trakheesi session is active, but the local agent does not yet have this permit’s property context.':'DLD/Trakheesi session is active on the office computer.';
    case 'real_estate_admin_profile_not_found':return 'Multiple DLD profiles were found, but REAL ESTATE OFFICE ADMIN was not detected.';
    case 'admin_profile_radio_not_found':return 'REAL ESTATE OFFICE ADMIN was detected, but its selection control was not found.';
    case 'trakheesi_not_found':return 'DLD dashboard opened, but the Trakheesi card was not detected.';
    case 'trakheesi_uae_pass_button_not_found':return 'Trakheesi was detected, but its “Login with UAE Pass” button was not found.';
    case 'no_active_session':return 'There is no active local DLD browser session. Send /testlogin first.';
    case 'login_form_not_found':return `DLD opened, but the login form was not detected. Page: ${result.url||'unknown'}`;
    case 'post_login_unknown':return `DLD moved to a new screen that still needs mapping. I will keep checking for the next known state. Page: ${result.url||'unknown'}`;
    case 'secondary_permit_not_found':return 'Secondary permit 150273 was not found. I stopped without changing anything.';
    case 'permit_menu_not_found':return 'Permit 150273 was found, but its action menu was not detected. I stopped without changing anything.';
    case 'permit_edit_not_found':return 'Permit 150273 menu opened, but Edit was not detected. I stopped.';
    case 'wrong_permit_edit_page':return 'The page did not confirm transaction 150273. I stopped to avoid editing the wrong permit.';
    case 'add_property_button_not_found':return 'Permit 150273 opened, but Add Property/Project was not detected.';
    case 'area_option_not_found':return `Area “${result.area}” was not found in the DLD dropdown. Please check the Title Deed/DLD area name.`;
    case 'property_type_not_mapped':return `${result.propertyType} is selected, but automatic field mapping is not configured for that property type yet.`;
    case 'property_selected':return `Property selected:\n${result.unitNo} — ${result.selectedResult||`${result.buildingName}, ${result.area}`}`;
    case 'listing_value_ready':return `Current Trakheesi listing is ready for Value${result.selectedResult?`:\n${result.selectedResult}`:'.'}`;
    case 'listing_resume_not_ready':return `I could not safely resume from the current Trakheesi page (${result.reason||'required listing screen not found'}). I did not click anything.`;
    case 'listing_resume_error':return `Could not inspect the current Trakheesi listing: ${result.message||'unknown error'}`;
    case 'file_normalization_failed':return `Could not prepare the ${result.which==='marketing_contract'?'Marketing Contract':'Advertisement Format'} for DLD: ${result.message}`;
    case 'document_upload_fields_not_found':return 'The required DLD document upload fields were not detected. I stopped before Save.';
    case 'value_field_not_found':return 'The visible Value field was not detected. I stopped before changing anything.';
    case 'listing_save_button_not_found':return 'The exact Unit Save button was not detected. I stopped without saving.';
    case 'listing_saved':return 'Property listing was saved successfully under secondary permit 150273.';
    case 'prepare_listing_error':return `Could not prepare the listing: ${result.message}`;
    case 'finalize_listing_error':return `Could not save the listing: ${result.message}`;
    default:return `DLD browser status: ${result.message||result.status||'unknown error'}`;
  }
}

async function downloadTelegramFile(fileId,originalName='title-deed.pdf'){
  const info=await telegram('getFile',{file_id:fileId});
  const response=await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);
  if(!response.ok)throw new Error(`Telegram file download failed (${response.status})`);
  const extension=path.extname(originalName)||path.extname(info.file_path)||'.bin';
  const filePath=path.join(os.tmpdir(),`jna-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`);
  await fs.writeFile(filePath,Buffer.from(await response.arrayBuffer()));
  return filePath;
}

async function telegramFileData(message,defaultName){
  const doc=message.document,photo=message.photo?.at(-1);const fileId=doc?.file_id||photo?.file_id;if(!fileId)return null;
  const info=await telegram('getFile',{file_id:fileId});
  const response=await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);if(!response.ok)throw new Error(`Telegram file download failed (${response.status})`);
  const buf=Buffer.from(await response.arrayBuffer());
  return{name:doc?.file_name||(defaultName||`upload-${Date.now()}.jpg`),size:buf.length,base64:buf.toString('base64')};
}

async function handleTitleDeed(chatId,message,state){
  const doc=message.document;const photo=message.photo?.at(-1);const fileId=doc?.file_id||photo?.file_id;
  if(!fileId)return false;
  const name=doc?.file_name||(photo?'title-deed.jpg':'title-deed.bin');
  let local;
  try{
    await sendMessage(chatId,'Reading the Title Deed…');
    local=await downloadTelegramFile(fileId,name);
    const {fields}=await extractTitleDeedFromFile(local);
    state.deed=fields;
    const missing=[];
    if(!fields.area)missing.push('Community / Area');
    if(!fields.landNo)missing.push('Plot No / Land No');
    if(!fields.buildingName)missing.push('Building Name');
    if(!fields.unitNo)missing.push('Property No / Unit No');
    const summary=`Title Deed extracted:\n\nArea: ${fields.area||'NOT FOUND'}\nLand No: ${fields.landNo||'NOT FOUND'}\nBuilding Name: ${fields.buildingName||'NOT FOUND'}\nUnit No: ${fields.unitNo||'NOT FOUND'}`;
    if(missing.length){state.step='deed_review';await sendMessage(chatId,`${summary}\n\nI could not confidently read: ${missing.join(', ')}. Please check the deed manually before we continue.`);return true;}
    state.step='purpose';await sendMessage(chatId,`${summary}\n\nNow send: RENT or SALE`);return true;
  }finally{if(local)await fs.rm(local,{force:true}).catch(()=>{});}
}

async function prepareListing(chatId,state){
  if(!state?.deed||!state.purpose||!state.propertyType)return;
  await sendMessage(chatId,'Opening secondary permit 150273 and searching DLD for the Title Deed property…');
  const result=await runBrowserTask('prepare_listing',{purpose:state.purpose,propertyType:state.propertyType,deed:state.deed},70000);
  await sendMessage(chatId,resultMessage(result));
  if(result.status==='property_selected'){
    state.step='value';
    await sendMessage(chatId,'Please enter the property VALUE in AED.\nExample: 50000');
  }
}
async function maybePrepareListing(chatId,state,result){if(state?.step==='ready_for_dld'&&['session_active','real_estate_admin_profile_selected'].includes(result.status))await prepareListing(chatId,state);}

function cancelAutoResumeWatch(chatId){autoResumeWatchers.delete(chatId);}
async function applyRecoveredBrowserState(chatId,fallbackState,result){
  let state=permitState.get(chatId)||fallbackState;
  if(['listing_value_ready','property_selected'].includes(result.status)){
    if(!state)state={};
    state.step='value';state.resumed=true;permitState.set(chatId,state);
    await sendMessage(chatId,'I recovered the current listing and continued to the next safe step.\n\nPlease enter the property VALUE in AED.\nExample: 50000');
    return true;
  }
  if(['session_active','real_estate_admin_profile_selected'].includes(result.status)&&state?.step==='ready_for_dld'){
    await sendMessage(chatId,'DLD session recovered. Continuing the permit workflow automatically…');
    await prepareListing(chatId,state);
    return true;
  }
  if(['session_active','real_estate_admin_profile_selected'].includes(result.status)&&result.needsPermitContext){
    await sendMessage(chatId,'The DLD session is active, but the previous Railway process lost the permit details. I will not guess the property. For this one recovery only, send /newpermit and upload the Title Deed again. After that, the office agent will keep the permit context locally so browser/Railway restarts will not cause this loop again.');
    return true;
  }
  return false;
}
function startAutoResumeWatch(chatId,state){
  if(autoResumeWatchers.has(chatId))return;
  const marker=Symbol('auto-resume');
  autoResumeWatchers.set(chatId,marker);
  void (async()=>{
    const deadline=Date.now()+5*60*1000;
    try{
      while(Date.now()<deadline&&autoResumeWatchers.get(chatId)===marker){
        await new Promise(r=>setTimeout(r,5000));
        if(autoResumeWatchers.get(chatId)!==marker)return;
        const current=permitState.get(chatId)||state;
        const result=await runBrowserTask('resume_listing',{workflow:workflowPayload(current)},70000).catch(error=>({status:'agent_error',message:error.message}));
        if(MANUAL_BROWSER_STATES.has(result.status))continue;
        if(await applyRecoveredBrowserState(chatId,current,result))return;
        if(['agent_offline','agent_not_configured','no_active_session'].includes(result.status))return;
      }
    }catch(error){console.error('Auto-resume watcher error:',error.message);}
    finally{if(autoResumeWatchers.get(chatId)===marker)autoResumeWatchers.delete(chatId);}
  })();
}

async function runLoginTest(chatId,state){
  if(loginTestRunning){await sendMessage(chatId,'A DLD login check is already running.');return;}
  loginTestRunning=true;
  try{
    await sendMessage(chatId,'Checking the DLD session on the office computer…');
    const result=await runBrowserTask('test_login',{workflow:workflowPayload(state)},90000);
    console.log('Local DLD test status:',result.status,result.url||'');
    await sendMessage(chatId,resultMessage(result));
    if(await applyRecoveredBrowserState(chatId,state,result))return;
    await maybePrepareListing(chatId,state,result);
    if(MANUAL_BROWSER_STATES.has(result.status))startAutoResumeWatch(chatId,state);
  }finally{loginTestRunning=false;}
}

async function finalizeListing(chatId,state){
  state.step='saving';await sendMessage(chatId,'Preparing the files, uploading them to Trakheesi, and saving the property…');
  const result=await runBrowserTask('finalize_listing',{value:state.value,marketingContract:state.marketingContract,advertisementFormat:state.advertisementFormat},90000);
  await sendMessage(chatId,resultMessage(result));
  if(result.status==='listing_saved'){
    state.step='saved';
    await sendMessage(chatId,'Done. Announcement Text was left blank. Save was completed. We will map the next permit/QR stage separately.');
  }else if(result.status==='file_normalization_failed'){
    state.step=result.which==='marketing_contract'?'marketing_contract':'advertisement_format';
    await sendMessage(chatId,result.which==='marketing_contract'?'Please upload the Marketing Contract again.':'Please upload the Advertisement Format again.');
  }else state.step='advertisement_format';
}

async function handleUpdate(update){
  const message=update.message;if(!message)return;
  const chatId=message.chat.id;
  let state=permitState.get(chatId);

  if(state?.step==='title_deed'&&(message.document||message.photo)){
    try{await handleTitleDeed(chatId,message,state);}catch(e){console.error('Title deed extraction failed:',e);await sendMessage(chatId,`I could not read that Title Deed automatically: ${e.message}\nPlease upload a clear PDF or image.`);}return;
  }
  if(state?.step==='marketing_contract'&&(message.document||message.photo)){
    try{
      state.marketingContract=await telegramFileData(message,'marketing-contract.jpg');
      state.step='advertisement_format';
      await sendMessage(chatId,'Marketing Contract received.\n\nNow upload the Copy of the Advertisement Format. DLD allows jpeg/jpg/bmp/png up to 1 MB. If the image is too large or another common image format is used, the office agent will resize/convert it automatically.');
    }catch(e){await sendMessage(chatId,`Could not read that upload: ${e.message}`);}return;
  }
  if(state?.step==='advertisement_format'&&(message.document||message.photo)){
    try{state.advertisementFormat=await telegramFileData(message,'advertisement-format.jpg');await finalizeListing(chatId,state);}catch(e){await sendMessage(chatId,`Could not read that upload: ${e.message}`);}return;
  }

  if(!message.text)return;
  const raw=message.text.trim();const command=raw.split(/\s+/)[0].split('@')[0].toLowerCase();
  console.log(`Received ${command} from chat ${chatId}`);

  if(command==='/testpixxi'){
    await sendMessage(chatId,'Testing Pixxi admin login…');
    try{
      const data=await getPixxiCurrentUser();
      const u=data?.data||data||{};
      const name=u?.nickName||u?.name||u?.userName||u?.username||'Admin account';
      const email=u?.email||u?.mail||'';
      await sendMessage(chatId,`Pixxi admin login successful.\n\nAccount: ${name}${email?`\nEmail: ${email}`:''}`);
    }catch(error){
      console.error('Pixxi login test failed:',error.message);
      await sendMessage(chatId,`Pixxi admin login failed: ${error.message}\n\nCheck PIXXI_ADMIN_EMAIL and PIXXI_ADMIN_PASSWORD in Railway Variables.`);
    }
    return;
  }
  if(command==='/resumelisting'){
    await sendMessage(chatId,'Checking the current DLD/Trakheesi browser state on the office computer…');
    const result=await runBrowserTask('resume_listing',{workflow:workflowPayload(state)},90000);
    await sendMessage(chatId,resultMessage(result));
    if(await applyRecoveredBrowserState(chatId,state,result)){cancelAutoResumeWatch(chatId);return;}
    if(MANUAL_BROWSER_STATES.has(result.status))startAutoResumeWatch(chatId,state);
    return;
  }
  if(command==='/cancel'){cancelAutoResumeWatch(chatId);permitState.delete(chatId);await sendMessage(chatId,'Current permit workflow cancelled. The DLD browser page was not changed.');return;}
  if(command==='/start'){await sendMessage(chatId,'Welcome to JnA Permit Bot.\n\nUse /newpermit to start a permit request. Manual OTP/CAPTCHA/UAE PASS steps are detected automatically after you complete them. /resumelisting can inspect the current browser state at any point.');return;}
  if(command==='/newpermit'){cancelAutoResumeWatch(chatId);state={step:'title_deed'};permitState.set(chatId,state);await sendMessage(chatId,'New Permit Request\n\nPlease upload the Title Deed as PDF or a clear image. I will extract Community → Area, Plot No → Land No, Building Name, and Property No → Unit No.');return;}
  if(command==='/testlogin'){await runLoginTest(chatId,state);return;}
  if(command==='/preparelisting'){if(!state||state.step!=='ready_for_dld'){await sendMessage(chatId,'No permit is ready for DLD. Start with /newpermit first.');return;}await prepareListing(chatId,state);return;}
  if(command==='/continue'){
    await sendMessage(chatId,'Continuing the DLD session on the office computer…');
    const result=await runBrowserTask('continue',{},50000);await sendMessage(chatId,resultMessage(result));await maybePrepareListing(chatId,state,result);
    if(MANUAL_BROWSER_STATES.has(result.status))startAutoResumeWatch(chatId,state);
    return;
  }
  if(command==='/uaepass'){
    await sendMessage(chatId,'Continuing UAE PASS in the office Chrome session…');
    const result=await runBrowserTask('uae_pass',{},50000);await sendMessage(chatId,resultMessage(result));
    if(MANUAL_BROWSER_STATES.has(result.status))startAutoResumeWatch(chatId,state);
    return;
  }
  if(command==='/checkuaepass'){
    const result=await runBrowserTask('check_ua_pass',{},40000).catch(async()=>runBrowserTask('check_uae_pass',{},40000));
    await sendMessage(chatId,resultMessage(result));await maybePrepareListing(chatId,state,result);
    if(MANUAL_BROWSER_STATES.has(result.status))startAutoResumeWatch(chatId,state);
    return;
  }

  if(state?.step==='purpose'&&/^(rent|sale)$/i.test(raw)){
    state.purpose=raw.toUpperCase();state.step='property_type';
    await sendMessage(chatId,`Purpose: ${state.purpose}\n\nSelect property type:\nLAND, BUILDING, VILLA, or UNIT`);return;
  }
  if(state?.step==='property_type'&&/^(land|building|villa|unit)$/i.test(raw)){
    state.propertyType=raw.toUpperCase();state.step='ready_for_dld';
    if(state.propertyType==='UNIT')await sendMessage(chatId,`Unit details ready for DLD:\n\nArea: ${state.deed.area}\nLand No: ${state.deed.landNo}\nMunicipality No: leave blank\nBuilding Name: ${state.deed.buildingName}\nUnit No: ${state.deed.unitNo}\n\nSend /testlogin. Once the session is active I will open secondary permit 150273 automatically.`);
    else await sendMessage(chatId,`${state.propertyType} selected. Automatic DLD field mapping is currently defined only for UNIT; I will not guess the other fields.`);
    return;
  }
  if(state?.step==='value'){
    const cleaned=raw.replace(/,/g,'');
    if(!/^\d+(?:\.\d{1,2})?$/.test(cleaned)||Number(cleaned)<=0){await sendMessage(chatId,'Please send a valid positive VALUE, for example: 50000');return;}
    state.value=cleaned;state.step='marketing_contract';
    await sendMessage(chatId,'Now upload the Marketing Contract from the Owner.\n\nDLD limit: 1 MB. Accepted: jpeg/jpg/bmp/gif/png/pdf. Oversized/common image formats will be resized/converted automatically where possible.');return;
  }
}

async function startup(){const me=await telegram('getMe');console.log(`Connected to Telegram as @${me.username} (${me.id})`);await telegram('deleteWebhook',{drop_pending_updates:false});console.log('Telegram webhook cleared; starting long polling');}
async function poll(){startAgentRelay();await startup();console.log('JnA Permit Bot is running in local-agent mode');while(true){try{const updates=await telegram('getUpdates',{offset,timeout:25,allowed_updates:['message']});for(const update of updates){offset=update.update_id+1;try{await handleUpdate(update);}catch(err){console.error('Update handling error:',err);try{if(update.message?.chat?.id)await sendMessage(update.message.chat.id,`Bot error: ${err.message}`);}catch{}}}}catch(err){console.error('Polling error:',err);await new Promise(resolve=>setTimeout(resolve,3000));}}}
poll().catch(err=>{console.error('Fatal bot error:',err);process.exit(1);});
