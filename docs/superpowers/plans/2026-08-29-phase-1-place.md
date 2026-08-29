# share-proto v2 — Phase 1 (Place model) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A comment knows exactly where it lives — page (path + hash), screen, and the UI *state* (open dropdown/dialog) that produced it — and one click takes anyone there; plus the triage basics that depend on that: global numbers, sorting/filtering, J/K navigation and a clean presentation mode (H).

**Architecture:** The overlay (`template/public/overlay.js`, one IIFE in a shadow root) gains a trail ring buffer (in-screen clicks), container detection at anchor time, a four-state pin renderer (real / ghost-on-trigger / hidden / approximate), and a `goTo()` that composes page navigation → learned-graph navigation → trail replay → open. The server side is small: `n` (global number) and `trail` are stored on the creating event, numbering repair is a pure function in `lib/threads.js` shared by the Vercel API and the local `server.js`. Phase 1 e2e runs against the zero-dependency local server with a deterministic fixture prototype; the lab deployment stays the Vercel smoke target.

**Tech Stack:** vanilla JS (ES2022, no build), Node ≥ 18, `node:test`, `@playwright/test 1.62`, Vercel CLI (lab redeploy).

**Spec:** `docs/superpowers/specs/2026-08-29-share-proto-v2-design.md` — §5 (5.1–5.6), §6.1, §6.2, §6.7, §7.2; also §11 (compatibility).

## Global Constraints

- The client role must never receive designer threads from the API — re-verify after any API change (spec §1).
- v1 threads keep working: no `n`, `page`, `trail`, `container` → derived or defaulted; UI never assumes presence (spec §11).
- Never remove the overlay's anchor model (path + tag + text-hint); Phase 1 only *adds* `anchor.container` and `trail` (SKILL hard rule).
- Never rewrite the storage model (`lib/storage.js`, `lib/state.js`); Phase 1 touches only event payloads and pure logic (SKILL hard rule).
- All interactions in e2e go through real mouse coordinates (`page.mouse`), never `el.click()` (spec §12).
- Docs in English; no design-tool brand names in docs or UI copy.
- Hotkeys use `e.code` (layout-independent).
- Work on branch `v2` in `~/.claude/skills/share-proto`; commit after every task; push only when Dmytro says so.
- Lab (`https://filepig-lab.vercel.app`, passwords in `~/filepig-lab/.passwords.local`) is the only Vercel deployment this plan touches.

---

## File structure

```
template/lib/threads.js          + assignNumbers, nextNumber, sanitizeTrail; assemble reads n/trail
template/api/comments.js         create: n, trail, page(300); response unchanged
template/server.js               create: n, trail, page; numbering repair on load
scripts/seed.mjs                 writes first.n in export order (durable numbers on upgrade)
template/public/overlay.js       page helpers · screenLabel v2 · trail + container · pins v2 ·
                                 goTo/replay · sort/filter/numbers · J/K · presentation mode
template/public/overlay.css      .pin.ghost, .pin-stack, .num, .sort, .chips, .nav-pos, .present-dot
tests/unit/threads.test.mjs      numbering + trail tests
tests/fixtures/proto.html        deterministic fixture: hash router, dropdown (role=menu), dialog
tests/fixtures/serve.sh          assemble fixture → run template/server.js on :4173 with known passwords
tests/e2e/playwright.config.mjs  projects: local (webServer) + lab (LAB_URL)
tests/e2e/place.spec.mjs         Phase 1 behaviour (local project)
tests/e2e/smoke.spec.mjs         unchanged (lab project)
SKILL.md, README.md              hand-over text: numbers, H, J/K
```

---

### Task 1: Numbers and trail on the server (pure logic first)

**Files:**
- Modify: `template/lib/threads.js`
- Modify: `template/api/comments.js` (create branch)
- Modify: `template/server.js` (create branch + load)
- Modify: `scripts/seed.mjs`
- Test: `tests/unit/threads.test.mjs`

**Interfaces:**
- Produces:
  - `assignNumbers(threads) → Thread[]` — pure; keeps valid unique `n`, gives missing/duplicate ones the next free integer in `createdAt` order (later `createdAt` loses a collision).
  - `nextNumber(threads) → number` — `max(n) + 1`, ≥ 1.
  - `sanitizeTrail(raw) → TrailStep[]` where `TrailStep = { anchor: object, txt: string|null }`, ≤ 8 steps, `[]` when invalid or > 6000 chars JSON.
  - `Thread` gains `n: number` and `trail: TrailStep[]` (always present after `assemble`/`applyCreate`).
  - Create event `first` gains `n` and `trail`; `page` is now ≤ 300 chars (holds a hash).

- [ ] **Step 1: Failing tests** — append to `tests/unit/threads.test.mjs` (add `assignNumbers, nextNumber, sanitizeTrail` to the import):

```js
test('assignNumbers keeps valid numbers, fills gaps in createdAt order, resolves collisions to the later thread', () => {
  const out = assignNumbers([
    { id: 'a', createdAt: 1, n: 1 },
    { id: 'b', createdAt: 2 },            // legacy → 2
    { id: 'c', createdAt: 3, n: 4 },
    { id: 'd', createdAt: 4, n: 4 },      // collision → next free (3)
    { id: 'e', createdAt: 5, n: 0 },      // invalid → next free (5)
  ]);
  assert.deepEqual(Object.fromEntries(out.map((t) => [t.id, t.n])), { a: 1, b: 2, c: 4, d: 3, e: 5 });
});

test('nextNumber is max+1 and starts at 1', () => {
  assert.equal(nextNumber([]), 1);
  assert.equal(nextNumber([{ n: 3 }, { n: 7 }, {}]), 8);
});

test('sanitizeTrail caps to 8 steps, drops junk, rejects oversized trails', () => {
  const step = (i) => ({ anchor: { path: `p${i}` }, txt: `t${i}` });
  const ten = Array.from({ length: 10 }, (_, i) => step(i));
  const out = sanitizeTrail([...ten, 'junk', { txt: 'no anchor' }]);
  assert.equal(out.length, 8);
  assert.equal(out[0].txt, 't2');
  assert.deepEqual(sanitizeTrail('nope'), []);
  assert.deepEqual(sanitizeTrail([{ anchor: { path: 'x'.repeat(7000) }, txt: null }]), []);
});

test('assemble exposes n and trail from the creating event and numbers legacy threads', () => {
  const T2 = '22222222-2222-4222-8222-222222222222';
  const withN = ev(T2, 5, {
    type: 'msg', at: 5, author: 'Bob', role: 'designer', text: 'x',
    first: { authorRole: 'designer', screen: 'S', screenLabel: 'Home', anchor: { path: 'body' }, n: 7, trail: [{ anchor: { path: 'b' }, txt: 'Open' }] },
  });
  const threads = assemble([first(T, 1), withN]);
  const legacy = threads.find((t) => t.id === T);
  const numbered = threads.find((t) => t.id === T2);
  assert.equal(numbered.n, 7);
  assert.deepEqual(numbered.trail, [{ anchor: { path: 'b' }, txt: 'Open' }]);
  assert.equal(legacy.n, 1);
  assert.deepEqual(legacy.trail, []);
});

test('applyCreate numbers the new thread and repairs a racing duplicate', () => {
  const base = [{ id: 'a', createdAt: 1, n: 1, messages: [] }];
  const out = applyCreate(base, { id: 'b', createdAt: 2, n: 1, messages: [] });
  assert.deepEqual(out.map((t) => [t.id, t.n]), [['a', 1], ['b', 2]]);
});
```

