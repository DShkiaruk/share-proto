# Comments on a Cloudflare Worker — from nothing

For the assistant running this. Everything here is executable except the two
steps a person must do in a browser; those are printed as sentences to hand
over, not as commands to run for them. Do the steps in order and do not skip
the checks — each one exists because skipping it fails later, further from the
cause.

Budget: 15 minutes, most of it waiting on the person.

## Why this path

Vercel's free plan includes **2,000 Blob write-class operations a month across
a whole account**, and this tool spends about two per comment. That is roughly
four prototype reviews a month for everything the account hosts, and past it the
store is *suspended* — comments stop loading and the room cannot even be
exported. Cloudflare's free plan gives Durable Objects with SQLite: **100,000
requests and 100,000 written rows a day**, no card asked for.

So: the page stays wherever it already is, and the comments move to a Worker.

## What the person ends up with

Be straight about this before starting, because it changes who can see what.

| | page | comments |
|---|---|---|
| **A. All on Vercel** | behind the password | Vercel Blob — free tier runs out |
| **B. Page on Vercel + comments on a Worker** | behind the password | on the Worker — no practical ceiling |
| **C. Page on any static host + comments on a Worker** | open to anyone with the link | on the Worker |

**B** is the recommended one and what the rest of this describes. The reviewer
signs in **once**: the Worker cannot see Vercel's cookie, so the gate spends the
password on both and hands the overlay its token. That only works when the two
passwords match — set them the same, as step 2 does. If the comment panel ever
asks for a password of its own, they have drifted apart; the panel is the
fallback, not the plan.

Pick **C** only when the prototype itself is not confidential.

## 1. Preflight

```bash
bash scripts/preflight.sh --worker
```

It prints, line by line, what is missing and the exact fix — node, wrangler, the
Cloudflare account. Work down the NEED lines in order and run it again until it
says "Nothing is in the way". Do not continue past it.

One line is the person's to do, and one is yours.

**Theirs: a Cloudflare account.** <https://dash.cloudflare.com/sign-up> — email
and password, free, and it does not ask for a card. Tell them what it is for: it
will hold the comments, they own it, and nothing about the prototype itself
moves there.

**Yours: signing this machine in.** Do not hand them a command to paste — run it:

```bash
bash scripts/cloudflare-login.sh
```

`wrangler login` asks nothing in the terminal. It opens their browser and waits
for the OAuth callback on localhost:8976, so the only human part is pressing
**Allow** on the page that appears. The script prints the link as well, in case
no window opened, and waits until the sign-in lands (five minutes by default).

Two cases where the callback cannot come back:

- **This is running somewhere their browser cannot reach** — a container, an SSH
  session. Use `bash scripts/cloudflare-login.sh --device`: they open a page and
  type a short code instead, and no callback is needed.
- **No browser at all** (CI, a locked-down machine). Then it is an API token:
  they make one at <https://dash.cloudflare.com/profile/api-tokens> with the
  *Edit Cloudflare Workers* template, and it goes in the environment as
  `CLOUDFLARE_API_TOKEN` — wrangler uses it and never asks to log in.

(The Vercel side is different and still needs them: `vercel login` prompts in the
terminal itself, so it stays `! vercel login`.)

## 2. Passwords and secrets

Two passwords — one for the team, one for the client — plus a session secret.
Generate them rather than inventing them:

```bash
TEAM=$(openssl rand -hex 4); CLIENT=$(openssl rand -hex 4); SECRET=$(openssl rand -hex 32)
echo "team: $TEAM   client: $CLIENT"
```

Put them in, one at a time (each opens a prompt; paste the value, press Enter):

```bash
cd worker
npx wrangler secret put DESIGNER_PASSWORD
npx wrangler secret put CLIENT_PASSWORD
npx wrangler secret put SESSION_SECRET
```

If the prototype's page lives on another origin — which it does in shapes B and
C — the Worker has to be told to accept it:

```bash
npx wrangler secret put ALLOWED_ORIGINS      # https://acme-proto.vercel.app
```

Comma-separate several. Getting this wrong shows up as comments never loading
and a CORS error in the browser console, so set it before testing, not after.

## 3. Deploy

```bash
cd worker && npm install && npx wrangler deploy
```

The last line of the output is the URL — `https://<name>.<subdomain>.workers.dev`.
Keep it; everything below needs it. Rename the worker in `wrangler.jsonc`
(`"name"`) first if the default is not what the person wants in that URL.

