# Ferry

A tiny file ferry. Send any file between devices, or run it in the cloud so the
link keeps working when your laptop is off.

**Live cloud version:** <https://ferry-cloud.pages.dev> (free Cloudflare Pages +
D1, no credit card). Enter the share key to unlock it.

- Resumable uploads with server-persisted offsets
- Range-based downloads (pause/resume, seek in large files)
- Share link and QR code
- Share-key authentication
- Two backends from one UI:
  - **Local** — one Rust binary, no database, no cloud
  - **Cloud** — Cloudflare Pages + Pages Functions + D1, free and always on

## Cloud version (free, no credit card)

The cloud version is a static site plus Pages Functions. File bytes are stored
as 1 MiB chunks in D1, so no object-storage billing or credit card is needed.

Free-tier limits that shaped the implementation:

| Limit | Value |
|---|---|
| D1 storage per database | 500 MB |
| D1 storage per account | 5 GB total |
| Max file size here | 350 MB |
| Upload budget here | 400 MB total |
| D1 row size | 2 MB |
| D1 rows written | 100,000/day |
| D1 rows read | 5,000,000/day |
| Pages requests | 100,000/day (static requests unmetered) |

Ferry enforces a **400 MB upload budget** and a **350 MB per-file cap** instead
of using the full 500 MB database. That leaves room for SQLite pages and
metadata, so an upload cannot fill the database and start failing halfway.

Downloads fetch eight 1 MiB chunks per D1 query. The free plan allows 50 D1
queries per request, so a 350 MB download uses at most 45 queries instead of
350, and still streams with backpressure.

### Deploy

You need one free Cloudflare account. No payment method is requested.

```sh
cd ferry
npm install

# 1. Log in (opens a browser, or use --device for a code-based login)
npx wrangler login --device

# 2. Create the database and copy its id into wrangler.toml
npx wrangler d1 create ferry

# 3. Apply the schema to the remote database
npx wrangler d1 execute ferry --remote --file=schema.sql

# 4. Create the Pages project (once)
npx wrangler pages project create ferry-cloud --production-branch main

# 5. Set the share key and display name
npx wrangler pages secret put FERRY_KEY --project-name ferry-cloud
npx wrangler pages secret put FERRY_NAME --project-name ferry-cloud

# 6. Deploy to the production branch
npx wrangler pages deploy web --project-name ferry-cloud --branch main --commit-dirty=true
```

`wrangler d1 create ferry` prints a `database_id`. Put it in `wrangler.toml`
where the placeholder is:

```toml
[[d1_databases]]
binding = "DB"
database_name = "ferry"
database_id = "paste-the-id-here"
```

The site is then live at `https://ferry-cloud.pages.dev` (or the project name you
chose). Open it on your phone and enter the `FERRY_KEY` you set in step 5.

After the first deploy, updating is just:

```sh
npm run deploy
```

`npm run deploy` is already set to `ferry-cloud` and `--branch main`. If you
used a different project name, change it in `package.json`.

### Local development for the cloud version

```sh
printf 'FERRY_KEY=testkey123\nFERRY_NAME=Ferry Cloud Test\n' > .dev.vars
npx wrangler d1 execute ferry --local --file=schema.sql
npx wrangler pages dev web --port 8791 --ip 127.0.0.1
```

Open <http://127.0.0.1:8791/> and use `testkey123`.

### Notes

- Upload chunks must start on a 1 MiB boundary. The UI always does this; it is
  the reason the API rejects an unaligned `offset` with `400 invalid_offset`.
- `GET /api/files` returns the newest 100 entries to stay well inside the free
  daily row-read allowance.
- Files stay until someone presses **Delete**. There is no automatic expiry.
- The share key is a global secret. Rotate it with
  `npx wrangler pages secret put FERRY_KEY --project-name ferry`.

## Local version

### Build

```sh
cargo build --release
```

The binary is at `target/release/ferry`.

### Run

```sh
./target/release/ferry
```

By default Ferry listens on `0.0.0.0:8787`, stores data in
`~/.local/share/ferry`, and prints a random share key plus local URLs.

```text
Ferry 0.1.0 - local file transfer
Device: my-laptop
Data:   /home/me/.local/share/ferry
Key:    a1b2c3d4e5f60718

Open on another device on the same network:
  http://192.168.1.10:8787/
    http://192.168.1.10:8787/#key=a1b2c3d4e5f60718
```

Open a printed URL on the other device, or scan the QR code from the Share
dialog. The key travels in the URL fragment, is stored locally by the browser,
and is sent as the `X-Ferry-Key` header from the web UI. Direct download links
use `?key=` so they work without JavaScript.

### Options

```text
-b, --bind <ADDR>    Address to listen on [default: 0.0.0.0]
-p, --port <PORT>    Port to listen on, 0 chooses a free port [default: 8787]
-d, --dir <DIR>      Directory for metadata and blobs
-k, --key <KEY>      Fixed share key instead of a random one
    --name <NAME>    Device name shown to other devices
```

### Bluetooth

Ferry uses IP over Bluetooth rather than OBEX. Pair both devices, enable
Bluetooth tethering/PAN on one, join the PAN from the other, and open the
address labelled `Bluetooth PAN` in the Share dialog. The same resumable
transfer works because it is still HTTP.

## How resume works

The UI splits each file into 1 MiB chunks and sends them with the current
offset. The server stores file bytes and metadata separately, verifies the
real size, and reports its offset when a chunk does not match. After a dropped
connection the client asks for the file metadata and continues from the
server's offset.

If the browser is closed entirely, the incomplete file still appears under
**Files here**; press **Resume** and choose the same file again.

## API

All `/api/*` routes require `X-Ferry-Key` or `?key=` except `GET /api/health`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness check |
| `GET` | `/api/info` | Device name, version, mode, limits, addresses |
| `GET` | `/api/files` | List files and stats |
| `POST` | `/api/uploads` | Create or resume an upload by fingerprint |
| `PUT` | `/api/uploads/:id?offset=` | Append one chunk |
| `GET` | `/api/files/:id` | File metadata (used to recover the offset) |
| `GET` | `/api/files/:id/download` | Download, supports `Range` |
| `DELETE` | `/api/files/:id` | Delete file and chunks |
| `GET` | `/api/qr?text=` | QR code as SVG |

## Storage layout (local)

```text
<data dir>/
  meta/<id>.json   file metadata and confirmed offset
  blobs/<id>.bin   file contents
```

On startup Ferry reconciles metadata with the actual blob sizes to recover
from a crash or power loss.

## Scope

The local version is meant for trusted local networks. It uses HTTP, not
HTTPS, and the share key is a convenience boundary rather than strong
authentication. The cloud version uses HTTPS and a global key; treat that key
like a password.

## License

MIT