- [ ] **Step 2: Run** `npm test` → expect 5 new failures (`assignNumbers is not a function`).

- [ ] **Step 3: Implement in `template/lib/threads.js`**

Add after `canSee`:
```js
// Global comment numbers. Valid unique numbers are kept; missing or duplicate
// ones get the next free integer in createdAt order (the later thread loses a
// collision). Called on every assemble() and applyCreate(), so a rebuild from
// events and a live patch agree.
export function assignNumbers(threads) {
  const sorted = threads.slice().sort((a, b) => a.createdAt - b.createdAt);
  const used = new Set();
  const out = new Map();
  for (const t of sorted) {
    if (Number.isInteger(t.n) && t.n > 0 && !used.has(t.n)) {
      used.add(t.n);
      out.set(t.id, t.n);
    }
  }
  let next = 1;
  for (const t of sorted) {
    if (out.has(t.id)) continue;
    while (used.has(next)) next++;
    used.add(next);
    out.set(t.id, next);
  }
  return threads.map((t) => (out.get(t.id) === t.n ? t : { ...t, n: out.get(t.id) }));
}

export const nextNumber = (threads) =>
  threads.reduce((m, t) => Math.max(m, Number.isInteger(t.n) ? t.n : 0), 0) + 1;

// The in-screen clicks that produced the commented state (opened a menu, a
// dialog…). Replayed by "Go to comment". Untrusted input → shape-checked.
export function sanitizeTrail(raw) {
  if (!Array.isArray(raw)) return [];
  const out = raw
    .slice(-8)
    .filter((s) => s && typeof s === 'object' && s.anchor && typeof s.anchor === 'object')
    .map((s) => ({ anchor: s.anchor, txt: typeof s.txt === 'string' ? s.txt.slice(0, 60) : null }));
  return JSON.stringify(out).length > 6000 ? [] : out;
}
```
In `assemble()` thread literal add `n: Number.isInteger(firstMsg.first.n) ? firstMsg.first.n : null,` and `trail: sanitizeTrail(firstMsg.first.trail),`; replace the final two lines with:
```js
  threads.sort((a, b) => a.createdAt - b.createdAt);
  return assignNumbers(threads);
```
Replace `applyCreate`:
```js
export const applyCreate = (threads, thread) =>
  threads.some((t) => t.id === thread.id) ? threads : assignNumbers([...threads, thread]);
```

- [ ] **Step 4: `template/api/comments.js` create branch** — import `nextNumber, sanitizeTrail` and change the create block to:
```js
  if (action === 'create') {
    const text = clean(body.text, MAX_TEXT);
    if (!text) return res.status(400).json({ error: 'Missing text' });
    const tid = uuid();
    // The number is taken from the state we can see now and persisted on the
    // event; assignNumbers() in the patch (and in any rebuild) repairs a race.
    const { state: before } = await store.loadState(root);
    const first = {
      authorRole: role,
      screen: clean(body.screen, 64),
      screenLabel: clean(body.screenLabel, 120),
      anchor: body.anchor && typeof body.anchor === 'object' ? body.anchor : null,
      proto: clean(body.proto, 64) || null,
      page: clean(body.page, 300) || null,
      n: nextNumber(before.threads),
      trail: sanitizeTrail(body.trail),
    };
    if (JSON.stringify(first.anchor || {}).length > 4000) return res.status(400).json({ error: 'Anchor too large' });
    const thread = { id: tid, createdAt: now, author, ...first, resolved: false, messages: [{ author, role, text, at: now }] };
    await storage.appendEvent(eventPath(tid), { type: 'msg', at: now, author, role, text, first });
    const { state, path } = await store.mutate(root, (s) => ({ threads: applyCreate(s.threads, thread) }));
    res.setHeader('X-Store-Path', path);
    return res.status(200).json({ thread: state.threads.find((t) => t.id === tid) });
  }
```

- [ ] **Step 5: `template/server.js`** — after the `cors.js` import add `const { assignNumbers, nextNumber, sanitizeTrail } = await import('./lib/threads.js');`. After the store is loaded (right after the `try { … } catch { /* first run */ }` that fills `store`), add:
```js
// Numbers are global per room; legacy threads get theirs in createdAt order.
for (const room of Object.values(store.rooms)) room.threads = assignNumbers(room.threads || []);
```
In `apiComments` create: `page: clean(body.page, 300) || null,` and add `n: nextNumber(S.threads), trail: sanitizeTrail(body.trail),` to the thread literal; after `S.threads.push(thread);` add `S.threads = assignNumbers(S.threads);` and respond with `S.threads.find((t) => t.id === thread.id)`.
(Delete the local `clean`/`canSee` duplicates in `server.js` and import them from `./lib/threads.js` too — same names, same behaviour.)

- [ ] **Step 6: `scripts/seed.mjs`** — the export is in `createdAt` order; number it: change the thread loop to `for (const [i, t] of data.threads.entries())` and add `n: Number.isInteger(t.n) ? t.n : i + 1, trail: Array.isArray(t.trail) ? t.trail : []` inside `first`.

- [ ] **Step 7: Verify** — `npm test` → all green (23); `node --check template/api/comments.js template/server.js scripts/seed.mjs`.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "Global comment numbers and state trail on the creating event (API, local server, seed)"`

---

### Task 2: Overlay — page identity with hash, deep links that keep the hash

**Files:**
- Modify: `template/public/overlay.js` — `onThisScreen` (≈351), copy-link (≈858), `autoNavigate` page branch (≈1181), boot deep-link (≈1585), create payload in `openComposer` (≈805)

**Interfaces:**
- Produces (module-scope helpers): `currentPage() → string` (`pathname + hash`), `splitPage(p) → {path, hash}`, `pageMatches(tPage) → boolean`, `deepLinkUrl(t) → string`.

- [ ] **Step 1: Add helpers** right above `labelsMatch`:
```js
  /* ---------- page identity ---------- */

  // A page is pathname + hash: hash routers ("#/settings") are pages too.
  const currentPage = () => location.pathname + location.hash;
  const splitPage = (p) => {
    const i = p.indexOf('#');
    return i < 0 ? { path: p, hash: '' } : { path: p.slice(0, i), hash: p.slice(i) };
  };
  // Legacy threads stored pathname only → match on pathname alone.
  function pageMatches(tPage) {
    if (!tPage) return true;
    const { path, hash } = splitPage(tPage);
    if (path !== location.pathname) return false;
    return !hash || hash === location.hash;
  }
  function deepLinkUrl(t) {
    const { path, hash } = splitPage(t.page || location.pathname);
    const u = new URL(path || '/', location.origin);
    u.searchParams.set('comment', t.id);
    u.hash = hash;
    return u.href;
  }
