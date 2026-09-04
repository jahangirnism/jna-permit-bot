# JnA Permit Bot — Office Browser Agent

This setup keeps Telegram/OCR/workflow state on Railway while running DLD/Trakheesi in Google Chrome on the office computer.

## Why

The DLD browser no longer runs from Railway/datacenter IPs. The office agent uses the office internet connection and a persistent local Chrome profile. CAPTCHA and UAE PASS approval remain manual.

## Railway

Add one variable:

- `AGENT_SHARED_SECRET` = a long random value (at least 32 characters)

Keep `TELEGRAM_BOT_TOKEN` on Railway. DLD credentials and Emirates ID can be removed from Railway after the local agent is working.

## Office computer prerequisites

- Google Chrome installed
- Node.js 20 or newer
- Git installed

## Install

```bash
git clone https://github.com/jahangirnism/jna-permit-bot.git
cd jna-permit-bot
npm install
cp .env.local.example .env.local
```

Edit `.env.local` and set:

- `COORDINATOR_URL=https://jna-permit-bot-production.up.railway.app`
- `AGENT_SHARED_SECRET` = exactly the same value as Railway
- `DLD_USERNAME`
- `DLD_PASSWORD`
- `UAE_PASS_EMIRATES_ID`

Do not commit `.env.local`.

## Start

```bash
npm run agent
```

Leave that terminal running. A dedicated persistent Google Chrome profile is stored under `~/.jna-permit-bot/chrome-profile` by default.

## Telegram flow

- `/testlogin` asks the office agent to check/reuse the local DLD session.
- If CAPTCHA appears, solve it manually in the office Chrome window, then send `/continue`.
- `/uaepass` fills the locally stored Emirates ID and continues UAE PASS.
- When a matching number appears, Telegram sends the number. Approve it manually in the UAE PASS app.
- `/checkuaepass` checks the result and selects `REAL ESTATE OFFICE ADMIN` when the profile selector appears.

## Security

The office agent only makes outbound HTTPS requests to Railway. No office router port forwarding is required. The relay requires the shared secret on every request.
