# Visual QA

`node tests/visual/shots.mjs` (with `bash tests/fixtures/serve.sh &` running) seeds the fixture with one of everything — a thread with a reply, a reaction, an attachment and In-progress status; a Won't-do thread with a reason; a Done thread on another route; a client thread; two screen shots; a labeled version — then captures the overlay's states and measures them.

Captured per run, in `light-desktop`, `dark-desktop` and `light-touch` (iPhone 13):

```
01-toolbar  02-sidebar  03-popover  04-status-menu  05-wont-note
06-hover-card  07-versions  08-map  09-presentation
```

The PNGs are gitignored — regenerate them rather than committing a moving target.

Machine checks in the same run (they are what a screenshot cannot prove):

- **Contrast** — every text token sampled per state against its effective background, AA thresholds (4.5:1, or 3:1 for ≥18 px / ≥14 px bold). `color-mix()` and `color(srgb …)` backgrounds are parsed; a transparent page falls back to white.
- **Truncation** — any status chip, name, map label or filter chip whose `scrollWidth` exceeds its box.
- **Theme** — the dark class is active and status chips resolve to their dark tokens.

Last full run (2026-08-29): 102 contrast samples, 0 failures; 0 clipped elements; dark chips correct.

## Fixed by this pass

- Thread header split into identity (kind · number · avatar · name · badges · actions) and a state row (status · "in: <container>" · position) — a long name no longer squeezed the status chip out, and the position counter was being clipped away entirely.
- Popover 320 → 340 px; sidebar 320 → 344 px so five status filters fit without an ellipsis.
- `--muted-fg-2` token for 11–12 px secondary text (badges, group headings, map labels, version meta): the 4.74:1 gray failed AA once nested on tinted surfaces.
- Map edge labels darkened; screen shots are now taken with the overlay hidden, so the map shows the prototype rather than the comment UI on top of it.
- The overlay's own face is the platform UI stack. It named a webfont it never loaded — a promise the CSS could not keep, and the wrong instinct for chrome that must not fight the prototype's typography.
