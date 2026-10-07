# @better-files/storage-node

The storage node agent for a [Better Files storage cluster](../storage-cluster). It turns a server's local disk into
cluster storage: it serves encrypted objects over HTTP, dials out to the control plane to join and heartbeat, and
runs the commands heartbeats return.

```sh
BETTER_FILES_JOIN_TOKEN=bfj_… npx better-files-node start \
  --data /srv/better-files --control https://app.example.com/api/better-files --tenant ops \
  --listen 0.0.0.0:7070 --advertise https://store-1.internal:7070 --zone eu-1a --capacity 2TiB
```

- **First start** joins with the token (read from `BETTER_FILES_JOIN_TOKEN` or `--token-stdin`, never from arguments)
  and saves the node identity to `<data>/node.json` (mode 0600). Later starts reuse it; a new address is reported
  in the next heartbeat.
- **Layout.** Objects live at `<data>/objects/<sha256(key)[0:2]>/<sha256(key)>`, each with a `.meta` sidecar
  (key, size, SHA-256) that the control plane uses to rebuild its index. Multipart parts are staged in
  `<data>/uploads/`; writes land in `<data>/tmp/` and are renamed into place.
- **Data API** (every call needs a token the control plane signed for this node):
  - `PUT`, `GET` (with `Range`), `HEAD` and `DELETE` on `/o/{key}`;
  - `POST /o/{key}/verify` re-hashes an object;
  - `PUT /u/{upload}/{part}`, `POST /u/{upload}/complete` and `DELETE /u/{upload}` for multipart uploads;
  - `GET /inventory` and `GET /stats`.

  `GET /health` is open.

- **Browsers** can upload parts directly (direct uploads) when `--cors` allows the app's origin; `ETag` is exposed.
- Serve it over TLS (a reverse proxy works) when the network between the app and the nodes is not private: tokens
  are bearer credentials for their one object and operation.

Programmatic use: `storageNode(options).start()`, `stop()`, `heartbeat()`, `stats()`.

Part of [Better Files](../../README.md).