```

- [ ] **Step 2: Use them**
  - `onThisScreen`: `(t) => pageMatches(t.page) && (!t.screenLabel || labelsMatch(t.screenLabel, state.screen))`.
  - Copy-link handler: `const url = deepLinkUrl(t);`.
  - `autoNavigate` first branch: `if (!pageMatches(t.page)) { toastSticky('Taking you to the comment…'); location.href = deepLinkUrl(t); return; }`.
  - Boot deep link:
    ```js
    const bootUrl = new URL(location.href);
    const deepLink = bootUrl.searchParams.get('comment');
    if (deepLink) {
      // Strip only our param — hash routers and the prototype's own query survive.
      bootUrl.searchParams.delete('comment');
      history.replaceState(null, '', bootUrl.pathname + bootUrl.search + bootUrl.hash);
    }
    ```
  - `openComposer` create payload: add `page: currentPage(),` (the `trail` field is added in Task 4).

- [ ] **Step 3: Verify** — `node --check template/public/overlay.js`; open the lab in a browser (`vercel dev` is not needed — the assembled fixture in Task 9 will exercise this; for now only the syntax check).

- [ ] **Step 4: Commit** — `git commit -am "Overlay: page = pathname + hash; deep links keep the hash and foreign query params"`

---

### Task 3: Overlay — screen identity fallbacks

**Files:**
- Modify: `template/public/overlay.js` `screenLabel()` (≈226–238)

- [ ] **Step 1: Replace `screenLabel`**
```js
  // Screen identity, in order of trust: an explicit [data-screen] tag on the
  // app root (or its first child) → the first two distinct visible headings →
  // the hash route → the first short visible sub-heading-ish text → the title.
  // Only the title is a "fallback label" (never learns graph edges).
  function screenLabel() {
    const rootEl = appRoot();
    const tagged =
      rootEl.getAttribute?.('data-screen') || rootEl.firstElementChild?.getAttribute?.('data-screen');
    if (tagged && tagged.trim()) return tagged.trim().slice(0, 80);
    const parts = [];
    for (const hd of rootEl.querySelectorAll('h1, h2, h3')) {
      const t = (hd.innerText || '').trim().slice(0, 40);
      if (t && hd.getClientRects().length && !parts.includes(t)) {
        parts.push(t);
        if (parts.length === 2) break;
      }
    }
    if (parts.length) return parts.join(' · ');
    if (location.hash.length > 1) return location.hash.slice(1).slice(0, 80);
    for (const n of rootEl.querySelectorAll('h4, h5, h6, [role="heading"], legend, strong')) {
      const t = (n.innerText || '').trim();
      if (t && t.length <= 40 && n.getClientRects().length) return t;
    }
    return document.title || 'Screen';
  }
```
(`isFallbackLabel` stays as is — it compares against `document.title`.)

- [ ] **Step 2: Verify + commit** — `node --check template/public/overlay.js && git commit -am "Overlay: screen identity falls back to data-screen, hash route, sub-headings before the title"`

---

### Task 4: Overlay — trail ring buffer and container detection

**Files:**
- Modify: `template/public/overlay.js` — click capture listener (≈1065–1090), `onMutate` (≈1487), `buildAnchor` (≈265), `clickLayer` handler (≈1422), `openComposer` payload

**Interfaces:**
- Produces: module-scope `trail: TrailStep[]` (≤ 8, in-screen), `findContainer(target) → {path, role, name}|null`, `anchor.container` on new anchors, `state.draft.trail`.

- [ ] **Step 1: Trail buffer** — replace the click capture listener with:
```js
  let lastNavClick = null;
  // In-screen click trail: what the reviewer clicked since this screen appeared
  // (opened a menu, a dialog…). Stored on a comment so "Go to comment" can
  // reproduce the state. Reset on screen change, keeping the click that caused it.
  let trail = [];
  const trailStep = (anchor) => ({ anchor, txt: anchor.txt || null });
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return; // our own replays must not teach the graph or the trail
      if (e.composedPath().includes(host)) return;
      const raw = e.composedPath()[0];
      if (!(raw instanceof Element)) return;
      const target = raw.closest('button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], summary, label') || raw;
      const s = (target.textContent || '').replace(/\s+/g, ' ').trim();
      const anchor = { path: buildPath(target), t: target.tagName.toLowerCase(), txt: s && s.length <= 60 ? s : null };
      lastNavClick = { at: Date.now(), from: screenLabel(), anchor };
      trail.push(trailStep(anchor));
      if (trail.length > 8) trail.shift();
    },
    true
  );
```
In `onMutate`, inside `if (state.screen !== prevScreen && …)` block is about edges; add a separate line right after `state.screenLabel = screenLabel();`:
```js
      if (state.screen !== prevScreen) trail = lastNavClick ? [trailStep(lastNavClick.anchor)] : [];
```
(Place it *before* the existing `if (... saveEdge ...)` block so both see the same `lastNavClick`.)

- [ ] **Step 2: Container detection** — add above `buildAnchor`:
```js
  const CONTAINER_ROLES = /^(dialog|alertdialog|menu|listbox|tooltip|combobox|tree)$/;

  function firstHeadingText(n) {
    for (const h of n.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) {
      const t = (h.innerText || '').trim();
      if (t) return t.slice(0, 40);
    }
    return '';
  }

  // The overlay container (menu, dialog, popover…) that holds `target`, if any:
  // by ARIA role, by open-state convention, or by being a floating layer that
  // does not cover the whole viewport. Also: the element a trail trigger
  // aria-controls. Null for ordinary page content.
  function findContainer(target) {
    const rootEl = appRoot();
    const viewport = innerWidth * innerHeight;
    for (let n = target; n && n !== rootEl && n !== document.body; n = n.parentElement) {
      const role = n.getAttribute('role') || '';
      const byRole = CONTAINER_ROLES.test(role) || n.getAttribute('aria-modal') === 'true' || n.getAttribute('data-state') === 'open';
      let byLayer = false;
      if (!byRole) {
        const cs = getComputedStyle(n);
        if ((cs.position === 'fixed' || cs.position === 'absolute') && (parseInt(cs.zIndex, 10) || 0) >= 1) {
          const r = n.getBoundingClientRect();
          byLayer = r.width * r.height > 0 && r.width * r.height < 0.9 * viewport;
        }
      }
      if (byRole || byLayer) return describeContainer(n, role);
    }
    const last = trail.at(-1);
    if (last) {
      const trig = locateAnchor(last.anchor).el;
      const id = trig?.getAttribute('aria-controls');
      const ctl = id ? document.getElementById(id) : null;
      if (ctl && ctl.contains(target)) return describeContainer(ctl, ctl.getAttribute('role') || '');
    }
    return null;
  }

  function describeContainer(n, role) {
    const name =
      n.getAttribute('aria-label') || firstHeadingText(n) || trail.at(-1)?.txt || n.tagName.toLowerCase();
    return {
      path: buildPath(n),
      role: role || (n.getAttribute('aria-modal') === 'true' ? 'dialog' : 'layer'),
      name: name.slice(0, 60),
    };
  }
