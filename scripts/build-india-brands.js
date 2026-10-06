#!/usr/bin/env node
"use strict";

/**
 * Grows data/india-brands.json from a CSV of Indian medicines, such as the public
 * Kaggle datasets "A-Z Medicine Dataset of India" or "Indian Medicine Data".
 * Check each dataset's license before you use or redistribute it.
 *
 * Usage:
 *   node scripts/build-india-brands.js medicines.csv
 *   node scripts/build-india-brands.js medicines.csv --name-col product_name --comp-col salt_composition
 *
 * Options:
 *   --name-col <col>   column holding the brand name        (default: auto-detect)
 *   --comp-col <col>   column holding the composition/salts (default: auto-detect)
 *   --keep-conflicts   keep brand names that appear with different compositions (default: drop them)
 *   --replace          ignore the existing hand-written list instead of keeping it on top
 *
 * Brands already in data/india-brands.json always win over the CSV, unless you pass --replace.
 */

const fs = require("fs");
const path = require("path");

const FORM_WORDS = new Set(["tablet", "tablets", "tab", "capsule", "capsules", "cap", "syrup", "syp", "injection", "inj",
  "suspension", "drops", "drop", "gel", "cream", "oral", "ointment", "lotion", "solution", "powder", "sachet", "kit", "spray",
  "shampoo", "soap", "infusion", "respules", "rotacap", "inhaler", "eye", "ear", "nasal"]);

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function brandKey(name) {
  const words = String(name).toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu|%)?(?![a-z0-9])/g, " ")
    .replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  while (words.length > 1 && FORM_WORDS.has(words[words.length - 1])) words.pop();
  return words.join("");
}

function composition(text) {
  return String(text).toLowerCase().replace(/\([^)]*\)/g, " ")
    .split("+").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" + ");
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--name-col") && !args[args.indexOf(a) - 1]?.startsWith("--comp-col"));
  const opt = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
  if (!file) { console.error("Usage: node scripts/build-india-brands.js medicines.csv [options]"); process.exit(1); }

  const rows = parseCsv(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const find = (explicit, patterns) => {
    if (explicit) { const i = header.indexOf(explicit.toLowerCase()); if (i === -1) throw new Error(`Column "${explicit}" not found. Columns: ${header.join(", ")}`); return i; }
    return header.findIndex((h) => patterns.some((p) => p.test(h)));
  };
  const nameCol = find(opt("--name-col"), [/^(product_)?name$/, /brand/, /medicine/]);
  const compCol = find(opt("--comp-col"), [/composition/, /salt/, /generic/, /ingredient/]);
  if (nameCol < 0 || compCol < 0) throw new Error(`Couldn't find the columns. Columns: ${header.join(", ")}. Use --name-col and --comp-col.`);

  const out = {}, conflicts = new Set();
  let skipped = 0;
  for (const row of rows) {
    const key = brandKey(row[nameCol] || "");
    const comp = composition(row[compCol] || "");
    if (key.length < 3 || !comp) { skipped++; continue; }
    if (out[key] === undefined) out[key] = comp;
    else if (out[key] !== comp) conflicts.add(key);
  }
  if (!args.includes("--keep-conflicts")) conflicts.forEach((k) => delete out[k]);

  const target = path.join(__dirname, "..", "data", "india-brands.json");
  const existing = args.includes("--replace") || !fs.existsSync(target) ? {} : JSON.parse(fs.readFileSync(target, "utf8"));
  const merged = Object.assign({}, out, existing);
  const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(target, JSON.stringify(sorted));

  console.log(`Read ${rows.length} rows, skipped ${skipped}, ${conflicts.size} brand names had conflicting compositions` +
    `${args.includes("--keep-conflicts") ? " (kept)" : " (dropped)"}.`);
  console.log(`Wrote ${Object.keys(sorted).length} brands to data/india-brands.json (${(fs.statSync(target).size / 1e6).toFixed(1)} MB).`);
}

main();
