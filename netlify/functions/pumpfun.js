// Multi-source early discovery: pump.fun → Dex profiles/boosts → Raydium recent
exports.handler = async function (event) {
  var headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store, max-age=0",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: headers, body: "" };
  }

  var limit = 24;
  if (event.queryStringParameters && event.queryStringParameters.limit) {
    limit = Math.max(1, Math.min(40, parseInt(event.queryStringParameters.limit, 10) || 24));
  }

  var ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
  var sourcesUsed = [];
  var lastError = null;
  var WSOL = "So11111111111111111111111111111111111111112";
  var STABLES = {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 1, // USDC
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 1, // USDT
    So11111111111111111111111111111111111111112: 1,
  };

  function toMs(v) {
    v = Number(v);
    if (!isFinite(v) || v <= 0) return null;
    if (v < 1e12) v *= 1000;
    if (v > Date.now() + 3600000) return null;
    if (v < 1577836800000) return null;
    return v;
  }

  function pickCreated(c) {
    return toMs(
      c.created_timestamp || c.createdTimestamp || c.createdAt || c.created_at ||
      c.open_timestamp || c.openTime || c.pairCreatedAt || c.timestamp || null
    );
  }

  function isMint(m) {
    return m && String(m).length >= 32 && String(m).length <= 48;
  }

  function normalizePump(data) {
    var coins = Array.isArray(data) ? data : (data && (data.coins || data.data || data.results || data.items)) || [];
    if (!Array.isArray(coins)) return [];
    return coins.map(function (c) {
      var mint = c.mint || c.address || c.token_address || c.tokenAddress;
      if (!isMint(mint)) return null;
      var created = pickCreated(c);
      return {
        mint: String(mint),
        address: String(mint),
        name: c.name || c.symbol || String(mint).slice(0, 8),
        symbol: c.symbol || null,
        usd_market_cap: c.usd_market_cap || c.market_cap || null,
        created_timestamp: created,
        pairCreatedAt: created,
        ageMinutes: created != null ? (Date.now() - created) / 60000 : null,
        source: "pump.fun",
      };
    }).filter(Boolean);
  }

  // 1) pump.fun
  var pumpUrls = [
    "https://frontend-api.pump.fun/coins?offset=0&limit=" + limit + "&sort=created_timestamp&order=DESC&includeNsfw=false",
    "https://frontend-api-v3.pump.fun/coins?offset=0&limit=" + limit + "&sort=created_timestamp&order=DESC&includeNsfw=false",
    "https://client-v2.pump.fun/coins?offset=0&limit=" + limit + "&sort=created_timestamp&order=DESC&includeNsfw=false",
  ];
  for (var i = 0; i < pumpUrls.length; i++) {
    try {
      var res = await fetch(pumpUrls[i], {
        headers: {
          Accept: "application/json",
          "User-Agent": ua,
          Origin: "https://pump.fun",
          Referer: "https://pump.fun/",
        },
      });
      if (!res.ok) {
        lastError = { status: res.status, url: pumpUrls[i] };
        continue;
      }
      var coins = normalizePump(await res.json());
      if (coins.length) {
        coins.forEach(function (c) {
          if (c.created_timestamp) c.ageMinutes = (Date.now() - c.created_timestamp) / 60000;
        });
        coins.sort(function (a, b) {
          var aa = a.ageMinutes; var bb = b.ageMinutes;
          var band = function (m) {
            if (m == null || !isFinite(m)) return 3;
            if (m >= 1 && m <= 10) return 0;
            if (m > 0 && m < 1) return 1;
            if (m > 10 && m <= 30) return 2;
            return 4;
          };
          var ba = band(aa); var bb2 = band(bb);
          if (ba !== bb2) return ba - bb2;
          if (aa != null && bb != null) return aa - bb;
          return (b.created_timestamp || 0) - (a.created_timestamp || 0);
        });
        return {
          statusCode: 200,
          headers: Object.assign({}, headers, {
            "X-Feed-Source": "pump.fun",
            "X-Feed-Count": String(coins.length),
            "X-Age-Priority": "early-lt-30m",
          }),
          body: JSON.stringify(coins.slice(0, limit)),
        };
      }
    } catch (e) {
      lastError = { error: (e && e.message) || "pump failed" };
    }
  }

  // 2) Multi-source merge (Dex + Raydium)
  var rows = [];
  var seen = {};

  function addRow(row) {
    if (!row || !isMint(row.mint)) return;
    var k = String(row.mint).toLowerCase();
    if (seen[k]) {
      // merge better age/metrics into existing
      var ex = seen[k];
      if (row.created_timestamp && !ex.created_timestamp) {
        ex.created_timestamp = row.created_timestamp;
        ex.pairCreatedAt = row.pairCreatedAt;
        ex.ageMinutes = row.ageMinutes;
      }
      if (row.liquidityUsd && !ex.liquidityUsd) ex.liquidityUsd = row.liquidityUsd;
      if (row.volume24h && !ex.volume24h) ex.volume24h = row.volume24h;
      if (row.priceChange5m != null && ex.priceChange5m == null) ex.priceChange5m = row.priceChange5m;
      if (row.symbol && !ex.symbol) ex.symbol = row.symbol;
      return;
    }
    seen[k] = row;
    rows.push(row);
  }

  // 2a Dex profiles
  try {
    var dx = await fetch("https://api.dexscreener.com/token-profiles/latest/v1", {
      headers: { Accept: "application/json", "User-Agent": ua },
    });
    if (dx.ok) {
      var dxData = await dx.json();
      var n = 0;
      (Array.isArray(dxData) ? dxData : []).forEach(function (row) {
        if ((row.chainId || "").toLowerCase() !== "solana") return;
        if (!isMint(row.tokenAddress)) return;
        addRow({
          mint: row.tokenAddress,
          address: row.tokenAddress,
          name: (row.description || row.tokenAddress || "").slice(0, 32),
          symbol: null,
          source: "dexscreener-realtime",
        });
        n++;
      });
      if (n) sourcesUsed.push("dex-profiles");
    }
  } catch (e1) {}

  // 2b Dex boosts (NEW primary attention source)
  try {
    var bx = await fetch("https://api.dexscreener.com/token-boosts/latest/v1", {
      headers: { Accept: "application/json", "User-Agent": ua },
    });
    if (bx.ok) {
      var boosts = await bx.json();
      var bn = 0;
      (Array.isArray(boosts) ? boosts : []).forEach(function (row) {
        if ((row.chainId || "").toLowerCase() !== "solana") return;
        if (!isMint(row.tokenAddress)) return;
        addRow({
          mint: row.tokenAddress,
          address: row.tokenAddress,
          name: (row.description || row.tokenAddress || "").slice(0, 32),
          symbol: null,
          source: "dexscreener-boost",
        });
        bn++;
      });
      if (bn) sourcesUsed.push("dex-boosts");
    }
  } catch (e2) {}

  // 2b2 Dex search — catch very new sol pairs mentioning new flow
  try {
    var sq = await fetch("https://api.dexscreener.com/latest/dex/search?q=SOL", {
      headers: { Accept: "application/json", "User-Agent": ua },
    });
    if (sq.ok) {
      var sd = await sq.json();
      var pairs = (sd && sd.pairs) || [];
      var sn = 0;
      pairs.forEach(function (p) {
        if (!p || (p.chainId || "").toLowerCase() !== "solana") return;
        var mint = p.baseToken && p.baseToken.address;
        if (!isMint(mint)) return;
        // skip pure SOL/stable bases
        if (STABLES[mint] || mint === WSOL) return;
        var created = toMs(p.pairCreatedAt);
        var ageMin = created != null ? (Date.now() - created) / 60000 : null;
        // only keep early pairs when age known
        if (ageMin != null && ageMin > 60) return;
        addRow({
          mint: mint,
          address: mint,
          name: ((p.baseToken && (p.baseToken.symbol || p.baseToken.name)) || mint).slice(0, 32),
          symbol: (p.baseToken && p.baseToken.symbol) || null,
          created_timestamp: created,
          pairCreatedAt: created,
          ageMinutes: ageMin,
          liquidityUsd: p.liquidity && p.liquidity.usd != null ? Number(p.liquidity.usd) || 0 : 0,
          volume24h: p.volume ? Number(p.volume.h24 || p.volume.h6 || p.volume.h1 || 0) || 0 : 0,
          priceChange5m: p.priceChange ? Number(p.priceChange.m5 != null ? p.priceChange.m5 : 0) || 0 : 0,
          source: "dexscreener-search",
        });
        sn++;
      });
      if (sn) sourcesUsed.push("dex-search");
    }
  } catch (eSearch) {}

  // 2c Raydium recent pools (NEW) — non-stable token paired with SOL when possible
  try {
    var rayUrl =
      "https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=volume24h&sortType=desc&pageSize=30&page=1";
    var rx = await fetch(rayUrl, { headers: { Accept: "application/json", "User-Agent": ua } });
    if (rx.ok) {
      var rd = await rx.json();
      var list = (((rd || {}).data || {}).data) || [];
      var rn = 0;
      list.forEach(function (p) {
        if (!p || !p.mintA || !p.mintB) return;
        var a = p.mintA.address;
        var b = p.mintB.address;
        var token = null;
        var sym = null;
        var name = null;
        if (a === WSOL && b && !STABLES[b]) {
          token = b; sym = p.mintB.symbol; name = p.mintB.name || sym;
        } else if (b === WSOL && a && !STABLES[a]) {
          token = a; sym = p.mintA.symbol; name = p.mintA.name || sym;
        } else {
          return; // skip stable-stable / unrelated
        }
        if (!isMint(token)) return;
        var created = toMs(p.openTime);
        // only keep relatively new opens when openTime known
        if (created != null) {
          var ageH = (Date.now() - created) / 3600000;
          if (ageH > 48) return; // older than 2 days
        }
        addRow({
          mint: token,
          address: token,
          name: (name || sym || token).slice(0, 32),
          symbol: sym || null,
          created_timestamp: created,
          pairCreatedAt: created,
          ageMinutes: created != null ? (Date.now() - created) / 60000 : null,
          liquidityUsd: Number(p.tvl || 0) || 0,
          volume24h: p.day && p.day.volume != null ? Number(p.day.volume) || 0 : 0,
          source: "raydium",
        });
        rn++;
      });
      if (rn) sourcesUsed.push("raydium");
    }
  } catch (e3) {
    lastError = lastError || { error: (e3 && e3.message) || "raydium failed" };
  }

  // 3) Enrich with Dex pair metrics / age for rows missing age
  var need = rows.filter(function (r) { return r.mint; }).slice(0, 25).map(function (r) { return r.mint; });
  if (need.length) {
    try {
      var pr = await fetch("https://api.dexscreener.com/tokens/v1/solana/" + need.join(","), {
        headers: { Accept: "application/json", "User-Agent": ua },
      });
      if (pr.ok) {
        var pd = await pr.json();
        var pairs = pd.pairs || pd || [];
        if (!Array.isArray(pairs)) pairs = [];
        rows.forEach(function (c) {
          var p = pairs.find(function (x) {
            return ((x.baseToken && x.baseToken.address) || "").toLowerCase() === c.mint.toLowerCase();
          });
          if (!p) return;
          var created = toMs(p.pairCreatedAt);
          if (created) {
            c.created_timestamp = created;
            c.pairCreatedAt = created;
            c.ageMinutes = (Date.now() - created) / 60000;
          }
          if (p.baseToken && p.baseToken.symbol) c.symbol = c.symbol || p.baseToken.symbol;
          if (p.liquidity && p.liquidity.usd != null) c.liquidityUsd = Number(p.liquidity.usd) || c.liquidityUsd || 0;
          if (p.volume) c.volume24h = Number(p.volume.h24 || p.volume.h6 || p.volume.h1 || c.volume24h || 0) || 0;
          if (p.priceChange) c.priceChange5m = Number(p.priceChange.m5 != null ? p.priceChange.m5 : 0) || 0;
        });
        sourcesUsed.push("dex-enrich");
      }
    } catch (e4) {}
  }

  rows = rows.filter(function (c) {
    if (c.ageMinutes != null && (c.ageMinutes < 0 || c.ageMinutes > 24 * 60)) return false;
    return true;
  });
  // PRIORITY WINDOW: 1–10 minutes after creation first (all sources)
  function ageBand(m) {
    if (m == null || !isFinite(m)) return 4;
    if (m > 0 && m <= 5) return 0;   // earliest discovery
    if (m > 5 && m <= 10) return 1;
    if (m > 10 && m <= 30) return 2; // entry window
    return 5;
  }
  function srcRank(s) {
    s = String(s || "");
    if (s.indexOf("pump") >= 0) return 0;
    if (s.indexOf("boost") >= 0) return 1;
    if (s.indexOf("dex") >= 0) return 2;
    if (s.indexOf("raydium") >= 0) return 3;
    return 4;
  }
  rows.sort(function (a, b) {
    var ba = ageBand(a.ageMinutes);
    var bb = ageBand(b.ageMinutes);
    if (ba !== bb) return ba - bb;
    // within 1–10m: younger first
    var aa = a.ageMinutes; var bb2 = b.ageMinutes;
    if (aa != null && bb2 != null && aa !== bb2) return aa - bb2;
    if (aa != null && bb2 == null) return -1;
    if (aa == null && bb2 != null) return 1;
    return srcRank(a.source) - srcRank(b.source);
  });
  // Put 1–10m cohort at front explicitly (stable)
  var hot = rows.filter(function (c) { return c.ageMinutes != null && c.ageMinutes > 0 && c.ageMinutes <= 30; });
  hot.sort(function (a, b) { return (a.ageMinutes || 0) - (b.ageMinutes || 0); });
  var rest = rows.filter(function (c) { return !(c.ageMinutes != null && c.ageMinutes > 0 && c.ageMinutes <= 30); });
  rows = hot.concat(rest);

  if (rows.length) {
    return {
      statusCode: 200,
      headers: Object.assign({}, headers, {
        "X-Feed-Source": sourcesUsed.join("+") || "multi",
        "X-Feed-Count": String(rows.length),
        "X-Age-Priority": "early-lt-30m",
      }),
      body: JSON.stringify(rows.slice(0, limit)),
    };
  }

  return {
    statusCode: 502,
    headers: headers,
    body: JSON.stringify({ error: "no sources available", detail: lastError, coins: [] }),
  };
};
