# Understanding Vercel’s NOT_FOUND (404) Error

This doc explains why you saw `NOT_FOUND` (Code: NOT_FOUND) and how to fix it, avoid it, and reason about it in the future.

---

## 1. The fix

**If you deploy the whole repo (monorepo) without setting Root Directory:**

- The root **`vercel.json`** (at repo root) must send traffic to where Vercel actually put the built files.
- **Change:** In that root `vercel.json`, set `routes[].dest` to the **artifact paths** that include the app folder, e.g.:
  - `"/api/omdb(.*)"` → `"/playground-serveless/api/omdb.js"`
  - `"/api/auth"` → `"/playground-serveless/api/auth.js"`
  - `"/"` → `"/playground-serveless/index.html"`
- Commit, push, and redeploy.

**If you still get 404 (or you prefer the clean approach):**

- In Vercel: **Settings → General → Root Directory** → set to **`playground-serveless`** (the folder that contains `api/`, `vercel.json`, `package.json`).
- Save and **Redeploy**. No root `vercel.json` is needed; the `vercel.json` inside `playground-serveless` is used, and paths like `/api/omdb.js` match the built artifacts.

---

## 2. Root cause

**What the code was doing**

- `builds` in `vercel.json` told Vercel: “Build these files” (e.g. `playground-serveless/api/omdb.js`).
- `routes` said: “When someone requests `/api/omdb...`, send them to `dest: "/api/omdb.js"`.”

**What it needed to do**

- When the **project root** is the repo root (no Root Directory set), Vercel places built outputs at paths that reflect the **source path**. So the serverless function from `playground-serveless/api/omdb.js` ends up at something like **`/playground-serveless/api/omdb.js`** in the deployment, not at **`/api/omdb.js`**.
- So the route’s `dest` must point to that **actual** path. If `dest` points to `/api/omdb.js` while the only built function is at `/playground-serveless/api/omdb.js`, Vercel has nothing to serve at `/api/omdb.js` → **NOT_FOUND**.

**What triggered the error**

- Deploying a repo whose root contains a **subfolder** (e.g. `playground-serveless/`) with the API and UI.
- Using a root `vercel.json` with `dest` values that assume the app is at the project root (e.g. `/api/omdb.js`), while the build output lives under the subfolder path.

**The oversight**

- Assuming that “route to `/api/omdb.js`” would work regardless of where the **source** file lived. On Vercel, the **URL path** of a serverless function is derived from the **path of the built artifact**, which can include the subfolder when you build from repo root.

---

## 3. The concept

**Why this error exists**

- NOT_FOUND is the platform saying: “No resource (static file or serverless function) exists at the path you’re requesting.” It protects you from broken links and makes it clear that routing and build output are out of sync.

**Correct mental model**

1. **Project root** = directory Vercel uses for the build (repo root, or “Root Directory” if set).
2. **Build:** Each entry in `builds` takes a **source** path (relative to project root) and produces an **artifact** (e.g. a function or static file). The artifact’s **logical path** in the deployment often mirrors the source path (e.g. `playground-serveless/api/omdb.js` → available at that URL path).
3. **Routes:** `src` matches the incoming URL; `dest` must be a path that **exists in the deployment**. If `dest` points to a path that was never produced by the build, you get NOT_FOUND.

So: **routes don’t create resources; they only point existing resources to URLs.** The build creates the resources; the route’s `dest` must match where they actually are.

**How this fits Vercel’s design**

- Vercel prefers one “app” per project root. For monorepos, you either set **Root Directory** to the app folder (so that folder is the project root and paths are simple) or you keep the repo as project root and **explicitly align** `builds` and `routes` with the resulting artifact paths (e.g. under `playground-serveless/`).

---

## 4. Warning signs and similar mistakes

**Watch out for**

- **Monorepo without Root Directory:** You have `my-app/api/handler.js` but routes use `dest: "/api/handler.js"`. If the build puts the function under `/my-app/api/...`, that `dest` will 404.
- **Typos in `dest`:** e.g. `omdb.js` vs `omdb.jss` or wrong folder name (`playground-serverless` vs `playground-serveless`).
- **Two `vercel.json` files:** One at repo root and one in the app folder. With Root Directory set, only the app folder’s config is used; without it, the root config is used. If you edit the wrong file, you’ll see unexpected 404s.
- **Assuming “Other” framework behaves like a framework:** With “Other”, there’s no auto-detection of `api/`. You **must** define `builds` (and optionally `routes`) so that the paths you route to actually exist in the build output.

**Similar pitfalls**

- Next.js in a subfolder without Root Directory: `pages/api` may not be at the path you expect.
- Static export in a subfolder: the static assets may live under `/subfolder/...`; routing `/` to `/index.html` can 404 if the file was emitted as `/subfolder/index.html`.

**Code smells**

- `vercel.json` at repo root with `api/` paths while the only `api/` folder is inside a subfolder.
- Routes that look like “what we want the URL to be” instead of “where the built artifact actually is.”

---

## 5. Alternatives and trade-offs

| Approach | What you do | Pros | Cons |
|----------|-------------|------|------|
| **Root Directory** | Set Root Directory to `playground-serveless` in Vercel. | One project root, simple paths (`/api/omdb.js`), single `vercel.json` in the app folder. | You must remember to set it when adding the project; one deployment per app. |
| **Monorepo root + correct `dest`** | Keep project root = repo root; root `vercel.json` with `builds` and `routes` whose `dest` use `playground-serveless/...`. | No dashboard change; one repo, one Vercel project. | Config is more fragile (paths must match build output); URLs still work as `/api/omdb` etc. via routing. |
| **Separate repo** | New repo containing only the contents of `playground-serveless`. Deploy that repo; no Root Directory. | Clean separation; no monorepo path logic. | Two repos to maintain; no single “monorepo” deployment. |
| **Multiple Vercel projects** | One Vercel project per app in the monorepo, each with its own Root Directory. | Each app has correct root and simple config. | More projects and possibly more build minutes. |

**Recommendation:** Prefer **Root Directory = `playground-serveless`** for this app so paths and config stay simple. Use the root `vercel.json` with corrected `dest` only if you intentionally deploy from the monorepo root without changing Root Directory.
