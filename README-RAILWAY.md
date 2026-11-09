# HiM Cooks — Railway service patch

This patch adds a persistent Railway monitor and Telegram command bot. It does not replace your existing `index.html`, `pumpfun.js`, `live-exec.js`, or Netlify configuration.

## Where to put these files

Put `onchain-listener.js`, `telegram-bot.js`, this `package.json`, and `railway.json` in the SAME directory that Railway uses as its service root.

Your screenshots show a nested `Himmmmmmmm` folder and duplicate-looking files at repository root. Pick one canonical directory for the Netlify site and make sure Railway's Root Directory matches the folder containing `onchain-listener.js`. Do not configure Railway to start a file that exists only in another directory.

## Railway settings

- Root Directory: the directory containing these four files. If you upload them into `Himmmmmmmm/`, set Root Directory to `/Himmmmmmmm`.
- Start Command: `npm start` (or let `railway.json` set it).
- Add the environment variables below in Railway → Service → Variables.

Required:
- `TELEGRAM_BOT_TOKEN` — token from BotFather
- `TELEGRAM_CHAT_ID` — destination chat ID for automatic token alerts
- `NETLIFY_PUMPFUN_URL` — full deployed Netlify function URL, e.g. `https://YOUR-SITE.netlify.app/.netlify/functions/pumpfun`
- `LIVE_EXEC_URL` — full deployed Netlify live-exec URL, e.g. `https://YOUR-SITE.netlify.app/.netlify/functions/live-exec`
- `LIVE_EXEC_SECRET` — a long random secret, identical to `LIVE_EXEC_SECRET` in Netlify
- `TELEGRAM_ALLOWED_USER_IDS` — comma-separated numeric Telegram user IDs authorised to issue `/status`, `/buy`, and `/sell`

Optional:
- `POLL_INTERVAL_MS=30000`
- `FEED_LIMIT=24`

## Commands

- `/start`
- `/status`
- `/buy <mint> <amountSOL>`
- `/sell <mint>`

For example: `/buy TOKEN_MINT 0.05`

The bot limits a single buy command to 5 SOL in this starter. Test with a tiny amount and a dedicated hot wallet. Live swaps can lose funds due to slippage, malicious tokens, fees, or failed transactions.

## Important notes

1. The listener polls the existing Netlify `pumpfun` endpoint; it does not directly subscribe to Solana program logs.
2. The monitor intentionally seeds the first feed response without alerting on all existing tokens.
3. `LIVE_EXEC_SECRET` must be configured in both Railway and Netlify. Never put it in `index.html` or other frontend code.
4. `SOLANA_PRIVATE_KEY` must exist only in Netlify's server-side environment for the current `live-exec.js` function. Use a dedicated hot wallet with limited funds, not your main wallet.
5. Set `TELEGRAM_ALLOWED_USER_IDS` before using trading commands. Leaving it blank means nobody can execute trading commands.
6. Your current `live-exec.js` uses Jupiter API v6 endpoints; if Jupiter returns an endpoint/quote error after deployment, that is a separate swap-provider compatibility issue, not the original Railway missing-file error.
7. Before enabling live trading, first verify `/start`, automatic alert delivery, and `/status`. Then test buy/sell with a very small amount.

## Local syntax check

Run `npm install` and then `npm run check` in this directory.
