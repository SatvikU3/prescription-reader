"use strict";

/**
 * POST /api/extract
 * Body: { image: "<base64, no data: prefix>", mime: "image/jpeg" | "image/png" | "image/webp" }
 * Returns: { text: "<transcribed handwriting>" }
 *
 * The Gemini API key lives in the GEMINI_API_KEY environment variable and
 * never reaches the browser.
 */

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX || 10);      // requests per IP per window
const RATE_WINDOW_MS = 10 * 60 * 1000;                           // 10 minutes
const MAX_BASE64_CHARS = 4000000;                                // Vercel caps request bodies at ~4.5 MB
const UPSTREAM_TIMEOUT_MS = 25000;
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
function debugDetail(status, data) {
  if (process.env.DEBUG_ERRORS !== "1") return "";
  const message = (data && data.error && data.error.message) || "no message";
  return " (Google said " + status + ": " + String(message).slice(0, 300) + ")";
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

  // Optional: only accept requests whose Origin header matches your site.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowedOrigins.length && !allowedOrigins.includes(req.headers.origin)) {
    return res.status(403).json({ error: "This origin isn't allowed." });
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(MODEL) + ":generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: image } }] }],
          generationConfig: { temperature: 0 }
        }),
        signal: controller.signal
      }
    );

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      console.error("Gemini error", upstream.status, data && data.error && data.error.message);
      if (upstream.status === 429) {
        return res.status(429).json({ error: "The shared Gemini quota is busy right now. Try again in a minute." });
      }
      return res.status(502).json({ error: "The handwriting reader had a problem. Try again." + debugDetail(upstream.status, data) });
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
  } catch (err) {
    if (err && err.name === "AbortError") {
      return res.status(504).json({ error: "The handwriting reader took too long. Try again." });
    }
    console.error("extract failed", err && err.message);
    return res.status(502).json({ error: "Couldn't reach the handwriting reader. Try again." + (process.env.DEBUG_ERRORS === "1" ? " (" + String(err && err.message).slice(0, 200) + ")" : "") });
  } finally {
    clearTimeout(timer);
  }
};
