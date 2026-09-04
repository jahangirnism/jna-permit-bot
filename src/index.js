import { testDldLogin, continueAfterCaptcha, continueUaePassLogin, checkUaePassStatus } from './dld.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('Missing TELEGRAM_BOT_TOKEN environment variable'); process.exit(1); }
const apiBase = `https://api.telegram.org/bot${token}`;
let offset = 0;
let loginTestRunning = false;

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
    case 'captcha_required': { const link=result.browserUrl?`\n\nOpen browser: ${result.browserUrl}`:'\n\nRailway public domain was not detected. Add BROWSER_PUBLIC_URL in Railway Variables.'; return `DLD login page is ready. Username/password are filled.\n\n1. Open the browser link below.\n2. Enter your VNC password if asked.\n3. Tick “I’m not a robot”.\n4. Return to Telegram and send /continue.${link}`; }
    case 'authentication_code': return 'DLD reached an authentication-code screen.';
    case 'uae_pass': return 'Trakheesi UAE PASS page is open. The bot is ready to use the Emirates ID stored in Railway. Send /uaepass to continue.';
    case 'uae_pass_id_required': return 'Add UAE_PASS_EMIRATES_ID in Railway Variables, redeploy, then repeat the login. The Emirates ID will be filled automatically and will not be requested in Telegram.';
    case 'uae_pass_id_field_not_found': return 'UAE PASS opened, but the Emirates ID field was not detected. Open the interactive browser and send me a screenshot of that page.';
    case 'uae_pass_login_button_not_found': return 'The Emirates ID field was filled, but the UAE PASS Login button was not detected.';
    case 'uae_pass_approval_required': return `UAE PASS APPROVAL REQUIRED\n\nSelect number ${result.challenge} in your UAE PASS app.\n\nAfter approving, send /checkuaepass.`;
    case 'real_estate_admin_profile_selected': return 'REAL ESTATE OFFICE ADMIN profile selected successfully. The DLD session has been saved and will be reused until DLD expires it.';
    case 'session_active': return 'DLD session is already active. The bot will reuse this session and will not ask for CAPTCHA/UAE PASS again unless DLD expires it.';
    case 'real_estate_admin_profile_not_found': return 'Multiple DLD profiles were found, but the REAL ESTATE OFFICE ADMIN profile was not detected.';
    case 'admin_profile_radio_not_found': return 'The REAL ESTATE OFFICE ADMIN profile was detected, but its selection control was not found.';
    case 'trakheesi_not_found': return 'DLD dashboard opened, but the Trakheesi card was not detected.';
    case 'trakheesi_uae_pass_button_not_found': return 'Trakheesi was detected, but its “Login with UAE Pass” button was not found.';
    case 'no_active_session': return 'There is no active DLD browser session. Send /testlogin first.';
    case 'login_form_not_found': return `DLD opened, but the login form was not detected. Page: ${result.url || 'unknown'}`;
    case 'signin_button_not_found': return 'The active DLD page is open, but the Sign In button was not detected.';
    case 'post_login_unknown': return `DLD moved to a new screen that still needs mapping. Page: ${result.url || 'unknown'}`;
    case 'command_timeout': return `The browser step timed out instead of hanging. ${result.message} Open the browser link to see the current DLD page, then send me a screenshot.`;
    case 'continue_error': return `The DLD continue step returned an error instead of hanging: ${result.message}`;
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

async function handleUpdate(update) {
  const message=update.message; if(!message?.text)return; const chatId=message.chat.id; const command=message.text.trim().split(/\s+/)[0].split('@')[0]; console.log(`Received ${command} from chat ${chatId}`);
  if(command==='/start'){await sendMessage(chatId,'Welcome to JnA Permit Bot.\n\nUse /testlogin to check/reuse the DLD session.\nIf DLD has expired the session, the bot will restart the CAPTCHA/UAE PASS login flow.');return;}
  if(command==='/testlogin'){await runLoginTest(chatId);return;}
  if(command==='/continue'){await sendMessage(chatId,'Continuing the active DLD login session…');const result=await withDeadline(continueAfterCaptcha(),30000,'DLD continue step');console.log('DLD continue status:',result.status,result.url||'');await sendMessage(chatId,resultMessage(result));return;}
  if(command==='/uaepass'){await sendMessage(chatId,'Submitting the Emirates ID stored in Railway to UAE PASS…');const result=await withDeadline(continueUaePassLogin(),30000,'UAE PASS submit step');console.log('UAE PASS submit status:',result.status,result.url||'');await sendMessage(chatId,resultMessage(result));return;}
  if(command==='/checkuaepass'){const result=await withDeadline(checkUaePassStatus(),20000,'UAE PASS status check');console.log('UAE PASS check status:',result.status,result.url||'');await sendMessage(chatId,resultMessage(result));return;}
  if(command==='/newpermit'){await sendMessage(chatId,'New Permit Request\n\nChecking the saved DLD session first.');await runLoginTest(chatId);}
}

async function startup(){const me=await telegram('getMe');console.log(`Connected to Telegram as @${me.username} (${me.id})`);await telegram('deleteWebhook',{drop_pending_updates:false});console.log('Telegram webhook cleared; starting long polling');}
async function poll(){await startup();console.log('JnA Permit Bot is running');while(true){try{const updates=await telegram('getUpdates',{offset,timeout:25,allowed_updates:['message']});for(const update of updates){offset=update.update_id+1;try{await handleUpdate(update);}catch(err){console.error('Update handling error:',err);try{if(update.message?.chat?.id)await sendMessage(update.message.chat.id,`Bot error: ${err.message}`);}catch{}}}}catch(err){console.error('Polling error:',err);await new Promise(resolve=>setTimeout(resolve,3000));}}}
poll().catch(err=>{console.error('Fatal bot error:',err);process.exit(1);});
