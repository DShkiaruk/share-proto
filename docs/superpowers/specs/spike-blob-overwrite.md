# Spike: overwrite freshness on Vercel Blob (2026-08-29)

Question: does `get(pathname, {access, useCache:false})` return the newest content right after `put(..., {allowOverwrite:true})`? Does `ifMatch` reject a stale writer?

Probe: `scripts/spike-blob.mjs` — 50 × {put, (0 or 200 ms), get, assert}, then two writers with the same `ifMatch` ETag. SDK `@vercel/blob 2.8.0`, Node 26.

| store | iterations | stale reads | ifMatch rejected | wall ms |
|---|---|---|---|---|
| private | 50 | 0 | yes (`BlobPreconditionFailedError`) | 39 145 (≈ 780 ms per put+get) |
| public  | — | n/a | n/a | `get(..., {access:'public', useCache:false})` → **403 Forbidden** on every read |

`get()` result shape (private): `{ statusCode, stream, headers, blob }`, with `blob = { url, downloadUrl, pathname, contentType, contentDisposition, cacheControl, size, uploadedAt, etag }`. `lib/storage.js` reads the ETag from `blob.etag`.

**Verdict: BRANCH=A.** Fixed-name `state.json`, read with `useCache:false`, written with `ifMatch` (optimistic concurrency). Events stay append-only.

Legacy public stores: the fresh-read path does not work on them (403), so `lib/storage.js` is **private-only**. A v1 deployment upgrades by exporting `GET /api/comments` as a designer, creating a private store, replaying the export with `scripts/seed.mjs`, and opening `/api/comments?rebuild=1` once. `BLOB_ACCESS=public` (from the plan) is dropped as a dead path.

## Lab verification (2026-08-29)

- `get()` on a larger document (`state.json`, ~40 KB) returned a **weak** ETag `W/"…"` while `head()` returned the strong `"…"`; `put({ifMatch: 'W/"…"'})` fails as a precondition error. The spike missed it because its document was 12 bytes. Fix: `normalizeEtag()` strips `W/` in `lib/storage.js` (verified on the lab: stripped tag accepted, same value as `head()`).
- Operation counts are asserted machine-side instead of via the dashboard: `scripts/smoke.sh` and `tests/e2e/smoke.spec.mjs` require `X-Store-Path: read` on polls and `X-Store-Path: patch` on a create (no `list()` on either path).
- `scripts/seed.mjs` re-run against the seeded lab store: `0 written, 39 already present` — idempotent.
