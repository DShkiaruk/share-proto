# share-proto v2 — Phase 3 (Workflow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "resolve" into a real triage loop: four statuses with a required reason for "Won't do", a comment kind (bug / question / idea), reactions, a "what's new since my last visit" digest, and a list of prototype versions with per-version labels and filtering.

**Architecture:** Everything rides on the append-only log. New event payloads — `state {status, note, author, role}`, `state {kind}`, `react {target, emoji, on}` — are folded by the pure `assemble()` into `thread.status/statusNote/kind/history[]` and `message.reactions{}`. Versions live in their own prefix (`versions/<ts>-<id>.json`) and in the state document (`versions[]`), first-seen by the overlay's boot `HEAD /` ETag. "What's new" is per browser (`fp_last_visit`), computed from timestamps already on the data. Status/kind/version-label writes are role-checked on both servers.

**Tech Stack:** vanilla JS, Node ≥ 18, `node:test`, Playwright 1.62.

**Spec:** `docs/superpowers/specs/2026-08-29-share-proto-v2-design.md` — §6.3, §6.4, §6.5, §6.6, §6.8, §6.1 (status filter), §7.3.

## Execution notes (2026-08-29)

All 5 tasks done; local e2e 12/12 (place 4, media 3, workflow 5) on the first run, lab redeployed. Deviations:
- Kind is cleared with a `kind: 'none'` state event (a JSON `null` would be indistinguishable from "no kind event").
- The Versions panel refreshes state when opened (labels set from another tab are otherwise 25 s stale); version ids are the served page's ETag with `W/` and quotes stripped, falling back to the v1 djb2 hash.
- "New for you" replaces the top of the list for 60 s after boot and pushes the rest under "Everything else"; `place.spec`'s oldest-sort assertion now skips `.new` rows.
- The v1 `resolve` action is kept and mapped to `status` events with author, so old overlays keep working against the new API.

**Critic review (post-execution) — outcomes:** BUG version id per page → `HEAD /` (one version per prototype); BUG `fp_last_visit` reset by every full load → visit = browser session (`sessionStorage.fp_session`), previous visit kept in `fp_prev_visit`; BUG status/reaction re-render wiped a half-typed reply → draft restored; BUG label editor Escape posted / Enter posted twice → `closed` flag; RISK unbounded `versions` from any role → cap 100, labels only for known ids; RISK default filter hid In-progress threads the badge counted → filter `active` (open + in progress) is the default and matches the badge; RISK legacy `v<hash>` protos → seeded as versions at rebuild (first seen = earliest comment), proto cap 80 everywhere; RISK badge outliving the 60 s window → timed re-render; RISK new screens only with new threads → shown on their own; NITs → same-status posts are no-ops (no duplicate system lines), Escape closes the won't-do note / status menu before the popover, legacy history lines read "Marked as …", controls in two rows so five status chips fit. Accepted/deferred: reactions keyed by author name only (same identity model as unread), e2e selectors that rely on ordering.

## Global Constraints

- Client role never receives designer threads (GET filter unchanged); a client may only set `open ↔ done` on threads they can see; `progress`, `wont`, kind changes, version labels are designer-only, server-enforced (spec §6.3, §6.4, §6.8).
- `resolved` stays derived (`status ∈ {done, wont}`) so v1 data, the v1 `resolve` action and every Phase 0–2 code path keep working (spec §11).
- Reaction palette fixed: 👍 ✅ ❓ 👀 (spec §15.1).
- Never rewrite the storage model; new event types only.
- e2e via real mouse; docs in English; branch `v2`, push after the phase.

---

## File structure

```
template/lib/threads.js      assemble: status/statusNote/kind/history, message.reactions; applyStatus, applyKind, applyReact; STATUSES, KINDS, EMOJI
template/lib/state.js        rebuild reads versions/ events → state.versions; emptyState.versions
template/api/comments.js     actions: status, kind, react, version, version-label; resolve → status; GET adds versions + navAt
template/server.js           same actions; S.versions
template/public/overlay.js   status chip + menu + system lines; kind chips + icons; reactions; what's new; versions panel; status filter
template/public/overlay.css  .status, .kind, .react*, .sys-line, .new-badge, .versions, .wont-note
tests/unit/threads.test.mjs  + status/kind/react/history tests
tests/e2e/workflow.spec.mjs  NEW (local project, after media)
SKILL.md / README.md         reviewer prose
```

---

### Task 1: Pure logic — status, kind, reactions, history

**Files:** `template/lib/threads.js`, `tests/unit/threads.test.mjs`.

