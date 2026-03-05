# Playground Serverless — Docs

This folder is the **docs/wiki** for the playground-serveless Vercel app. The app exposes **job APIs**, **OMDb/cinematerial proxies**, and optional **headless scrapers**. All responses are **JSON** (no HTML in API responses).

---

## Quick links

| Resource | Location | Description |
|----------|----------|-------------|
| **API reference** | [README → API reference](../README.md#api-reference-all-endpoints) | Full endpoint table, env vars, example `curl` calls |
| **OMDb proxy** | [README → OMDb](../README.md#omdb-api-proxy-separate-backend) | Deploy, test UI, usage counter, abuse prevention |
| **Jobs snapshot** | [README → Jobs snapshot](../README.md#jobs-snapshot-sources-and-headless-browser) | Sources, headless, KV cache, filtering |
| **Test results** | [API-TEST-RESULTS.md](../API-TEST-RESULTS.md) | Example test runs (if present) |

---

## API overview

| Area | Endpoints | Response |
|------|-----------|----------|
| **Jobs** | `/api/jobs-snapshot`, `/api/jobs-cached`, `/api/jobs-refresh` | JSON: `{ ok, jobs, sources, sourceCounts }` |
| **OMDb** | `/api/omdb` (search, by ID, poster, `?usage=1`) | JSON only; key stays server-side |
| **CineMaterial** | `/api/cinematerial?i=tt...&title=...&type=movie` | JSON: `{ posters, pageUrl }` |
| **Auth** | `/api/auth` | JSON; for test UI secret check |
| **RSS / proxies** | `/api/rss`, `/api/workingnomads` | JSON or proxied feed |
| **Headless** | `/api/headless-scrape-*`, `/api/jobs-scraper-background` | JSON; require `ENABLE_HEADLESS=1` |

All documented endpoints return **JSON** (or proxied RSS content). The test UI at `/` is HTML and secret-protected; it is not part of the public API surface.

---

## More

- **Deploy & env:** [README](../README.md)
- **Workspace context:** [JOBS-SCRAPER.md](../JOBS-SCRAPER.md) in the repo root (if present)
