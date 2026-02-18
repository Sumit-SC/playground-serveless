# OMDb API proxy (separate backend)

Minimal serverless backend that calls OMDb with your API key and returns only safe data. Use this **repo by itself** on Vercel so your main site repo stays front-end only (e.g. GitHub Pages).

## 1. Create a new GitHub repo

- Create a **new empty repo** (e.g. `omdb-proxy`).
- Copy the contents of **this folder** (`api/`, this README) into that repo and push.

## 2. Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub.
2. **Import** the repo (this folder as its own repo, or the repo that contains it).
3. **Root Directory (critical):** If this folder lives inside a monorepo, set **Settings → General → Root Directory** to exactly the folder that contains `api/` (e.g. `playground-serveless` — check spelling). The deployed root must contain `api/omdb.js`, `package.json`, and `vercel.json`. Save and redeploy.
4. **Build / Install:** You can leave **Build Command** and **Install Command** empty. The included `vercel.json` tells Vercel to build only the API function.
5. Before deploying, open **Settings → Environment Variables** and add:
   - **Name:** `OMDB_API_KEY`  
   - **Value:** your key from [omdbapi.com](https://www.omdbapi.com/)
   - **Name:** `UI_SECRET`  
   - **Value:** a password of your choice (used to unlock the test UI at `/`).
6. (Optional) To reduce API abuse (see [Preventing API abuse](#preventing-api-abuse) below):
   - **Name:** `ALLOWED_ORIGINS`  
   - **Value:** your site origin(s), comma-separated, e.g.  
     `https://yourusername.github.io,https://your-custom-domain.com`
   - **Name:** `API_SECRET`  
   - **Value:** a secret string; then only requests with header `X-API-Key: <this value>` are allowed (401 otherwise).
   - **Name:** `RATE_LIMIT_PER_MINUTE`  
   - **Value:** e.g. `60` — max requests per IP per minute (429 when exceeded).
7. Deploy. Note the URL (e.g. `https://omdb-proxy-xxxx.vercel.app`).
8. **Test:** Open `https://your-app.vercel.app/api/omdb?t=Inception` in the browser. You should get JSON like `{"poster":"https://..."}`.
9. **If you get 404 NOT_FOUND (Code: NOT_FOUND):**  
   - **Recommended:** In Vercel → your project → **Settings → General → Root Directory**. Set it to **`playground-serveless`** (the folder that contains `api/`, `index.html`, `vercel.json`, `package.json`). Leave “Include source files outside of the Root Directory” unchecked. Click **Save**, then **Redeploy** (Deployments → ⋮ on latest → Redeploy).  
   - **If this folder is inside a monorepo:** The root of the repo is not the app root. You must set Root Directory to the folder that directly contains `api/` and `vercel.json`, e.g. `playground-serveless`.  
   - **Option B:** Deploy only this app: create a **new repo** whose root contains only the contents of this folder (`api/`, `index.html`, `package.json`, `vercel.json`, README). Import that repo on Vercel and do **not** set Root Directory.  
   - **If you use the monorepo root:** A root `vercel.json` in the repo points builds to `playground-serveless/` and routes `dest` to the **actual artifact paths** (e.g. `/playground-serveless/api/omdb.js`). Commit that `vercel.json`, redeploy, then try again. If 404 persists, use Root Directory as above.

## 3. Point your main site to this backend

In your **main site** (the one on GitHub Pages), set the proxy URL before any script that uses OMDb.

In `index.html` (and in `playground.html` if you use the IMDb flyout there), add near the top of `<body>`:

```html
<script>window.OMDB_PROXY_URL = 'https://omdb-proxy-xxxx.vercel.app';</script>
```

Replace `https://omdb-proxy-xxxx.vercel.app` with your actual Vercel URL (no trailing slash).

Your main repo never contains the key; only this small proxy repo is deployed to Vercel with the env var.

---

## Test UI (secret-protected)

The repo includes a minimal test UI at the root URL (`https://your-app.vercel.app/`).

- **Unlock:** Set env var **`UI_SECRET`** (any string). Open `/` and enter that value to unlock the UI. You can also use `?secret=YOUR_SECRET` in the URL once.
- **Use:** Search movies/series → see a **grid of posters** (thumbnails + title + year). **Click a card** to load full **details** (poster, plot, director, cast, awards, box office, etc.) and scroll to the detail panel. In the detail view, **CineMaterial posters**: use “Open on CineMaterial” to open [CineMaterial](https://www.cinematerial.com/) for that title (URL uses IMDb ID, e.g. `i1375666`), or “Fetch / refresh posters” to load poster images via the scraper API. Use “Open in new tab” for a shareable link, or add `?i=tt0137523` to the URL to open a title by IMDb ID (after unlocking).
- **Lock:** Click “Lock” to hide the UI again (or close the tab; the secret is only in `sessionStorage` for the session).
- Your main site or bot keeps calling `/api/omdb` as before; no secret is required for the API. The secret only gates the test UI.

---

## API URL and testing (for your bot or main site)

- **Same host as the UI:** The API lives on the same deployment as the test UI. If your app is `https://omdb-proxy-xxxx.vercel.app`, then:
  - **UI:** `https://omdb-proxy-xxxx.vercel.app/`
  - **API base:** `https://omdb-proxy-xxxx.vercel.app/api/omdb`
- **No key from the client:** Your bot, browser, or main site **never** send an API key. You only call `GET /api/omdb?...`. The key is set once on the **server** (Vercel env var `OMDB_API_KEY`). The proxy adds it to requests to OMDb; callers get plain JSON with no auth.
- **Key required on the server:** If `OMDB_API_KEY` is missing or wrong, the API returns `503` with `"OMDb proxy not configured"`. So you must set the key in Vercel (Settings → Environment Variables) for the API to work.
- **How to confirm the API works:**
  - In the test UI (after unlock), use the “API base” line and the **Poster by title** / **Search** / **By ID** links to open the raw JSON in a new tab.
  - Or from a terminal:  
    `curl "https://YOUR-APP.vercel.app/api/omdb?t=Inception"`  
    `curl "https://YOUR-APP.vercel.app/api/omdb?s=batman"`  
    `curl "https://YOUR-APP.vercel.app/api/omdb?i=tt1375666"`  
  - You should get JSON (e.g. `{"poster":"https://..."}` for `?t=`, `{"results":[...]}` for `?s=`, and full detail for `?i=`).

---

## Daily API counter (1000/day, resets midnight UTC)

The proxy tracks how many times it has called OMDb **today** (UTC). After 1000 requests in a day it returns **429** and does not call OMDb until the next day.

- **Get count without using a hit:**  
  `GET /api/omdb?usage=1`  
  Returns only `{"dailyCount":N,"dailyLimit":1000}`. Does **not** increment the counter or call OMDb.
- **Every other response** (search, by ID, poster by title, errors) includes `usage: { dailyCount, dailyLimit: 1000 }` in the JSON.
- **How to check the deployment has this update:**
  1. Open: `https://YOUR-APP.vercel.app/api/omdb?usage=1`  
     You should see JSON like `{"dailyCount":0,"dailyLimit":1000}` (or a number &lt; 1000). If you see this, the daily counter is live.
  2. Open: `https://YOUR-APP.vercel.app/api/omdb?t=Inception`  
     The JSON should include `"usage":{"dailyCount":1,"dailyLimit":1000}` (or higher). If you see `usage.dailyCount` and `usage.dailyLimit`, the update is applied.
  3. In the Playground (main site), open the **IMDb** flyout; the header should show **"X/1000 today"**. Opening the flyout calls `?usage=1` so the number appears without using an OMDb hit.

---

## CineMaterial posters (scraper API)

The app can fetch poster images from [CineMaterial](https://www.cinematerial.com/) using the **IMDb ID** you get from OMDb. CineMaterial uses the same ID with an `i` prefix (e.g. `tt1375666` → `i1375666`) in URLs like `https://www.cinematerial.com/movies/inception-i1375666`.

- **Endpoint:** `GET /api/cinematerial?i=tt1375666&title=Inception&type=movie` (or `type=series` for TV). Returns `{ posters: [{ url }], pageUrl, posterPages }`.
- **In the test UI:** Open a title’s detail, then use **“Open on CineMaterial”** to open that title on CineMaterial (where you can use their filters by country/category), or **“Fetch / refresh posters”** to load poster image URLs via the scraper.
- **Use sparingly:** The scraper fetches the public CineMaterial page; respect their [terms](https://www.cinematerial.com/) and don’t hammer the endpoint.

**ThePosterDB:** [ThePosterDB](https://theposterdb.com/) is linked in the detail view (“ThePosterDB”) as a second poster source; search is by title and section (movies/shows). They have different coverage (often fewer images than CineMaterial) and offer an [API](https://api.ratingposterdb.com/) with key for programmatic access if you need it.

---

## Jobs snapshot: sources and headless browser

**Sources (no config):** The jobs aggregator pulls from **RemoteOK** (JSON API), **Remotive** (API + RSS), **WeWorkRemotely** (RSS), **Jobscollider** (RSS), **Wellfound** (RSS), and **Working Nomads** (our proxy). RSS feeds are fetched **directly** from the job boards (no self-call), so you get multiple sources even on first deploy.

**More results:** Use `?limit=200` or `?limit=400` (max). Default is 180. Use `?days=14` for a 2-week window.

**Response:** Each response includes `sources` and `sourceCounts` (e.g. `{ "remoteok": 45, "remotive": 32 }`) so you can see which boards contributed.

**Headless browser (optional):** To add jobs scraped from multiple sites (WeWorkRemotely, **Hirist**, **Naukri**, etc.) via headless Chromium, set **`ENABLE_HEADLESS=1`** in Vercel → Settings → Environment Variables, then redeploy. The jobs-snapshot API will call the headless scrapers and merge those jobs. Headless is slow (~20–35s) and uses more memory; enable only if you want maximum coverage.

**Vercel KV storage (optional):** To cache headless-scraped jobs and avoid slow scraping on every request:
1. Create a Vercel KV database (Vercel Dashboard → Storage → Create KV Database).
2. Add env vars: **`KV_REST_API_URL`** and **`KV_REST_API_TOKEN`** (auto-set by Vercel).
3. Call `/api/jobs-scraper-background` periodically (cron, manual, or Vercel Cron) to refresh cached jobs.
4. The jobs-snapshot API will automatically use cached jobs from KV (faster) + live sources.

**New sources added:** Indeed RSS, Wellfound (multiple feeds), Hirist (headless), Naukri (headless). Total sources: **10+** (RemoteOK, Remotive, WeWorkRemotely, Jobscollider, Wellfound, Indeed, WorkingNomads, Hirist, Naukri, plus cached headless).

---

## Preventing API abuse (is an open API safe?)

**What “open” means:** If you don’t set `API_SECRET`, anyone who knows your API URL can call it. Your **OMDb key stays on the server** and is never sent to the client, so it’s not exposed. The main risk is **quota exhaustion**: OMDb free tier (e.g. 1,000 requests/day) and Vercel usage can be used up by someone hammering the endpoint.

**Is it safe?** For a low-traffic personal project it’s often acceptable to leave the API open and rely on OMDb’s and Vercel’s limits. For anything you care about, add at least one of the protections below.

**Options (use one or more):**

| Method | Env var | What it does | Best for |
|--------|---------|----------------|----------|
| **CORS** | `ALLOWED_ORIGINS` | Only listed origins can call the API **from a browser**. Blocks other sites embedding your API in their pages. Does **not** stop curl, Postman, or bots (they don’t send Origin). | Limiting which websites can use your API in the browser. |
| **API key** | `API_SECRET` | Every request must include header `X-API-Key: <your secret>`. Wrong or missing key → 401. Only your bot or main site (where you store the secret server-side or in a private env) should know it. | Restricting the API to your own app/bot. |
| **Rate limit** | `RATE_LIMIT_PER_MINUTE` | Max requests per IP per minute (e.g. `60`). Excess → 429 Too Many Requests. Implemented in-memory per serverless instance; for strict limits across all instances use something like Vercel KV. | Throttling heavy or abusive callers. |

**Recommendation:** Set **`ALLOWED_ORIGINS`** to your main site so random websites can’t use your API from the browser. If only your bot or server should call the API, set **`API_SECRET`** and send it as `X-API-Key` from your code. Add **`RATE_LIMIT_PER_MINUTE`** (e.g. 60) to cap burst traffic per IP.

**If you set `API_SECRET`:** Your bot or main site must send `X-API-Key: <API_SECRET>` on every request. The test UI at `/` has an optional “API key” field; enter the same value as `API_SECRET` so the test UI can still call the API after you unlock it.

---

## API reference (all endpoints)

| Endpoint | Method | Purpose | Env / notes |
|----------|--------|---------|-------------|
| `/api/omdb` | GET | OMDb proxy (search, by ID, poster by title) | `OMDB_API_KEY` required; optional: `ALLOWED_ORIGINS`, `API_SECRET`, `RATE_LIMIT_PER_MINUTE` |
| `/api/omdb?usage=1` | GET | Daily usage count (no OMDb hit) | Same |
| `/api/omdb?stats=1` | GET | Daily stats (by type, category, source) | Same |
| `/api/auth` | GET | UI secret check for test UI | `UI_SECRET` |
| `/api/cinematerial` | GET | CineMaterial poster scraper by IMDb ID | None |
| `/api/jobs-snapshot` | GET | Aggregated jobs from many sources. Each job has `date`, `dateFormatted`, `postedAgo`. Response includes `sources` and `sourceCounts` (per-source counts). | Optional: `ENABLE_HEADLESS=1` to include WeWorkRemotely headless scrape. Query: `q`, `days`, `limit` (default 180, max 400). |
| `/api/rss` | GET | RSS/Atom proxy (CORS + allowlist) | None |
| `/api/workingnomads` | GET | Working Nomads jobs proxy | None |
| `/api/headless-scrape-weworkremotely` | GET | WeWorkRemotely scraper (headless browser). Also used by jobs-snapshot when `ENABLE_HEADLESS=1`. | `ENABLE_HEADLESS=1` to enable |
| `/api/headless-scrape-multi` | GET | Multi-site headless scraper (Hirist, Naukri). Use `?site=all` to scrape all sites. | `ENABLE_HEADLESS=1` to enable |
| `/api/jobs-scraper-background` | GET | Background scraper that saves headless-scraped jobs to Vercel KV. Call periodically (cron/manual). | `ENABLE_HEADLESS=1`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` |

**Example calls:**

```bash
# OMDb
curl "https://YOUR-APP.vercel.app/api/omdb?t=Inception"
curl "https://YOUR-APP.vercel.app/api/omdb?s=batman"
curl "https://YOUR-APP.vercel.app/api/omdb?i=tt1375666"
curl "https://YOUR-APP.vercel.app/api/omdb?usage=1"

# Jobs (analyst-focused, last 7 days, up to 180 results; use limit=400 for more)
curl "https://YOUR-APP.vercel.app/api/jobs-snapshot?q=data%20analyst&days=7&limit=180"

# RSS proxy (url and count required; host allowlisted)
curl "https://YOUR-APP.vercel.app/api/rss?url=https%3A%2F%2Fremotive.com%2Ffeed&count=20"

# Working Nomads
curl "https://YOUR-APP.vercel.app/api/workingnomads?q=data%20science&count=50"

# CineMaterial (poster images by IMDb ID)
curl "https://YOUR-APP.vercel.app/api/cinematerial?i=tt1375666&title=Inception&type=movie"
```