```
In `buildAnchor`, add to the returned object: `container: findContainer(target),`.

- [ ] **Step 3: Draft carries the trail** — in the `clickLayer` click handler add `trail: anchor.container ? trail.slice() : [],` to `state.draft`; in `openComposer` payload add `trail: state.draft.trail,`.

- [ ] **Step 4: Verify + commit** — `node --check template/public/overlay.js && git commit -am "Overlay: in-screen click trail and container detection on anchors"`

---

### Task 5: Overlay — four pin states (real / ghost / hidden / approximate)

**Files:**
- Modify: `template/public/overlay.js` `renderPins`/`positionPins` (≈682–725)
- Modify: `template/public/overlay.css` (after `.pin.draft` at ≈143)

**Interfaces:**
- Produces: `triggerOf(t) → {el, pos}|null`, pins carry `.ghost` and a `.pin-stack` badge; pin label is `#n` (author initial only for legacy threads without `n`… which cannot happen after Task 1, so the initial is a pure fallback).

- [ ] **Step 1: Replace `renderPins` and `positionPins`**
```js
  // The last trail click is the trigger that opened the commented state.
  function triggerOf(t) {
    const step = t.trail?.at(-1);
    if (!step) return null;
    const loc = locateAnchor(step.anchor);
    return loc.el ? loc : null;
  }

  function renderPins() {
    pinsLayer.replaceChildren();
    pinEls.clear();
    for (const t of visiblePins()) {
      const label = Number.isInteger(t.n) ? String(t.n) : t.author.charAt(0).toUpperCase();
      const p = el('button', 'pin' + (t.resolved ? ' resolved' : ''), label);
      p.style.background = pastel(t.author);
      if (isUnread(t)) p.appendChild(el('span', 'pin-dot'));
      if (t.id === state.active) p.classList.add('active');
      p.setAttribute('aria-label', `Comment #${t.n} by ${t.author}`);
      p.addEventListener('click', (e) => {
        e.stopPropagation();
        if (p.classList.contains('ghost')) goTo(t); // reopen the state, then show the real pin
        else openThread(t.id, p);
      });
      pinsLayer.appendChild(p);
      pinEls.set(t.id, p);
    }
    positionPins();
  }

  function positionPins() {
    const ghosts = new Map(); // trigger key → [pin]
    for (const [id, p] of pinEls) {
      const t = state.threads.find((x) => x.id === id);
      p.querySelector('.pin-stack')?.remove();
      if (!t || !onThisScreen(t)) {
        p.style.display = 'none';
        continue;
      }
      // 1. real: the anchored element is here. 2. ghost: it lives in a closed
      // container and the trigger is here. 3. hidden: container, no trigger.
      // 4. approximate: no container → stored document fraction (v1 rule).
      let pos = resolveAnchor(t.anchor);
      let ghost = false;
      if (!pos) {
        if (t.anchor?.container) {
          const trig = triggerOf(t);
          pos = trig?.pos || null;
          ghost = Boolean(pos);
        } else {
          pos = fracPos(t.anchor);
        }
      }
      if (!pos) {
        p.style.display = 'none';
        continue;
      }
      p.classList.toggle('ghost', ghost);
      p.style.background = ghost ? '' : pastel(t.author);
      const off = pos.x < -40 || pos.y < -40 || pos.x > innerWidth + 40 || pos.y > innerHeight + 40;
      p.style.display = off ? 'none' : '';
      p.style.left = `${pos.x}px`;
      p.style.top = `${pos.y}px`;
      if (ghost && !off) {
        const key = `${Math.round(pos.x)},${Math.round(pos.y)}`;
        (ghosts.get(key) || ghosts.set(key, []).get(key)).push(p);
      }
    }
    // Several comments behind one trigger → one ghost with a count.
    for (const pins of ghosts.values()) {
      if (pins.length < 2) continue;
      pins.slice(1).forEach((p) => (p.style.display = 'none'));
      pins[0].appendChild(el('span', 'pin-stack', String(pins.length)));
    }
    if (state.draft && draftPin) {
      draftPin.style.left = `${state.draft.x}px`;
      draftPin.style.top = `${state.draft.y}px`;
    }
  }
```
`goTo` is defined in Task 6; until then the syntax check passes (function hoisting inside the IIFE) but nothing calls it.

- [ ] **Step 2: CSS** — after `.pin.draft { … }` (the first one, ≈143):
```css
/* ghost pin: the comment sits inside a closed menu/dialog; this marks the
   trigger that opens it */
.pin.ghost {
  background: var(--surface);
  border: 1.5px dashed var(--muted-fg);
  color: var(--muted-fg);
  box-shadow: var(--shadow-sm);
}

.pin-stack {
  position: absolute;
  top: -6px;
  right: -8px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 9999px;
  background: var(--ink);
  color: var(--primary-fg);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}
```
Also make pin text tabular: in `.pin {` add `font-variant-numeric: tabular-nums;`.

- [ ] **Step 3: Verify + commit** — `node --check template/public/overlay.js && git commit -am "Overlay: numbered pins with ghost/hidden/approximate states for comments inside closed containers"`

---

### Task 6: Overlay — one-click `goTo` with trail replay

**Files:**
- Modify: `template/public/overlay.js` — `autoNavigate` (≈1177), `armGuided`/`checkPendingJump` (≈1253, 1289), sidebar row click (≈1370), popover goto-row (≈929), boot `go()` (≈1600)

**Interfaces:**
- Produces: `goTo(t)`, `openAtState(t)`, `replayTrail(t) → Promise<boolean>`, `synthClick(el)`, `waitFor(pred, ms)`. `armGuided(t, message?)`.

- [ ] **Step 1: Add above `autoNavigate`**
```js
  // Synthetic pointer sequence: many UI kits open menus on pointerdown, not click.
  function synthClick(target) {
    const r = target.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    };
    const fire = (Ctor, type, buttons) => {
      try { target.dispatchEvent(new Ctor(type, { ...base, buttons })); } catch { /* old engines */ }
    };
    fire(PointerEvent, 'pointerdown', 1);
    fire(MouseEvent, 'mousedown', 1);
    fire(PointerEvent, 'pointerup', 0);
    fire(MouseEvent, 'mouseup', 0);
    target.click();
  }

  async function waitFor(pred, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return Boolean(pred());
  }

  // Reproduce the state a comment was left in by replaying its trail until the
  // anchored element appears. Stops early at the first step that cannot be found.
  async function replayTrail(t) {
    const steps = t.trail || [];
    for (let i = 0; i < steps.length; i++) {
      if (locateAnchor(t.anchor).pos) return true;
      const loc = locateAnchor(steps[i].anchor);
      if (!loc.el) return false;
      synthClick(loc.el);
      const next = steps[i + 1];
      await waitFor(() => locateAnchor(t.anchor).pos || (next && locateAnchor(next.anchor).el), 1500);
    }
    return Boolean(locateAnchor(t.anchor).pos);
  }

  // On the right screen: reopen the state if needed, then open the thread.
  async function openAtState(t) {
    cancelJump();
    if (!locateAnchor(t.anchor).pos && t.trail?.length) {
      toastSticky('Opening the state with this comment…');
      await replayTrail(t);
      clearSticky();
      positionPins();
    }
    if (locateAnchor(t.anchor).pos || !t.anchor?.container) return jumpToThread(t);
    armGuided(t, `Open “${t.anchor.container.name || 'the menu'}” — the comment will appear there · Esc to cancel`);
  }

  // One click from anywhere: other page → other screen → closed state → pin.
  async function goTo(t) {
    if (state.presenting) togglePresent();
    if (state.pinsHidden) setPinsHidden(false);
    setSidebar(false);
    if (!pageMatches(t.page)) {
      toastSticky('Taking you to the comment…');
      location.href = deepLinkUrl(t);
      return;
    }
    if (t.screenLabel && !labelsMatch(screenLabel(), t.screenLabel)) return autoNavigate(t);
    return openAtState(t);
  }
