# Upgrading a v1 deployment to v2

v2 changes how comments are stored and read (private Blob store, one state document instead of `list()` polls), so an existing v1 project on Vercel is **migrated**, not just redeployed. Comments, replies, resolves, links and both passwords survive. Budget: ~10 minutes.

Nothing here touches the reviewers' link: the domain and passwords stay the same.

## 1. Export what you have (as a designer)

```bash
D=https://<your-domain>
curl -s -c jar -H 'Content-Type: application/json' -d '{"password":"<team password>","name":"Migration"}' $D/api/login
curl -s -b jar $D/api/comments > export.json
python3 -c "import json; d=json.load(open('export.json')); print(len(d['threads']), 'threads', len(d['nav']), 'edges')"
```

## 2. Create a private store and seed it

In the project directory (the one with `.vercel/`). **Disconnect the old store first** — otherwise `BLOB_READ_WRITE_TOKEN` still points at it and the seed would write v2 events into the v1 store (silently: the rebuild then returns nothing). Dashboard → Storage → the old store → Disconnect from this project.

```bash
vercel blob create-store <name>-comments-v2 --access private   # answer "y" to link, Enter for all environments
vercel env pull .env.v2 --environment production                # brings BLOB_READ_WRITE_TOKEN of the new store
cd <skill-dir> && npm install --silent                          # once: @vercel/blob for the seed script
set -a; source <project>/.env.v2; set +a
node scripts/seed.mjs <project>/export.json                     # idempotent — safe to re-run
```

Check you pulled the new store's token before seeding: `grep BLOB_READ_WRITE_TOKEN .env.v2` must show exactly one line, and `vercel blob list-stores` should show only the new store connected to this project.

## 3. Replace the code

From `<skill-dir>/template/` copy into the project: `api/`, `lib/`, `middleware.js`, `vercel.json`, `.vercelignore`, `package.json` (then `npm install`), and `public/overlay.js`, `public/overlay.css`, `public/screenshot.js`, `public/login.html`, `public/favicon.svg`. Keep your `public/index.html` (it already has the `<script src="/overlay.js" defer>` tag).

```bash
vercel deploy --prod --yes
```

## 4. Rebuild the state document once, then check

```bash
curl -s -b jar "$D/api/comments?rebuild=1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['threads']), 'threads')"
bash <skill-dir>/scripts/smoke.sh $D "<team password>" "<client password>"   # must print ALL OK
```

Optional — fill the map: `node <skill-dir>/scripts/crawl.mjs $D --password "<team password>"` (see SKILL step 6b).

## What reviewers will notice

- Every comment has a number; the sidebar sorts and filters; clicking a comment takes you there (other page, other screen, inside a closed menu).
- Statuses (Open · In progress · Done · Won’t do), kinds, reactions, a "what's new" digest, a Versions panel.
- Pictures: each new comment keeps a preview of its screen; screenshots can be attached; **M** opens the map.
- **H** now hides everything (pins too) — the dot in the corner brings it back.

Older comments keep working; they show as an "Older version" of the prototype (their build predates version tracking) and have no preview.

## Not covered

- The Cloudflare Worker edition (`worker/`) still speaks the v1 API — do not point a v2 overlay at it until it is ported.
- Local mode (`server.js`) needs no migration: delete nothing; new fields appear as they are used.
