const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN environment variable');
  process.exit(1);
}

const apiBase = `https://api.telegram.org/bot${token}`;
let offset = 0;

async function telegram(method, body = {}) {
  const response = await fetch(`${apiBase}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

async function sendMessage(chatId, text) {
  return telegram('sendMessage', { chat_id: chatId, text });
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const command = message.text.trim().split(/\s+/)[0].split('@')[0];

  if (command === '/start') {
    await sendMessage(
      chatId,
      'Welcome to JnA Permit Bot.\n\nUse /newpermit to start a new Trakheesi permit request.'
    );
    return;
  }

  if (command === '/newpermit') {
    await sendMessage(
      chatId,
      'New Permit Request\n\nStep 1: DLD login connection will be started here.'
    );
  }
}

async function poll() {
  console.log('JnA Permit Bot is running');

  while (true) {
    try {
      const updates = await telegram('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message']
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (err) {
          console.error('Update handling error:', err);
        }
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
