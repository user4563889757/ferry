# Ferry

A tiny, self-hosted file ferry for your local network.

Send any file between devices on the same Wi-Fi or Bluetooth PAN. Uploads are
chunked and saved on the server as they arrive, so an interrupted transfer
resumes where it stopped instead of starting over.

- One Rust binary, no database, no cloud
- Vanilla HTML/CSS/JS UI embedded in the binary
- Resumable uploads with server-persisted offsets
- Range-based downloads
- Share link and QR code
- Session share key
- Works over Bluetooth tethering/PAN as well as regular LAN

## Build

```sh
cargo build --release
```

The binary is at `target/release/ferry`.

## Run

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

## Bluetooth

Ferry uses IP over Bluetooth rather than OBEX. Pair both devices, enable
Bluetooth tethering/PAN on one, join the PAN from the other, and open the
address labelled `Bluetooth PAN` in the Share dialog. The same resumable
transfer works because it is still HTTP.

## How resume works

The UI splits each file into 4 MiB chunks and sends them with the current
offset. The server stores file bytes and metadata separately, verifies the
real blob size on disk, and reports its offset when a chunk does not match.
After a dropped connection the client asks for the file metadata and continues
from the server's offset.

If the browser is closed entirely, the incomplete file still appears under
**Files here**; press **Resume** and choose the same file again.

## Storage layout

```text
<data dir>/
  meta/<id>.json   file metadata and confirmed offset
  blobs/<id>.bin   file contents
```

On startup Ferry reconciles metadata with the actual blob sizes to recover
from a crash or power loss.

## Scope

Ferry is meant for trusted local networks. It uses HTTP, not HTTPS, and the
share key is a convenience boundary rather than strong authentication. Do not
expose it directly to the public internet.

## License

MIT
