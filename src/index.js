import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testDldLogin, continueAfterCaptcha, continueUaePassLogin, checkUaePassStatus } from './dld.js';
import { extractTitleDeedFromFile } from './titleDeed.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('Missing TELEGRAM_BOT_TOKEN environment variable'); process.exit(1); }
const apiBase = `https://api.telegram.org/bot${token}`;
let offset = 0;
let loginTestRunning = false;
const permitState = new Map();

async function telegram(method, body = {}) {
  const response = await fetch(`${apiBase}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!data.ok) throw new Error(`${method} failed (${data.error_code || response.status}): ${data.description || 'Unknown Telegram error'}`);
  return data.result;
}
async function sendMessage(chatId, text) { return telegram('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }); }
async function withDeadline(promise, ms, label) { let timer; try { return await Promise.race([promise, new Promise(resolve => { timer=setTimeout(()=>resolve({status:'command_timeout',message:`${label} did not finish within ${Math.round(ms/1000)} seconds.`}),ms); })]); } finally { clearTimeout(timer); } }

function resultMessage(result) {
  switch (result.status) {
    case 'missing_credentials': return 'DLD test cannot start. Add DLD_USERNAME and DLD_PASSWORD in Railway Variables first.';
    case 'missing_vnc_password': return 'Interactive browser is not enabled yet. Add VNC_PASSWORD in Railway Variables, redeploy, then run /testlogin again.';
    case 'captcha_required': { const link=result.browserUrl?`\n\nOpen browser: ${result.browserUrl}`:'\n\nRailway public domain was not detected. Add BROWSER_PUBLIC_URL in Railway Variables.'; return `DLD login page is ready. Username/password are filled.\n\n1. Open the browser link below.\n2. Enter your VNC password if asked.\n3. Complete the CAPTCHA manually.\n4. Return to Telegram and send /continue.${link}`; }
    case 'authentication_code': return 'DLD reached an authentication-code screen.';
    case 'uae_pass': return 'Trakheesi UAE PASS page is open. The bot is ready to use the Emirates ID stored in Railway. Send /uaepass to continue.';
    case 'uae_pass_id_required': return 'Add UAE_PASS_EMIRATES_ID in Railway Variables. Do not send the Emirates ID in Telegram.';
    case 'uae_pass_id_field_not_found': return 'UAE PASS opened, but the Emirates ID field was not detected.';
    case 'uae_pass_login_button_not_found': return 'The Emirates ID field was filled, but the UAE PASS Login button was not detected.';
    case 'uae_pass_approval_required': return `UAE PASS APPROVAL REQUIRED\n\nSelect number ${result.challenge} in your UAE PASS app.\n\nAfter approving, send /checkuaepass.`;
    case 'real_estate_admin_profile_selected': return 'REAL ESTATE OFFICE ADMIN profile selected successfully. The DLD session has been saved and will be reused until DLD expires it.';
    case 'session_active': return 'DLD session is already active. The bot will reuse this session.';
    case 'real_estate_admin_profile_not_found': return 'Multiple DLD profiles were found, but the REAL ESTATE OFFICE ADMIN profile was not detected.';
    case 'admin_profile_radio_not_found': return 'The REAL ESTATE OFFICE ADMIN profile was detected, but its selection control was not found.';
    case 'trakheesi_not_found': return 'DLD dashboard opened, but the Trakheesi card was not detected.';
    case 'trakheesi_uae_pass_button_not_found': return 'Trakheesi was detected, but its “Login with UAE Pass” button was not found.';
    case 'no_active_session': return 'There is no active DLD browser session. Send /testlogin first.';
    case 'login_form_not_found': return `DLD opened, but the login form was not detected. Page: ${result.url || 'unknown'}`;
    case 'post_login_unknown': return `DLD moved to a new screen that still needs mapping. Page: ${result.url || 'unknown'}`;
    case 'command_timeout': return `The browser step timed out instead of hanging. ${result.message}`;
    case 'continue_error': return `The DLD continue step returned an error: ${result.message}`;
    case 'uae_pass_error': return `The UAE PASS submit step returned an error: ${result.message}`;
    case 'uae_pass_check_error': return `The UAE PASS status check returned an error: ${result.message}`;
    default: return `DLD login test error: ${result.message || result.status || 'unknown error'}`;
  }
}

async function runLoginTest(chatId) {
  if (loginTestRunning) { await sendMessage(chatId, 'A DLD login test is already running.'); return; }
  loginTestRunning = true;
  try { await sendMessage(chatId, 'Checking existing DLD session first…'); const result=await withDeadline(testDldLogin(),50000,'DLD login check'); console.log('DLD test status:',result.status,result.url||''); await sendMessage(chatId,resultMessage(result)); }
  finally { loginTestRunning=false; }
}

async function downloadTelegramFile(fileId, originalName='title-deed.pdf') {
  const info=await telegram('getFile',{file_id:fileId});
  const response=await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);
  if(!response.ok)throw new Error(`Telegram file download failed (${response.status})`);
  const ext=path.extname(originalName)||path.extname(info.file_path)||'.bin';
  const filePath=path.join(os.tmpdir(),`jna-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  await fs.writeFile(filePath,Buffer.from(await response.arrayBuffer()));
  return filePath;
}

async function handleTitleDeed(chatId,message,state){
  const doc=message.document;
  const photo=message.photo?.at(-1);
  const fileId=doc?.file_id||photo?.file_id;
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
    state.step='purpose';
    await sendMessage(chatId,`${summary}\n\nNow send: RENT or SALE`);
    return true;
  }finally{if(local)await fs.rm(local,{force:true}).catch(()=>{});}
}

