# Ferry handoff

Last updated: 2026-11-04
Repository: <https://github.com/user4563889757/ferry>
Live site: <https://getferry.pages.dev>
Old address: <https://ferry-cloud.pages.dev> (301 redirect to the new one)

This file is the starting point for any other AI coding agent or developer.
Read this first, then `README.md`.

## What exists

Two working backends share one web UI in `web/`:

1. **Local** — Rust binary in `src/`, no database, stores files under
   `~/.local/share/ferry`. Build with `cargo build --release`.
2. **Cloud** — Cloudflare Pages + Pages Functions + D1. This is the deployed
   public version. Files are stored as 1 MiB chunks in D1.

Both expose the same `/api/...` contract, so the UI works with either.

## Current status

- Cloud site is live and was tested end-to-end: auth, create upload, 1 MiB
  chunk append, resume by fingerprint, full download, cross-chunk range
  download, QR, list, delete.
- Share-key auth uses `X-Ferry-Key` or `?key=`. `GET /api/health` is public.
- Storage guards:
  - `MAX_FILE` = 350 MB
  - `MAX_DB` = 400 MB total upload budget
  - D1 hard limit is 500 MB, so there is deliberate headroom.
  - Upload creation and every chunk append return `507 storage_full` before
    the database can fill up.
- Downloads fetch 8 chunks per D1 query to stay under the free plan's
  50-queries-per-invocation limit. A 350 MB download uses about 45 queries.
- `GET /api/files` returns the newest 100 files; the UI polls every 15 seconds
  to stay inside the free daily row-read limit.
- Uploading a 350 MB file costs about 700 D1 row writes; the free limit is
  100,000/day.
- The old `ferry-cloud.pages.dev` project now serves `redirect/_redirects`
  (root and unknown paths 301 to `getferry.pages.dev`). Its API is still live
  as a fallback.

## Accounts and secrets

- Cloudflare account: the project owner's account. `wrangler` is logged in on
  the original laptop. Use `npx wrangler login --device` on a new machine.
- `FERRY_KEY`: stored in `/home/wok/ferry/.ferry-key` and as a Cloudflare Pages
  secret. **It is not in git.** Never commit it.
- `.dev.vars`: local-only test key, gitignored.
- D1 `database_id` in `wrangler.toml` is not a secret. It is
  `d15e8ee0-d03a-4297-82b2-2900518220ea`.
- The D1 database is named `ferry` and holds the uploaded files. Do not delete
  or recreate it unless the owner explicitly wants to lose the files.

## Continue on a new machine

```sh
git clone https://github.com/user4563889757/ferry.git
cd ferry
npm install
npx wrangler login --device
```

Then read `README.md` for the full deploy flow. Short version:

```sh
npm run deploy
```

`package.json` already points at the `getferry` Pages project and the `main`
production branch. Updating the live site is just `npm run deploy`.

Apply schema changes (only when the schema actually changes):

```sh
npx wrangler d1 execute ferry --remote --file=schema.sql
```

Local cloud development:

```sh
printf 'FERRY_KEY=testkey123\nFERRY_NAME=Ferry Cloud Test\n' > .dev.vars
npx wrangler d1 execute ferry --local --file=schema.sql
npx wrangler pages dev web --port 8791 --ip 127.0.0.1
```

## Testing without a browser

The API is easy to exercise with `curl`. Use the real key from `.ferry-key`
or the local test key. Important cases:

- `GET /api/health` returns `200` without a key.
- `GET /api/files` returns `401` without a key.
- `POST /api/uploads` with `{"name","size","fresh":true}` creates an upload.
- `PUT /api/uploads/:id?offset=` must start on a 1 MiB boundary.
- `GET /api/files/:id/download` supports `Range`.
- `DELETE /api/files/:id` removes file metadata and chunks.

## Known limitations / next ideas

- No custom domain yet. `getferry.pages.dev` is the free Cloudflare address.
- No IPFS mirror yet. Possible, but uploads still need the Cloudflare API.
- No automated test suite; testing is manual `curl` plus ad-hoc browser checks.
- No automatic file expiry. Files stay until deleted.
- No multi-user accounts. One global share key.
- The old `ferry-cloud` project could be deleted eventually, but keeping it as
  a redirect is harmless.

## Rules for the next agent

- Do not commit `.ferry-key`, `.dev.vars`, `node_modules/`, or `.wrangler/`.
- Do not print the share key into files that are tracked by git.
- Do not delete the D1 database or the `getferry` Pages project.
- Keep the `/api/...` contract stable; the same UI serves local Rust and cloud.
- Keep chunks at 1 MiB and preserve the storage/query guards.
- Run `npm run deploy` from `/home/wok/ferry` and verify
  `https://getferry.pages.dev/api/health` after changes.
