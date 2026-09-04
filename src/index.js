import { testDldLogin } from './dld.js';

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
  return telegram('sendMessage', { chat_id: chatId, text });
}

function resultMessage(result) {
  switch (result.status) {
    case 'missing_credentials': return 'DLD test cannot start. Add DLD_USERNAME and DLD_PASSWORD in Railway Variables first.';
    case 'captcha_required': return 'DLD login page reached. Username/password were filled, but the “I’m not a robot” CAPTCHA requires manual completion. This confirms the CAPTCHA checkpoint.';
    case 'authentication_code': return 'DLD accepted the first login step and reached an authentication-code screen.';
    case 'uae_pass': return 'DLD accepted the first login step and reached UAE PASS authentication.';
    case 'login_form_not_found': return `DLD opened, but the login form was not detected. Page: ${result.url || 'unknown'}`;
    case 'signin_button_not_found': return 'DLD credentials fields were detected, but the Sign In button was not detected.';
    case 'post_login_unknown': return `DLD submitted the login form and reached a new screen that still needs mapping. Page: ${result.url || 'unknown'}`;
    default: return `DLD login test error: ${result.message || result.status || 'unknown error'}`;
  }
}

async function runLoginTest(chatId) {
  if (loginTestRunning) {
    await sendMessage(chatId, 'A DLD login test is already running.');
    return;
  }
  loginTestRunning = true;
  try {
    await sendMessage(chatId, 'Starting DLD login test…');
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
    await sendMessage(chatId, 'Welcome to JnA Permit Bot.\n\nUse /newpermit to start a new Trakheesi permit request.\nUse /testlogin to test the DLD login connection.');
    return;
  }
  if (command === '/testlogin') {
    await runLoginTest(chatId);
    return;
  }
  if (command === '/newpermit') {
    await sendMessage(chatId, 'New Permit Request\n\nStep 1: checking DLD login connection.');
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
