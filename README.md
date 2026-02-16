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
6. (Optional) To restrict who can call the OMDb API:
   - **Name:** `ALLOWED_ORIGINS`  
   - **Value:** your site origin(s), comma-separated, e.g.  
     `https://yourusername.github.io,https://your-custom-domain.com`
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
- **Use:** Search movies/series → see a **grid of posters** (thumbnails + title + year). **Click a card** to load full **details** (poster, plot, director, cast, awards, box office, etc.) and scroll to the detail panel. Use “Open in new tab” for a shareable link, or add `?i=tt0137523` to the URL to open a title by IMDb ID (after unlocking).
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
