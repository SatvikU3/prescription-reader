# Prescription Reader (India + USA)

Upload a photo of a handwritten Indian or US prescription and get a clear medication list.

- **Gemini** (Google) reads the handwriting, through your own serverless function, so the API key stays on the server.
- **Pattern rules** in the page read Indian and US prescription notation.
- **Brand lookup** checks a list of common Indian brands first, then RxNorm (US National Library of Medicine, free, no key) for US brands and generics. Generic names are shown in both the India/international form and the US form (paracetamol / acetaminophen).

```
index.html                    the whole front end (HTML, CSS, JS in one file)
api/extract.js                POST /api/extract -> sends the image to Gemini, returns the text
api/lookup.js                 GET  /api/lookup  -> brand/generic lookup (India list, then RxNorm)
data/india-brands.json        Indian brand -> generic composition (starter list)
data/name-equivalents.json    India/UK/international name -> US name (paracetamol -> acetaminophen)
scripts/build-india-brands.js grow the Indian brand list from a CSV dataset
test/api.test.js              checks for both API functions (npm test)
vercel.json  .env.example     function limits and environment variables
```

## Deploy on Vercel (free Hobby plan)

1. Get a free Gemini API key at https://aistudio.google.com/apikey
2. Push this folder to a GitHub repo.
3. In Vercel: **Add New > Project**, import the repo, leave the defaults.
4. Before deploying, open **Environment Variables** and add `GEMINI_API_KEY` with your key.
5. Deploy. Your site is live at `https://<project>.vercel.app`.

Or from the command line:

```bash
npm i -g vercel
vercel                      # follow the prompts
vercel env add GEMINI_API_KEY
vercel --prod
```

## Run locally

```bash
cp .env.example .env.local   # then put your key in it
npx vercel dev               # open http://localhost:3000
npm test                     # API checks, no network needed
```

Opening `index.html` directly from disk won't work, because `/api/...` only exists when served by Vercel (or `vercel dev`).

## What it understands

| Style | Examples |
|---|---|
| Indian dosing patterns | `1-0-1`, `1-1-1`, `0-0-1`, `1/2-0-1/2`, `2-0-2` |
| Indian and UK abbreviations | `BD`, `TDS`, `QDS`, `OD`, `HS`, `SOS`, `stat`, `mane`, `AC`, `PC`, with or without dots (`b.i.d.`, `t.d.s.`) |
| Indian durations | `x 5/7` (days), `x 2/52` (weeks), `x 5 days`, `for 2 weeks` |
| Indian prefixes | `Tab.`, `Cap.`, `Syp.`, `Inj.`, `T.`, `Rx`, numbered lines |
| Brand numbers | `Dolo 650`, `Pan 40` (strength is read from the number and flagged for checking) |
| US sigs | `Sig: Take 1 tablet by mouth twice daily`, `1 tab PO BID`, `2 tabs q6h PRN`, `qHS`, `qAM`, `with meals` |
| US quantities | `Disp: #30`, `Qty 60`, `Refills: 2`, `no refills` |
| Multi-line entries | the drug on one line and `Sig:`, `Disp:` or `1-0-1` lines below it |

Lines like `Dr.`, `Date:`, `Patient:`, `BP`, `Weight` are skipped and listed under "skipped".

`OD` means once daily on an Indian prescription but right eye in US eye care. It is read as right eye only when the line mentions an eye or ophthalmic drop.

## About the Indian brand list

`data/india-brands.json` has about 100 well-known Indian brands (Dolo, Crocin, Combiflam, Pantop, Azithral, Montair LC, Glycomet, Thyronorm and so on). It was written by hand from general knowledge and has not been checked against an official register, so check it yourself before relying on it, and expect gaps. Brand variants (Duo, Forte, Plus, SR) can differ in strength or ingredients: a variant of a known brand is shown with a caution, and a near-miss spelling is only suggested, never applied.

To grow the list from a public dataset:

1. Download a CSV that has a brand name column and a composition column, for example the Kaggle datasets "A-Z Medicine Dataset of India" or "Indian Medicine Data". Check the license first.
2. Run `npm run build:brands -- path/to/medicines.csv` (add `--name-col` and `--comp-col` if the columns aren't detected).
3. Your hand-written entries stay on top. Brand names that appear with conflicting compositions are dropped unless you pass `--keep-conflicts`.

A full dataset has 100,000+ names, which makes `india-brands.json` several MB and slows the function's first request a little. If that matters, keep only the brands you expect to see.

eka.care offers a commercial Indian drug search API (500,000+ brands) if you need coverage you can rely on. It needs credentials from them.

## Environment variables

| Name | Required | Default | What it does |
|---|---|---|---|
| `GEMINI_API_KEY` | yes | | Your Gemini key. Server only. |
| `GEMINI_MODEL` | no | `gemini-2.5-flash` | Any Gemini model that accepts images. |
| `RATE_LIMIT_MAX` | no | `10` | Max extract requests per IP per 10 minutes. |
| `ALLOWED_ORIGINS` | no | (any) | Comma-separated list, e.g. `https://your-site.vercel.app`. Rejects browser requests from other sites. |

## What protects your key and quota

- The key is read from an environment variable inside the function and sent to Google in a header. It never appears in the page, the repo, or any response.
- `extract.js` only accepts JPG/PNG/WebP, caps the image size, and rate limits by IP.
- Set `ALLOWED_ORIGINS` once you know your final URL.

Limits to be aware of:

- **The rate limiter is per server instance.** Serverless instances don't share memory, so a determined person can get around it. For a hard limit, store counters in Upstash Redis or Vercel KV.
- **`ALLOWED_ORIGINS` only stops other websites' scripts.** Someone calling your endpoint with curl can fake the header.
- **Everyone shares your free Gemini quota.** If it runs out, the site shows a "quota is busy" message until it resets. Check the current free-tier limits in Google AI Studio.
- **Vercel caps request bodies at about 4.5 MB.** The page shrinks photos to 1800px JPEG before upload, which stays well under that.

## Privacy and wording

Photos pass through your function to Google's Gemini API. The code doesn't store or log them, but on the Gemini free tier Google may use submitted content to improve its products (check their current terms). Edit the privacy paragraph in the "Safety" section of `index.html` so it matches how you actually run the site.

This is a reading aid, not medical advice. Keep the "check against the original" wording visible.

## Customising

- **Colors and fonts:** all design tokens are CSS variables at the top of `index.html`.
- **More abbreviations:** add entries to `FREQUENCY_RULES`, `TIMING_RULES`, `DURATION_RULES` or `ROUTE_RULES` in the script.
- **More name pairs:** add India/UK to US names in `data/name-equivalents.json`.
