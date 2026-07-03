---
name: share-proto
description: Publish an HTML prototype to Vercel behind a password, with a built-in comment layer (pins, threads, replies, resolve). Two passwords = two roles — designers see all comments, the client sees only client comments (enforced server-side). Use when the user wants to share a prototype for feedback, e.g. "share my prototype", "add comments to my prototype", "build share-proto for my prototype", "let the client leave comments".
---

# Share a prototype with comments

Output: a live password-protected URL + two passwords (designers / client). One shared link; the name + password entered at login decide who the person is and what they see.

The `template/` next to this file already contains the whole system — auth middleware, comments API, overlay UI. It is battle-tested; **assemble it, don't rebuild it**.

## Input cases — pick by what the user has

- **A. Local HTML file** (prototype not online yet): follow all steps below.
- **B. URL of an online prototype** (deployed anywhere, no local file): download it first — `curl -sL <url> -o /tmp/proto.html` — then follow all steps with that file. The result is a NEW protected URL; remind the user the old public URL stays open and they may want to take it down.
- **C. Local project already deployed to Vercel** (has `.vercel/` link, e.g. made by this skill earlier or a plain static deploy): install the tool in place instead of assembling fresh — copy `template/`'s `api/`, `lib/`, `middleware.js`, `vercel.json`, `package.json` deps, and `public/overlay.js`, `public/overlay.css`, `public/login.html`, `public/favicon.svg` into the project; inject the overlay tag + viewport into its HTML entry (reuse the injection logic from `assemble.py`); then continue from step 3 (secrets) in that directory. Same domain keeps working.

If it's unclear which case applies, ask one short question.

## Hard rules

- **Never rewrite `api/comments.js` storage logic.** It is append-only on purpose: Vercel Blob's CDN caches overwritten blobs for ~60s, so overwriting = replies/resolves silently reverting. Every mutation writes a new immutable blob + snapshot.
- **Never remove the overlay's anchor model** (path + tag + text-hint). Screen-hash approaches break on responsive prototypes that render different DOM per breakpoint.
- The client role must never receive designer threads from the API. If you touch the API, re-verify this before finishing.

## Steps

### 1. Preflight

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

The script copies the template, injects the overlay tag, fixes the viewport meta, and titles the login page from the prototype's `<title>`.

### 3. Link + secrets

```bash
cd ~/<name>-share
vercel link --yes --project <name>
```

Generate: `PASS_TEAM="<name>-team-$(openssl rand -hex 2)"`, `PASS_CLIENT="<name>-client-$(openssl rand -hex 2)"`, `SECRET=$(openssl rand -hex 32)`. Then for `production` and `development` (skip `preview` — it prompts interactively and isn't needed):

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
spawn vercel blob create-store <name>-comments --access public
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

If the token is missing: `vercel blob list-stores --all`, delete the orphan store with `vercel blob delete-store <id> --yes`, re-run the expect script.

**Manual fallback** (no `expect`, e.g. non-macOS, or the script keeps failing): the store can be connected in the dashboard — tell the user to open vercel.com → Storage → the `<name>-comments` store → Connect Project → pick the project, all environments. Then verify `BLOB_READ_WRITE_TOKEN` appears in `vercel env ls`.

### 5. Deploy + find the real domain

```bash
vercel deploy --prod --yes
vercel project ls   # the production domain is in this output
```

**Trap:** the domain is NOT always `<name>.vercel.app` — if the name is taken by another Vercel user you get a suffixed domain (e.g. `<name>-sigma.vercel.app`). Always take the domain from `vercel project ls` and smoke-test THAT domain, otherwise you may be testing a stranger's site.

### 6. Smoke test (curl, against the real domain)

- `GET /` without cookies → login page HTML (`protected prototype` in title)
- `POST /api/login {"password": "$PASS_TEAM"}` → `{"role":"designer"}`; wrong password → 401
- `POST /api/login {"password": "$PASS_CLIENT"}` → `{"role":"client"}`
- With designer cookie: `GET /` → prototype HTML containing `overlay.js`; `GET /api/comments` → `{"role":"designer","threads":[]}`
- `GET /api/comments` without cookie → 401
- Optional deeper check: create a comment as client, confirm designer GET returns it and that a designer-created thread is absent from client GET. Then wipe: `vercel blob empty-store --yes`.

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

- How reviewers use it: press **C** (or tap Comment) → click anywhere → type → Enter. Threads sidebar lists everything; resolve with the check icon; H hides the toolbar.
- Roles: designers see all comments; the client sees only client comments (server-enforced).
- To update the prototype later: run assemble.py again into a fresh dir? No — simpler: replace `public/index.html` with the new export, re-add the `<script src="/overlay.js" defer></script>` line before `</body>` (assemble.py's injection), then `vercel deploy --prod --yes`. Comments survive — they live in Blob, keyed to elements.
- To wipe all comments: `vercel blob empty-store --yes` from the project dir.

## Notes

- Vercel Hobby plan formally requires Pro for commercial/client work; the deploy works either way — mention it once.
- The overlay is design-neutral (near-black on white, Geist). If the prototype's brand clashes hard, you may re-tint the CSS variables at the top of `public/overlay.css` — optional, don't gold-plate.
- Multi-page prototypes (several HTML files): put extra pages in `public/` and inject the overlay tag into each; comments work per-page automatically.
