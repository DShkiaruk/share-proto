# What breaks, and what catches it now

Every entry here was found by a designer using the tool, not by a test. They are
written down because they were not one-off bugs: each is a **class**, and each
has a mechanism next to it that fails loudly the next time. If you are adding to
this tool, the last column is the part to keep working.

| What the person saw | The class | What catches it now |
|---|---|---|
| A reload on an inner screen gave a Vercel 404 | **Parity of the serving layer.** The local server had `--spa`; the hosted one never got it. The parity tests compared *actions*, so the gap was invisible. | The rewrite is in `template/vercel.json`, unconditional; `tests/unit/routing.test.mjs` pins it, including that assets and `/api/*` are still served as themselves |
| The password was asked for twice | **A recommended shape nobody walked end to end.** Embed mode was built for someone else's PR preview; it became the default for our own gated pages, where the second login is redundant. | `tests/e2e/bridge.spec.mjs` — a gated page on one port, its comments on another, walked as designer and as client |
| Two ways to comment on screen at once | **A UI state machine with no single owner.** `showLogin()` took the toolbar down, `showPill()` did not. | The same spec asserts the toolbar is gone whenever the panel or the pill is asking |
| The map opened on one card | **A summary that reported success after failing.** `crawl.mjs` posted every screenshot to the page's own origin — the wrong host as soon as the comments live apart — and printed a summary anyway. | It posts through the overlay (`window.__fp.api`), and exits non-zero when it learned screens and stored no pictures |
| The map was an unreadable ribbon | **A fixture too small to show the problem.** Two screens in the tests, thirty on a real console. | `tests/e2e/map.spec.mjs` seeds 24 screens one click apart and measures: every card inside the panel, and wide enough on screen to recognise |
| A deployed Worker could not be checked | **A recommended shape with no verification path.** `worker-smoke.sh` only ever booted localhost. | `scripts/smoke.sh … --room <name>` runs the same contract against a deployed host, bearer tokens and all |
| A client could read another client's room | **Authority read from the request instead of the session.** | Room-scoped tokens, `ROOM_PASSWORDS`, and the room checks in `tests/unit/room.test.mjs` |
| The preflight said "ready" while signed out | **A check that matched the wrong evidence.** `wrangler whoami` prints the word "account" either way. | It looks for the address; `bash -n` over every script is in the unit suite |

## The rule these add up to

**A configuration the runbook recommends must be a configuration the tests run
in.** Four of the eight above exist only when the page and the comments are
hosted apart, and every one of them survived until a person hit it, because the
suite only ever ran same-origin.

The second rule: **a script that summarises must not be able to summarise a
failure as a success.** `crawl.mjs` printed `shots: 0` next to `screens: 30` and
exited 0. If a number can be zero for a bad reason, say so and exit non-zero.

## Before handing a link to anyone

In this order — each one assumes the last passed.

```bash
bash scripts/smoke.sh   <url> <team> <client> [--room <name>]   # the contract, over HTTP
node scripts/crawl.mjs  <url> --password <team>                 # fills the map
node scripts/verify.mjs <url> --team <team> --client <client> \
     [--room <name>] [--deep /an/inner/path]                    # the reviewer's journey
```

`verify.mjs` is the one that would have caught every UI entry in the table. It
signs in as both roles, leaves a comment and deletes it again, and checks the
things a person notices: one sign-in, one way to comment, a comment that
survives a reload, a client who cannot read the team's, a map with pictures in
it that fits on screen. It names the fix for each failure rather than only
reporting it.
