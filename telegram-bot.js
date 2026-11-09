/**
 * HiM Cooks Telegram bot for Railway.
 *
 * Commands:
 *   /start
 *   /status
 *   /buy <mint> <amountSol>
 *   /sell <mint>
 *
 * Trading commands are disabled unless the sender's Telegram numeric ID is
 * listed in TELEGRAM_ALLOWED_USER_IDS (comma-separated). Never leave this
 * variable empty if you intend to enable live trading.
 *
 * Required env:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID (for broadcast alerts)
 *   TELEGRAM_ALLOWED_USER_IDS (numeric Telegram user IDs, comma-separated)
 *   LIVE_EXEC_URL (Netlify live-exec endpoint)
 *   LIVE_EXEC_SECRET (same secret configured in Netlify)
 */
const TelegramBot = require("node-telegram-bot-api");

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const DEFAULT_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
const ALLOWED_IDS = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",").map((v) => v.trim()).filter(Boolean)
);
const EXEC_URL = (process.env.LIVE_EXEC_URL || "").trim();
const EXEC_SECRET = (process.env.LIVE_EXEC_SECRET || "").trim();

let bot = null;

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendAlert(text, options = {}) {
  if (!TOKEN || !DEFAULT_CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing");
  const apiUrl = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: DEFAULT_CHAT_ID, text, ...options }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await res.json();
  if (!res.ok || !result.ok) throw new Error(`Telegram sendMessage failed: ${result.description || res.status}`);
  return result;
}

async function callLiveExec(payload) {
  if (!EXEC_URL || !EXEC_SECRET) throw new Error("LIVE_EXEC_URL and LIVE_EXEC_SECRET must be configured");
  const res = await fetch(EXEC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-exec-secret": EXEC_SECRET,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Live execution returned HTTP ${res.status}`);
  return data;
}

function isAllowed(msg) {
  return ALLOWED_IDS.has(String(msg.from && msg.from.id || ""));
}

function reply(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, { disable_web_page_preview: true, ...extra });
}

function startBot() {
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  bot = new TelegramBot(TOKEN, { polling: true });

  bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
    const text =
      "HiM Cooks bot is online.\n\n" +
      "/status — check trading wallet status\n" +
      "/buy <mint> <amountSOL> — execute a buy\n" +
      "/sell <mint> — sell the full token balance\n\n" +
      "Live trading commands are restricted to approved Telegram user IDs.";
    await reply(msg.chat.id, text);
  });

  bot.onText(/^\/status(?:@\w+)?$/, async (msg) => {
    if (!isAllowed(msg)) return reply(msg.chat.id, "Your Telegram ID is not authorised to use trading commands.");
    try {
      const result = await callLiveExec({ action: "status" });
      await reply(msg.chat.id, `Wallet: ${result.publicKey}\nSOL balance: ${Number(result.balanceSol).toFixed(5)} SOL`);
    } catch (e) {
      await reply(msg.chat.id, `Status failed: ${e.message}`);
    }
  });

  bot.onText(/^\/buy(?:@\w+)?\s+(\S+)\s+([0-9]*\.?[0-9]+)$/, async (msg, match) => {
    if (!isAllowed(msg)) return reply(msg.chat.id, "Not authorised. Ask the administrator to add your Telegram numeric ID.");
    const mint = match[1];
    const amountSol = Number(match[2]);
    if (!Number.isFinite(amountSol) || amountSol <= 0 || amountSol > 5) {
      return reply(msg.chat.id, "Amount must be greater than 0 and no more than 5 SOL per command. Adjust this limit in code only after testing.");
    }
    await reply(msg.chat.id, `Submitting buy for ${amountSol} SOL. Confirm the mint carefully before using live funds…`);
    try {
      const result = await callLiveExec({ action: "buy", mint, amountSol });
      await reply(msg.chat.id, `Buy submitted.\nMint: ${escapeHtml(mint)}\nSignature: ${result.signature}\nBalance: ${Number(result.balanceSol).toFixed(5)} SOL`);
    } catch (e) {
      await reply(msg.chat.id, `Buy failed: ${e.message}`);
    }
  });

  bot.onText(/^\/sell(?:@\w+)?\s+(\S+)$/, async (msg, match) => {
    if (!isAllowed(msg)) return reply(msg.chat.id, "Not authorised. Ask the administrator to add your Telegram numeric ID.");
    const mint = match[1];
    await reply(msg.chat.id, `Submitting sell-all for mint ${mint}.`);
    try {
      const result = await callLiveExec({ action: "sell", mint });
      await reply(msg.chat.id, `Sell submitted.\nMint: ${escapeHtml(mint)}\nSignature: ${result.signature}\nBalance: ${Number(result.balanceSol).toFixed(5)} SOL`);
    } catch (e) {
      await reply(msg.chat.id, `Sell failed: ${e.message}`);
    }
  });

  bot.on("polling_error", (err) => console.error("[telegram] Polling error:", err.message || err));
  console.log("[telegram] Bot polling started.");
}

if (require.main === module) {
  try {
    startBot();
  } catch (err) {
    console.error("[telegram] Startup failed:", err.message || err);
    process.exit(1);
  }
}

module.exports = { sendAlert, startBot };
