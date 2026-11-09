/**
 * Silent Live execution — server-side hot wallet only.
 * Env (Netlify):
 *   SOLANA_PRIVATE_KEY  — base58 secret key of a DEDICATED trading wallet (not your main wallet)
 *   LIVE_EXEC_SECRET    — shared secret so only your app can call this
 *   SOLANA_RPC_URL      — optional RPC
 *
 * NEVER put the private key in frontend code.
 */
const { Connection, Keypair, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Exec-Secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function json(status, body) {
  return { statusCode: status, headers, body: JSON.stringify(body) };
}

function loadKeypair() {
  const raw = (process.env.SOLANA_PRIVATE_KEY || "").trim();
  if (!raw) throw new Error("SOLANA_PRIVATE_KEY not set in Netlify env");
  // support base58 secret key (Phantom export) or JSON byte array
  if (raw.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

async function jupiterSwap(keypair, inputMint, outputMint, amount, slippageBps) {
  const quoteUrl =
    "https://quote-api.jup.ag/v6/quote?inputMint=" +
    encodeURIComponent(inputMint) +
    "&outputMint=" +
    encodeURIComponent(outputMint) +
    "&amount=" +
    amount +
    "&slippageBps=" +
    (slippageBps || 250);

  const quoteRes = await fetch(quoteUrl, { cache: "no-store" });
  if (!quoteRes.ok) throw new Error("Jupiter quote HTTP " + quoteRes.status);
  const quote = await quoteRes.json();
  if (!quote || quote.error || !quote.outAmount) {
    throw new Error((quote && (quote.error || quote.message)) || "No Jupiter route");
  }

  const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!swapRes.ok) throw new Error("Jupiter swap build failed");
  const swapJson = await swapRes.json();
  if (!swapJson.swapTransaction) throw new Error("No swapTransaction");

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapJson.swapTransaction, "base64")
  );
  tx.sign([keypair]);

  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  try {
    await conn.confirmTransaction(sig, "confirmed");
  } catch (_) {}
  return { signature: sig, outAmount: quote.outAmount };
}

async function getBalance(keypair) {
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const lamports = await conn.getBalance(keypair.publicKey, "confirmed");
  return lamports / 1e9;
}

async function sellAllToken(keypair, mint) {
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const accounts = await conn.getParsedTokenAccountsByOwner(keypair.publicKey, {
    mint: new (require("@solana/web3.js").PublicKey)(mint),
  });
  if (!accounts.value.length) throw new Error("No token account");
  let raw = 0;
  accounts.value.forEach(function (a) {
    const amt = parseInt(a.account.data.parsed.info.tokenAmount.amount, 10) || 0;
    if (amt > raw) raw = amt;
  });
  if (!raw) throw new Error("Zero token balance");
  return jupiterSwap(keypair, mint, SOL_MINT, raw, 250);
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "POST only" });
  }

  try {
    const secret = (process.env.LIVE_EXEC_SECRET || "").trim();
    if (!secret) {
      return json(503, {
        error: "LIVE_EXEC_SECRET not configured",
        hint: "Set LIVE_EXEC_SECRET + SOLANA_PRIVATE_KEY in Netlify env",
      });
    }
    const provided =
      (event.headers["x-exec-secret"] ||
        event.headers["X-Exec-Secret"] ||
        "") + "";
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      return json(400, { error: "Invalid JSON" });
    }
    const bodySecret = (body.secret || "") + "";
    if (provided !== secret && bodySecret !== secret) {
      return json(401, { error: "Unauthorized" });
    }

    const action = (body.action || "").toLowerCase();
    const keypair = loadKeypair();
    const pubkey = keypair.publicKey.toBase58();

    if (action === "status" || action === "balance") {
      const bal = await getBalance(keypair);
      return json(200, { ok: true, publicKey: pubkey, balanceSol: bal, silent: true });
    }

    if (action === "buy") {
      const mint = body.mint;
      const sol = Number(body.amountSol || 0);
      if (!mint || sol <= 0) return json(400, { error: "mint and amountSol required" });
      const lamports = Math.floor(sol * 1e9);
      const bal = await getBalance(keypair);
      if (bal < sol + 0.004) {
        return json(400, { error: "Insufficient hot-wallet SOL", balanceSol: bal });
      }
      const result = await jupiterSwap(keypair, SOL_MINT, mint, lamports, body.slippageBps || 250);
      const balAfter = await getBalance(keypair);
      return json(200, {
        ok: true,
        action: "buy",
        mint,
        signature: result.signature,
        publicKey: pubkey,
        balanceSol: balAfter,
      });
    }

    if (action === "sell") {
      const mint = body.mint;
      if (!mint) return json(400, { error: "mint required" });
      const result = await sellAllToken(keypair, mint);
      const balAfter = await getBalance(keypair);
      return json(200, {
        ok: true,
        action: "sell",
        mint,
        signature: result.signature,
        publicKey: pubkey,
        balanceSol: balAfter,
      });
    }

    return json(400, { error: "Unknown action. Use status|buy|sell" });
  } catch (err) {
    return json(500, { error: (err && err.message) || "live-exec failed" });
  }
};
