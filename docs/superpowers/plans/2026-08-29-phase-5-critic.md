# share-proto v2 — Phase 5 (Critic & release) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop on v2: apply the Phase 4 review, run one whole-diff review (v2 vs main) and a visual QA pass on the overlay, make the upgrade path for existing v1 deployments explicit, and release — `v2` becomes `main`, the old main is tagged `v1`.

**Architecture:** No new subsystems. Reviews are dispatched as read-only subagents; fixes land as small commits with the existing unit/e2e suites as the gate; visual QA uses Playwright screenshots of the fixture in light and dark themes with programmatic contrast checks (WCAG AA) on the overlay tokens.

**Tech Stack:** as before; `impeccable` + `design-taste-frontend` skills for the visual pass.

**Spec:** `docs/superpowers/specs/2026-08-29-share-proto-v2-design.md` — §14 (Phase 5), §11, §13.

## Global Constraints

- The live client deployment (`filepig-prototype-sigma`) is **not** cut over in this plan — it gets a recipe, not a deploy (client-facing change = Dmytro's call).
- Every fix keeps `npm test` and `npm run e2e` (local 15 + lab 3) green before commit.
- Docs in English, no design-tool brand names.
- Merge to `main` is fast-forward only, after the gates; tag the previous `main` as `v1` first (reversible).

---

### Task 1: Apply the Phase 4 review

- [ ] Triage the Phase 4 critic report (BUG/RISK/NIT), fix what holds, record outcomes in the Phase 4 plan's execution notes (same format as Phases 0–3). Gate: `npm test`, `npm run e2e`.

### Task 2: Visual QA of the overlay (impeccable pass)

- [ ] Load the `impeccable` and `design-taste-frontend` skills. Script `tests/visual/shots.mjs` (Playwright, fixture on :4173, not part of `npm run e2e`): capture PNGs of — toolbar; sidebar with controls, "New for you", a status tag, a kind icon; a thread popover with status menu open, a won't-do note, reactions, a system line, an attachment; the hover card; the Versions panel; the map with ≥3 nodes; presentation-mode dot — each in light and dark (`prefers-color-scheme` emulation + a dark fixture background) at 1280×800 and 390×844 (touch). Save to `docs/superpowers/visual/` (gitignored except a curated `README.md` with the final set).
- [ ] Review the screenshots against the skill guidance: hierarchy, spacing rhythm, alignment, truncation, dark-theme legibility, touch targets ≥ 34 px, no overlapping edge labels on the map at fit scale, status-chip colors readable in both themes.
- [ ] Programmatic contrast: evaluate the computed `color`/`background-color` of `.status.s-*`, `.status-tag`, `.badge`, `.num`, `.time`, `.sys-line`, `.react-chip`, `.chip`, `.ver-meta`, `.map-countline`, `.toast`, `.present-dot` against their effective backgrounds in both themes; assert ≥ 4.5:1 for text < 18 px (3:1 for ≥ 18 px bold). Fix tokens/CSS where it fails.
- [ ] Commit `"Visual QA: <what changed>"` with the curated screenshot README.

### Task 3: Whole-diff review (v2 vs main)

- [ ] Dispatch a read-only reviewer over `git diff main..v2 -- template scripts tests SKILL.md README.md` with the same brief as earlier phases plus: cross-phase regressions (Phase 0 storage discipline still intact after Phases 1–4 patches; every `mutate` patch pure; every `X-Store-Path` header set), dead code, duplicated helpers between overlay/servers, SKILL.md coherence end-to-end (a fresh agent can execute it), README accuracy against features.
- [ ] Fix, gate, commit.

### Task 4: Upgrade path and docs

- [ ] `docs/UPGRADE.md`: v1 → v2 for an existing Vercel deployment — export threads as a designer (`GET /api/comments`), create a **private** store, `scripts/seed.mjs export.json`, copy `template/` files (`api/`, `lib/`, `public/overlay.*`, `public/screenshot.js`, `.vercelignore`, `vercel.json`, `package.json`), deploy, `?rebuild=1`, run `smoke.sh`, optionally `crawl.mjs`; what changes for reviewers (numbers, statuses, map, previews) and what stays (links, passwords). Note the Worker edition (`worker/`) is v1-frozen.
- [ ] `CHANGELOG.md`: v2 summary per phase, breaking changes (private store, `resolve` still accepted), new hotkeys (M, J/K, H semantics).
- [ ] SKILL.md end-to-end read: fix ordering/wording; ensure the hand-over block mentions numbers, M, H, statuses. README "Limitations" accurate.
- [ ] Commit.

### Task 5: Release

- [ ] Final gates: `npm test`; `npm run e2e` local; lab: redeploy, `smoke.sh`, lab e2e, `?rebuild=1`, browser regression of v1 behaviour (14 legacy threads visible, go-to works, client sees 7).
- [ ] `git tag v1 main && git push origin v1`; `git checkout main && git merge --ff-only v2 && git push origin main`; back to `v2` (keep the branch).
- [ ] Update `share-proto-local` README wording if needed (already redirects). Memory: state, lab, what's next (cut-over of live FilePig awaits Dmytro; Worker port backlog).
- [ ] Final report to Dmytro: what shipped, what was verified, what is deliberately left (live cut-over, Worker edition, `/map.html`, reactions-by-name identity, e2e ordering fragility).

---

## Self-review against the spec

§14 Phase 5 items — code review of the whole diff (Task 3), verification-before-completion (Task 5 gates), Playwright green on lab (Task 5), docs (Task 4), cut-over recipe (Task 4 UPGRADE.md) — all present; visual QA added because the user's design-quality requirement (impeccable/taste, AA contrast) has not yet had a dedicated pass.
