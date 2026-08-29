# share-proto v2 — design spec

Date: 2026-08-29. Status: draft for review.
Scope owner: Dmytro. Decisions below were taken in an 11-question interview; items marked **(assumed)** were decided by the implementer alone and are open to override.

## 1. Goal

Turn share-proto from "pins on a page" into a review tool that understands the prototype's **structure and state**: comments that live inside dropdowns and dialogs, one-click navigation to any comment, page previews, a map of every screen, and a real triage workflow (numbers, statuses, kinds, reactions, versions) — while fixing the storage economics and security gaps found in the 2026-08-29 audit.

Two hard constraints carry over from v1 and are not up for discussion:

- The client role must never receive designer threads from the API.
- Old threads (v1 data on live deployments) keep working: visible, navigable, resolvable.

## 2. Non-goals

- Export to Markdown/CSV (rejected).
- Assignees / team members as an entity (rejected).
- Notifications outside the page (email, Slack) — still deliberate.
- Comment *editing* by anyone but the author; moderation UI.
- Real-time (WebSocket) updates — polling stays.

## 3. Repository consolidation (Phase 0)

`share-proto` becomes the superset; `share-proto-local` is reduced to a README that tells the agent to clone `share-proto` and pick **local mode**.

Ported from local into main: `page`-aware threads, `template/server.js` (zero-dependency local server), embed mode (`lib/cors.js`, token auth, rooms per hostname), `worker/` (Cloudflare edition). `worker/wrangler.log` is dropped and gitignored.

Mode selection is a property of the assembled project, not of the code: the same `public/overlay.js` runs against `/api/*` whatever serves it (Vercel functions, `server.js`, Worker). SKILL.md gets one "Mode" table and per-mode steps; the shared steps (assemble, smoke test, hand-over block) are written once.

## 4. Storage layer

### 4.1 Problem

Every `GET /api/comments` performs two `list()` calls; `list()` and `put()` are Blob *advanced operations*. One open tab polling every 25 s costs ~290 advanced ops/hour. Exceeding the Hobby quota disables Blob for 30 days (Vercel docs, usage-and-pricing). Everything in v2 adds writes (previews, attachments, shots, reactions), so reads must stop listing.

### 4.2 Spike (Phase 0, one day, throwaway)

Question: on a **private** store, does `get(pathname, { access: 'private', useCache: false })` return the freshly overwritten content immediately after `put(pathname, …, { allowOverwrite: true })`?

Method: separate test store; loop 50× {put N; get; assert N} with 0 ms and 200 ms gaps; also probe `head()` for ETag semantics. Record results in `docs/superpowers/specs/spike-blob-overwrite.md`.

### 4.3 Branch A — spike passes (expected)

- Store is **private** (`vercel blob create-store … --access private`). Nothing in the store is reachable without `BLOB_READ_WRITE_TOKEN`.
- Events stay **append-only** (`threads/<tid>/<ts>-<uuid>.json` etc.) — they are the source of truth and the audit trail.
- Snapshots move to **fixed pathnames**, overwritten: `snap.json`, `navsnap.json`, `versions.json`, `mapmeta.json`. Read with `get(…, { useCache: false })`. `GET /api/comments` = **1 simple operation, 0 advanced**.
- Rebuild-from-events stays as the repair path (`?rebuild=1`, designer only) and runs automatically when `snap.json` is missing.
- Snapshot GC code is deleted (nothing to GC).

### 4.4 Branch B — spike fails

- Keep v1 append-only snapshots and `list({limit:1})`.
- `GET` returns `ETag: <snapshot pathname>`; the overlay sends `If-None-Match` and the function answers `304` without fetching the snapshot body (still 1 list). Poll interval backs off 25 s → 60 s after 5 minutes without user input, resets on input.

Either branch: `del()` is free; `put()` counts — so the per-mutation cost is `put(event) + get(snap) + put(snap)` ≈ 2 advanced ops (A) instead of ≈ 4–6 (v1).

### 4.5 File proxy

Private blobs (previews, attachments, shots) are served through `GET /api/file?p=<pathname>`: session required; role check — a client may fetch files only for threads they can see, and screen shots for any screen; `Cache-Control: private, max-age=31536000, immutable` (pathnames are content-unique). Local mode serves the same route from `data/files/`.

## 5. Place model — where a comment lives

### 5.1 Fields on a thread (new in bold)

```
screenLabel   composite heading label (v1)
page          **pathname + hash**, e.g. "/index.html#/settings" (from local edition, extended with hash)
anchor        path / t / txt / ox / oy / fx / fy (v1)
anchor.container  **{ path, role, name }** when the target sits inside an overlay container
trail         **[ { anchor, txt } ]** — the in-screen clicks that produced the state (≤ 8)
n             **global sequential number** (see 6.2)
```

