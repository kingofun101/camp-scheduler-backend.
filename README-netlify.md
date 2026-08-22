# Camp Scheduler Backend — Netlify Edition

A version of the sync backend built specifically for Netlify: a serverless
function backed by **Netlify Blobs** (Netlify's built-in key/value store)
instead of a locally-running server with a SQLite file.

## Why this is a different version, not just a deploy target

Netlify runs your code as short-lived serverless functions — each request
gets a fresh, throwaway filesystem. A local file like the SQLite database in
`backend/server.js` (the self-hosted Express version) would get wiped between
requests, so that version can't run on Netlify as-is.

Netlify Blobs solves this properly: it's a persistent key/value store built
into the platform, no separate database to provision, and it survives across
requests and deploys. This version uses it instead of SQLite. Everything else
— the API contract, the data shape, how the scheduler HTML talks to it — is
identical to the self-hosted version.

**Same-code guarantee:** I tested this by running the scheduler's actual
frontend `gsSaveSettings` / `gsLoadSettings` / `gsSaveSchedule` /
`gsLoadSchedule` / `gsListWeeks` functions against the real handler code in
this file (with Netlify Blobs stubbed locally, since that requires a live
Netlify site) — full save/load round trips for both settings and a generated
schedule came back correct. The one thing I couldn't test from here is
Netlify's actual Blobs storage layer itself, since that only exists once this
is deployed to a real Netlify site.

## Deploying

1. Push this folder (`netlify-backend/`) to a Git repository.
2. On Netlify: **Add new site → Import an existing project**, connect the repo.
3. Build settings: no build command needed, publish directory can be empty/root
   — this site has no static frontend, it's purely the function. (If Netlify's
   UI requires a publish directory, create an empty `public/` folder.)
4. Deploy. Netlify auto-detects `netlify/functions/exec.mjs` and the
   `config.path = "/exec"` inside it — no `netlify.toml` redirects needed.
5. Your endpoint is live at `https://your-site-name.netlify.app/exec`.

### Enable auth (do this before real use)
In Netlify's site settings → **Environment variables**, add:
```
API_TOKEN = <a long random string>
```
Generate one with `openssl rand -hex 24`. Then in the scheduler HTML:
```js
const BACKEND_URL = 'https://your-site-name.netlify.app/exec';
const CAMP_ID = 'shalom';
const API_TOKEN = '<the same random string>';
```

### Netlify Blobs — no setup needed
Netlify Blobs works automatically for any site deployed on Netlify — there's
nothing to provision or configure. The store is created the first time the
function writes to it.

## Local testing with the Netlify CLI

```bash
npm install
npx netlify dev
```
This runs the function locally (at `http://localhost:8888/exec` by default)
with a local emulation of Netlify Blobs, so you can test the full flow before
deploying.

## Multi-camp

Same as the self-hosted version — every request carries a `camp` field
(`CAMP_ID` in the HTML), and each camp's data is stored under its own key
prefix, fully isolated within the same deployment.

## API reference

Identical to the self-hosted backend — see `../backend/README.md` for the
full action table. Both versions are interchangeable from the scheduler's
point of view; only `BACKEND_URL` changes.

## Which version should you actually use?

- **This Netlify version** — best if you want zero server management, a free
  or near-free tier to start, and you're comfortable with Netlify's platform
  for a future multi-camp product.
- **The self-hosted Express version** (`../backend/`) — best if you want full
  control, plan to run it on your camp's own network with no ongoing hosting
  cost, or want a portable option that isn't tied to one platform.

Both speak the same API, so switching between them later is just changing
`BACKEND_URL` — none of your data-model or frontend code needs to change.
