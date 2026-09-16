---
name: share-proto
description: Share an HTML prototype (or a set of frozen snapshots of real product screens) behind a password with a built-in comment layer (pins, threads, replies, resolve, cross-page Go to comment). Two passwords = two roles — designers see all comments, the client sees only client comments (enforced server-side). Three modes: Vercel (default, private Blob store), fully local with zero dependencies (no Vercel account needed), or embed on someone else's deployment. Use when the user wants to share a prototype or screens for feedback, e.g. "share my prototype", "add comments to my prototype", "let the client leave comments".
---

# Share a prototype with comments

Output: a live password-protected URL + two passwords (designers / client). One shared link; the name + password entered at login decide who the person is and what they see.

The `template/` next to this file already contains the whole system — auth middleware, comments API, overlay UI. It is battle-tested; **assemble it, don't rebuild it**.

## Modes

| Mode | Pick when | Steps |
|---|---|---|
| **Vercel** (default) | permanent link, no infra of your own | Steps 1–7 below |
| **Local** | nothing may leave the machine / no Vercel account | "Local mode — no Vercel" |
| **Embed** | commenting on someone else's deployment (PR previews) | "Embed mode" (needs a hosted comments server: this template on Vercel, or `worker/` on Cloudflare — both speak v2, and every server announces its version so the overlay never offers what a server cannot do) |

If the user didn't say, default to Vercel and mention the other two in one line.

### Where the comments live — decide this at install time, not after

The page and the comments can be hosted apart, and on the free tiers they
should be. Vercel's Hobby plan includes **2,000 Blob advanced operations per
month, counted across the whole account, not per store** — and an upload is
one, a `list()` is one, and so is browsing the store in the dashboard. This
tool spends roughly **two of them per comment, plus one per picture and per
newly learned transition**, which works out at about four prototype reviews a
month for an entire account. Past that the store is **suspended**: not
throttled, not read-only — comments stop loading, and the room cannot even be
exported until it is lifted (Vercel says 30 days; there are reports of it
needing support to clear).

So, for anything that will see real review traffic, put the comments on a
**Cloudflare Worker** (free plan: Durable Objects with SQLite, 100,000
requests and 100,000 written rows **per day**) and keep the page wherever it
already is. That is Embed mode pointed at your own page — see "Cloudflare
Worker as the comments host", then "Embed mode" for the one tag it adds.

Vercel Blob is still the right answer for a prototype shown to one or two
people, or a review that lasts a week. Say which one you are setting up and
why, in one line, rather than choosing silently.

**The Cloudflare path has its own runbook: [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md).**
It starts from a machine with nothing installed and no Cloudflare account, names
what the person has to do in their own browser (and the words to hand them), and
ends with a verified deployment. Follow it instead of improvising — it exists
because every step that gets skipped fails later, further from the cause.

## Input cases — pick by what the user has

- **A. Local HTML file** (prototype not online yet): follow all steps below.
- **B. URL of an online prototype** (deployed anywhere, no local file): download it first — `curl -sL <url> -o /tmp/proto.html` — then follow all steps with that file. The result is a NEW protected URL; remind the user the old public URL stays open and they may want to take it down.
- **C. Local project already deployed to Vercel** (has `.vercel/` link, e.g. made by this skill earlier or a plain static deploy): install the tool in place instead of assembling fresh — copy `template/`'s `api/`, `lib/`, `middleware.js`, `vercel.json`, `.vercelignore`, `package.json` deps, and `public/overlay.js`, `public/overlay.css`, `public/screenshot.js`, `public/login.html`, `public/favicon.svg` into the project; inject the overlay tag + viewport into its HTML entry (reuse the injection logic from `assemble.py`); then continue from step 3 (secrets) in that directory. Same domain keeps working. **If the project already has a v1 (public) Blob store**, follow the upgrade paragraph in step 4 first — the v2 API reads only private stores.

- **D. A build of a real app** (many files, client-side routing — a Vite/Next static export): see "App-build case" under Local mode for the file layout; it is the same on Vercel, where client-side routes are already handled.