### 5.2 Container detection (at comment creation)

Walk up from the anchored element to `appRoot()`. The first ancestor matching any of these is the container:

- `role` in `dialog | alertdialog | menu | listbox | tooltip | combobox | tree`, or `aria-modal="true"`;
- `getComputedStyle(el).position` in `fixed | absolute` **and** z-index ≥ 1 **and** the element is not `appRoot()` and its box covers < 90 % of the viewport (so full-page layouts with `position:absolute` roots do not count);
- `[data-state="open"]`, `[aria-expanded]` targets' `aria-controls` element (Radix/Headless UI convention).

`container.name` = `aria-label` → first heading inside → text of the trail's last click (the trigger) → tag.

### 5.3 Trail

The overlay already records the last prototype click for the navigation graph. It now keeps a ring buffer of the last 8 clicks **since the current screen label appeared**. When a comment is created with a container, `trail` = those clicks (anchors + short text). Without a container, `trail` is empty.

### 5.4 Pin states on the current screen

| Condition | Pin |
|---|---|
| anchor resolves & visible | **real pin** at anchor |
| anchor absent, `container` set, trigger (last trail anchor) resolves | **ghost pin** on the trigger: dashed ring, "collapsed" glyph, stacked count when several comments share the trigger |
| anchor absent, no trigger found | hidden; sidebar row shows "in: <container.name>" |
| anchor absent, no container (v1 behaviour) | approximate pin at fx/fy — unchanged |

Clicking a ghost pin replays the trail (5.5) and then opens the real pin.

### 5.5 Go to comment (one click)

```
goTo(thread):
  if page differs → location = page + '?comment=' + id   (deep-link boot continues)
  if screen differs → autoNavigate (v1 graph, per-hop re-planning)
  if trail non-empty → replay: for each step, locate anchor → synthetic pointer sequence
                        (pointerdown, mousedown, pointerup, mouseup, click) → wait ≤ 1.5 s for anchor
                        of next step or of the comment
  if anchor resolves → open thread on pin, pulse
  else → guided toast "Open “<container.name>” — the comment will appear there"
```

Sidebar row click = `goTo`. Hover (desktop) / "preview" button (touch) shows the thread card without navigating (7.4).

Deep links keep `location.hash` and unrelated query params: only the `comment` param is stripped.

### 5.6 Screen identity fallbacks

`screenLabel()` order: `[data-screen]` on appRoot or its first child → composite h1–h3 (v1) → `location.hash` if non-empty → largest visible text node ≤ 40 chars → `document.title`. Labels derived from `document.title` remain "fallback" labels and never create graph edges.

## 6. Comment workflow

### 6.1 Sorting and filtering (sidebar)

Sort control: **Newest (default) · Oldest · Unread first · By screen**. "By screen" keeps the v1 "On this screen / Other screens" groups; other sorts are flat lists. Persisted per browser (`fp_sort`).

Filter chips (designer only): **All · Client · Team**. Status filter replaces the v1 Open/Resolved segment: **Open · In progress · Done · Won't do · All**.

### 6.2 Numbering

`n` is assigned server-side on create: `max(n) + 1` over the fresh reconstruct. Deterministic collision repair in `assemble()`: threads sharing `n` are ordered by `createdAt`; later ones are renumbered to the next free integer. Numbers are global (client sees gaps) so both roles name the same comment the same way. Legacy threads without `n` get numbers by `createdAt` order on first rebuild (one-time, stored as `state` events).

Shown on the pin (replaces the author initial when the pin is ≥ 24 px; initial moves into the popover), in sidebar rows, in previews, and in the thread header.

### 6.3 Status

`state` event gains `status: 'open' | 'progress' | 'done' | 'wont'` and optional `note` (required, ≤ 200 chars, for `wont`). `resolved` is derived: `status ∈ {done, wont}`; legacy `{resolved:true}` events map to `done`. Both roles may set `open` ↔ `done`; `progress` and `wont` are designer-only (server-enforced). Status is shown as a chip in the thread header; the popover renders each `state` event as a system line in the thread ("Dmytro marked as In progress") — no extra message is written.

### 6.4 Kind

`kind: 'bug' | 'question' | 'idea' | null`, set at create via three optional chips in the composer, changeable later by the designer (`state` event with `kind`). Rendered as a small icon before the number.

### 6.5 Reactions

Event `{ type:'react', target: msg.at, emoji, on }` (author from session). Palette: 👍 ✅ ❓ 👀 — four, fixed **(assumed)**. Toggling posts on/off. Rendered under the message as chips with counts; own reactions highlighted.

### 6.6 What's new since my last visit

