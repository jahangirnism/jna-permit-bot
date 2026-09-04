import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractTitleDeedFromFile } from './titleDeed.js';
import { startAgentRelay, runBrowserTask } from './agentRelay.js';

const token=process.env.TELEGRAM_BOT_TOKEN;
if(!token){console.error('Missing TELEGRAM_BOT_TOKEN environment variable');process.exit(1);}
const apiBase=`https://api.telegram.org/bot${token}`;
let offset=0;
let loginTestRunning=false;
const permitState=new Map();

async function telegram(method,body={}){
  const response=await fetch(`${apiBase}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!data.ok)throw new Error(`${method} failed (${data.error_code||response.status}): ${data.description||'Unknown Telegram error'}`);
  return data.result;
}
async function sendMessage(chatId,text){return telegram('sendMessage',{chat_id:chatId,text,disable_web_page_preview:true});}

function resultMessage(result){
  switch(result.status){
    case 'agent_not_configured':return 'Local browser agent is not configured yet. Add AGENT_SHARED_SECRET on Railway and start the office agent with the same secret.';
    case 'agent_offline':return 'The office browser agent is offline. Start it on the office computer, keep Chrome available, then try again.';
    case 'agent_error':return `Office browser agent error: ${result.message||'unknown error'}`;
    case 'missing_credentials':return 'The office browser agent is missing DLD_USERNAME or DLD_PASSWORD in its local environment.';
    case 'captcha_required':return 'CAPTCHA is showing in the office Chrome window. Complete it manually there, then return to Telegram and send /continue.';
    case 'authentication_code':return 'DLD reached an authentication-code screen in the office Chrome window.';
    case 'uae_pass':return 'UAE PASS is open in the office Chrome window. Send /uaepass to continue.';
    case 'uae_pass_id_required':return 'The office browser agent is missing UAE_PASS_EMIRATES_ID in its local environment.';
    case 'uae_pass_id_field_not_found':return 'UAE PASS opened, but the Emirates ID field was not detected in the office Chrome window.';
    case 'uae_pass_login_button_not_found':return 'The Emirates ID was filled, but the UAE PASS Login button was not detected.';
    case 'uae_pass_approval_required':return `UAE PASS APPROVAL REQUIRED\n\nSelect number ${result.challenge} in your UAE PASS app.\n\nAfter approving, send /checkuaepass.`;
    case 'real_estate_admin_profile_selected':return 'REAL ESTATE OFFICE ADMIN profile selected successfully. The local Chrome session will be reused.';
    case 'session_active':return 'DLD session is already active in the office Chrome profile and will be reused.';
    case 'real_estate_admin_profile_not_found':return 'Multiple DLD profiles were found, but REAL ESTATE OFFICE ADMIN was not detected.';
    case 'admin_profile_radio_not_found':return 'REAL ESTATE OFFICE ADMIN was detected, but its selection control was not found.';
    case 'trakheesi_not_found':return 'DLD dashboard opened, but the Trakheesi card was not detected.';
    case 'trakheesi_uae_pass_button_not_found':return 'Trakheesi was detected, but its “Login with UAE Pass” button was not found.';
    case 'no_active_session':return 'There is no active local DLD browser session. Send /testlogin first.';
    case 'login_form_not_found':return `DLD opened, but the login form was not detected. Page: ${result.url||'unknown'}`;
    case 'post_login_unknown':return `DLD moved to a new screen that still needs mapping. Page: ${result.url||'unknown'}`;
    case 'continue_error':return `The DLD continue step returned an error: ${result.message}`;
    case 'uae_pass_error':return `The UAE PASS submit step returned an error: ${result.message}`;
    case 'uae_pass_check_error':return `The UAE PASS status check returned an error: ${result.message}`;
    default:return `DLD browser error: ${result.message||result.status||'unknown error'}`;
  }
}

async function runLoginTest(chatId){
  if(loginTestRunning){await sendMessage(chatId,'A DLD login check is already running.');return;}
  loginTestRunning=true;
  try{
    await sendMessage(chatId,'Checking the DLD session on the office computer…');
    const result=await runBrowserTask('test_login',{},70000);
    console.log('Local DLD test status:',result.status,result.url||'');
    await sendMessage(chatId,resultMessage(result));
  }finally{loginTestRunning=false;}
}

async function downloadTelegramFile(fileId,originalName='title-deed.pdf'){
  const info=await telegram('getFile',{file_id:fileId});
  const response=await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);
  if(!response.ok)throw new Error(`Telegram file download failed (${response.status})`);
  const ext=path.extname(originalName)||path.extname(info.file_path)||'.bin';
  const filePath=path.join(os.tmpdir(),`jna-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  await fs.writeFile(filePath,Buffer.from(await response.arrayBuffer()));
  return filePath;
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

async function handleUpdate(update){
  const message=update.message;if(!message)return;
  const chatId=message.chat.id;const state=permitState.get(chatId);

  if(state?.step==='title_deed'&&(message.document||message.photo)){
    try{await handleTitleDeed(chatId,message,state);}catch(e){console.error('Title deed extraction failed:',e);await sendMessage(chatId,`I could not read that Title Deed automatically: ${e.message}\nPlease upload a clear PDF or image.`);}return;
  }

  if(!message.text)return;
  const raw=message.text.trim();const command=raw.split(/\s+/)[0].split('@')[0];
  console.log(`Received ${command} from chat ${chatId}`);

  if(state?.step==='purpose'&&/^(rent|sale)$/i.test(raw)){
    state.purpose=raw.toUpperCase();state.step='property_type';
    await sendMessage(chatId,`Purpose: ${state.purpose}\n\nSelect property type:\nLAND, BUILDING, VILLA, or UNIT`);return;
  }
  if(state?.step==='property_type'&&/^(land|building|villa|unit)$/i.test(raw)){
    state.propertyType=raw.toUpperCase();state.step='ready_for_dld';
    if(state.propertyType==='UNIT'){
      await sendMessage(chatId,`Unit details ready for DLD:\n\nArea: ${state.deed.area}\nLand No: ${state.deed.landNo}\nMunicipality No: leave blank\nBuilding Name: ${state.deed.buildingName}\nUnit No: ${state.deed.unitNo}\n\nSend /testlogin when you want the office Chrome session to continue.`);
    }else await sendMessage(chatId,`${state.propertyType} selected. Automatic DLD field mapping is currently defined only for UNIT; I will not guess the other fields.`);
    return;
  }

  if(command==='/start'){await sendMessage(chatId,'Welcome to JnA Permit Bot.\n\nUse /newpermit to start a permit request. DLD browser work now runs on the office computer, not Railway.');return;}
  if(command==='/newpermit'){permitState.set(chatId,{step:'title_deed'});await sendMessage(chatId,'New Permit Request\n\nPlease upload the Title Deed as PDF or a clear image. I will extract Community → Area, Plot No → Land No, Building Name, and Property No → Unit No before opening DLD.');return;}
  if(command==='/testlogin'){await runLoginTest(chatId);return;}
  if(command==='/continue'){await sendMessage(chatId,'Continuing the DLD session on the office computer…');const result=await runBrowserTask('continue',{},50000);await sendMessage(chatId,resultMessage(result));return;}
  if(command==='/uaepass'){await sendMessage(chatId,'Continuing UAE PASS in the office Chrome session…');const result=await runBrowserTask('uae_pass',{},50000);await sendMessage(chatId,resultMessage(result));return;}
  if(command==='/checkuaepass'){const result=await runBrowserTask('check_uae_pass',{},40000);await sendMessage(chatId,resultMessage(result));return;}
}

async function startup(){const me=await telegram('getMe');console.log(`Connected to Telegram as @${me.username} (${me.id})`);await telegram('deleteWebhook',{drop_pending_updates:false});console.log('Telegram webhook cleared; starting long polling');}
async function poll(){startAgentRelay();await startup();console.log('JnA Permit Bot is running in local-agent mode');while(true){try{const updates=await telegram('getUpdates',{offset,timeout:25,allowed_updates:['message']});for(const update of updates){offset=update.update_id+1;try{await handleUpdate(update);}catch(err){console.error('Update handling error:',err);try{if(update.message?.chat?.id)await sendMessage(update.message.chat.id,`Bot error: ${err.message}`);}catch{}}}}catch(err){console.error('Polling error:',err);await new Promise(resolve=>setTimeout(resolve,3000));}}}
poll().catch(err=>{console.error('Fatal bot error:',err);process.exit(1);});
