/**
 * HiM Cooks persistent Railway monitor.
 *
 * This polls the existing Netlify pumpfun function for new Solana token
 * candidates and sends Telegram alerts. It is not a raw Solana RPC log
 * subscription; it reuses the project's current multi-source token feed.
 *
 * Required env:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 *   NETLIFY_PUMPFUN_URL  e.g. https://YOUR-SITE.netlify.app/.netlify/functions/pumpfun
 *
 * Optional:
 *   POLL_INTERVAL_MS (default 30000)
 *   FEED_LIMIT (default 24)
 */
const { sendAlert, startBot } = require("./telegram-bot");

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
const FEED_URL = (process.env.NETLIFY_PUMPFUN_URL || "").trim();
const POLL_MS = Math.max(15000, Number(process.env.POLL_INTERVAL_MS || 30000));
const FEED_LIMIT = Math.min(40, Math.max(1, Number(process.env.FEED_LIMIT || 24)));
const seen = new Set();
const MAX_SEEN = 3000;

function short(value, max = 80) {
  return String(value || "").replace(/[<>]/g, "").slice(0, max);
}

async function pollFeed() {
  const url = new URL(FEED_URL);
  url.searchParams.set("limit", String(FEED_LIMIT));
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Netlify token feed returned HTTP ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data) ? data : (Array.isArray(data.coins) ? data.coins : []);
  return rows;
}

async function main() {
  if (!BOT_TOKEN || !CHAT_ID || !FEED_URL) {
    throw new Error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and NETLIFY_PUMPFUN_URL in Railway Variables.");
  }
  console.log(`[monitor] Starting; poll interval=${POLL_MS}ms; feed=${FEED_URL}`);
  startBot();
  await sendAlert(`✅ HiM Cooks monitor started.\nFeed polling: every ${Math.round(POLL_MS / 1000)} seconds.`);
  let firstRun = true;

  async function tick() {
    try {
      const rows = await pollFeed();
      // Seed on first successful poll so deploying doesn't spam old feed entries.
      if (firstRun) {
        for (const row of rows) {
          const mint = String(row.mint || row.address || "");
          if (mint) seen.add(mint);
        }
        firstRun = false;
        console.log(`[monitor] Initialised with ${rows.length} existing feed entries.`);
        return;
      }

      // Feed usually sorts newest-first; alert on entries not seen before.
      for (const row of rows.slice().reverse()) {
        const mint = String(row.mint || row.address || "");
        if (!mint || seen.has(mint)) continue;
        seen.add(mint);
        const name = short(row.name || row.symbol || "Unknown token", 60);
        const symbol = short(row.symbol || "N/A", 20);
        const age = row.ageMinutes == null ? "unknown" : `${Math.max(0, Math.round(Number(row.ageMinutes)))} min`;
        const cap = row.usd_market_cap == null ? "unknown" : `$${Number(row.usd_market_cap).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
        const message =
          `🆕 <b>New Solana token detected</b>\n` +
          `<b>${name}</b> (${symbol})\n` +
          `Age: ${age}\nMarket cap: ${cap}\n\n` +
          `<code>${short(mint, 60)}</code>\n` +
          `<a href="https://dexscreener.com/solana/${encodeURIComponent(mint)}">View on Dexscreener</a>`;
        await sendAlert(message, { parse_mode: "HTML", disable_web_page_preview: true });
      }
      if (seen.size > MAX_SEEN) {
        const keep = Array.from(seen).slice(-Math.floor(MAX_SEEN * 0.7));
        seen.clear();
        keep.forEach((m) => seen.add(m));
      }
      console.log(`[monitor] Feed checked: ${rows.length} entries; seen=${seen.size}`);
    } catch (err) {
      console.error("[monitor] Poll failed:", err.message || err);
    }
  }

  await tick();
  setInterval(tick, POLL_MS);
}

main().catch((err) => {
  console.error("[monitor] Fatal startup error:", err.message || err);
  process.exit(1);
});
