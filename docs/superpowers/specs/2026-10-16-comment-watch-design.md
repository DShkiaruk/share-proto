# Comment watch — "what's new on my prototypes" when Claude starts

Status: design, approved in conversation 2026-10-16 (Dmytro); this document
is for review before an implementation plan.

## Why

Designers learn about new comments only by opening the prototype. Comments
from clients sit unnoticed for hours. The ask: the designer who owns a
prototype hears about new comments — **without doing anything by hand**.

Options considered and rejected in the conversation (facts checked against
official docs, 2026-10-15/16):

- **A Slack bot** — real notifications, but needs a Slack admin to approve an
  app and a shared server holding its token. Rejected by the owner.
- **A Slack workflow per designer** (Workflow Builder webhook) — no admin,
  but ~5 minutes of manual setup per designer. Rejected: no manual steps.
- **Slack through the designer's own Claude** (scheduled routines + the Slack
  connector) — the connector posts *as the designer*, and Slack most likely
  does not notify people about their own messages (not stated officially; one
  community answer says so); cloud routines run at most hourly; an
  event-driven trigger needs a token created by hand on claude.ai. Rejected.

Chosen: **the designer's own Claude Code tells them, at the start of a new
session.** No Slack, no admin, no server, no manual step. Not instant: news
waits until the next session — accepted.

## Decisions (from the conversation)

| Question | Answer |
|---|---|
| Who is told | The one designer who deployed the prototype (the owner). |
| About what | New comments and replies by **anyone else** — client and team. Not the owner's own. Not status changes or reactions. |
| When | Only at the start of a **new** Claude Code session. Silent when nothing is new. |
| Manual steps | None. Everything is set up by Claude during the normal deploy (SKILL.md). |

## What the designer sees

When something is new, Claude opens its first reply in the session with:

> 📬 New on your prototypes
> **Sentinel report** — 3 from the client, 1 from the team
> · #12 Osama (client) on "Summary": "Can we move the verdict…" → <link to the comment>
> · #13 Osama (client) on "Summary": "Same for the …" → <link>
> · …and 2 more → <link to the prototype>

At most 5 lines per prototype, the newest first; the rest are counted. Each
link is the deep link the overlay already understands: the thread's own page
(`t.page`: path + hash, so multi-page and hash-routed prototypes land on the
right page) with `?comment=<id>` — built the way `deepLinkUrl()` builds it,
on the prototype's origin, never from the stored string as a URL.
After the summary has been handed to Claude, those comments count as seen.

If the hook's `systemMessage` turns out to render at session start (to be
checked, see "Unknowns"), the one-line headline is also shown there, so the
designer sees it before typing anything.

## How it works

```
deploy (SKILL.md step 7b)                       new Claude Code session
  └─ node scripts/watch.mjs add …                 └─ SessionStart hook (matcher "startup")
       ├─ writes ~/.claude/share-proto/watch.json      └─ node scripts/watch.mjs check
       └─ installs the hook once                            ├─ reads watch.json
          (merge into ~/.claude/settings.json)              ├─ GET /api/comments per prototype (parallel, ≤3 s)
                                                            ├─ diffs against lastSeen
                                                            └─ prints hook JSON → Claude
```

### `scripts/watch.mjs` — one file, zero dependencies (Node ≥ 18)

- `add <page-url> --password <team> --name <designer name> [--api <comments host>] [--room <room>] [--title <title>]`
  Signs in once to prove the password works (`POST /api/login`, the same call
  the login page makes), stores the entry, sets `lastSeen` to the newest
  timestamp already on the server — the server's clock, not the laptop's, so
  nothing old is reported and nothing new is skipped — and installs the hook
  if absent. Idempotent: adding the same
  page again updates it.
- `remove <page-url>` · `list` (title, URL, last check, last error) — for
  Claude to use when asked, never needed by the designer.
- `check` — the hook entry point. Never throws, never prints anything but the
  hook JSON (or nothing), always exits 0.

### Registry — `~/.claude/share-proto/watch.json` (mode 0600)

```json
{ "v": 1, "prototypes": [ {
  "page": "https://sentinel-competitor-report.vercel.app/",
  "api": "https://sentinel-competitor-report.vercel.app",
  "room": "", "title": "Sentinel · Competitor analysis",
  "me": "Dima", "password": "…", "token": "…", "tokenExp": 1797251596807,
  "lastSeen": 1792140000000, "lastCheck": 0, "failingSince": 0
} ] }
```

