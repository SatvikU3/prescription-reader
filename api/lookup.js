"use strict";

/**
 * GET /api/lookup?name=Dolo%20650[&region=us]
 *
 * Finds the generic name for a drug name written on a prescription.
 *   1. Indian brand list (data/india-brands.json), skipped when region=us
 *   2. A known generic name (data/name-equivalents.json), e.g. paracetamol / acetaminophen
 *   3. RxNorm (US National Library of Medicine, free, no key) for US brands and generics
 *   4. A close spelling of an Indian brand, offered as a "check this" suggestion only
 *
 * Generic names come back in both the India/international form and the US form.
 */

const INDIA = require("../data/india-brands.json");
const EQUIV = require("../data/name-equivalents.json");

const RX = "https://rxnav.nlm.nih.gov/REST";
const TIMEOUT_MS = 8000;
const BRAND_TTYS = ["BN", "SBD", "SBDF", "BPCK"];
const VARIANT_WORDS = new Set(["duo", "forte", "plus", "cr", "sr", "xl", "er", "mr", "ds", "junior", "kid", "kids",
  "syrup", "syp", "drops", "gel", "cream", "tablet", "tab", "capsule", "cap", "injection", "inj", "oral", "suspension"]);

// US name -> India/international name, for display. Spelling-only variants are
// recognised when read from a note, but never used as the display name.
const SPELLING_VARIANTS = new Set(["amoxycillin", "sulphasalazine", "cyclosporin", "ciclosporin", "chlorphenamine", "aluminium hydroxide"]);
const US_TO_IN = {};
for (const [inn, us] of Object.entries(EQUIV)) {
  if (!us.includes("+") && !SPELLING_VARIANTS.has(inn)) US_TO_IN[us] = inn;
}

const toUS = (c) => EQUIV[c] || c;
const toIN = (c) => US_TO_IN[c] || c;
const splitGenerics = (s) => String(s).split(/\s*\+\s*/).map((x) => x.trim().toLowerCase()).filter(Boolean);

function genericFields(components) {
  return {
    genericIndia: components.map(toIN).join(" + "),
    genericUS: components.map(toUS).join(" + "),
    single: components.length === 1
  };
}

function baseName(name) {
  return String(name).toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu|%)?(?![a-z0-9])/g, " ")
    .replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function indiaResult(key, extra) {
  return Object.assign({
    level: "good", score: 100, source: "india", isBrand: true,
    matchedName: capitalise(key)
  }, genericFields(splitGenerics(INDIA[key])), extra || {});
}

function indiaExact(base) {
  const key = base.replace(/ /g, "");
  if (INDIA[key]) return indiaResult(key);
  // "Augmentin Duo", "Pantop Forte": the brand family is known, the variant may differ.
  const words = base.split(" ");
  const removed = [];
  while (words.length > 1 && VARIANT_WORDS.has(words[words.length - 1])) {
    removed.unshift(words.pop());
    const k = words.join("");
    if (INDIA[k]) {
      return indiaResult(k, { caution: "'" + removed.join(" ") + "' isn't in the brand list, so the strength or ingredients may differ from the base brand." });
    }
  }
  return null;
}

function distance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function indiaFuzzy(key) {
  if (key.length < 5) return null;
  const limit = key.length >= 9 ? 2 : 1;
  let best = null;
  for (const k of Object.keys(INDIA)) {
    if (k.length < 5 || Math.abs(k.length - key.length) > limit) continue;
    const d = distance(key, k);
    if (d <= limit && (!best || d < best.d)) best = { k, d };
  }
  if (!best) return null;
  const generic = genericFields(splitGenerics(INDIA[best.k]));
  return {
    level: "weak", score: 60, source: "india", isBrand: true,
    matchedName: capitalise(best.k) + " (" + generic.genericIndia + ")"
  };
}