```
(`togglePresent` and `state.presenting` arrive in Task 8; add `presenting: false,` to `state` now so the reference is defined.)

- [ ] **Step 2: Wire it**
  - In `autoNavigate`: replace `loc.el.click();` with `synthClick(loc.el);` and the success branch `jumpToThread(state.threads.find((x) => x.id === t.id) || t);` with `openAtState(state.threads.find((x) => x.id === t.id) || t);`.
  - `armGuided(t, message)`:
    ```js
    function armGuided(t, message) {
      setSidebar(false);
      state.pendingJump = t.id;
      toastSticky(message || `Navigate to “${t.screenLabel || 'the screen with this comment'}” — it will open there · Esc to cancel`);
    }
    ```
  - `checkPendingJump`: after `if (!onThisScreen(t)) return;` add `if (t.anchor?.container && !locateAnchor(t.anchor).pos) return;`.
  - Sidebar row click handler body → `goTo(t);` (drop the `if/else`).
  - Popover goto-row click → `closePopover(); goTo(t);`.
  - Boot `go()`: replace the inner `if (onThisScreen(t)) jumpToThread(t); else autoNavigate(t);` with `goTo(t);`.

- [ ] **Step 3: Verify + commit** — `node --check template/public/overlay.js && git commit -am "Overlay: one-click goTo — page, learned graph, trail replay, then the pin; pointer-sequence replay"`

---

### Task 7: Overlay — numbers in UI, sort control, role filter

**Files:**
- Modify: `template/public/overlay.js` — `state`, `visiblePins`, `renderSidebar` (≈1303–1411), `openThread` header (≈846)
- Modify: `template/public/overlay.css`

**Interfaces:**
- Produces: `state.sort ∈ 'newest'|'oldest'|'unread'|'screen'` (localStorage `fp_sort`), `state.roleFilter ∈ 'all'|'client'|'team'`, `threadsInView() → Thread[]` (status + role filter, unsorted), `sortThreads(list) → Thread[]`.

- [ ] **Step 1: State + selectors** — add to `state`: `sort: localStorage.getItem('fp_sort') || 'newest', roleFilter: 'all',`. Add after `visiblePins`' current definition (and make `visiblePins` return `threadsInView()`):
```js
  function threadsInView() {
    return state.threads.filter(
      (t) =>
        (state.filter === 'resolved' ? t.resolved : !t.resolved) &&
        (state.roleFilter === 'all' ||
          (state.roleFilter === 'client' ? t.authorRole === 'client' : t.authorRole === 'designer'))
    );
  }
  const visiblePins = () => threadsInView();

  function sortThreads(list) {
    const arr = list.slice();
    if (state.sort === 'oldest') return arr.sort((a, b) => (a.n || 0) - (b.n || 0));
    if (state.sort === 'unread') return arr.sort((a, b) => isUnread(b) - isUnread(a) || lastAt(b) - lastAt(a));
    return arr.sort((a, b) => lastAt(b) - lastAt(a)); // newest (also inside "by screen" groups)
  }
```
(Delete the old `function visiblePins() {…}`.)

- [ ] **Step 2: Sidebar** — in `renderSidebar` replace from `const seg = el('div', 'seg');` down to `addRows(elsewhere, 'Other screens');` with:
```js
    const controls = el('div', 'sb-controls');
    const seg = el('div', 'seg');
    for (const f of ['open', 'resolved']) {
      const b = el('button', state.filter === f ? 'on' : '', f === 'open' ? 'Open' : 'Resolved');
      b.addEventListener('click', () => {
        state.filter = f;
        renderSidebar();
        renderPins();
      });
      seg.appendChild(b);
    }
    const sort = el('select', 'sort');
    sort.setAttribute('aria-label', 'Sort comments');
    for (const [v, label] of [['newest', 'Newest'], ['oldest', 'Oldest'], ['unread', 'Unread first'], ['screen', 'By screen']]) {
      const o = el('option', null, label);
      o.value = v;
      o.selected = state.sort === v;
      sort.appendChild(o);
    }
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      localStorage.setItem('fp_sort', state.sort);
      renderSidebar();
    });
    controls.append(seg, sort);
    sidebar.appendChild(controls);

    if (state.role === 'designer') {
      const chips = el('div', 'chips');
      for (const [v, label] of [['all', 'All'], ['client', 'Client'], ['team', 'Team']]) {
        const c = el('button', 'chip' + (state.roleFilter === v ? ' on' : ''), label);
        c.addEventListener('click', () => {
          state.roleFilter = v;
          renderSidebar();
          renderPins();
        });
        chips.appendChild(c);
      }
      sidebar.appendChild(chips);
    }

    const list = el('div', 'sb-list');
    const match = threadsInView();

    const addRows = (items, label) => {
      if (!items.length) return;
      if (label) list.appendChild(el('div', 'sb-group', label));
      for (const t of sortThreads(items)) {
        const row = el('button', 'sb-row' + (t.resolved ? ' resolved' : '') + (isUnread(t) ? ' unread' : ''));
        const meta = el('div', 'meta');
        meta.append(el('span', 'num', `#${t.n}`), avatar(t.author, 24), el('span', 'name', t.author));
        const rb = roleBadge(t);
        if (rb) meta.appendChild(el('span', 'badge', rb));
        if (t.resolved) {
          const c = el('span', 'check-ico');
          c.append(icon('check'));
          meta.appendChild(c);
        }
        meta.appendChild(el('span', 'time', timeAgo(lastAt(t))));
        if (isUnread(t)) meta.appendChild(el('span', 'row-dot'));
        row.appendChild(meta);
        row.appendChild(el('div', 'excerpt', t.messages[0]?.text || ''));
        const extras = [];
        if (t.messages.length > 1) extras.push(`${t.messages.length - 1} ${t.messages.length === 2 ? 'reply' : 'replies'}`);
        if (t.anchor?.container?.name) extras.push(`in: ${t.anchor.container.name}`);
        if (extras.length) row.appendChild(el('div', 'replies', extras.join(' · ')));
        row.addEventListener('click', () => goTo(t));
        list.appendChild(row);
      }
    };

    if (state.sort === 'screen') {
      addRows(match.filter(onThisScreen), 'On this screen');
      addRows(match.filter((t) => !onThisScreen(t)), 'Other screens');
    } else {
      addRows(match, null);
    }
