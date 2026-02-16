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
6. (Optional) To restrict who can call the API:
   - **Name:** `ALLOWED_ORIGINS`  
   - **Value:** your site origin(s), comma-separated, e.g.  
     `https://yourusername.github.io,https://your-custom-domain.com`
7. Deploy. Note the URL (e.g. `https://omdb-proxy-xxxx.vercel.app`).
8. **Test:** Open `https://your-app.vercel.app/api/omdb?t=Inception` in the browser. You should get JSON like `{"poster":"https://..."}`.
9. **If you still get 404 NOT_FOUND:**  
   - **Option A:** Create a **new repo** whose root contains only: `api/` (with `omdb.js` inside), `package.json`, `vercel.json`, and this README. Push that repo and import it on Vercel **without** setting Root Directory. Then the API lives at `/api/omdb`.  
   - **Option B:** In the current project, confirm **Root Directory** is exactly the folder name (e.g. `playground-serveless`). In the repo, that folder must contain `api/omdb.js`, `vercel.json`, and `package.json`. Redeploy after changing settings.

## 3. Point your main site to this backend

In your **main site** (the one on GitHub Pages), set the proxy URL before any script that uses OMDb.

In `index.html` (and in `playground.html` if you use the IMDb flyout there), add near the top of `<body>`:

```html
<script>window.OMDB_PROXY_URL = 'https://omdb-proxy-xxxx.vercel.app';</script>
```

Replace `https://omdb-proxy-xxxx.vercel.app` with your actual Vercel URL (no trailing slash).

Your main repo never contains the key; only this small proxy repo is deployed to Vercel with the env var.
