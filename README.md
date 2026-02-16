# OMDb API proxy (separate backend)

Minimal serverless backend that calls OMDb with your API key and returns only safe data. Use this **repo by itself** on Vercel so your main site repo stays front-end only (e.g. GitHub Pages).

## 1. Create a new GitHub repo

- Create a **new empty repo** (e.g. `omdb-proxy`).
- Copy the contents of **this folder** (`api/`, this README) into that repo and push.

## 2. Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub.
2. **Import** the `omdb-proxy` repo.
3. Leave **Root Directory** as `.` (root).
4. Before deploying, open **Settings → Environment Variables** and add:
   - **Name:** `OMDB_API_KEY`  
   - **Value:** your key from [omdbapi.com](https://www.omdbapi.com/)
5. (Optional) To restrict who can call the API:
   - **Name:** `ALLOWED_ORIGINS`  
   - **Value:** your site origin(s), comma-separated, e.g.  
     `https://yourusername.github.io,https://your-custom-domain.com`
6. Deploy. Note the URL (e.g. `https://omdb-proxy-xxxx.vercel.app`).

## 3. Point your main site to this backend

In your **main site** (the one on GitHub Pages), set the proxy URL before any script that uses OMDb.

In `index.html` (and in `playground.html` if you use the IMDb flyout there), add near the top of `<body>`:

```html
<script>window.OMDB_PROXY_URL = 'https://omdb-proxy-xxxx.vercel.app';</script>
```

Replace `https://omdb-proxy-xxxx.vercel.app` with your actual Vercel URL (no trailing slash).

Your main repo never contains the key; only this small proxy repo is deployed to Vercel with the env var.