## 4. Check it before wiring anything to it

```bash
bash scripts/worker-smoke.sh          # the whole contract against a local wrangler dev
```

Then the same contract against the **deployed** one, in a room made for it:

```bash
bash scripts/smoke.sh https://<worker> <team password> <client password> --room smoke
```

`--room` is what makes this work on a Worker: it names the room and switches to
the bearer token the login returns, because a Worker sets no cookie. Use a
throwaway name rather than a live room — the checks delete their comments, but
the map keeps the two screens they teach it. Do not continue until it prints
`ALL OK`.

A browser pass on top, if you want to see it: open `https://<worker>/demo` — a
fake screen with the overlay on it. Sign in and leave a comment. If that works,
the Worker is done; anything that fails later is the wiring, not it.

## 5. Point the prototype at it

**A prototype not assembled yet** — say so at assembly time and there is nothing
to edit:

```bash
python3 scripts/assemble.py "<prototype.html>" ~/acme-proto \
  --comments https://<worker> --room acme-proto
```

**A prototype that already exists** — one tag in its HTML, before `</body>`,
**instead of** the local `<script src="/overlay.js">` the tool injects:

```html
<script src="https://<worker>/overlay.js" data-room="acme-proto" defer></script>
```

- `data-room` names the room. One Worker holds many; give each prototype its
  own name (kebab-case, the project's name). Without it the room is derived from
  the hostname, which is fine for PR previews and confusing for anything else.
- The overlay notices the script came from another origin and switches to embed
  mode by itself: a login modal instead of the page's cookie, and a bearer token.

Then redeploy the page however it is normally deployed (`vercel deploy --prod
--yes` for shape B).

## 6. Verify the whole thing, not just the parts

Open the prototype's real URL and, as a designer:

1. leave a comment and reload — it is still there;
2. open the comment list — it lists it;
3. open the browser console — no CORS errors (if there are, revisit
   `ALLOWED_ORIGINS` in step 2);
4. sign in as the client in a private window — they see their own comments and
   none of the team's.

## 7. If there are comments somewhere else already

```bash
node scripts/move-room.mjs \
  --from https://<old-deployment> --from-password <team password> \
  --to   https://<worker>         --to-password   <team password> --to-room acme-proto
```

`--dry-run` first. It reads only from the source, so the old link keeps working
while the new one is checked; it is idempotent, so an interrupted transfer is
resumed by running it again. Authors, times, numbers, statuses, replies,
reactions, pictures and the learned map all come across.

**If the old store is already suspended, nothing can be exported from it.** That
is the one case where the quota has to be lifted first — a Pro trial is the
fastest route, support is the free one — and the move run the moment it answers.

## 8. Hand over

Give the person: the prototype URL, the two passwords and which is which. Add
that the Worker is on **their** Cloudflare account and costs nothing at this
size. Build the map before handing it over (step 6b in SKILL.md) — on a fresh
room the map holds one screen, which reads as broken.

## More than one client on the same Worker

Rooms were built for one client's many PR previews, where one pair of passwords
over all of them is the point. If rooms on this Worker will belong to
**different** clients, give each its own pair:

```bash
npx wrangler secret put ROOM_PASSWORDS
# {"acme-proto": {"designer": "…", "client": "…"}, "globex": {"designer": "…", "client": "…"}}
```

A room named there is opened by its own pair only — the deployment-wide password
is not a master key to it. Rooms not named there keep the deployment-wide pair. A
session is issued for one room and refused by the others either way, so nobody
reads another client's comments by changing `?room=`.

## When something is wrong

| What is seen | What it is |
|---|---|
| Comments never load, console shows a CORS error | `ALLOWED_ORIGINS` does not list the page's origin. Set it and redeploy. |
| The login modal refuses a password that is right | The secret went to a different Worker, or `ROOM_PASSWORDS` names this room and the deployment-wide pair is being used. `npx wrangler secret list` shows what is set. |
| Comments load but pictures do not | Same-origin check on `/api/file` — the token is sent as a header, so a blocked request is CORS again. |
| "Not authenticated for this room" | A session from another room, or a stale tab. Reloading the page re-signs in. |
| Everything works locally, nothing on the deployed URL | `npx wrangler deploy` was not run after the last change, or secrets were put on a different account — `npx wrangler whoami`. |
