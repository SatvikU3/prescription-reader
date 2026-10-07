"use strict";

/**
 * POST /api/extract
 * Body: { image: "<base64, no data: prefix>", mime: "image/jpeg" | "image/png" | "image/webp" }
 * Returns: { text: "<transcribed handwriting>" }
 *
 * The Gemini API key lives in the GEMINI_API_KEY environment variable and
 * never reaches the browser.
 */

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX || 10);      // requests per IP per window
const RATE_WINDOW_MS = 10 * 60 * 1000;                           // 10 minutes
const MAX_BASE64_CHARS = 4000000;                                // Vercel caps request bodies at ~4.5 MB
const UPSTREAM_TIMEOUT_MS = 24000;                               // longest a single attempt may take when there is no fallback
// With a fallback model, the main model only gets this long, so the fallback still has time to answer.
const PRIMARY_TIMEOUT_MS = Number(process.env.PRIMARY_TIMEOUT_MS || 14000);
// Stop starting new attempts after this long, so we answer with our own message before Vercel's limit.
// This suits the default 30-second limit in vercel.json. If you raise maxDuration to 60, also set TIME_BUDGET_MS=50000.
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MS || 26000);
// Gemini 3 models "think" before answering, which is slow. Reading text off a photo doesn't need much of it.
// Set GEMINI_THINKING_LEVEL=none to leave the model's default.
const THINKING_LEVEL = (process.env.GEMINI_THINKING_LEVEL || "low").trim();
// When the main model is busy, try a second one. Set GEMINI_FALLBACK_MODEL=none to turn this off.
const FALLBACK_MODEL = (process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite").trim();
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS === undefined ? 1500 : process.env.RETRY_DELAY_MS);
const TRANSIENT = new Set([0, 500, 502, 503, 504]);               // 0 = timed out or couldn't connect
const FALL_BACK_ON = new Set([0, 404, 429, 500, 502, 503, 504]);
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

const PROMPT =
  "This is a photo of a medical prescription, probably from India or the United States. Transcribe all the text " +
  "you can read, exactly as written, one line per line of text. Put each prescribed medicine on its own line and keep " +
  "everything written about it as written: abbreviations (BD, TDS, BID, PRN, SOS, OD, HS), dosing patterns like 1-0-1 or " +
  "1/2-0-1/2, durations like x 5/7 or x 5 days, prefixes like Tab., Cap., Syp., Inj., Rx or Sig, and quantities like #30 or " +
  "Refills: 2. If a word or number is unclear, write [illegible] instead of guessing. Do not correct spellings, do not add " +
  "or infer drug names or doses, and do not add commentary. Output plain text only.";

// Best-effort, per-instance rate limit. Serverless instances don't share memory,
// so treat this as a speed bump, not a hard guarantee (see README for stricter options).
const hits = new Map();

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  if (hits.size > 1000) {
    for (const [key, rec] of hits) if (rec.resetAt < now) hits.delete(key);
  }
  const rec = hits.get(ip);
  if (!rec || rec.resetAt < now) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_MAX;
}

// While testing, set DEBUG_ERRORS=1 in Vercel to show Google's error text on the page.
// Remove it afterwards. The text never contains your key, but visitors don't need to see it.
function debugDetail(status, data, attempts) {
  if (process.env.DEBUG_ERRORS !== "1") return "";
  const message = (data && data.error && data.error.message) || "no message";
  const tried = (attempts || []).map((a) => a.model + ": " + (a.timedOut ? "timed out" : a.status) + " after " + (a.ms / 1000).toFixed(1) + "s").join("; ");
  return " (Google said " + status + ": " + String(message).slice(0, 300) + (tried ? ". Tried " + tried : "") + ")";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function generationConfig(model) {
  if (!model.startsWith("gemini-3")) return { temperature: 0 };   // older models are steadier at 0
  return THINKING_LEVEL === "none" ? {} : { thinkingConfig: { thinkingLevel: THINKING_LEVEL } };
}

async function callGemini(model, apiKey, mime, image, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: image } }] }],
          generationConfig: generationConfig(model)
        }),
        signal: controller.signal
      }
    );
    const data = await upstream.json().catch(() => ({}));
    return { ok: upstream.ok, status: upstream.status, data, model };
  } catch (err) {
    const timedOut = err && err.name === "AbortError";
    return { ok: false, status: 0, timedOut, data: { error: { message: timedOut ? "timed out" : String(err && err.message) } }, model };
  } finally {
    clearTimeout(timer);
  }
}

