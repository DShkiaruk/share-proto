# Changelog

## v2 — 2026-08-29

One repo for all modes (Vercel · local · embed), a storage layer that survives free-tier quotas, and a comment model that understands the prototype's structure and state.

### Foundation
- `share-proto-local` merged in: local mode (`template/server.js`, zero dependencies), embed mode (rooms per PR preview, CORS), Cloudflare Worker edition (`worker/`, **v1-frozen**).
- **Private Blob store**; append-only events + one `state.json` document read with `useCache:false` and written with ETag preconditions. A poll is one simple operation — no more `list()` per poll (which could exhaust the Hobby quota and disable Blob for 30 days).
- `/api/file` — session-gated proxy for previews, attachments and screen shots.
- Passwords `hex 4` minimum; login rate limit; `scripts/smoke.sh`; `scripts/seed.mjs` (also the v1 → v2 migration path, see `docs/UPGRADE.md`).
- Fixed a v1 bug: `resolved` was lost on every rebuild from events.

### Place model
- A comment stores `page` (path + hash), the in-screen click **trail** and its **container** (menu, dialog, floating layer). Pins: real / ghost on the trigger / hidden / approximate.
- One-click **Go to comment** from the sidebar: other document → hash route → learned graph → trail replay (pointer sequence) → pin.
- Overlay pointer events no longer count as "outside clicks" for the prototype's menus.
- Global comment **numbers** (`#12`) shared by both roles; sort Newest / Oldest / Unread / By screen; Client / Team filter for designers; **J**/**K** walk comments; **H** is a presentation mode (everything hidden, a dot brings it back).

### Media
- Viewport **preview** captured after posting (pin marked), shown on hover in the sidebar and in other-screen popovers.
- **Attachments**: paste, drop or the paperclip (≤ 3 × 1.5 MB, magic-byte validated), thumbnails, lightbox.

### Workflow
- **Statuses** Open · In progress · Done · Won’t do (with a required reason the client sees; clients may toggle Open/Done), system lines in the thread, status filter (default Active = open + in progress).
- **Kind** (bug / question / idea) at creation, changeable by designers.
- **Reactions** 👍 ✅ ❓ 👀.
- **What's new** since your last visit (per browser session): badge + "New for you" section, new screens.
- **Versions** of the prototype (page ETag), first-seen dates, designer labels, filter by version; "Older version" badge shows the label.

### Map
- **M** opens a map of every screen: thumbnails, comment counts, arrows labeled with the click that connects them; click a screen to go there; designers rename or hide screens.
- `scripts/crawl.mjs` walks a deployment with real clicks and shoots every screen (skips destructive controls).

### Breaking / migration
- v2 reads only **private** stores — existing v1 deployments migrate with `docs/UPGRADE.md` (export → seed → deploy → `?rebuild=1`).
- The v1 `resolve` action is still accepted (mapped to a status event).
- `H` semantics changed (hides pins too). New hotkeys: `M`, `J`/`K`.

## v1 — 2026-07-03

Password-protected prototype sharing with pins, threads, replies, resolve, unread dots, learned "Go to comment" navigation, auto dark theme, mobile support.