**Interfaces:**
- `STATUSES = ['open','progress','done','wont']`, `KINDS = ['bug','question','idea']`, `EMOJI = ['👍','✅','❓','👀']`.
- Events: `{type:'state', at, status, note?, author, role}`; legacy `{type:'state', at, resolved}` ⇒ status `done|open` (author unknown → `null`). `{type:'state', at, kind, author, role}`. `{type:'react', at, target, emoji, on, author, role}`.
- Thread: `status` (string), `statusNote` (string|null, last `wont` note), `kind` (string|null), `history: [{at, status, note, author}]` (status changes only, chronological), `resolved` derived. Message: `reactions: {emoji: [author]}` (present only when non-empty).
- `applyStatus(threads, tid, {status, note, author, at})`, `applyKind(threads, tid, kind)`, `applyReact(threads, tid, {target, emoji, on, author})` — pure.

- [ ] **Step 1: Tests**
```js
test('assemble derives status/history from state events and keeps resolved in sync', () => {
  const [t] = assemble([
    first(T, 1),
    ev(T, 2, { type: 'state', at: 2, resolved: true }),                                   // legacy → done
    ev(T, 3, { type: 'state', at: 3, status: 'progress', author: 'Bob', role: 'designer' }),
    ev(T, 4, { type: 'state', at: 4, status: 'wont', note: 'Out of scope', author: 'Bob', role: 'designer' }),
    ev(T, 5, { type: 'state', at: 5, kind: 'bug', author: 'Bob', role: 'designer' }),
  ]);
  assert.equal(t.status, 'wont');
  assert.equal(t.statusNote, 'Out of scope');
  assert.equal(t.resolved, true);
  assert.equal(t.kind, 'bug');
  assert.deepEqual(t.history.map((h) => [h.status, h.author]), [['done', null], ['progress', 'Bob'], ['wont', 'Bob']]);
});

test('assemble folds reactions per message; toggling off removes the author', () => {
  const [t] = assemble([
    first(T, 1),
    ev(T, 2, { type: 'react', at: 2, target: 1, emoji: '👍', on: true, author: 'Bob', role: 'designer' }),
    ev(T, 3, { type: 'react', at: 3, target: 1, emoji: '👍', on: true, author: 'Cy', role: 'client' }),
    ev(T, 4, { type: 'react', at: 4, target: 1, emoji: '👍', on: false, author: 'Bob', role: 'designer' }),
    ev(T, 5, { type: 'react', at: 5, target: 1, emoji: '🔥', on: true, author: 'Bob', role: 'designer' }), // not in palette → ignored
  ]);
  assert.deepEqual(t.messages[0].reactions, { '👍': ['Cy'] });
});

test('status helpers are pure and keep resolved derived', () => {
  const base = [{ id: 'a', status: 'open', resolved: false, history: [], messages: [{ at: 1 }] }];
  const done = applyStatus(base, 'a', { status: 'done', note: null, author: 'Ann', at: 9 });
  assert.equal(done[0].resolved, true);
  assert.equal(done[0].history.length, 1);
  assert.equal(base[0].history.length, 0);
  assert.equal(applyKind(base, 'a', 'idea')[0].kind, 'idea');
  const r = applyReact(base, 'a', { target: 1, emoji: '✅', on: true, author: 'Ann' });
  assert.deepEqual(r[0].messages[0].reactions, { '✅': ['Ann'] });
  assert.equal(applyReact(r, 'a', { target: 1, emoji: '✅', on: false, author: 'Ann' })[0].messages[0].reactions, undefined);
});
```

- [ ] **Step 2: Implement** — constants at top; in `assemble()` after `messages` are built:
```js
    const statusEvents = states.filter((e) => 'resolved' in e.data || typeof e.data.status === 'string');
    const history = [];
    for (const e of statusEvents) {
      const status = typeof e.data.status === 'string' && STATUSES.includes(e.data.status) ? e.data.status : e.data.resolved ? 'done' : 'open';
      history.push({ at: e.data.at, status, note: status === 'wont' ? clean(e.data.note, 200) || null : null, author: e.data.author || null });
    }
    const status = history.length ? history.at(-1).status : 'open';
    const kinds = states.filter((e) => typeof e.data.kind === 'string' && KINDS.includes(e.data.kind));
    const kind = kinds.length ? kinds.at(-1).data.kind : KINDS.includes(firstMsg.first.kind) ? firstMsg.first.kind : null;
    for (const e of evs.filter((x) => x.data.type === 'react')) {
      const { target, emoji, on, author } = e.data;
      if (!EMOJI.includes(emoji) || !author) continue;
      const m = messages.find((x) => x.at === target);
      if (!m) continue;
      m.reactions = toggleReaction(m.reactions, emoji, author, Boolean(on));
    }
```
and in the thread literal: `status, statusNote: status === 'wont' ? history.at(-1).note : null, kind, history, resolved: status === 'done' || status === 'wont',` (replace the old `resolved:` line; keep `preview`). Helpers:
```js
function toggleReaction(reactions, emoji, author, on) {
  const next = { ...(reactions || {}) };
  const set = new Set(next[emoji] || []);
  if (on) set.add(author);
  else set.delete(author);
  if (set.size) next[emoji] = [...set];
  else delete next[emoji];
  return Object.keys(next).length ? next : undefined;
}
export const applyStatus = (threads, tid, { status, note, author, at }) =>
  threads.map((t) => t.id === tid ? { ...t, status, statusNote: status === 'wont' ? note || null : null, resolved: status === 'done' || status === 'wont', history: [...(t.history || []), { at, status, note: status === 'wont' ? note || null : null, author }] } : t);
export const applyKind = (threads, tid, kind) => threads.map((t) => (t.id === tid ? { ...t, kind } : t));
export const applyReact = (threads, tid, { target, emoji, on, author }) =>
  threads.map((t) => t.id === tid ? { ...t, messages: t.messages.map((m) => { if (m.at !== target) return m; const reactions = toggleReaction(m.reactions, emoji, author, on); const { reactions: _drop, ...rest } = m; return reactions ? { ...rest, reactions } : rest; }) } : t);
```
`applyResolve` becomes `applyStatus(threads, tid, { status: resolved ? 'done' : 'open', author, at })` — update its signature: `applyResolve(threads, tid, resolved, author = null, at = Date.now())`.