The password stays only on the designer's machine — the same machine that
already holds it in the project folder. The token (60 days, from the login
response) is reused; on 401 the script signs in again once.

### Hook — merged into `~/.claude/settings.json`

```json
{ "hooks": { "SessionStart": [ { "matcher": "startup", "hooks": [
  { "type": "command", "command": "node \"<abs path>/scripts/watch.mjs\" check", "timeout": 5 }
] } ] } }
```

- Merge, never overwrite: read, append our group only if no command already
  contains `watch.mjs check`, write back; keep a one-time backup
  `settings.json.share-proto.bak`. Refuse (and say so) if the file is not
  valid JSON.
- `startup` only — not on resume, clear, compact or fork, so a long session
  restarted from the same conversation does not repeat the news.
- The path is absolute to the skill's own `scripts/watch.mjs`. On Windows the
  same `node "<path>"` form; paths are quoted.

## What "new" means

For each thread the script can see with the designer's (team) session:

- a thread whose `createdAt > lastSeen` and whose author is not the owner →
  a new comment;
- each message with `at > lastSeen` in an older thread, not by the owner →
  a new reply.

"The owner" = `author === me && role === 'designer'`. If the designer later
comments under another name, those comments will be reported back to them —
accepted (rare, harmless).

`lastSeen` advances to the newest timestamp reported (not to "now"), so a
comment landing during the check is not skipped.

## Limits and failure handling

- **Time:** all prototypes in parallel; each request aborts at 2.5 s; the
  whole check returns by 3 s. A prototype that did not answer keeps its
  `lastSeen` and is reported next time — nothing is lost.
- **Reads:** a prototype is not read again within 5 minutes of its last check
  (several sessions opened in a row). One read per check — well inside the
  free storage tier's monthly read budget.
- **Gone prototypes:** `failingSince` records the first failure; after 30 days
  of failing the entry is removed and Claude mentions it once ("stopped
  watching X — it has not answered for a month").
- **Offline / no Node / broken registry:** the hook prints nothing and exits 0.
  A broken registry is moved aside to `watch.json.broken-<date>`.
- **Local mode** (temporary tunnel links) is never registered.

## Privacy

The summary puts comment text into the designer's Claude session, i.e. it is
sent to Anthropic like anything else in that session. For a client that was
promised its data stays inside its perimeter, the deploy step asks once
whether to watch; the answer "no" means the prototype is not registered.

## Changes to the repo

- `scripts/watch.mjs` (new) and `tests/unit/watch.test.mjs` (new).
- `SKILL.md`: step **7b. Watch for new comments** after hand-over — run
  `watch.mjs add` with the team password and the designer's name; ask the
  privacy question when the client has data restrictions; mention in one line
  that Claude will say when there are new comments.
- `SKILL.md` "Updating an install": re-running `add` is safe.
- `README.md`, `CHANGELOG.md` (v2.8).
- No change to the overlay or to any of the three servers.

## Tests

Unit (`node:test`, local fixture server in-process):
- new comment / new reply by someone else → reported; the owner's own → not;
- nothing new → no output at all;
- `lastSeen` advances to the newest reported timestamp;
- one prototype times out → the others are reported, its `lastSeen` unchanged;
- 401 with a stale token → one re-login, then success;
- room prototypes (`?room=`) sign in and read their room;
- hook install: absent → added; present → untouched; other hooks kept;
  invalid JSON → refused, file unchanged;
- the output is valid hook JSON and under 10 000 characters.

End to end: the local fixture server + `watch.mjs add` + a comment posted by
another name + `watch.mjs check` → the summary names it; second `check` →
silent.

## Unknowns — checked first, before writing the script

1. Does `systemMessage` from a SessionStart hook render in the terminal and in
   the Desktop app's Code tab at session start? (Docs: "shown to the user",
   not confirmed for this event.)
2. Is there a confirmation prompt the first time a user-level hook appears?
3. Does the hook run in the VS Code extension? (Docs name terminal, IDE
   extensions, Desktop and cloud generally; VS Code not by name.)

Each is a 5-minute check on Dmytro's Claude with a throwaway hook that prints
a fixed message. The answers change only the presentation (headline before
typing or not) and the SKILL.md wording, not the design.

## Not in scope

- Instant or out-of-session notifications (Slack, email, OS popups).
- Several recipients per prototype; per-thread subscriptions.
- Status changes and reactions in the summary.
