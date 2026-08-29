# share-proto

Ship any HTML prototype as a password-protected link with a built-in commenting layer: pins on the exact spot, threads, replies, resolve, unread dots, one-click "Go to comment" navigation (across pages too), dark-theme auto-matching, mobile support.

Two roles, one link: **designers see every comment, the client sees only client comments** — enforced on the server, not hidden in the UI. Everyone signs in with their name, so every comment is attributed.

Three ways to run it — same overlay, same API contract:

| Mode | When | What serves it |
|---|---|---|
| **Vercel** (default) | you want a permanent link | Vercel functions + private Blob store |
| **Local** | nothing may leave your machine, or no Vercel account | `template/server.js` (zero dependencies) + optional `cloudflared` tunnel |
| **Embed** | commenting on someone else's deployment (PR previews) | one `<script>` tag pointing at a hosted comments server (Vercel or the Cloudflare Worker in `worker/`) |

## How to use

Paste this into Claude Code:

```
Read https://github.com/DShkiaruk/share-proto and build it for my prototype
```

Then tell it where the prototype is — a local HTML file or a URL if it's already online — and, if it matters, which mode. Claude installs whatever is missing, walks you through a free Vercel signup if you need one, and finishes with **the share link and two passwords** — one for your team, one for the client.

One-time requirements: Claude Code and, for Vercel mode, a free [vercel.com](https://vercel.com) account (the agent opens signup for you, ~2 min).

## For Claude Code (agent instructions)

When a user shares this repository link and asks to build/share/publish a prototype or add commenting to one:

1. Clone the repository if it's not present locally:
   `git clone https://github.com/DShkiaruk/share-proto ~/.claude/skills/share-proto`
   (if the folder exists, update it: `git -C ~/.claude/skills/share-proto pull`)
2. Read `SKILL.md` at the repo root and follow it step by step. It covers three input cases (a local HTML file, a URL of an already-deployed prototype, a project already linked to Vercel) and three modes (Vercel, local, embed).
3. **Mandatory output**: your final message must end with the prominent block from SKILL.md step 7 — the share link and both passwords. Never bury them in prose.

## What's inside

```
SKILL.md              — the step-by-step runbook (also works as a Claude Code skill)
scripts/assemble.py   — deterministic project assembly from the template
scripts/smoke.sh      — post-deploy checks (gate, roles, isolation, file proxy)
scripts/crawl.mjs     — walks the prototype with real clicks and shoots every screen for the map
template/             — the complete system: auth middleware, comments API, overlay UI
template/server.js    — local mode server (no Vercel)
worker/               — Cloudflare Worker edition of the comments server (embed mode host)
tests/                — unit tests (node --test) and Playwright e2e against a lab deployment
```

The template is self-contained: append-only comment events in a private Blob store with a single derived state document, element-anchored pins, a shared navigation graph that powers "Go to comment", automatic dark-theme matching. Don't rewrite its internals — they encode lessons that aren't reproducible from the code alone (see "Hard rules" in SKILL.md).

## How reviewers leave comments

Sign in with a name + password (the password decides the role). Press **C** or hit Comment → click anywhere → type → Enter. Every comment gets a number (#1, #2…) that is the same for everyone, so "look at #7" works on a call. The Threads sidebar lists everything — sort by newest, oldest, unread or screen; designers can filter to client or team comments. Click a comment and the prototype takes you to it in one step: another page, another screen (the overlay learns the prototype's navigation from real clicks), even a comment left inside a dropdown or dialog — the state is reopened, and while it is closed a dashed ghost pin marks the button that opens it. **J**/**K** walk the comments, **H** hides everything for a clean presentation (a small dot in the corner brings it back). Each comment keeps a picture of the screen it was left on — hover a thread in the sidebar to see where it is — and reviewers can paste, drop or attach screenshots to any message. Threads carry a status (Open · In progress · Done · Won’t do, the last one with a short reason), a kind (bug / question / idea) and reactions; the Threads button counts what changed since your last visit, and a Versions panel lists every build with a name you give it. **M** opens a map of the prototype — every screen as a thumbnail with its comment counts and the clicks that connect them; click a screen to jump there. The map fills itself as people click around, or all at once with `scripts/crawl.mjs`. Reviewers can edit their own messages, copy a direct link to any comment, and comments left on an outdated build get an "Older version" badge.

## Limitations

- The prototype must be a self-contained HTML file (fonts/libraries from CDNs are fine).
- Vercel's free Hobby plan is formally for non-commercial use (Pro is $20/mo if needed).
- Read state is per browser; there are no notifications outside the page (deliberate).
- Comments and images live in a private Blob store; the API is the only reader.
- Comments inside UI that closes on *focus* leaving it (some component libraries) or inside a native `<dialog>` opened with `showModal()` may not be placeable — the composer needs focus, and a modal dialog makes the rest of the page inert.
- The Cloudflare Worker edition (`worker/`) still speaks the v1 API: no comment numbers, trails or previews until it is ported.

MIT