Client-side, like read state: `fp_last_visit` = timestamp of the previous session start. "New" = threads created, messages, status changes and reactions with `at > lastVisit` not authored by me, plus screens whose first-seen `at` in `navsnap` > lastVisit. Surfaced as a **"N new"** badge on the Threads button and a **"New for you"** section at the top of the sidebar for the first minute after boot (then folds into the normal list; "New" dots remain).

### 6.7 Keyboard navigation

`J` / `K` (also `]` / `[`) — next / previous comment by `n` within the current filter; runs `goTo`. Works with the popover open; announces "3 of 14" in a small counter in the popover header.

### 6.8 Versions

Version id = `ETag` of `HEAD /` (fallback: v1 djb2 hash of the fetched HTML). On boot the overlay posts `{ action:'version', id }`; the server appends `versions/<ts>-<id>.json` on first sight and rebuilds `versions.json` (`[{ id, firstSeen, label? }]`). Designer can label a version from the Versions panel (`state`-like event). Thread header keeps the "Older version" badge and gains the version's label/date on hover; the Versions panel lists versions with comment counts and lets you filter the sidebar to one version.

## 7. Overlay UI

### 7.1 Toolbar

`grip · Comment (C) · Threads (N badge / "N new") · Map (M) · eye · avatar`. Design tokens unchanged (Geist, near-black on white, auto-dark). Layout and micro-interactions are built with the `impeccable` and `design-taste-frontend` skills loaded; contrast AA checked before shipping.

### 7.2 Presentation mode — H

`H` hides toolbar, pins, popover and sidebar together, remembering what was open; `H` again restores it. A 6 px, 40 %-opacity dot stays in the toolbar's corner as the way back (click = restore). First-time toast "Hidden — press H to bring comments back". The eye button still toggles pins alone.

### 7.3 Sidebar

Header: title, sort control, "Mark all read". Chips row: role filter (designer) · status filter. Sections per 6.1/6.6. Row: `#n · kind icon · avatar · name · role badge · status chip · time · unread dot`, excerpt, reply count, `in: <container>` when applicable, **preview thumbnail** on hover (7.4).

### 7.4 Preview card (hover / touch button)

Card = thread thumbnail (viewport capture with a pin marker, §8.1) + first message + status. Desktop: appears after 350 ms hover to the left of the sidebar; touch: a small "eye" button on the row opens it as a sheet. Click on the thumbnail = zoom (full-size image in a lightbox).

### 7.5 Map panel — M

Full-screen panel inside the shadow root, mounted on open only. Content: nodes (screens) laid out in **BFS layers from the boot screen** (hand-rolled layered layout, no dagre), node = thumbnail 240×150 + label + comment count (open/total, per role visibility); edges = SVG cubic curves labeled with the click text. Click node → close panel → `goTo`-style navigation to that screen. Designer edits: rename node (alias), hide node — stored in `mapmeta.json` via `action:'mapmeta'`. Nodes with no thumbnail show a neutral placeholder. Pan/zoom via wheel/drag; fit-to-view on open. Also exposed as `/map.html` later (same module) — not in this iteration.

## 8. Media

### 8.1 Thread preview capture

At comment creation, after the POST succeeds, the overlay captures the **viewport** with `modern-screenshot` (vendored into `public/`), draws the pin marker at the anchor point, downsizes to ≤ 960 px wide JPEG q0.8 (~40–80 KB), and posts `{ action:'preview', threadId, image: <base64> }`. Server: `put('previews/<tid>/<ts>.jpg', …, { access:'private' })`, then a `state` event `{ preview: pathname }`. Failure (CORS fonts/images, timeout 4 s) is silent; the row shows a placeholder. Capture runs in an idle callback so posting never waits on it.

### 8.2 Attachments in comments

Paste or drop an image into the composer; client resizes to ≤ 1600 px, JPEG q0.85, ≤ 1.5 MB; sent as base64 in the create/reply JSON (`images: [..]`, max 3). Server stores `attach/<tid>/<ts>-<i>.jpg` and records `{ img: [pathname] }` on the message. Rendered as thumbnails under the message; click = lightbox.

### 8.3 Screen shots (map)

`shots/<labelKey>/<ts>.jpg`, written by the crawler (`action:'shot'`, base64, designer only) or, as fallback, by the first thread preview taken on that screen (server copies the preview pathname into the shot index). `labelKey` = base64url(label).

## 9. Map crawler — `scripts/crawl.mjs`

Runs on the designer's machine (Playwright is a devDependency of the skill repo, not of the template):

```
node scripts/crawl.mjs <url> --password <team> --depth 4 --max-screens 60 --viewport 1280x800
```

