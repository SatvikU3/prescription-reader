// Run with: node test/api.test.js   (no dependencies; network calls are mocked)
const assert = require("assert");
const path = require("path");
process.env.GEMINI_API_KEY = "test-key";
process.env.RATE_LIMIT_MAX = "3";

const api = (f) => require(path.join(__dirname, "..", "api", f));
function mockRes() {
  const r = { headers: {}, statusCode: 200, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const mkReq = (over) => Object.assign({ method: "POST", headers: { "x-forwarded-for": "1.1.1.1" }, body: { image: "QUJD", mime: "image/jpeg" } }, over);
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

(async () => {
  const extract = api("extract.js");
  const lookup = api("lookup.js");
  let r;

  // ---------- extract ----------
  r = mockRes(); await extract(mkReq({ method: "GET" }), r); assert.equal(r.statusCode, 405);
  r = mockRes(); await extract(mkReq({ body: { image: "QUJD", mime: "image/gif" } }), r); assert.equal(r.statusCode, 400);
  r = mockRes(); await extract(mkReq({ body: { image: "not base64!!", mime: "image/png" }, headers: { "x-forwarded-for": "2.2.2.2" } }), r); assert.equal(r.statusCode, 400);
  r = mockRes(); await extract(mkReq({ body: { image: "A".repeat(4000001), mime: "image/png" }, headers: { "x-forwarded-for": "3.3.3.3" } }), r); assert.equal(r.statusCode, 413);

  let seen;
  global.fetch = async (url, opts) => { seen = { url: String(url), opts }; return ok({ candidates: [{ content: { parts: [{ text: "Tab. Dolo 650 1-0-1" }] } }] }); };
  r = mockRes(); await extract(mkReq({ headers: { "x-forwarded-for": "4.4.4.4" } }), r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.text, "Tab. Dolo 650 1-0-1");
  assert(!seen.url.includes("test-key")); assert.equal(seen.opts.headers["x-goog-api-key"], "test-key");
  assert(JSON.parse(seen.opts.body).contents[0].parts[0].text.includes("1-0-1"));

  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "quota" } }) });
  r = mockRes(); await extract(mkReq({ headers: { "x-forwarded-for": "5.5.5.5" } }), r); assert.equal(r.statusCode, 429);
  global.fetch = async () => ok({ candidates: [{ content: { parts: [] } }] });
  r = mockRes(); await extract(mkReq({ headers: { "x-forwarded-for": "6.6.6.6" } }), r); assert.equal(r.statusCode, 422);

  global.fetch = async () => ok({ candidates: [{ content: { parts: [{ text: "x" }] } }] });
  const codes = [];
  for (let i = 0; i < 5; i++) { r = mockRes(); await extract(mkReq({ headers: { "x-forwarded-for": "7.7.7.7" } }), r); codes.push(r.statusCode); }
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);

  process.env.ALLOWED_ORIGINS = "https://good.example";
  r = mockRes(); await extract(mkReq({ headers: { origin: "https://evil.example", "x-forwarded-for": "8.8.8.8" } }), r); assert.equal(r.statusCode, 403);
  r = mockRes(); await extract(mkReq({ headers: { origin: "https://good.example", "x-forwarded-for": "8.8.8.8" } }), r); assert.equal(r.statusCode, 200);
  delete process.env.ALLOWED_ORIGINS;

  // ---------- lookup: Indian brands never touch the network ----------
  global.fetch = async () => { throw new Error("network should not be used"); };
  const get = async (name, region) => { const x = mockRes(); await lookup({ method: "GET", query: { name, region } }, x); return x; };

  r = await get("Dolo 650");
  assert.equal(r.body.level, "good"); assert.equal(r.body.source, "india"); assert.equal(r.body.isBrand, true);
  assert.equal(r.body.genericIndia, "paracetamol"); assert.equal(r.body.genericUS, "acetaminophen"); assert.equal(r.body.single, true);

  r = await get("Combiflam");
  assert.equal(r.body.genericIndia, "ibuprofen + paracetamol"); assert.equal(r.body.genericUS, "ibuprofen + acetaminophen"); assert.equal(r.body.single, false);

  r = await get("Montair LC");   assert.equal(r.body.genericIndia, "montelukast + levocetirizine");
  r = await get("Pan-D 40");     assert.equal(r.body.genericIndia, "pantoprazole + domperidone");
  r = await get("Thyronorm 50"); assert.equal(r.body.genericUS, "levothyroxine");

  r = await get("Augmentin 625 Duo");
  assert.equal(r.body.level, "good"); assert(r.body.caution && r.body.caution.includes("duo"));
  assert.equal(r.body.genericIndia, "amoxicillin + clavulanic acid");

  // One-letter misread of Crocin: RxNorm finds nothing, so the Indian list offers a suggestion only.
  global.fetch = async (url) => {
    if (String(url).includes("approximateTerm")) return ok({ approximateGroup: { candidate: [] } });
    throw new Error("unexpected " + url);
  };
  r = await get("Crocim");
  assert.equal(r.body.level, "weak"); assert(r.body.matchedName.startsWith("Crocin")); assert.equal(r.body.genericIndia, undefined);
  global.fetch = async () => { throw new Error("network should not be used"); };

  r = await get("Paracetamol");  // known generic, India and US forms
  assert.equal(r.body.source, "name-list"); assert.equal(r.body.genericIndia, "paracetamol"); assert.equal(r.body.genericUS, "acetaminophen");
  r = await get("Acetaminophen");
  assert.equal(r.body.genericIndia, "paracetamol"); assert.equal(r.body.genericUS, "acetaminophen");

  // ---------- lookup: RxNorm path ----------
  const rxMock = (tty, name, ingredients, score = "100") => async (url) => {
    const u = String(url);
    if (u.includes("approximateTerm")) return ok({ approximateGroup: { candidate: [{ rxcui: "1", score }] } });
    if (u.includes("properties.json")) return ok({ properties: { name, tty } });
    if (u.includes("related.json")) return ok({ relatedGroup: { conceptGroup: [{ tty: "IN", conceptProperties: ingredients.map((n) => ({ name: n })) }] } });
    throw new Error("unexpected " + u);
  };

  global.fetch = rxMock("BN", "Tylenol", ["acetaminophen"]);
  r = await get("Tylenol");
  assert.equal(r.body.source, "rxnorm"); assert.equal(r.body.isBrand, true);
  assert.equal(r.body.genericUS, "acetaminophen"); assert.equal(r.body.genericIndia, "paracetamol");

  global.fetch = rxMock("IN", "metformin", []);
  r = await get("Metformin");    assert.equal(r.body.genericIndia, "metformin"); assert.equal(r.body.genericUS, "metformin");

  global.fetch = rxMock("BN", "Glucophage", ["metformin"]);
  r = await get("Glucophage", "us"); assert.equal(r.body.genericUS, "metformin");

  // region=us skips the Indian list entirely
  global.fetch = rxMock("SCD", "something", [], "30");
  r = await get("Dolo 650", "us"); assert.equal(r.body.source, "rxnorm"); assert.equal(r.body.level, "none");

  // weak RxNorm match with no Indian near-match stays weak, with no generic
  global.fetch = rxMock("SCD", "something", ["x"], "55");
  r = await get("Qwertyuiopz"); assert.equal(r.body.level, "weak"); assert.equal(r.body.genericUS, undefined);

  // validation and failures
  r = await get("");    assert.equal(r.statusCode, 400);
  r = await get("650"); assert.equal(r.body.level, "none");
  global.fetch = async () => { throw new Error("boom"); };
  r = await get("Zzzzzzzzzzzz"); assert.equal(r.statusCode, 502);

  console.log("all API checks passed");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