```
Keep the existing empty-state and footer code after it unchanged (it references `match`).

- [ ] **Step 3: Popover header number** — in `openThread`, change `who.append(avatar(t.author, 24), el('span', 'name', t.author));` to `who.append(el('span', 'num', \`#${t.n}\`), avatar(t.author, 24), el('span', 'name', t.author));`.

- [ ] **Step 4: CSS** — append near the sidebar rules:
```css
.sb-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 16px 4px;
}
.sb-controls .seg { margin: 0; flex: 1; }
.sort {
  font: inherit;
  font-size: 12px;
  color: var(--ink);
  background: var(--muted);
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 6px 8px;
  cursor: pointer;
}
.sort:focus-visible { outline: 2px solid var(--ring); }
.chips {
  display: flex;
  gap: 6px;
  padding: 6px 16px 0;
}
.chip {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 9999px;
  border: 1px solid var(--border);
  color: var(--muted-fg);
}
.chip.on {
  color: var(--primary-fg);
  background: var(--primary);
  border-color: var(--primary);
}
.num {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--muted-fg);
}
```

- [ ] **Step 5: Verify + commit** — `node --check template/public/overlay.js && git commit -am "Overlay: comment numbers in rows and headers; Newest/Oldest/Unread/By-screen sort; Client/Team filter for designers"`

---

### Task 8: Overlay — J/K navigation and presentation mode (H)

**Files:**
- Modify: `template/public/overlay.js` — keydown handler (≈1454), `toggleToolbar` (≈1448), `setMode`, `openThread` header
- Modify: `template/public/overlay.css`

- [ ] **Step 1: Presentation mode** — replace `toggleToolbar` with:
```js
  // H = presentation mode: toolbar, pins, popover and sidebar all go; a faint
  // dot stays as the way back. Restores what was open.
  let presentSaved = null;
  let presentDot = null;
  function togglePresent() {
    state.presenting = !state.presenting;
    if (state.presenting) {
      presentSaved = { sidebar: state.sidebar };
      closePopover();
      cancelDraft();
      if (state.mode) setMode(false);
      if (state.sidebar) setSidebar(false);
      toolbar.style.display = 'none';
      pinsLayer.style.display = 'none';
      presentDot = el('button', 'present-dot');
      presentDot.title = 'Show comments (H)';
      presentDot.setAttribute('aria-label', 'Show comments');
      presentDot.addEventListener('click', togglePresent);
      root.appendChild(presentDot);
      let hinted = false;
      try { hinted = sessionStorage.getItem('fp_present_hint') === '1'; sessionStorage.setItem('fp_present_hint', '1'); } catch {}
      if (!hinted) toast('Hidden — press H to bring comments back', 4000);
    } else {
      presentDot?.remove();
      presentDot = null;
      toolbar.style.display = '';
      pinsLayer.style.display = state.pinsHidden ? 'none' : '';
      if (presentSaved?.sidebar) setSidebar(true);
      presentSaved = null;
      renderAll();
    }
  }
```
In `setMode(on)`, first line: `if (on && state.presenting) togglePresent();`.

- [ ] **Step 2: J/K** — add above the keydown handler:
```js
  // J/K (or ] [): walk comments by number within the current filter.
  function stepThread(dir) {
    const list = threadsInView().slice().sort((a, b) => (a.n || 0) - (b.n || 0));
    if (!list.length) return;
    let i = list.findIndex((t) => t.id === state.active);
    if (i < 0) i = dir > 0 ? -1 : list.length;
    i = (i + dir + list.length) % list.length;
    goTo(list[i]);
  }
```
Replace the tail of the keydown handler:
```js
    if (e.code === 'KeyC') setMode(!state.mode);
    else if (e.code === 'KeyH') togglePresent();
    else if (e.code === 'KeyJ' || e.code === 'BracketRight') stepThread(1);
    else if (e.code === 'KeyK' || e.code === 'BracketLeft') stepThread(-1);
```
In `openThread`, after the `.num` span, add the position counter:
```js
    const ordered = threadsInView().slice().sort((a, b) => (a.n || 0) - (b.n || 0));
    const at = ordered.findIndex((x) => x.id === t.id);
    if (at >= 0) who.appendChild(el('span', 'nav-pos', `${at + 1} of ${ordered.length}`));
```
Update the grip tooltip: `'Drag to move · double-click to reset · H hides comments · J/K next/previous'`.

- [ ] **Step 3: CSS**
```css
.present-dot {
  position: fixed;
  right: 10px;
  bottom: 10px;
  width: 6px;
  height: 6px;
  padding: 8px;               /* 22px hit area around a 6px dot */
  box-sizing: content-box;
  border-radius: 9999px;
  background: var(--ink);
  background-clip: content-box;
  opacity: 0.4;
  pointer-events: auto;
  transition: opacity 150ms var(--ease);
}
.present-dot:hover { opacity: 0.9; }
.nav-pos {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted-fg);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 4: Verify + commit** — `node --check template/public/overlay.js && git commit -am "Overlay: H presentation mode with a return dot; J/K walk comments by number"`

---

### Task 9: Fixture prototype + local-mode e2e project

**Files:**
- Create: `tests/fixtures/proto.html`, `tests/fixtures/serve.sh`
- Modify: `tests/e2e/playwright.config.mjs`, `.gitignore` (+ `tests/fixtures/site/`)

**Interfaces:**
- Produces: `npm run e2e` runs project `local` (fixture on `http://localhost:4173`, passwords `team-e2e` / `client-e2e`) and, when `LAB_URL` is set, project `lab` (`smoke.spec.mjs` only). Helpers unchanged; `login()` works on both (same login.html).

- [ ] **Step 1: Fixture** — `tests/fixtures/proto.html`:
```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Fixture</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; }
  header { display: flex; gap: 16px; padding: 16px; border-bottom: 1px solid #ddd; }
  main { padding: 24px; }
  .menu { position: absolute; z-index: 10; margin-top: 4px; background: #fff; border: 1px solid #ccc; padding: 6px; width: 160px; }
  .menu button { display: block; width: 100%; text-align: left; padding: 8px; background: none; border: 0; }
  dialog { border: 1px solid #999; padding: 24px; }
  section[hidden] { display: none; }
</style>
</head>
<body>
<div id="root">
  <header>
    <a href="#/home">Home</a>
    <a href="#/settings">Settings</a>
  </header>
  <main>
    <section data-route="home">
      <h1>Home</h1>
      <p>Welcome to the fixture prototype.</p>
      <div style="position: relative">
        <button id="sort-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="sort-menu">Sort</button>
        <div id="sort-menu" class="menu" role="menu" aria-label="Sort menu" hidden>
          <button role="menuitem">Name</button>
          <button role="menuitem">Price</button>
          <button role="menuitem">Date</button>
        </div>
      </div>
      <p><button id="open-dialog">Open dialog</button></p>
      <dialog id="dlg"><h2>Confirm</h2><p>Dialog body text.</p><button id="dlg-close">Close</button></dialog>
    </section>
    <section data-route="settings" hidden>
      <h1>Settings</h1>
      <p>Toggle things here.</p>
      <label><input type="checkbox" /> Email me</label>
    </section>
  </main>
</div>
<script>
  const route = () => {
    const r = (location.hash.replace('#/', '') || 'home');
    document.querySelectorAll('section[data-route]').forEach((s) => (s.hidden = s.dataset.route !== r));
  };
  addEventListener('hashchange', route); route();
  const btn = document.getElementById('sort-btn'), menu = document.getElementById('sort-menu');
  const setMenu = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); setMenu(menu.hidden); });
  menu.addEventListener('click', () => setMenu(false));
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) setMenu(false); });
  document.getElementById('open-dialog').addEventListener('click', () => document.getElementById('dlg').showModal());
  document.getElementById('dlg-close').addEventListener('click', () => document.getElementById('dlg').close());
</script>
</body>
</html>
```
(The menu opens on **pointerdown** on purpose — that is what `synthClick`'s pointer sequence must handle.)

- [ ] **Step 2: Server script** — `tests/fixtures/serve.sh`:
```bash
#!/usr/bin/env bash
# Assemble the fixture with the current template and serve it with the local
# server on :4173 using known passwords. Used by Playwright's webServer.
set -euo pipefail
cd "$(dirname "$0")/../.."
rm -rf tests/fixtures/site
python3 scripts/assemble.py tests/fixtures/proto.html tests/fixtures/site >/dev/null
cd tests/fixtures/site
rm -rf data
DESIGNER_PASSWORD=team-e2e CLIENT_PASSWORD=client-e2e SESSION_SECRET=e2e-secret exec node server.js --port 4173
```
`chmod +x tests/fixtures/serve.sh`; add `tests/fixtures/site/` to `.gitignore`.

- [ ] **Step 3: Config** — replace `tests/e2e/playwright.config.mjs`:
```js
import { defineConfig } from '@playwright/test';

const projects = [
  {
    name: 'local',
    testMatch: /place\.spec\.mjs/,
    use: { baseURL: 'http://localhost:4173', viewport: { width: 1280, height: 800 } },
  },
];
if (process.env.LAB_URL) {
  projects.push({
    name: 'lab',
    testMatch: /smoke\.spec\.mjs/,
    use: { baseURL: process.env.LAB_URL, viewport: { width: 1280, height: 800 } },
  });
}

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: 0,
  use: { trace: 'retain-on-failure' },
  reporter: [['list']],
  projects,
  webServer: {
    command: 'bash tests/fixtures/serve.sh',
    url: 'http://localhost:4173/login.html',
    reuseExistingServer: false,
    timeout: 30_000,
    cwd: new URL('../..', import.meta.url).pathname,
  },
});
```
`requireEnv()` in `helpers.mjs` must only run for the lab project — change `smoke.spec.mjs` to keep `requireEnv()` and remove any env assertion from shared code (there is none besides that call).

- [ ] **Step 4: Check the local server accepts the cookie over http** — `template/server.js` `setSessionCookie` (≈154): confirm it omits `Secure` when the request is plain http (look for `x-forwarded-proto`/`Secure` logic). If it always sets `Secure`, Chromium still accepts Secure cookies for `localhost`, so nothing to change; note the finding in the commit message.

- [ ] **Step 5: Smoke the harness** — `bash tests/fixtures/serve.sh &` then `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4173/login.html` → 200; kill the server. Commit: `git add -A && git commit -m "e2e: deterministic fixture prototype served by the local server; local + lab Playwright projects"`.

---

### Task 10: Phase 1 e2e — `tests/e2e/place.spec.mjs`

**Files:**
- Create: `tests/e2e/place.spec.mjs`

- [ ] **Step 1: Write the spec**
```js
import { test, expect } from '@playwright/test';
import { login, mouseClick, inOverlay, apiGet, apiPost } from './helpers.mjs';

const TEAM = 'team-e2e';
const CLIENT = 'client-e2e';

async function commentAt(page, locator, text) {
  await mouseClick(page, inOverlay(page, '.tb-btn').first());   // Comment button
  await expect(inOverlay(page, '.click-layer')).toBeVisible();
  await mouseClick(page, locator);
  const ta = inOverlay(page, '.popover textarea');
  await expect(ta).toBeVisible();
  await ta.fill(text);
  await page.keyboard.press('Enter');
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: text })).toBeVisible({ timeout: 10_000 });
  const { threads } = await apiGet(page, '/api/comments');
  return threads.find((t) => t.messages[0]?.text === text);
}

test.describe.configure({ mode: 'serial' });

test('a comment inside a dropdown gets a container + trail; closed → ghost pin; ghost click reopens it', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await mouseClick(page, page.locator('#sort-btn'));            // pointerdown opens the menu
  await expect(page.locator('#sort-menu')).toBeVisible();
  const t = await commentAt(page, page.getByRole('menuitem', { name: 'Price' }), 'inside menu');
  expect(t.anchor.container?.role).toBe('menu');
  expect(t.anchor.container?.name).toBe('Sort menu');
  expect(t.trail.length).toBeGreaterThanOrEqual(1);
  expect(t.trail.at(-1).txt).toBe('Sort');
  expect(t.page).toBe('/#/home');

  await page.keyboard.press('Escape');                          // close popover
  await page.mouse.click(600, 700);                             // outside → menu closes
  await expect(page.locator('#sort-menu')).toBeHidden();
  const ghost = inOverlay(page, '.pin.ghost');
  await expect(ghost).toHaveCount(1);
  const gb = await ghost.boundingBox();
  const bb = await page.locator('#sort-btn').boundingBox();
  expect(Math.abs(gb.x + 4 - (bb.x + bb.width / 2))).toBeLessThan(60); // sits on the trigger
  await mouseClick(page, ghost);
  await expect(page.locator('#sort-menu')).toBeVisible({ timeout: 5000 });
  await expect(inOverlay(page, '.pin:not(.ghost)')).toHaveCount(1);
  await expect(inOverlay(page, '.popover')).toBeVisible();
});

test('a comment on another hash page: sidebar row navigates there in one click; deep link keeps the hash', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await mouseClick(page, page.getByRole('link', { name: 'Settings' }));
  await expect(page.locator('section[data-route="settings"] h1')).toBeVisible();
  const t = await commentAt(page, page.locator('section[data-route="settings"] h1'), 'on settings');
  expect(t.page).toBe('/#/settings');
  expect(t.screenLabel).toBe('Settings');

  await page.goto('/#/home');
  await page.waitForSelector('[data-fp-host]');
  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1));   // Threads
  const row = inOverlay(page, '.sb-row').filter({ hasText: 'on settings' });
  await mouseClick(page, row);
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: 'on settings' })).toBeVisible({ timeout: 10_000 });

  await page.goto(`/?comment=${t.id}&keep=1#/settings`);
  await page.waitForSelector('[data-fp-host]');
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: 'on settings' })).toBeVisible({ timeout: 15_000 });
  expect(page.url()).toMatch(/\?keep=1#\/settings$/);          // only `comment` was stripped
});