If it's unclear which case applies, ask one short question.

## Local mode — no Vercel

Same system without deploying anywhere: `template/server.js` (plain Node >= 18, zero npm deps — no `npm install`) replaces middleware + `api/*` + Blob with one local process. Comments live in `data/comments.json`. Pick this when the prototype must not be hosted externally (client security policy), the user has no Vercel account, or the link should exist only for the duration of the review.

1. **Assemble** as usual with `assemble.py` — but skip the `npm install` in step 2: `server.js` has no dependencies, and local mode never runs `api/*`. Then instead of steps 3–5:
2. **Run**: `cd <target-dir> && node server.js` (options: `--port <n>`, default 3456). First run generates both passwords + a session secret into `data/secrets.json` and prints them with the URL; they survive restarts. Env vars `DESIGNER_PASSWORD` / `CLIENT_PASSWORD` / `SESSION_SECRET` override.
3. **Share beyond localhost** (optional): `cloudflared tunnel --url http://localhost:3456` (`brew install cloudflared` if missing) → temporary `trycloudflare.com` URL. The link exists only while both processes run and the machine is awake — tell the user this is a feature (nothing stays hosted) and a constraint (laptop must stay on during review). Passwords still gate access; cookies work through the tunnel (`Secure` is added when `x-forwarded-proto` says https).
4. **Smoke test**: same checks as step 6 below, against `http://localhost:<port>`.
5. **Hand over**: same block as step 7 with the tunnel URL; add that comments persist in `data/comments.json` (delete the file to wipe; don't commit `data/` — it holds the passwords).

**App-build case** (the prototype is a static build of a real app, many files — e.g. a demo build with mocked APIs): assemble any placeholder HTML first, then replace `public/index.html` and add the build's assets into `public/`, keeping `overlay.js`, `overlay.css`, `login.html`, `favicon.svg` in place; inject `<script src="/overlay.js" defer></script>` before `</body>` of the build's index.html (assemble.py's injection logic). If the app routes on the client (React Router and friends), the Vercel edition already sends every extensionless path to `index.html` (`vercel.json`), and the local edition needs `node server.js --spa`. Without that, a reload on an inner screen is a 404 and the comments left there are unreachable. Never point such a build at a real backend — mock the data layer first; this server only adds the gate + comments.

## Embed mode — overlay on someone else's page

The overlay can be dropped into a page it does not serve (e.g. a client's PR
preview on S3/CloudFront) with a single tag:

```html
<script src="https://<comments-host>/overlay.js" defer></script>
```

It detects embed mode by comparing the script's origin to the page's origin.
Everything then adapts automatically:

- **API + assets** go to the script's origin (the comments host).
- **Auth** is a Bearer token (cross-site cookies don't survive): an in-overlay
  login modal appears instead of the login page; the token lives in the
  preview origin's localStorage. Login still returns `{role}` for classic
  installs — embed additionally uses the `token` field.
- **Rooms**: comments are partitioned per preview — hostname `pr-N.<domain>`
  → room `pr-n` (other hostnames slug to a room name). Query param `room=` on
  `/api/comments`; server-side storage nests under `rooms/<room>/` (Blob) or
  `store.rooms[<room>]` (local server). Classic same-origin traffic keeps the
  old paths / room `_`.
- **CORS**: the comments host must set `ALLOWED_ORIGINS` (comma-separated,
  `*` matches one hostname label run): e.g.
  `ALLOWED_ORIGINS=https://pr-*.preview.acme.com`. Unlisted origins get no
  CORS headers and the browser blocks the call. `/overlay.js`+`/overlay.css`
  are served with `Access-Control-Allow-Origin: *` (public script; the HEAD
  version-check needs it).

Deployment of the comments host is just the normal flow (Vercel steps below,
or Local mode) — the assembled `public/index.html` is irrelevant to embedded
pages; only `/overlay.js`, `/overlay.css` and `/api/*` matter. Set
`ALLOWED_ORIGINS` as an env var in both cases.

### Cloudflare Worker as the comments host

Prefer this over Vercel when the host must outlive a free Blob quota, or when
the client's CI already lives on Cloudflare. One Durable Object per room; the
same v2 API; pictures are stored in the object itself.

```bash
cd worker && npm install
npx wrangler secret put DESIGNER_PASSWORD     # then CLIENT_PASSWORD,
npx wrangler secret put SESSION_SECRET        # then ALLOWED_ORIGINS
npx wrangler deploy
```

Verify before handing the URL over: `scripts/worker-smoke.sh` runs the whole
contract against a local `wrangler dev`, and `npm run e2e:worker` runs the
embed spec — the real overlay on a foreign page — against it. On the
deployed host, open `/demo`: a fake screen with the overlay attached, so the
client can try commenting before any PR carries the tag.

### Moving a room that already exists

Comments already left somewhere else — a Vercel deployment running out of
quota, a local server, another Worker room — move across with their authors,
times, numbers, statuses, replies, reactions, trails, the theme each was left
in, the pictures and the learned map:

```bash
node scripts/move-room.mjs \
  --from https://<old-deployment> --from-password <team password> \
  --to   https://<worker-host>    --to-password   <team password> --to-room <name>
```

Add `--dry-run` first: it reads the source and prints what it found without
sending anything. The move only reads from the source, so the old link keeps
working while the new one is checked — switch the overlay tag over afterwards.
It is idempotent (the target skips threads it already has), so an interrupted
transfer is resumed by running the same command again, and it reports anything
that did not arrive rather than claiming success.

`bash scripts/move-smoke.sh` proves the whole path on two real servers before
you point it at anything that matters.

**If the source store is already suspended**, nothing can be exported from it —
that is the one case where the quota has to be lifted first (a Pro trial is the
fastest; support is the free route). Build the target and run the move the
moment it answers.

### One worker, several clients

Rooms were built for one client's many PR previews, where a single pair of
passwords over all of them is the point. Hosting rooms for **different**
clients on one worker is a different situation, and it needs `ROOM_PASSWORDS`:

```bash
npx wrangler secret put ROOM_PASSWORDS
# {"acme-app": {"designer": "…", "client": "…"}, "globex": {"designer": "…", "client": "…"}}
```

A room named there is opened by its own pair only — the deployment-wide
password is not a master key to it. Rooms not named there keep the
deployment-wide pair, so the single-client case stays as simple as it was. A
session is issued for one room and is refused by the others either way, so one
client cannot read another's comments by changing `?room=`.

Ten wrong passwords from one address lock it out for ten minutes (the counter
lives in a Durable Object, so it holds across the whole worker — the other two
editions can only count per instance).

`ROOM_MEDIA_BUDGET_MB` (default 64) caps what one room may store in pictures;
past it, uploads are refused with 507 rather than old ones being dropped. A
room written by the v1 worker upgrades itself on first load — comments,
numbers and the learned navigation are kept.

## Hard rules

- **Never rewrite the storage model in `api/comments.js` / `lib/storage.js`.** Events are append-only and are the source of truth; `state.json` is a derived document written with ETag preconditions and read with `useCache:false`. Overwriting event blobs or reading the document through the CDN cache brings back silently-reverting replies (v1 lesson) and quota-burning `list()` polls (v2 lesson).
- **Never remove the overlay's anchor model** (path + tag + text-hint). Screen-hash approaches break on responsive prototypes that render different DOM per breakpoint.
- The client role must never receive designer threads from the API. If you touch the API, re-verify this before finishing.
- **Never fork the thread rules into the Worker.** `worker/src/room.js` imports `template/lib/{threads,state,media}.js` and `worker/src/index.js` imports `template/lib/{session,cors}.js`; a copy there would drift silently and only show up as a role-leak or a lost comment. Three servers, one set of rules.

## Steps

### 1. Preflight

Run the check rather than reading down a list — it names what is missing and the
exact fix, including the steps the person has to do themselves:

```bash
bash <skill-dir>/scripts/preflight.sh            # both paths
bash <skill-dir>/scripts/preflight.sh --vercel   # page on Vercel only
bash <skill-dir>/scripts/preflight.sh --worker   # comments on Cloudflare only
```

Work down its NEED lines in order and re-run until it says "Nothing is in the
way". Everything below assumes it did.

- Locate the HTML file (from the user's message; search `~/Downloads` if they gave just a name). Confirm it contains `</body>`.
- **Node/npm**: `command -v npm` — if missing, try `brew install node` (macOS with Homebrew). No brew either → send the user to https://nodejs.org (LTS installer), wait, re-check. Don't proceed without npm.
- **Vercel CLI**: `command -v vercel || npm i -g vercel`
- **Vercel account**: `vercel whoami` — if it fails, walk the user through registration instead of just failing:
  1. Explain (in the user's language) why this is needed: Vercel is what puts the prototype online — it hosts the page, runs the password/role check, and stores the comments. Free Hobby plan is enough.
  2. Open the signup page for them: `open "https://vercel.com/signup"` — recommend continuing with Google (fastest), plan "Hobby".
  3. Once they confirm the account exists, tell them to type `! vercel login` in the prompt (login happens in their terminal + browser; you cannot do it for them).
  4. Re-run `vercel whoami` and continue only when it prints a username.
- Pick a project name: kebab-case from the file/product name, e.g. `acme-proto`. Ask only if ambiguous.

### 2. Assemble

```bash
python3 <skill-dir>/scripts/assemble.py "<prototype.html>" ~/<name>-share
cd ~/<name>-share && npm install
```

Putting the comments on a Cloudflare Worker instead of this deployment's Blob
store is a flag here, not an edit afterwards — add
`--comments https://<worker> --room <name>` and follow
[docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) for the Worker itself.

The script copies the template, injects the overlay tag, fixes the viewport meta, and titles the login page from the prototype's `<title>`.

### 3. Link + secrets

```bash
cd ~/<name>-share
vercel link --yes --project <name>
```

Generate: `PASS_TEAM="<name>-team-$(openssl rand -hex 4)"`, `PASS_CLIENT="<name>-client-$(openssl rand -hex 4)"`, `SECRET=$(openssl rand -hex 32)`. Never use fewer than 4 bytes: the prefix is guessable from the domain, so the random part is the whole password. Then for `production` and `development` (skip `preview` — it prompts interactively and isn't needed):

```bash
printf '%s' "$PASS_TEAM"   | vercel env add DESIGNER_PASSWORD production
printf '%s' "$PASS_CLIENT" | vercel env add CLIENT_PASSWORD production
printf '%s' "$SECRET"      | vercel env add SESSION_SECRET production
# repeat with `development`
```

### 4. Blob store (comments storage)

The CLI's link prompt needs a real TTY — drive it with `expect` (preinstalled on macOS):

```bash
cat > /tmp/blob-link.exp <<'EOF'
#!/usr/bin/expect -f
set timeout 60
spawn vercel blob create-store <name>-comments --access private
expect {
  -re {link this blob store.*} { send "y\r"; exp_continue }
  -re {Select environments.*} { sleep 1; send "\r"; exp_continue }
  eof { }
  timeout { exit 2 }
}
EOF
expect /tmp/blob-link.exp
vercel env ls | grep BLOB_READ_WRITE_TOKEN   # must exist before continuing
```

The store is **private**: nothing in it is readable without the project's token; comments and images are served only through the API with a valid session. Upgrading a v1 project that still has a *public* store? Export `GET /api/comments` as a designer, create a private store with the command above, replay the export with `node <skill-dir>/scripts/seed.mjs export.json` (needs `BLOB_READ_WRITE_TOKEN` from `vercel env pull`), deploy, then open `/api/comments?rebuild=1` once as a designer.

If the token is missing: `vercel blob list-stores --all`, delete the orphan store with `vercel blob delete-store <id> --yes`, re-run the expect script.

**Manual fallback** (no `expect`, e.g. non-macOS, or the script keeps failing): the store can be connected in the dashboard — tell the user to open vercel.com → Storage → the `<name>-comments` store → Connect Project → pick the project, all environments. Then verify `BLOB_READ_WRITE_TOKEN` appears in `vercel env ls`.

### 5. Deploy + find the real domain

```bash
vercel deploy --prod --yes
vercel project ls   # the production domain is in this output
```

**Trap:** the domain is NOT always `<name>.vercel.app` — if the name is taken by another Vercel user you get a suffixed domain (e.g. `<name>-sigma.vercel.app`). Always take the domain from `vercel project ls` and smoke-test THAT domain, otherwise you may be testing a stranger's site.

### 6. Smoke test (against the real domain)

```bash
bash <skill-dir>/scripts/smoke.sh https://<real-domain> "$PASS_TEAM" "$PASS_CLIENT"
```

It checks the login gate, both roles, 401s, that a designer thread is invisible to the client, and the private file proxy. It creates one thread and deletes it. Do not continue to the hand-over until it prints `ALL OK`.

### 6b. Build the map (optional, ~1–3 min)

```bash
cd <skill-dir> && npm install --silent   # once: Playwright for the crawler
node <skill-dir>/scripts/crawl.mjs https://<real-domain> --password "$PASS_TEAM"
```

It walks the prototype breadth-first with real clicks — the overlay learns the screen graph from them — and takes a shot of every screen; reviewers then press **M** for the map. It never presses controls whose text matches delete/remove/reset/sign out/log out/clear/discard, and every branch starts from a fresh load. Skip it for prototypes with other destructive buttons, or run with `--max-screens 10` first.

### 7. Hand over — REQUIRED output format

End your final message with this standout block (translated to the user's language). The link and both passwords are MANDATORY and must be visually prominent — never bury them in prose:

> ## 🔗 Share link
> **https://<real-domain>**
>
> 🔑 **Team password:** `<team password>`
> 🔑 **Client password:** `<client password>`
>
> Everyone signs in with their name — all comments are attributed.

Then briefly, in prose:

- How reviewers use it: press **C** (or tap Comment) → click anywhere → type → Enter. Every comment gets a number (#1, #2…) shared by everyone; click a comment in the Threads sidebar and the prototype takes you there — other page, other screen, even inside a closed menu. Sort by newest/oldest/unread/screen; **J**/**K** walk the comments; **H** hides everything for a clean presentation (the small dot in the corner brings it back). Each comment keeps a picture of the screen it was left on (hover a thread in the sidebar to see it); reviewers can paste, drop or attach screenshots to any message. Threads have a status — Open, In progress, Done, Won’t do (with a short reason the client sees) — a kind (bug / question / idea), and reactions; the Threads button shows what changed since your last visit, and the Versions panel lists every build the prototype has had. **M** opens a map of every screen, laid out as a flow (columns = clicks from the opening screen; screens nothing links to sit in their own band). Click a screen to go there, comment on a screen from its card, and — as a designer — give a screen a picture; screens you visit are photographed for the map on their own. A comment remembers the state of the prototype it was left in: leave one on a screen's dark version and, from the light one, its header says so and offers to switch back.
- Roles: designers see all comments; the client sees only client comments (server-enforced).
- **To update the tool itself in a project that already has it** (a newer overlay, a fixed bug): `python3 <skill>/scripts/update.py <project-dir>` — add `--dry-run` first to see what it would touch. It syncs every file the tool owns, keeps `public/index.html`, the secrets and the Vercel link, and rewrites `public/login.html` with the prototype's own name instead of the template placeholder. Then redeploy and run `scripts/smoke.sh` against the deployment. Comments, screens and the learned map survive — they live in the store, not in these files. A Worker room is a separate deployment: `cd worker && npx wrangler deploy`.
  Then check the deployment itself with Playwright, by measuring rather than by looking, and say what each check returned: dates in the comment list share one right edge (compare `right` across `.sb-row .time`); opening a comment leaves the list open and the popover clear of it; the status control is a button whose resting background matches the list's pickers; Backspace deletes in the composer and the letters `c`/`m` do not reach the prototype (it may guard keys of its own); the console stays clean and the thread count is the same before and after. Delete anything the check created. If the prototype switches theme by a class or a data attribute, leave a comment in one theme, switch to the other, and confirm the thread offers the way back and takes it — if it has no switch, say so rather than inventing the check.
- To update the prototype later: replace `public/index.html` with the new export (keep the `<script src="/overlay.js" defer></script>` line before `</body>` — assemble.py adds it if missing), then `vercel deploy --prod --yes`. Comments survive — they live in the store, keyed to elements.
- If comments ever look inconsistent after an upgrade, a designer can open `/api/comments?rebuild=1` once: it rebuilds the state document from the event log.
- To wipe all comments: `vercel blob empty-store --yes` from the project dir.

## Notes

- Vercel Hobby plan formally requires Pro for commercial/client work; the deploy works either way — mention it once.
- The overlay is design-neutral (near-black on white, the platform UI face). If the prototype's brand clashes hard, you may re-tint the CSS variables at the top of `public/overlay.css` — optional, don't gold-plate.
- The overlay learns as it is used: a comment remembers the clicks that reopen its state, and a transition remembers the clicks that make its control appear. Anything created before this version learns the first time somebody walks that path by hand — worth saying at hand-over, so "it asked me to navigate there myself" reads as one-time, not broken.
- Prototypes with a native modal (`dialog.showModal()`): while it is open the browser makes the whole page outside it inert, so the overlay cannot be clicked at all. Say so when handing over — a reviewer who tries will think the tool is broken — and tell them to comment on the control that opens it. Everything works again the moment the dialog closes, and the map still gets the dialog as a screen.
- `smoke.sh` against local mode prints `n/a` for the store-path check: that header only exists where there is a Blob-backed state document. `ALL OK` is still the bar.
- Multi-page prototypes (several HTML files): put extra pages in `public/` and inject the overlay tag into each; comments work per-page automatically. Threads remember their page (`page` field), so "Go to comment" navigates across pages by direct URL + deep link — no learned click-graph needed between files.
- Snapshot sets (frozen pages saved from a real app, e.g. SingleFile exports — scripts stripped, buttons dead): same as multi-page, plus generate a minimal neutral `index.html` listing the screens (styled like login.html), because frozen pages have no working navigation of their own. Reviewers browse via the index; "Go to comment" still teleports them directly.

## Capturing snapshots from a running app (agent recipe)

When the "prototype" is a real app running locally (a dev server) rather than an HTML file, capture the frozen snapshots yourself — do NOT ask the user to click through a browser extension manually, and do NOT tunnel/deploy/share the running app itself.

1. Get from the user: the local app URL and a test account (or ask them to log in once in the browser you drive). Propose the screen/state list yourself from the feature's code — include non-happy states (open panels, hover tooltips, validation errors, empty states), not just the default view.
2. Drive the app with Playwright (or your browser tool): arrange each state, then serialize the page to ONE self-contained HTML — inject `single-file-core` (npm: `single-file-cli`) into the page and invoke it, or an equivalent serializer that inlines CSS/images/fonts and strips scripts. `page.content()` alone is NOT enough: external CSS/asset URLs would keep pointing at the app. States that exist only as CSS `:hover` need the class/state forced onto the element before serializing.
3. Neutralize navigation in every snapshot: the serialized HTML bakes in the app's real links (`<a href>` often absolute `http://localhost:<port>/...`) and form actions — one click would dump the reviewer into the user's live dev server. Strip or replace every `href` with `javascript:void(0)` (keep the visual), remove `target`, and empty `<form action>`. Then click-sweep the saved file: no click anywhere may navigate off the page.
4. Verify every snapshot before building: renders offline (zero network requests), `grep` finds no backend/API domains, keys, or tokens in the HTML (including in leftover hrefs), and no real personal data is visible on screen (test-account data only).
5. Continue with the Snapshot sets case above (index page, assemble, local mode or Vercel).