async function handleUpdate(update) {
  const message=update.message;if(!message)return;
  const chatId=message.chat.id;
  const state=permitState.get(chatId);

  if(state?.step==='title_deed'&&(message.document||message.photo)){
    try{await handleTitleDeed(chatId,message,state);}catch(e){console.error('Title deed extraction failed:',e);await sendMessage(chatId,`I could not read that Title Deed automatically: ${e.message}\nPlease upload a clear PDF or image.`);}return;
  }

  if(!message.text)return;
  const raw=message.text.trim();
  const command=raw.split(/\s+/)[0].split('@')[0];
  console.log(`Received ${command} from chat ${chatId}`);

  if(state?.step==='purpose'&&/^(rent|sale)$/i.test(raw)){
    state.purpose=raw.toUpperCase();state.step='property_type';
    await sendMessage(chatId,`Purpose: ${state.purpose}\n\nSelect property type by sending one word:\nLAND, BUILDING, VILLA, or UNIT`);return;
  }
  if(state?.step==='property_type'&&/^(land|building|villa|unit)$/i.test(raw)){
    state.propertyType=raw.toUpperCase();state.step='ready_for_dld';
    if(state.propertyType==='UNIT'){
      await sendMessage(chatId,`Unit details ready for DLD:\n\nArea: ${state.deed.area}\nLand No: ${state.deed.landNo}\nMunicipality No: leave blank\nBuilding Name: ${state.deed.buildingName}\nUnit No: ${state.deed.unitNo}\n\nThe data is ready. Send /testlogin when you want to continue to DLD.`);
    }else{
      await sendMessage(chatId,`${state.propertyType} selected. We have only mapped automatic Title Deed fields for UNIT so far. I will not guess the other property-type fields.`);
    }
    return;
  }

  if(command==='/start'){await sendMessage(chatId,'Welcome to JnA Permit Bot.\n\nUse /newpermit to start a permit request.');return;}
  if(command==='/newpermit'){permitState.set(chatId,{step:'title_deed'});await sendMessage(chatId,'New Permit Request\n\nPlease upload the Title Deed as PDF or a clear image. I will extract Community → Area, Plot No → Land No, Building Name → Building Name, and Property No → Unit No before opening DLD.');return;}
  if(command==='/testlogin'){await runLoginTest(chatId);return;}
  if(command==='/continue'){await sendMessage(chatId,'Continuing the active DLD login session…');const result=await withDeadline(continueAfterCaptcha(),30000,'DLD continue step');await sendMessage(chatId,resultMessage(result));return;}
  if(command==='/uaepass'){await sendMessage(chatId,'Submitting the Emirates ID stored in Railway to UAE PASS…');const result=await withDeadline(continueUaePassLogin(),30000,'UAE PASS submit step');await sendMessage(chatId,resultMessage(result));return;}
  if(command==='/checkuaepass'){const result=await withDeadline(checkUaePassStatus(),20000,'UAE PASS status check');await sendMessage(chatId,resultMessage(result));return;}
}

async function startup(){const me=await telegram('getMe');console.log(`Connected to Telegram as @${me.username} (${me.id})`);await telegram('deleteWebhook',{drop_pending_updates:false});console.log('Telegram webhook cleared; starting long polling');}
async function poll(){await startup();console.log('JnA Permit Bot is running');while(true){try{const updates=await telegram('getUpdates',{offset,timeout:25,allowed_updates:['message']});for(const update of updates){offset=update.update_id+1;try{await handleUpdate(update);}catch(err){console.error('Update handling error:',err);try{if(update.message?.chat?.id)await sendMessage(update.message.chat.id,`Bot error: ${err.message}`);}catch{}}}}catch(err){console.error('Polling error:',err);await new Promise(resolve=>setTimeout(resolve,3000));}}}
poll().catch(err=>{console.error('Fatal bot error:',err);process.exit(1);});