test('numbers are global and identical for both roles; sorting and filters work', async ({ browser }) => {
  const designer = await browser.newPage();
  await login(designer, 'Designer', TEAM);
  const client = await browser.newPage();
  await login(client, 'Client', CLIENT);
  const c = await commentAt(client, client.locator('section[data-route="home"] h1'), 'client says hi');
  const mine = await apiGet(designer, '/api/comments');
  const all = mine.threads.map((t) => t.n).sort((a, b) => a - b);
  expect(all).toEqual([1, 2, 3]);
  expect(mine.threads.find((t) => t.id === c.id).n).toBe(3);
  const theirs = await apiGet(client, '/api/comments');
  expect(theirs.threads.map((t) => t.n)).toEqual([3]);          // gap-free for us, gaps for them: same numbers

  await mouseClick(designer, inOverlay(designer, '.tb-btn').nth(1));
  await expect(inOverlay(designer, '.sb-row .num').first()).toHaveText('#3');   // newest first
  await inOverlay(designer, 'select.sort').selectOption('oldest');
  await expect(inOverlay(designer, '.sb-row .num').first()).toHaveText('#1');
  await mouseClick(designer, inOverlay(designer, '.chip').filter({ hasText: 'Client' }));
  await expect(inOverlay(designer, '.sb-row')).toHaveCount(1);
  await expect(inOverlay(designer, '.pin')).toHaveCount(1);
  await expect(inOverlay(client, '.chips')).toHaveCount(0);      // no role filter for clients
});

