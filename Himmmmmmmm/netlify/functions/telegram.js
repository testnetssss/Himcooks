// Netlify Function – send Telegram alerts for HiM Cooks Live Auto
exports.handler = async function (event) {
  var headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: "POST only" }) };
  }

  var token = process.env.TELEGRAM_BOT_TOKEN || "";
  var defaultChat = process.env.TELEGRAM_CHAT_ID || "";

  try {
    var body = JSON.parse(event.body || "{}");
    var chatId = String(body.chatId || defaultChat || "").trim();
    var text = String(body.text || "").trim();
    var botToken = String(body.token || token || "").trim();

    if (!botToken || !chatId || !text) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({
          error: "Missing token, chatId, or text",
          hint: "Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in Netlify env, or pass token/chatId in body",
        }),
      };
    }

    // Prevent abuse: cap message size
    if (text.length > 3500) text = text.slice(0, 3500) + "…";

    var tgUrl = "https://api.telegram.org/bot" + encodeURIComponent(botToken) + "/sendMessage";
    var res = await fetch(tgUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        disable_web_page_preview: true,
      }),
    });
    var data = await res.json();
    if (!res.ok || !data.ok) {
      return {
        statusCode: 502,
        headers: headers,
        body: JSON.stringify({ error: "Telegram API failed", detail: data }),
      };
    }
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ ok: true, message_id: data.result && data.result.message_id }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: (err && err.message) || "telegram failed" }),
    };
  }
};
