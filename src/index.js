import { testDldLogin, continueAfterCaptcha, continueUaePassLogin, checkUaePassStatus } from './dld.js';

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN environment variable');
  process.exit(1);
}

const apiBase = `https://api.telegram.org/bot${token}`;
let offset = 0;
let loginTestRunning = false;

async function telegram(method, body = {}) {
  const response = await fetch(`${apiBase}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`${method} failed (${data.error_code || response.status}): ${data.description || 'Unknown Telegram error'}`);
  return data.result;
}

async function sendMessage(chatId, text) {
  return telegram('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
}

function resultMessage(result) {
  switch (result.status) {
    case 'missing_credentials':
      return 'DLD test cannot start. Add DLD_USERNAME and DLD_PASSWORD in Railway Variables first.';
    case 'missing_vnc_password':
      return 'Interactive browser is not enabled yet. Add VNC_PASSWORD in Railway Variables, redeploy, then run /testlogin again.';
    case 'captcha_required': {
      const link = result.browserUrl ? `\n\nOpen browser: ${result.browserUrl}` : '\n\nRailway public domain was not detected. Add BROWSER_PUBLIC_URL in Railway Variables.';
      return `DLD login page is ready. Username/password are filled.\n\n1. Open the browser link below.\n2. Enter your VNC password if asked.\n3. Tick “I’m not a robot”.\n4. Return to Telegram and send /continue.${link}`;
    }
    case 'authentication_code':
      return 'DLD reached an authentication-code screen.';
    case 'uae_pass':
      return 'Trakheesi UAE PASS page is open. The bot is ready to use the Emirates ID stored in Railway. Send /uaepass to continue.';
    case 'uae_pass_id_required':
      return 'Add UAE_PASS_EMIRATES_ID in Railway Variables, redeploy, then repeat the login. The Emirates ID will be filled automatically and will not be requested in Telegram.';
    case 'uae_pass_id_field_not_found':
      return 'UAE PASS opened, but the Emirates ID field was not detected. Open the interactive browser and send me a screenshot of that page.';
    case 'uae_pass_login_button_not_found':
      return 'The Emirates ID field was filled, but the UAE PASS Login button was not detected.';
    case 'uae_pass_approval_required':
      return `UAE PASS APPROVAL REQUIRED\n\nSelect number ${result.challenge} in your UAE PASS app.\n\nAfter approving, send /checkuaepass.`;
    case 'trakheesi_not_found':
      return 'DLD dashboard opened, but the Trakheesi card was not detected.';
    case 'trakheesi_uae_pass_button_not_found':
      return 'Trakheesi was detected, but its “Login with UAE Pass” button was not found.';
    case 'no_active_session':
      return 'There is no active DLD browser session. Send /testlogin first.';
    case 'login_form_not_found':
      return `DLD opened, but the login form was not detected. Page: ${result.url || 'unknown'}`;
    case 'signin_button_not_found':
      return 'The active DLD page is open, but the Sign In button was not detected.';
    case 'post_login_unknown':
      return `DLD moved to a new screen that still needs mapping. Page: ${result.url || 'unknown'}`;
    default:
      return `DLD login test error: ${result.message || result.status || 'unknown error'}`;
  }
}

async function runLoginTest(chatId) {
  if (loginTestRunning) {
    await sendMessage(chatId, 'A DLD login test is already running.');
    return;
  }
  loginTestRunning = true;
  try {
    await sendMessage(chatId, 'Starting DLD interactive login test…');
    const result = await testDldLogin();
    console.log('DLD test status:', result.status, result.url || '');
    await sendMessage(chatId, resultMessage(result));
  } finally {
    loginTestRunning = false;
  }
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message?.text) return;
  const chatId = message.chat.id;
  const command = message.text.trim().split(/\s+/)[0].split('@')[0];
  console.log(`Received ${command} from chat ${chatId}`);

  if (command === '/start') {
    await sendMessage(chatId, 'Welcome to JnA Permit Bot.\n\nUse /testlogin to start DLD login.\nAfter CAPTCHA, send /continue.\nIf needed, use /uaepass and /checkuaepass for UAE PASS approval.');
    return;
  }
  if (command === '/testlogin') {
    await runLoginTest(chatId);
    return;
  }
  if (command === '/continue') {
    await sendMessage(chatId, 'Continuing the active DLD login session…');
    const result = await continueAfterCaptcha();
    console.log('DLD continue status:', result.status, result.url || '');
    await sendMessage(chatId, resultMessage(result));
    return;
  }
  if (command === '/uaepass') {
    await sendMessage(chatId, 'Submitting the stored Emirates ID to UAE PASS…');
    const result = await continueUaePassLogin();
    console.log('UAE PASS submit status:', result.status, result.url || '');
    await sendMessage(chatId, resultMessage(result));
    return;
  }
  if (command === '/checkuaepass') {
    const result = await checkUaePassStatus();
    console.log('UAE PASS check status:', result.status, result.url || '');
    await sendMessage(chatId, resultMessage(result));
    return;
  }
  if (command === '/newpermit') {
    await sendMessage(chatId, 'New Permit Request\n\nStep 1: opening the DLD login session.');
    await runLoginTest(chatId);
  }
}

async function startup() {
  const me = await telegram('getMe');
  console.log(`Connected to Telegram as @${me.username} (${me.id})`);
  await telegram('deleteWebhook', { drop_pending_updates: false });
  console.log('Telegram webhook cleared; starting long polling');
}

async function poll() {
  await startup();
  console.log('JnA Permit Bot is running');
  while (true) {
    try {
      const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        try { await handleUpdate(update); } catch (err) { console.error('Update handling error:', err); }
      }
    } catch (err) {
      console.error('Polling error:', err);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

poll().catch(err => {
  console.error('Fatal bot error:', err);
  process.exit(1);
});