- [ ] **Step 3:** `npm test` → commit `"threads: status with history, kind, reactions (pure, tested)"`

---

### Task 2: Servers — new actions, versions, navAt

**Files:** `template/api/comments.js`, `template/lib/state.js`, `template/server.js`.

**Interfaces (HTTP):**
- `POST {action:'status', threadId, status, note?}` — `open|done` any visible role; `progress|wont` designer; `wont` requires `note` (1–200). Response `{thread}`.
- `POST {action:'kind', threadId, kind|null}` — designer. `POST {action:'react', threadId, at, emoji, on}` — any visible role, emoji in palette.
- `POST {action:'version', id}` — any role; `id` ≤ 80 chars `[A-Za-z0-9"/_.:-]`; appends `versions/<ts>-<key>.json` when unknown. `POST {action:'version-label', id, label}` — designer, label ≤ 60.
- `GET` adds `versions: [{id, firstSeen, label}]` and `navAt: {key: at}`.
- `resolve` (v1) → `status` event `{status: done|open, author, role}`.

- [ ] **Step 1: state.js** — `emptyState` gets `versions: []`; `rebuild` reads `readEvents(`${root}versions/`)` → `{ id, firstSeen, label }` merged by id (labels: latest `label` event wins; a version event is `{id, at}` or `{id, label, at}`).
- [ ] **Step 2: comments.js** — after `existing` check add branches `status`, `kind`, `react`; before the `threadId` check add `version` and `version-label` (they carry no thread). `resolve` branch writes `{type:'state', at: now, status, author, role}` and patch `applyStatus`. GET: `versions: state.versions || []`, `navAt: Object.fromEntries(Object.entries(state.nav).map(([k, v]) => [k, v.at]))`.
- [ ] **Step 3: server.js** — same branches on the in-memory thread (`thread.status = …; thread.history.push(...)`, reactions via the exported `applyReact` on `S.threads`), `S.versions` array.
- [ ] **Step 4:** `node --check`, `npm test` → commit `"API/local server: status, kind, reactions, versions; navAt on GET"`

---

### Task 3: Overlay — status, kind, reactions in the thread popover

**Files:** `template/public/overlay.js` (`openThread`, `openComposer`, `renderSidebar`), `overlay.css`.

- [ ] **Step 1: Status chip + menu** — in the popover head, replace the resolve check button with a `.status` chip showing the current status label (`Open / In progress / Done / Won't do`); click opens a small `.status-menu` (designer: 4 items; client: `Open` / `Done`). Choosing `Won't do` shows an inline `.wont-note` textarea (required) + Save. POST `{action:'status'}` → `refresh()` → `openThread`. Keep the check icon behaviour for clients (Open↔Done) as the chip's two options.
- [ ] **Step 2: System lines** — in the messages loop, merge `t.history` (status changes) with messages by `at`; render history entries as `.sys-line`: "Bob marked as In progress" / "Bob won't do: <note>". Skip the implicit initial `open`.
- [ ] **Step 3: Kind** — composer (`openComposer`) gets three optional chips `.kind-chip` (Bug / Question / Idea) above the textarea; selected value is sent as `kind` on create (`first.kind` on the server — add `kind: KINDS.includes(body.kind) ? body.kind : null` to `first` in Task 2). Popover head and sidebar rows show a kind icon (Lucide `bug`, `circle-help`, `lightbulb`) before the number; designer can change kind from the status menu's second section.
- [ ] **Step 4: Reactions** — under each message: `.reacts` row with existing emoji chips (`👍 2`, own highlighted `.mine`) and a `+` button revealing the 4-emoji palette; click → `POST {action:'react', at: m.at, emoji, on: !mine}` → refresh → reopen.
- [ ] **Step 5:** CSS for `.status`, `.status-menu`, `.wont-note`, `.sys-line`, `.kind-chip`, `.kind-ico`, `.reacts`, `.react-chip(.mine)`, `.react-add` in the existing token language. `node --check` → commit `"Overlay: status menu with won't-do reason, system lines, kind chips, reactions"`