Algorithm: login → for each known screen (BFS, starting at boot): reload, replay the path with **real mouse clicks** (`page.mouse.click` at element center), settle 1200 ms, `screenLabel()` via the overlay's exposed `window.__fp.label()`, screenshot viewport → `action:'shot'`; enumerate visible `button, a, [role=button], [role=tab], [role=menuitem]` not matching `/delete|remove|reset|sign out|log out|clear/i`, click each, and if the label changes record `action:'edge'` and enqueue. Budgeted by `--max-screens` and a 5-minute wall clock. Prints a summary (screens, edges, shots). SKILL.md adds it as an optional step after deploy ("Build the map").

## 10. Security

- Store private (Branch A) or, in Branch B, blobs remain public but pathnames gain a 128-bit random prefix per project (`<SECRET-derived>/threads/…`) so the store host alone is not enough **(assumed)**.
- Passwords: `openssl rand -hex 4` minimum (32 bits) in SKILL.md; the login handler adds a per-IP token bucket in memory (best-effort on serverless) **(assumed)**.
- `/api/file` enforces session + role visibility; no directory listing.
- Base64 uploads capped (1.5 MB per image, 3 per message); JPEG re-encoded server-side is out of scope — content-type sniffed against magic bytes before storing.
- `mapmeta`, `shot`, `version label`, `progress/wont` status: designer only, server-enforced.

## 11. Compatibility and migration

- v1 threads: no `n`, `page`, `trail`, `status`, `kind` — all derived or defaulted at rebuild; UI never assumes presence.
- v1 labels ("A" vs composite "A · B") — `labelsMatch` stays.
- `proto` badge logic unchanged (`t.proto !== state.proto`).
- Live deployments upgrade by replacing `public/overlay.*`, `api/*`, `lib/*` and running `?rebuild=1` once; the ETag nudge tells long-lived tabs to refresh.

## 12. Testing

- **Lab project**: `filepig-lab` — new Vercel project assembled from `~/filepig-prototype/public/index.html` with the v2 template and its **own** private store, seeded with a copy of the live FilePig threads (14) via a `scripts/seed.mjs` that replays events from a `GET` export of the source (designer session). The live client deployment is not touched until v2 is verified.
- **`scripts/smoke.sh <domain> <team-pass> <client-pass>`** — the SKILL step-6 checks as a script (login, roles, 401s, client isolation, file proxy 403).
- **Playwright e2e** (`tests/e2e.spec.mjs`, run against `LAB_URL`): login; create a comment inside an open dropdown → close it → ghost pin on trigger → click → dropdown reopens → real pin; one-click go-to from sidebar across screens; deep link with hash preserved; numbering stable across roles; H hides/restores everything; status/kind/reaction round-trips; client cannot see designer threads or files; map opens, node click navigates; J/K order. All interactions use real mouse coordinates (`page.mouse`), never `el.click()`.
- Unit-ish tests for pure functions (`assemble()`, numbering repair, `labelsMatch`, container detection on fixtures) with `node --test`.

## 13. Documentation

SKILL.md: modes table, storage branch outcome, `hex 4` passwords, crawl step, hand-over block mentions the map (`M`) and numbering; remove the leftover self-correction prose in step 7. README: feature list updated, no design-tool brand names. `docs/superpowers/specs/` holds this spec and the spike results.

## 14. Phasing

Each phase is its own implementation plan and ships independently to the lab project.

| Phase | Content | Depends on |
|---|---|---|
| **0 Foundation** | repo merge; pin deps; `smoke.sh`; passwords; **storage spike → decision**; snapshot layer per branch; `/api/file`; lab project + seed; e2e harness | — |
| **1 Place** | `page`+hash, container + trail, ghost pins, one-click `goTo` with replay, hash-safe deep links, screen-identity fallbacks, numbering, sort/filter, H mode, J/K | 0 |
| **2 Media** | thread preview capture, hover/touch preview card, attachments, lightbox | 0 (file proxy), 1 (rows) |
| **3 Workflow** | statuses, kinds, reactions, what's new, versions panel | 1 |
| **4 Map** | crawler, shots, map panel, mapmeta edits, SKILL step | 1, 2 (shots reuse preview pipeline) |
| **5 Critic** | code review of the whole diff; verification-before-completion; Playwright suite green on lab; docs; cut-over recipe for live deployments | all |

## 15. Assumptions taken alone (override any)

1. Reaction palette fixed to four emoji.
2. Preview = viewport, ≤ 960 px, JPEG; attachments ≤ 3 per message.
3. Map layout hand-rolled (BFS layers), no external graph library; `/map.html` deferred.
4. "What's new" stays per-browser (no server-side per-user state), consistent with read state.
5. Lab project rather than preview deployments of the live client project.
6. Branch-B fallback details (random pathname prefix, ETag/304) only if the spike fails.
