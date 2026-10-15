# "Has anything changed?" — design record (v2.9.0)

Status: built 2026-10-16 at the owner's request ("так, зроби до кінця").
Evidence: `docs/superpowers/bench/2026-10-15-cdn-version/`.

## Problem

1. **Slow to show others' comments.** Updates were seen up to 25 s late while
   someone was at the page, and up to 4 min late once the tab had gone quiet.
2. **Reads cost quota.** Every poll was a full read of the room, one Blob
   operation. On Hobby, Blob gives 10,000 simple operations a month per
   account, and Blob is blocked for 30 days past that.

## Decision

- **A public, cacheable version per room.**
  - `GET /api/version[?room=]` returns `{ v }`.
  - Every `GET /api/comments` carries `ver`, the version that read was of, and
    `changes`, where to ask.
- **What the version is.**
  - Vercel: the state document's ETag (`head()`, no download).
  - Local server: `<boot>.<writes>`.
  - Worker room: `<boot>.<posts>`.
- **Vercel caching.**
  - `Vercel-CDN-Cache-Control: public, max-age=600` and
    `Vercel-Cache-Tag: fp-state[-<room>]`.
  - `createStateStore({ onWrite })` purges with `dangerouslyDeleteByTag`
    after every successful document write.
- **Overlay.**
  - Asks every 15 s while someone is here, every 2 min after 3 quiet minutes,
    and never while hidden.
  - Asks at once on focus and on visibility.
  - A click or key asks at most once per 3 s.
  - It reads in full only when `v !== ver`.
  - After three failed asks in a row, it falls back to the old read pacing.

## Why the version is content-derived, not "time generated"

The CDN holds separate entries per node. A time-based value would differ
between nodes even with no write, and a tab moving between nodes would read
every time. The probe saw three different entries at once after a purge.

## Risks accepted

- **Stale answers.** A version computed just before a write, and stored after
  that write's purge, stays until it expires: at most 10 minutes. This is
  rare; the window is one ETag read long.
- **Change timing is visible.** Anyone with the URL can see *when* a room
  changes, never what. Room names are already in the page.
- **CDN requests count.** Each ask counts toward Hobby's 1,000,000 a month.
  At the active pace that is 1,920 asks per 8-hour tab-day.
- **Purge-related function runs.** Each one is one Blob `head`.

## Not done

- No push or WebSocket channel: still a poll, just a nearly free one.
- No Cloudflare Cache API in front of the Worker room. Each ask there is a
  Worker request plus a Durable Object request, within the free allowances.