---

### Task 4: Overlay — status filter, what's new, versions

**Files:** `template/public/overlay.js` (`threadsInView`, `renderSidebar`, `renderToolbar`, boot), `overlay.css`.

- [ ] **Step 1: Status filter** — `state.filter` becomes one of `open|progress|done|wont|all` (default `open`); the `.seg` shows `Open · In progress · Done · Won't do · All` (compact labels on narrow widths). `threadsInView()` filters by `t.status` (`all` → everything). Pins follow the filter (as today).
- [ ] **Step 2: What's new** — boot: `const prevVisit = Number(localStorage.getItem('fp_last_visit') || 0); localStorage.setItem('fp_last_visit', String(Date.now()));` `isNew(t)` = any of: `t.createdAt > prevVisit`, a message `at > prevVisit` not mine, a `history` entry `at > prevVisit` with `author !== myLabel()`, a reaction on my message (approximation: any reactions on my messages when `lastAt(t) > prevVisit`). `newScreens` = labels in `state.navAt` whose earliest `at > prevVisit`. Toolbar: Threads button shows `N new` (instead of the open count) for the first 60 s after boot when N > 0. Sidebar: top section "New for you" listing `isNew` threads (+ a line "New screens: A, B") during that minute; afterwards rows keep a `.new` tag.
- [ ] **Step 3: Versions** — boot: `fetch('/', {method:'HEAD', cache:'no-store'})` → `etag` (fallback: existing djb2 hash) → `state.proto = id` → `api('POST', {action:'version', id})` once per session. Sidebar header gets a `Versions` button → `.versions` panel inside the sidebar: rows `label || short id · first seen date · N comments` (designer: click label to edit → `version-label`); a row click sets `state.versionFilter = id` (chip "Version: <label> ×" above the list); "Older version" badge in the popover shows the label when known.
- [ ] **Step 4:** CSS; `node --check` → commit `"Overlay: status filter, what's-new digest, versions panel with labels and filter"`

---

### Task 5: e2e + lab + docs

**Files:** `tests/e2e/workflow.spec.mjs`, `tests/e2e/playwright.config.mjs` (project `local-workflow` after `local-media`), `SKILL.md`, `README.md`.

- [ ] **Step 1: Spec** (serial, local server, reuses threads from earlier projects):
  1. designer opens a thread → status menu → "In progress" → chip text; system line "marked as In progress"; API `status: 'progress'`.
  2. designer → "Won't do" without note → Save disabled; with note → API `status: 'wont'`, `statusNote`; client (`Client` page) cannot set `progress` (API 403) but can set `done` on their own thread.
  3. reactions: designer clicks `+` → 👍 → chip `👍 1 .mine`; click again → gone.
  4. kind: new comment with `Bug` chip → API `kind: 'bug'`; icon in the row.
  5. status filter: `Won't do` shows exactly the one thread; `All` shows every thread.
  6. what's new: a client comment after `fp_last_visit` (set in the past via `page.evaluate`) → reload designer → Threads button text matches `/new/`; "New for you" section present.
  7. versions: API GET has `versions.length >= 1` with the current ETag; designer labels it → `label` persisted.
- [ ] **Step 2:** `npm run e2e` → green; deploy lab (`api/ lib/ public/overlay.*`), `smoke.sh`, e2e with `LAB_URL`; verify on the real prototype that `versions` lists one version and legacy threads show status `open`.
- [ ] **Step 3:** SKILL step 7 / README: statuses (with reason for won't-do), kinds, reactions, what's new, versions. Execution notes, memory, commit, push.

---

## Self-review against the spec

§6.3 statuses/roles/note/system lines → Tasks 1–3; §6.4 kind at create + designer change + icon → Tasks 1–3; §6.5 palette/toggle/counts → Tasks 1–3; §6.6 client-side new-since digest incl. new screens (via `navAt`) → Task 4; §6.8 version id via ETag, first-seen registration, labels, filter, badge label → Tasks 2, 4; §6.1 status filter replacing Open/Resolved → Task 4; §7.3 row chips → Tasks 3–4. Compatibility: `resolved` derived; v1 `resolve` action mapped; legacy `proto` values remain valid ids (unknown versions simply unlabeled).
