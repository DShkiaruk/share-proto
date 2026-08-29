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

## Lab verification

Filled in Task 10 Step 6.