test('H hides everything and the dot brings it back; J/K walk comments', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await page.mouse.click(600, 720);                             // focus the page body
  await page.keyboard.press('KeyH');
  await expect(inOverlay(page, '.toolbar')).toBeHidden();
  await expect(inOverlay(page, '.pins')).toBeHidden();
  const dot = inOverlay(page, '.present-dot');
  await expect(dot).toBeVisible();
  await mouseClick(page, dot);
  await expect(inOverlay(page, '.toolbar')).toBeVisible();

  await page.keyboard.press('KeyJ');
  await expect(inOverlay(page, '.popover .num')).toHaveText('#1', { timeout: 10_000 });
  await expect(inOverlay(page, '.popover .nav-pos')).toHaveText('1 of 3');
  await page.keyboard.press('KeyJ');
  await expect(inOverlay(page, '.popover .num')).toHaveText('#2', { timeout: 10_000 });
  await page.keyboard.press('KeyK');
  await expect(inOverlay(page, '.popover .num')).toHaveText('#1', { timeout: 10_000 });
});
```

- [ ] **Step 2: Run** — `npm run e2e` (local project only). Fix what fails in the overlay, not in the test, unless the test's assumption is wrong (e.g. a bounding-box tolerance). Expected: 4 passed.

- [ ] **Step 3: Run with the lab too** — `read LAB_TEAM LAB_CLIENT < ~/filepig-lab/.passwords.local; LAB_URL=https://filepig-lab.vercel.app LAB_TEAM=$LAB_TEAM LAB_CLIENT=$LAB_CLIENT npm run e2e` → 7 passed (lab smoke still against the Phase 0 deployment; it does not depend on Phase 1).

- [ ] **Step 4: Commit** — `git add -A && git commit -m "e2e: place model — container/ghost/replay, hash pages and deep links, numbering/sort/filter, H and J/K"`

---

### Task 11: Lab deploy, docs, memory

**Files:**
- Modify: `SKILL.md` step 7, README "How reviewers leave comments"; `~/filepig-lab` (deploy)

- [ ] **Step 1: Deploy Phase 1 to the lab**
```bash
cd ~/.claude/skills/share-proto
rsync -a template/api/ ~/filepig-lab/api/ && rsync -a template/lib/ ~/filepig-lab/lib/ && rsync -a template/public/overlay.js template/public/overlay.css ~/filepig-lab/public/
cd ~/filepig-lab && vercel deploy --prod --yes | grep Aliased
read PT PC < .passwords.local; cd ~/.claude/skills/share-proto
bash scripts/smoke.sh https://filepig-lab.vercel.app "$PT" "$PC"                       # ALL OK
curl -s -c /tmp/lab.jar -H 'Content-Type: application/json' -d "{\"password\":\"$PT\",\"name\":\"Dmytro\"}" https://filepig-lab.vercel.app/api/login >/dev/null
curl -s -b /tmp/lab.jar "https://filepig-lab.vercel.app/api/comments?rebuild=1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(sorted(t['n'] for t in d['threads']))"
```
Expected: numbers `[1..14]` on the legacy FilePig threads (seeded without `n` → numbered by `createdAt` on rebuild).

- [ ] **Step 2: Browser regression on the lab (real prototype)** — designer: sidebar rows show `#n`; sort select works; "Go to comment" from a row on another screen navigates in one click and opens the thread; H hides everything, dot restores; client: no chips, same numbers. Use a throwaway Playwright script like Phase 0's `_goto.mjs` or do it by hand; record the outcome in the commit message.

- [ ] **Step 3: Docs** — SKILL.md step 7 prose bullet "How reviewers use it": `press **C** (or tap Comment) → click anywhere → type → Enter. Every comment gets a number (#1, #2…) shared by everyone; click a comment in the Threads sidebar and the prototype takes you there — other page, other screen, even inside a closed menu. Sort by newest/oldest/unread/screen; J/K walk the comments; **H** hides everything for a clean presentation (the small dot brings it back).` README "How reviewers leave comments" — same facts, one paragraph.

- [ ] **Step 4: Memory + commit** — append to `~/.claude/projects/-Users-dimaskliaruk/memory/share_proto_skill.md`: "Фаза 1 done <date>: …, e2e local project (fixture + server.js), lab redeployed; next Phase 2 (Media)". `git add -A && git commit -m "Docs: numbers, one-click Go to comment, sort, J/K, H in SKILL and README"`.

- [ ] **Step 5: Ask Dmytro before pushing `v2`.**

---

## Self-review against the spec

- §5.1 fields → Tasks 1 (n, trail, page 300), 4 (container), 2 (page+hash). §5.2 container detection incl. aria-controls → Task 4. §5.3 trail → Task 4. §5.4 four pin states + stacked ghosts → Task 5. §5.5 goTo composition, pointer sequence, ≤1.5 s waits, guided toast with container name; deep links strip only `comment` → Tasks 6, 2. §5.6 fallbacks → Task 3. §6.1 sort + role chips + "By screen" groups + `fp_sort` → Task 7 (status filter beyond Open/Resolved is Phase 3). §6.2 numbering rules, legacy numbering, pins show number, rows/header → Tasks 1, 5, 7. §6.7 J/K + "n of N" → Task 8. §7.2 H, remembered sidebar, 6 px dot, first-time toast, eye unchanged → Task 8. §7.4 hover preview is Phase 2 (explicitly out). §11 compat → Task 1 (assemble defaults), Task 2 (`pageMatches` on legacy pathname-only pages), Task 5 (fallback initial label).
- Placeholders: none — every step carries code; "≈line" markers are locators, not TBDs.
- Names: `goTo/openAtState/replayTrail/synthClick/waitFor/triggerOf/findContainer/describeContainer/threadsInView/sortThreads/stepThread/togglePresent/pageMatches/deepLinkUrl/currentPage/splitPage/assignNumbers/nextNumber/sanitizeTrail` are used consistently across Tasks 1–10. `state.presenting` is declared in Task 6 and used in Tasks 6 and 8.