async function rx(path, params) {
  const url = new URL(RX + path);
  Object.keys(params || {}).forEach((k) => url.searchParams.set(k, params[k]));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error("RxNorm returned " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function words(s) {
  return String(s).toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
}

// How well a RxNorm concept name matches what was written on the prescription.
// 2 = the written name appears in it as whole words, 1 = a one or two letter misspelling, 0 = unrelated.
// (RxNorm's own match scores are only a ranking, so names are compared instead.)
function nameMatch(term, conceptName) {
  const t = words(term).join(" ");
  const nameWords = words(conceptName);
  if (!t || !nameWords.length) return 0;
  if ((" " + nameWords.join(" ") + " ").includes(" " + t + " ")) return 2;
  // "Tylenol Extra Strength": the first word alone is found, which is worth a suggestion but not trust.
  const first = t.split(" ")[0];
  if (t.includes(" ") && first.length >= 4 && nameWords.includes(first)) return 1;
  const limit = t.length >= 9 ? 2 : t.length >= 5 ? 1 : 0;
  if (limit && !t.includes(" ") &&
      nameWords.some((w) => w.length >= 4 && Math.abs(w.length - t.length) <= limit && distance(t, w) <= limit)) return 1;
  return 0;
}

async function conceptResult(rxcui, level, knownProps) {
  const props = knownProps || ((await rx("/rxcui/" + encodeURIComponent(rxcui) + "/properties.json")).properties || {});
  const result = {
    level, score: level === "good" ? 100 : 60, source: "rxnorm", rxcui,
    matchedName: props.name || null, tty: props.tty || null,
    isBrand: BRAND_TTYS.includes(props.tty)
  };
  if (level !== "good") return result;

  let components;
  if (props.tty === "IN") {
    components = [String(props.name).toLowerCase()];
  } else {
    const rel = await rx("/rxcui/" + encodeURIComponent(rxcui) + "/related.json", { tty: "IN" });
    const groups = (rel.relatedGroup && rel.relatedGroup.conceptGroup) || [];
    components = [];
    groups.forEach((g) => (g.conceptProperties || []).forEach((c) => {
      const n = String(c.name).toLowerCase();
      if (!components.includes(n)) components.push(n);
    }));
  }
  if (components.length) Object.assign(result, genericFields(components));
  return result;
}

async function rxnormLookup(term) {
  // 1. An exact or normalised name match (brand or ingredient) is trusted.
  const exact = await rx("/rxcui.json", { name: term, search: 2 });
  const ids = (exact.idGroup && exact.idGroup.rxnormId) || [];
  if (ids.length) return conceptResult(ids[0], "good");

  // 2. Otherwise look at the closest few concepts and compare their names with what was written.
  const approx = await rx("/approximateTerm.json", { term, maxEntries: 4 });
  const seen = new Set();
  const candidates = [];
  ((approx.approximateGroup && approx.approximateGroup.candidate) || []).forEach((c) => {
    if (c.rxcui && !seen.has(c.rxcui)) { seen.add(c.rxcui); candidates.push(c.rxcui); }
  });

  let best = null;
  for (const rxcui of candidates.slice(0, 3)) {
    const props = (await rx("/rxcui/" + encodeURIComponent(rxcui) + "/properties.json")).properties || {};
    const m = nameMatch(term, props.name);
    if (m > 0 && (!best || m > best.m)) best = { rxcui, props, m };
    if (m === 2) break;
  }
  if (!best) return { level: "none", source: "rxnorm" };
  return conceptResult(best.rxcui, best.m === 2 ? "good" : "weak", best.props);
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Use GET." });
  }

  const name = String((req.query && req.query.name) || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: "Add a drug name with ?name=" });
  const useIndia = (req.query && req.query.region) !== "us";

  const base = baseName(name);
  if (!base) return res.status(200).json({ level: "none" });
  const key = base.replace(/ /g, "");

  try {
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");

    if (useIndia) {
      const hit = indiaExact(base);
      if (hit) return res.status(200).json(hit);
    }

    // A generic name that appears in the India/US equivalents table (e.g. paracetamol, albuterol).
    if (EQUIV[base] || US_TO_IN[base]) {
      return res.status(200).json(Object.assign(
        { level: "good", score: 100, source: "name-list", isBrand: false, matchedName: base },
        genericFields([base])
      ));
    }

    const result = await rxnormLookup(base);
    if (result.level === "good") return res.status(200).json(result);

    if (useIndia) {
      const fuzzy = indiaFuzzy(key);
      if (fuzzy) return res.status(200).json(fuzzy);
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error("lookup failed", err && err.message);
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "The drug database didn't respond. Try again." });
  }
};
