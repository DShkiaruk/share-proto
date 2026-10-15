# "Has anything changed?" from the CDN — experiment, 2026-10-15

**Question.** Can the overlay ask "has anything changed?" often, and right after a click, without spending the free Blob quota?

**Why it matters.** On Vercel Hobby, Blob gives 10,000 simple operations a month per account. Over the limit, Blob is blocked for 30 days ([usage and pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing)). Today every poll is one Blob read. Vercel does not say outright that a read with `useCache: false` counts as an operation; it says a read that misses the cache does, and this one skips the cache. If it does count, one tab polling every 25 s for 8 h a day uses about 1,150 a day, and the quota runs out in about 9 working days.

**Setup.** Tested on a throwaway Vercel project, now removed. The code is in this folder.
- `api/v.js` returns a version (the time it was generated) with these headers:
  - `Vercel-CDN-Cache-Control: public, max-age=3600`
  - `Vercel-Cache-Tag: state`
- `api/bump.js` calls `dangerouslyDeleteByTag('state')` from `@vercel/functions` 3.10.1.

This follows the documented recipe: [cdn-cache/purge](https://vercel.com/docs/caching/cdn-cache/purge).

**What happened.** Raw output is in `raw-output.txt`. All reads were made from one place (edge `arn1`).

1. **It is cached.** The first read reached the function (690 ms). Later reads came from the CDN: `HIT` in ~45 ms, with no function run. A request carrying a `Cookie` header was still a `HIT`.
2. **A purge is fast.** After the purge call, the new version was seen within 0.36–0.93 s (8 tries, median ~0.58 s). The purge call itself took 4–45 ms inside the function.
3. **A purge costs a few runs.** Right after a purge, 1–4 reads were `REVALIDATED`. Each of those ran the function (the version changed every time). After that, reads were `HIT` again.
4. **Not every read agrees for 1–2 s.** In that window, different reads were served different versions, sometimes an older one after a newer one. After that, everything converged.

**What it means for the overlay.**
- A cached, cookie-free `/api/v` (the gate's middleware skips `/api/`) could answer "same as before?" with no function run and no Blob read. A click, a focus or a 10 s poll could then ask it.
- The full read, one Blob operation, would happen only when the answer changes.
- Each write would purge and pay a few function runs. Each of those needs the current version: one Blob `head` per run.
- Not measured:
  - other regions;
  - limits on how often you can purge;
  - CDN requests count against Hobby's 1,000,000 a month.

**Not built.** This is a design check, not an implementation.