// Tries the main model, then the fallback model (once more if it was only busy), all within the time budget.
// Without a fallback model the main model is simply tried twice.
async function generate(apiKey, mime, image) {
  const started = Date.now();
  const left = () => TIME_BUDGET_MS - (Date.now() - started);
  const hasFallback = !!FALLBACK_MODEL && FALLBACK_MODEL !== "none" && FALLBACK_MODEL !== MODEL;
  const attempts = [];

  const attempt = async (model, cap) => {
    const t0 = Date.now();
    const r = await callGemini(model, apiKey, mime, image, Math.max(1000, Math.min(cap, left())));
    r.ms = Date.now() - t0;
    attempts.push({ model, status: r.status, timedOut: !!r.timedOut, ms: r.ms });
    console.log("Gemini attempt", model, r.timedOut ? "timed out" : r.status, r.ms + "ms");
    return r;
  };
  // A model that timed out is slow, so asking it again would waste time.
  const canRetry = (r) => !r.ok && !r.timedOut && TRANSIENT.has(r.status) && left() > 5000;

  let result = await attempt(MODEL, hasFallback ? PRIMARY_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS);
  if (result.ok) return result;

  if (hasFallback && FALL_BACK_ON.has(result.status) && left() > 3000) {
    console.error("Gemini error", result.status, MODEL, result.data && result.data.error && result.data.error.message, "- trying", FALLBACK_MODEL);
    let fb = await attempt(FALLBACK_MODEL, UPSTREAM_TIMEOUT_MS);
    if (fb.ok) return fb;
    if (canRetry(fb)) {
      await sleep(RETRY_DELAY_MS);
      fb = await attempt(FALLBACK_MODEL, UPSTREAM_TIMEOUT_MS);
      if (fb.ok) return fb;
    }
    console.error("Fallback failed", fb.status, FALLBACK_MODEL, fb.data && fb.data.error && fb.data.error.message);
  } else if (!hasFallback && canRetry(result)) {
    await sleep(RETRY_DELAY_MS);
    const again = await attempt(MODEL, UPSTREAM_TIMEOUT_MS);
    if (again.ok) return again;
  }

  result.attempts = attempts; // the main model's failure is reported, with every attempt for debugging
  return result;
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch (e) { return null; }
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  // Browsers send an Origin header with every POST. Accept requests from this site's own address
  // (so every Vercel address of the project works: production, preview and deployment links)
  // and from any extra origins listed in ALLOWED_ORIGINS. Other websites' scripts are turned away.
  // Requests without an Origin header (curl, servers) can't be told apart and are left to the rate limit.
  const origin = req.headers.origin;
  if (origin) {
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    const sameSite = !!host && (origin === "https://" + host || origin === "http://" + host);
    const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
    if (!sameSite && !extra.includes(origin)) {
      return res.status(403).json({ error: "This origin isn't allowed." });
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set");
    return res.status(500).json({ error: "The server isn't configured yet." });
  }

  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    res.setHeader("Retry-After", String(Math.ceil(RATE_WINDOW_MS / 1000)));
    return res.status(429).json({ error: "Too many requests from your connection. Try again in a few minutes." });
  }

  const body = readBody(req);
  const image = body && body.image;
  const mime = body && body.mime;

  if (typeof image !== "string" || !image) {
    return res.status(400).json({ error: "Send the photo as a base64 string in 'image'." });
  }
  if (!ALLOWED_MIME.has(mime)) {
    return res.status(400).json({ error: "Use a JPG, PNG or WebP image." });
  }
  if (image.length > MAX_BASE64_CHARS) {
    return res.status(413).json({ error: "That image is too large. Try a smaller photo." });
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
    return res.status(400).json({ error: "The image data isn't valid base64." });
  }

  const result = await generate(apiKey, mime, image);
  const data = result.data || {};

  if (!result.ok) {
    console.error("Gemini error", result.status, result.model, data.error && data.error.message);
    const detail = debugDetail(result.status, data, result.attempts);
    if (result.status === 429) {
      return res.status(429).json({ error: "The shared Gemini quota is busy right now. Try again in a minute." + detail });
    }
    if (result.status === 503) {
      return res.status(503).json({ error: "The handwriting reader is busy right now. Try again in a minute." + detail });
    }
    if (result.timedOut) {
      return res.status(504).json({ error: "The handwriting reader took too long. Try again." + detail });
    }
    if (result.status === 0) {
      return res.status(502).json({ error: "Couldn't reach the handwriting reader. Try again." + detail });
    }
    return res.status(502).json({ error: "The handwriting reader had a problem. Try again." + detail });
  }

  if (data.promptFeedback && data.promptFeedback.blockReason) {
    return res.status(422).json({ error: "Gemini couldn't process this image. Try a clearer photo." });
  }

  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || "").join("").trim();
  if (!text) {
    return res.status(422).json({ error: "No text was found in this image. Try a clearer, closer photo." });
  }

  return res.status(200).json({ text });
};
