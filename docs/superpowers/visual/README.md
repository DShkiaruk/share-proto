# Visual QA

`node tests/visual/shots.mjs` (with `bash tests/fixtures/serve.sh &` running) seeds the fixture with one of everything — a thread with a reply, a reaction, an attachment and In-progress status; a Won't-do thread with a reason; a Done thread on another route; a client thread; two screen shots; a labeled version — then captures the overlay's states and measures them.

Captured per run, in `light-desktop`, `dark-desktop`, `light-touch` and `dark-touch` (iPhone 13):

```
01-toolbar  02-sidebar  03-popover  04-status-menu  05-wont-note
06-hover-card  07-versions  08-map  09-presentation
```

The PNGs are gitignored — regenerate them rather than committing a moving target.

Machine checks in the same run — the script **exits non-zero** when any of them fails, so it can gate:

- **Contrast** — each text token is sampled once per *distinct rendering* (colour × background × size × weight), so `.status-tag.s-done` and `.status-tag.s-wont` are both measured, not just whichever comes first. Thresholds are WCAG AA: 4.5:1, or 3:1 only for ≥24 px (≥18.66 px bold). Backgrounds are composited through the shadow boundary with real alpha, including `color-mix()`/`color(srgb …)`; SVG text is read from `fill`, not `color`.
- **Truncation** — any status chip, name, map label, filter chip, container hint or position counter whose `scrollWidth` exceeds its box.
- **Theme** — the dark class is active and status chips resolve to their dark tokens (a screenshot at 1× is not readable enough to judge an 11 px chip; this is measured).

Last full run (2026-08-31): 162 samples across four states, 0 failures, 0 clipped, dark chips correct.

What it still does not check: focus rings, motion, touch-target sizes, and anything on a screen the seeding does not produce.

## Fixed by this pass

- Thread header split into identity (kind · number · avatar · name · badges · actions) and a state row (status · "in: <container>" · position) — a long name no longer squeezed the status chip out, and the position counter was being clipped away entirely.
- Popover 320 → 340 px; sidebar 320 → 344 px so five status filters fit without an ellipsis.
- `--muted-fg-2` token for 11–12 px secondary text (badges, group headings, map labels, version meta): the 4.74:1 gray failed AA once nested on tinted surfaces.
- Map edge labels darkened; screen shots are now taken with the overlay hidden, so the map shows the prototype rather than the comment UI on top of it.
- The overlay's own face is the platform UI stack. It named a webfont it never loaded — a promise the CSS could not keep, and the wrong instinct for chrome that must not fight the prototype's typography. The login page followed (it really did load Geist from a third party, which contradicted local mode's "nothing leaves your machine").

## Fixed after review

- `.replies` was styled with the new token through a selector that lost on specificity, so the one place it mattered — a hovered sidebar row — stayed at 4.35:1.
- The probe itself was wrong three ways: it granted 3:1 to 18 px text (AA says 24 px), measured one element per selector, and read `color` on SVG text. Its alpha default was the string `'1'`, which turned the compositing sum into string concatenation — every ratio came out near 1 the moment real compositing was added. Fixed and now gating.
- The status chip could not close its own menu; the menu could open below the fold on a phone; the state row could be squeezed instead of the message list; the chip was a 23 px touch target.
