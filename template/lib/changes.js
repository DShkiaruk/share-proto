/* "Has anything changed?" — one question every open tab asks often, so it
   must cost (almost) nothing.

   A full read of the comments is one storage operation, and on Vercel's free
   tier those are counted: 10,000 a month per account, Blob blocked for 30
   days past that. A tab that asked every 25 s spent ~1,150 a working day. So
   the overlay asks a small public endpoint for the room's version — the
   storage document's ETag on Vercel, a write counter elsewhere — and reads
   in full only when it differs from the version its last full read carried.

   On Vercel the answer is cached on the CDN under a tag, and every write to
   the room's document purges that tag (docs/superpowers/bench/
   2026-10-15-cdn-version: cached answers in ~45 ms with no function run; a
   purge shows within 0.4–0.9 s). The cache still expires after CHANGES_MAX_AGE,
   which bounds how stale a rare race (a version computed just before a write,
   stored just after its purge) can leave it.

   The endpoint needs no session: the answer is the same for everyone, and it
   says only that something changed, never what. */

export const CHANGES_PATH = '/api/version';
export const CHANGES_MAX_AGE = 600; // seconds

// One tag per room; tags may not contain commas, and room names are
// [a-z0-9-] (ROOM_RE), so this is always a valid tag.
export const versionTag = (room) => (room ? `fp-state-${room}` : 'fp-state');

// Same for every reader, so any page may read it (no credentials, so `*` is
// allowed), and the browser keeps no copy of its own: freshness is the CDN's.
export const VERSION_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};
