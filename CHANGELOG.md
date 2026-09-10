# Changelog

## v2 — 2026-08-29

One repo for all modes (Vercel · local · embed), a storage layer that survives free-tier quotas, and a comment model that understands the prototype's structure and state.

### Foundation
- `share-proto-local` merged in: local mode (`template/server.js`, zero dependencies), embed mode (rooms per PR preview, CORS), Cloudflare Worker edition (`worker/`).
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

### Worker edition (Cloudflare)
- Ported to the v2 API: statuses, kinds, reactions, numbers, previews, attachments, screen shots, the map and `/api/file` all work there. Rules live in `worker/src/room.js` over one Durable Object per room; `worker/src/index.js` is transport only.
- One set of rules for three servers: the worker imports `template/lib/{threads,state,media,session,cors}.js` instead of copying them (`worker/src/session.js`, a duplicate, is gone).
- Pictures are stored in the Durable Object, capped per room by `ROOM_MEDIA_BUDGET_MB` (64 MB default); a full room answers 507.
- v1 rooms upgrade themselves on first read (nav sharded per edge, threads gain numbers and statuses) — see `docs/UPGRADE.md`.
- Verified by `tests/unit/room.test.mjs` (rules), `scripts/worker-smoke.sh` (24 wire checks against `wrangler dev`) and `npm run e2e:worker` (the embed spec, real overlay, same file as the local run).
- Login brake: ten wrong passwords from one address and that address is refused for ten minutes. Held in one Durable Object, so unlike the per-instance counter the other editions keep, it is shared by every request the worker sees.
- Every server announces its API version (`v`) and the overlay hides what an older one cannot do.

## v2.1 — 2026-08-31

Everything reported from a live deployment, and the same behaviour on all three
servers.

### Where a comment lives
- A comment's trail — the clicks that reopen the state it was left in — is kept for **every** comment, not only those inside a container the overlay could classify. A detail panel docked in the layout is not a floating layer and never was classifiable; that is exactly the case that lost its trail.
- A pin is drawn in one of two honest places: on its element, or as a ghost on the click that brings that element back. The old third answer — the stored document fraction — put confident pins on whatever had moved into their place, and is gone.
- Clicking a comment whose element is absent waits for it instead of giving up, and **learns the way** once someone opens that state by hand (`trail` action). Older comments heal one at a time.
- `scrollIntoView` walks every scrollable ancestor, so a trigger inside a list that scrolls independently of the page is reachable.

### The map
- Laid out as a flow: columns are clicks from the opening screen and are labelled, the entry is flagged, screens nothing links to get their own band, and exactly one card says "you are here".
- Right-angled edges with one port each, returns dashed in their own lanes, labels beside their target with the ground painted behind them.
- Opaque panel on its own ground with a dot grid — the prototype used to show through, and white cards sat on white.
- Comment on a screen from its card (no anchor, no pin, "About this screen"); a designer can add a picture to a screen that has none, and screens a designer visits are captured automatically when the overlay is idle.
- A card takes you to its screen even when the way in needs an in-screen step first: an edge now carries those clicks and the walk replays them. Arrival is exact, so a walk toward a sub-state no longer stops on its parent and calls it success.

### Servers
- New action `trail`; `navTrail` in every GET. The Vercel functions, `server.js` and the Worker room all speak them.
- `tests/unit/parity.test.mjs` compares the three sources: same actions, same GET fields, same shared rules. `scripts/smoke.sh` and `scripts/worker-smoke.sh` now run the same new checks, so a deployment is verified the same way whichever edition serves it.

## v1 — 2026-07-03

Password-protected prototype sharing with pins, threads, replies, resolve, unread dots, learned "Go to comment" navigation, auto dark theme, mobile support.

## v2.2 — 2026-09-10

Five things reported from a live review, and the pass over the comment list they
turned out to be one symptom of.

### The prototype's own state
- A comment records the **theme it was left in** — the mode we measure, plus the
  class tokens and data attributes that produced it. When the prototype is in
  the other state its header says so, and (for the two mechanisms prototypes
  actually use — a class, a `data-theme`-style attribute) offers to switch back,
  verifies that the colour really changed, and undoes itself if it did not.
- `detectTheme()` no longer keeps a stale answer when nothing on the page paints
  an opaque background: a prototype that goes light by *removing* a class used to
  leave a dark comment panel over a white page.
- The overlay watches `<html>` too. `html.dark` is where most prototypes keep the
  theme, and it sits outside the subtree we were observing.

### Keys typed into the overlay stay in the overlay
- Every key event that starts in one of our own fields is stopped at the shadow
  host. Two things were wrong without it: the prototype's shortcuts fired while
  someone wrote a comment (on a Ukrainian layout "с" is the physical C key —
  our own shortcut), and a page that guards a key outside its inputs
  ("Backspace must not navigate back") saw only our host element, decided nobody
  was typing, and cancelled the keystroke. That is why **Backspace stopped
  deleting text**. `tests/e2e/keys.spec.mjs` reproduces both against a fixture
  that carries the guard.

### The comment list, rebuilt around what a row is for
Researched against five annotation tools (Figma, Air, Framer, Ditto, Sketch) and
three inbox lists (Linear, Intercom, Upwork) before touching anything.
- A row is three lines: who and when (quiet), the comment itself (the only
  ink-coloured text), where it lives (quiet). The comment used to be the
  smallest, greyest thing in the row.
- The **time sits in its own column on the right edge** and no longer moves with
  the tags before it. The unread dot moved to the left gutter for the same
  reason.
- Status is a **glyph, not a word**, and only when it is not "Open" — four
  distinct shapes (ring, half, tick, slash) so the state survives colour
  blindness. Role left the row entirely: a client's avatar wears a ring, and the
  filter above the list still says the words.
- Audience and sort are one control shape instead of a row of pills next to a
  native `<select>`.
- The **status control looks like a control**: glyph, label, chevron, hover and
  open states. "Open" as bare text was read as decoration, and was.
- In a thread header, facts that cannot be acted on are one muted sentence, not
  a badge each. The only badge left is "Older version", which is a warning.
- The list stays open when you open a comment (Figma, Air and Framer all do),
  and the popover keeps clear of it.

### Also
- A hover preview no longer covers the thread it belongs to.
- Sidebar empty states name the filter you are actually looking at.
- New: `theme` on a comment (all three servers, one shared sanitiser), covered by
  `npm test`, both smoke scripts and `tests/e2e/theme.spec.mjs`.
