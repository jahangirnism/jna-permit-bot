import 'dotenv/config';
import { Telegraf } from 'telegraf';

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN environment variable');
  process.exit(1);
}

const bot = new Telegraf(token);

bot.start(async (ctx) => {
  await ctx.reply(
    'Welcome to JnA Permit Bot.\n\nUse /newpermit to start a new Trakheesi permit request.'
  );
});

bot.command('newpermit', async (ctx) => {
  await ctx.reply(
    'New Permit Request\n\nStep 1: DLD login connection will be started here.\n\nThe automation module is being configured.'
  );
});

bot.catch((err) => {
  console.error('Telegram bot error:', err);
});

bot.launch()
  .then(() => console.log('JnA Permit Bot is running'))
  .catch((err) => {
    console.error('Failed to start bot:', err);
    process.exit(1);
  });

const shutdown = (signal) => {
  bot.stop(signal);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
