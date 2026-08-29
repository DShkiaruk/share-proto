# share-proto v2 — Phase 2 (Media) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every comment carries a picture of where it was left (viewport capture with the pin marked), reviewers can attach screenshots to messages, and the sidebar shows a preview card on hover — all through the private store and the session-gated file proxy.

**Architecture:** Images travel as data URLs inside the existing JSON API (`action: 'preview'`, `images: []` on create/reply), are validated by magic bytes in a pure `lib/media.js`, stored as private blobs (`previews/<tid>/…`, `attach/<tid>/…`) and referenced from events (`state.preview`, `msg.img`). The overlay lazy-loads a vendored UMD build of `modern-screenshot` to rasterize the viewport after a comment is posted (never blocking the post), renders thumbnails through `/api/file`, and shows a hover card in the sidebar. The local `server.js` gets the same routes with files under `data/files/`.

**Tech Stack:** vanilla JS, `modern-screenshot 4.7.0` (vendored UMD, 29 KB), Node ≥ 18, `node:test`, Playwright 1.62.

**Spec:** `docs/superpowers/specs/2026-08-29-share-proto-v2-design.md` — §4.5, §7.3 (thumbnail on hover), §7.4, §8.1, §8.2, §10 (upload caps); §8.3 (shots) is Phase 4.

## Execution notes (2026-08-29)

All 8 tasks done; local e2e 4 (place) + 3 (media), lab smoke 3/3 (one transient failure of the lab "designer leaves a comment" test right after the media deploy — passed 3× afterwards; watch item), lab redeployed, preview verified on the real prototype (14 KB JPEG via /api/file). Deviations:
- Overlay `refresh()` re-renders only when a thread signature changes, and `onMutate` re-renders the open sidebar only on a screen change — a wholesale rebuild under the cursor swallowed clicks (found by `place.spec` once previews started arriving ~1 s after a post).
- Two local Playwright projects (`local-place` → `local-media`, `workers: 1`) share the fixture server; ordering keeps count-based assertions valid.
- `commentAt` in `place.spec` waits for the overlay's own state (`window.__fp`) to hold the preview before same-document navigation.
- Paperclip button added next to paste/drop (touch has no paste); `?token=` accepted by `/api/file` for embed-mode `<img>`.

**Critic review (post-execution) — outcomes:** BUG hover card unreachable → 150 ms grace timer + card `pointerenter`; BUG delete left media blobs → previews/attach purged with the thread (Blob and local); BUG attachment strip stale on cap → `break` + always `renderStrip()`; BUG eye toggle → outside-pointerdown ignores the eye; RISK session token in `?token=` image URLs → removed on both servers, embed mode fetches with the bearer header and shows `blob:` URLs; RISK silently dropped images → server 400 on any invalid image, client per-image cap with a toast; RISK `autoNavigate` outside trip cancellation → trip id threaded through; RISK edits invisible to the refresh signature → message text length/edited in the signature; RISK capture without deadline → `timeout: 4000`, `requestIdleCallback({timeout:1500})`, bail if the screen changed since the post; RISK sidebar stale on same-screen visibility changes → re-render when the on-screen set changes; RISK touch sheet → coarse-pointer CSS turns the card into a bottom sheet; NITs → `numLabel` in alt, `filter(Boolean)` on pasted items, eye is a `span[role=button]`, white fill before JPEG encode, `/api/file` uses the state store, uuid in attachment names, 413 before destroying an oversize local body, dead signature clause removed, media.spec asserts the 960×600 viewport capture.

## Global Constraints

- Client role never receives designer threads or their media — `/api/file` checks visibility (spec §1, §4.5).
- Uploads: ≤ 1.5 MB per image, ≤ 3 images per message; content type sniffed from magic bytes, never trusted from the client (spec §10).
- Preview capture never delays or fails a post (spec §8.1: idle, 4 s cap, silent failure).
- Never rewrite the storage model; Phase 2 adds event fields and file blobs only.
- All e2e interactions via real mouse coordinates; file attachment via `setInputFiles` on the composer's real `<input type=file>`.
- Docs in English; no design-tool brand names.
- Branch `v2`; commit per task; push after the phase (autonomy granted).

---

## File structure

```
template/lib/media.js              NEW pure: parseImageDataUrl(str, {maxBytes}) → {buf, contentType, ext}|null; MAX_IMAGE_BYTES, MAX_IMAGES
template/lib/threads.js            assemble: msg.img, state.preview → thread.preview; applyPreview(); applyReply keeps img
template/api/comments.js           create/reply accept images[]; new action 'preview'
template/api/file.js               + `?token=` fallback for embed-mode <img>
template/server.js                 /api/file route, data/files store, preview + images
template/public/screenshot.js      NEW vendored modern-screenshot UMD (dist/index.js, unmodified, license header kept)
template/public/overlay.js         capturePreview(), attachments in composer (paste/drop/button), message thumbnails,
                                   lightbox, sidebar hover card / touch eye button, preview in other-screen popover
template/public/overlay.css        .attach-*, .msg .imgs, .lightbox, .preview-card, .sb-row .eye
tests/unit/media.test.mjs          NEW
tests/unit/threads.test.mjs        + preview/img tests
tests/e2e/media.spec.mjs           NEW (local project)
tests/fixtures/pixel.png           NEW 1×1 PNG for attachment upload
SKILL.md / README.md               reviewer prose: previews, attachments
```

---

### Task 1: `lib/media.js` — image validation (pure)

**Files:** Create `template/lib/media.js`, `tests/unit/media.test.mjs`.

**Interfaces:**
- `MAX_IMAGE_BYTES = 1.5 * 1024 * 1024`, `MAX_IMAGES = 3`
- `parseImageDataUrl(str, { maxBytes = MAX_IMAGE_BYTES } = {}) → { buf: Uint8Array, contentType: 'image/jpeg'|'image/png'|'image/webp', ext: 'jpg'|'png'|'webp' } | null` — null for non-data-URLs, unknown magic, oversize.
- `parseImages(arr) → parsed[]` — takes `≤ MAX_IMAGES` valid entries, ignores the rest.

- [ ] **Step 1: Tests**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImageDataUrl, parseImages, MAX_IMAGES } from '../../template/lib/media.js';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const PNG = 'data:image/png;base64,' + b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = 'data:image/jpeg;base64,' + b64([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = 'data:image/webp;base64,' + b64([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), 1]);

test('parseImageDataUrl sniffs jpeg/png/webp from bytes, not from the declared type', () => {
  assert.equal(parseImageDataUrl(PNG).ext, 'png');
  assert.equal(parseImageDataUrl(JPG).contentType, 'image/jpeg');
  assert.equal(parseImageDataUrl(WEBP).ext, 'webp');
  assert.equal(parseImageDataUrl('data:image/png;base64,' + b64([0xff, 0xd8, 0xff, 0, 0])).ext, 'jpg'); // lies about type
});

test('parseImageDataUrl rejects junk, svg, oversize', () => {
  assert.equal(parseImageDataUrl('hello'), null);
  assert.equal(parseImageDataUrl('data:image/svg+xml;base64,' + b64(Buffer.from('<svg/>'))), null);
  assert.equal(parseImageDataUrl(JPG, { maxBytes: 3 }), null);
  assert.equal(parseImageDataUrl(null), null);
});

test('parseImages caps the count and skips invalid entries', () => {
  const out = parseImages([JPG, 'junk', PNG, WEBP, JPG]);
  assert.equal(out.length, MAX_IMAGES);
  assert.deepEqual(out.map((p) => p.ext), ['jpg', 'png', 'webp']);
  assert.deepEqual(parseImages('nope'), []);
});
```

- [ ] **Step 2: Implement**
```js
/* Image payload validation — pure, shared by the Vercel API and server.js.
   Images arrive as data URLs inside JSON. The content type is decided by the
   magic bytes, never by the declared MIME (an SVG "image" would be a script). */

export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
export const MAX_IMAGES = 3;

const KINDS = [
  { sig: [0xff, 0xd8, 0xff], contentType: 'image/jpeg', ext: 'jpg' },
  { sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], contentType: 'image/png', ext: 'png' },
  { riff: true, contentType: 'image/webp', ext: 'webp' },
];

function decodeBase64(s) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseImageDataUrl(str, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (typeof str !== 'string') return null;
  const m = /^data:([\w/+.-]+)?;base64,([A-Za-z0-9+/=\s]+)$/.exec(str);
  if (!m) return null;
  const b64 = m[2].replace(/\s+/g, '');
  if ((b64.length * 3) / 4 > maxBytes + 4) return null; // cheap pre-check before decoding
  let buf;
  try {
    buf = decodeBase64(b64);
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.length > maxBytes) return null;
  for (const k of KINDS) {
    if (k.riff) {
      const s = (o, t) => [...t].every((c, i) => buf[o + i] === c.charCodeAt(0));
      if (buf.length >= 12 && s(0, 'RIFF') && s(8, 'WEBP')) return { buf, contentType: k.contentType, ext: k.ext };
    } else if (k.sig.every((b, i) => buf[i] === b)) {
      return { buf, contentType: k.contentType, ext: k.ext };
    }
  }
  return null;
}

export function parseImages(arr, opts) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    const p = parseImageDataUrl(s, opts);
    if (p) out.push(p);
    if (out.length === MAX_IMAGES) break;
  }
  return out;
}
```

- [ ] **Step 3:** `npm test` green → `git commit -am "lib/media.js: magic-byte image validation for JSON uploads"`

---

### Task 2: Threads carry `preview` and message `img`

**Files:** `template/lib/threads.js`, `tests/unit/threads.test.mjs`.

**Interfaces:**
- Event `{type:'state', at, preview: '<pathname>'}` → `thread.preview` (last wins). Event `{type:'msg', …, img: ['<pathname>']}` → `message.img`.
- `applyPreview(threads, tid, pathname) → Thread[]`. `applyReply` keeps `msg.img` (already spreads msg). `applyCreate` unchanged (thread literal built by the API carries `img` on its first message).

- [ ] **Step 1: Tests**
```js
test('assemble carries message images and the latest preview', () => {
  const [t] = assemble([
    { ...first(T, 1), data: { ...first(T, 1).data, img: ['attach/a/1.jpg'] } },
    ev(T, 2, { type: 'state', at: 2, preview: 'previews/a/2.jpg' }),
    ev(T, 3, { type: 'state', at: 3, preview: 'previews/a/3.jpg' }),
    ev(T, 4, { type: 'state', at: 4, resolved: true }),
  ]);
  assert.deepEqual(t.messages[0].img, ['attach/a/1.jpg']);
  assert.equal(t.preview, 'previews/a/3.jpg');
  assert.equal(t.resolved, true); // a preview-only state event does not touch resolved
});

test('applyPreview sets the thread preview without touching other threads', () => {
  const base = [{ id: 'a', preview: null }, { id: 'b', preview: null }];
  const out = applyPreview(base, 'a', 'previews/a/9.jpg');
  assert.equal(out[0].preview, 'previews/a/9.jpg');
  assert.equal(out[1].preview, null);
});
```
(Add `applyPreview` to the import list.)

- [ ] **Step 2: Implement** — in `assemble()`: `messages` map becomes `({ author, role, text, at, ...(Array.isArray(m.img) && m.img.length ? { img: m.img.slice(0, 3) } : {}) })`; states: `const resolvedStates = states.filter((e) => 'resolved' in e.data); const previews = states.filter((e) => typeof e.data.preview === 'string');` → `resolved: resolvedStates.length ? Boolean(resolvedStates.at(-1).data.resolved) : false, preview: previews.length ? previews.at(-1).data.preview : null,`. Add:
```js
export const applyPreview = (threads, tid, preview) =>
  threads.map((t) => (t.id === tid ? { ...t, preview } : t));
```

- [ ] **Step 3:** `npm test` → commit `"threads: message images and thread preview from events"`

---

### Task 3: Vercel API — images on create/reply, `preview` action, token fallback in file proxy

**Files:** `template/api/comments.js`, `template/api/file.js`.

**Interfaces:**
- `POST {action:'create', …, images?: [dataURL]}` / `{action:'reply', …, images?: []}` → stores `attach/<tid>/<ts>-<i>.<ext>`, message gets `img: [pathnames]`.
- `POST {action:'preview', threadId, image: dataURL}` → author of the thread (same author+role) or designer; stores `previews/<tid>/<ts>.<ext>`; event `{type:'state', at, preview}`; response `{ preview }`.
- `GET /api/file?p=…&token=<session token>` — accepted like `Authorization: Bearer` (embed mode `<img>` cannot send headers).

- [ ] **Step 1: comments.js** — imports: `applyPreview` from threads, `parseImages, parseImageDataUrl` from `../lib/media.js`, `putFile` via `storage`. Helper inside handler scope:
```js
  async function storeImages(tid, kind, images) {
    const parsed = parseImages(images);
    const paths = [];
    for (const [i, img] of parsed.entries()) {
      const pathname = `${root}${kind}/${tid}/${ts(now)}-${i}.${img.ext}`;
      await storage.putFile(pathname, img.buf, img.contentType);
      paths.push(pathname.slice(root.length)); // stored relative to root; file proxy re-adds it
    }
    return paths;
  }
```
In `create`: `const img = await storeImages(tid, 'attach', body.images);` → message `{ author, role, text, at: now, ...(img.length ? { img } : {}) }` and the event gets `...(img.length ? { img } : {})`. In `reply`: same with `storeImages(tid, 'attach', body.images)` → `msg`. New branch before `reply` (after `existing` check):
```js
  if (action === 'preview') {
    const own = existing.author === author && existing.authorRole === role;
    if (!own && role !== 'designer') return res.status(403).json({ error: 'Not allowed' });
    const img = parseImageDataUrl(body.image);
    if (!img) return res.status(400).json({ error: 'Bad image' });
    const rel = `previews/${tid}/${ts(now)}.${img.ext}`;
    await storage.putFile(`${root}${rel}`, img.buf, img.contentType);
    await storage.appendEvent(eventPath(tid), { type: 'state', at: now, preview: rel });
    const { path } = await store.mutate(root, (s) => ({ threads: applyPreview(s.threads, tid, rel) }));
    res.setHeader('X-Store-Path', path);
    return res.status(200).json({ preview: rel });
  }
```
Body size: Vercel functions accept up to 4.5 MB request bodies — 3 × 1.5 MB base64 (~2 MB each) can exceed it; cap the *total* client-side (Task 6: ≤ 3 MB of base64 per request) and here return 413 when `JSON.stringify(body.images||[]).length > 3.2e6`.

- [ ] **Step 2: file.js** — replace the session line with:
```js
  const url = new URL(req.url, 'http://x');
  const bearer = req.headers.authorization || (url.searchParams.get('token') ? `Bearer ${url.searchParams.get('token')}` : '');
  const session = await sessionFromHeaders(req.headers.cookie || '', bearer, process.env.SESSION_SECRET);
```
(and delete the later duplicate `const url = …`).

- [ ] **Step 3:** `node --check` both → commit `"API: image attachments on create/reply, thread preview action, token query for embed <img>"`

---

### Task 4: Local server parity (`server.js`)

**Files:** `template/server.js`.

- [ ] **Step 1:** `const FILES = path.join(DATA, 'files');` and helpers:
```js
async function putFileLocal(rel, buf) {
  const file = path.join(FILES, rel);
  if (!file.startsWith(FILES + path.sep)) throw new Error('bad path');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, buf);
}
const SAFE_FILE = /^(previews|attach|shots)\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,80}\.(jpe?g|png|webp)$/;
const MIME_IMG = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
```
Import `parseImages, parseImageDataUrl` from `./lib/media.js` and `applyPreview` is not needed (server mutates in place). In `apiComments`: create/reply store images (`attach/<tid>/<ts>-<i>.<ext>`, room-prefixed dir `rooms/<room>/` when a room is set), `preview` action as in Task 3 (`thread.preview = rel`). New route in the server switch, after the `/api/comments` block:
```js
    if (pathname === '/api/file') {
      const u = new URL(req.url, 'http://local');
      const bearer = req.headers.authorization || (u.searchParams.get('token') ? `Bearer ${u.searchParams.get('token')}` : '');
      const s2 = session || (await sessionFromHeaders('', bearer, SECRETS.sessionSecret));
      if (!s2) return json(res, 401, { error: 'Not authenticated' });
      const rel = String(u.searchParams.get('p') || '');
      if (!SAFE_FILE.test(rel)) return json(res, 400, { error: 'Bad path' });
      const room = roomFromReq(req);
      const [kind, key] = rel.split('/');
      if (kind !== 'shots') {
        const t = roomStore(room).threads.find((x) => x.id === key);
        if (!t || !canSee(s2.r, t)) return json(res, 404, { error: 'Not found' });
      }
      const file = path.join(FILES, room ? `rooms/${room}/` : '', rel);
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (!st?.isFile()) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': MIME_IMG[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
    }
```
Also raise `readBody`'s limit to 4 MB if it has one (check the function; v1 local edition may cap at 1 MB).

- [ ] **Step 2:** `node --check template/server.js` → commit `"server.js: /api/file, image attachments and previews under data/files"`

---

### Task 5: Overlay — viewport preview capture after posting

**Files:** `template/public/screenshot.js` (vendored), `template/public/overlay.js`.

**Interfaces:** `capturePreview(thread, point) → Promise<void>` (never throws); `loadScreenshotLib() → Promise<object|null>`; `fileUrl(rel) → string` (`apiUrl('/api/file') + ?p=…(&token=… in embed)`).

- [ ] **Step 1: Vendor** — `cp node_modules/modern-screenshot/dist/index.js template/public/screenshot.js` and prepend a one-line comment `/* modern-screenshot 4.7.0 — MIT — https://github.com/qq15725/modern-screenshot (vendored, unmodified) */`. Add `screenshot.js` to the middleware matcher exclusions? No — it loads only after login, same as overlay.js. In `server.js` the file is static under `public/` automatically. Note `assemble.py` copies `template/public/*` → nothing to do.

- [ ] **Step 2: Capture** — add after the `api()` section:
```js
  /* ---------- media ---------- */

  const fileUrl = (rel) =>
    apiUrl('/api/file') + (ROOM ? '&' : '?') + `p=${encodeURIComponent(rel)}` + (EMBED && authToken ? `&token=${encodeURIComponent(authToken)}` : '');

  let shotLib = null;
  function loadScreenshotLib() {
    if (shotLib) return shotLib;
    shotLib = new Promise((resolve) => {
      if (window.modernScreenshot) return resolve(window.modernScreenshot);
      const s = document.createElement('script');
      s.src = (EMBED ? API_ORIGIN : '') + '/screenshot.js';
      s.onload = () => resolve(window.modernScreenshot || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
    return shotLib;
  }

  // Rasterize the current viewport with the pin marked, downscale, and attach it
  // to the thread. Runs after the post succeeded; any failure is silent — a
  // comment without a picture is still a comment.
  async function capturePreview(thread, point) {
    try {
      const lib = await loadScreenshotLib();
      if (!lib) return;
      const scale = Math.min(1, 960 / innerWidth);
      const full = await Promise.race([
        lib.domToCanvas(document.documentElement, {
          scale,
          width: innerWidth,
          height: innerHeight,
          filter: (node) => node !== host,
          style: { transform: `translate(${-scrollX}px, ${-scrollY}px)` },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
      ]);
      const c = document.createElement('canvas');
      c.width = Math.round(innerWidth * scale);
      c.height = Math.round(innerHeight * scale);
      const ctx = c.getContext('2d');
      ctx.drawImage(full, 0, 0, c.width, c.height);
      if (point) {
        const x = point.x * scale, y = point.y * scale;
        ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.fillStyle = '#3b82f6'; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
      }
      const image = c.toDataURL('image/jpeg', 0.8);
      if (image.length > 1.4e6) return; // ~1 MB of base64 — skip rather than fail the request
      await api('POST', { action: 'preview', threadId: thread.id, image });
      refresh();
    } catch {
      /* no preview */
    }
  }
```
In `openComposer`'s create success path, after `state.draft = null;` add `const point = { x: state.draft?.x ?? 0, y: state.draft?.y ?? 0 }` **before** nulling the draft, then after `refresh()`: `(window.requestIdleCallback || setTimeout)(() => capturePreview(thread, point));`.

- [ ] **Step 3:** `node --check` → commit `"Overlay: viewport preview captured after posting (vendored modern-screenshot)"`

---

### Task 6: Overlay — attachments in the composer, message thumbnails, lightbox

**Files:** `template/public/overlay.js` (`composeRow`, `openComposer`, `openThread` messages), `template/public/overlay.css`.

**Interfaces:** `composeRow()` returns `{ row, ta, send, images }` where `images` is a getter of pending data URLs; `shrinkImage(file) → Promise<dataURL>` (≤ 1600 px, JPEG 0.85); `openLightbox(src)`.

- [ ] **Step 1: composeRow** — add a paperclip `icon` (Lucide `paperclip`: `<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>`), a hidden `<input type="file" accept="image/*" multiple class="attach-input">`, a `.attach-strip` of thumbnails with ✕, and handlers: `input change`, textarea `paste` (clipboardData.items image/*), row `dragover/drop`. Cap 3, total base64 ≤ 3 MB (toast "Too many / too large"). `shrinkImage`:
```js
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }
```
`send.disabled = !ta.value.trim() && !pending.length` (an image-only message is allowed; server requires text — so send `text: ta.value.trim() || '📎'`… no: keep the text requirement and disable send without text; images are attachments *to* a message). Submit handlers in `openComposer` / `openThread` pass `images: images()` in the POST.

- [ ] **Step 2: Render** — in `openThread` message loop, after `textEl`: if `m.img?.length` → `const strip = el('div', 'imgs'); for (const rel of m.img) { const im = el('img'); im.src = fileUrl(rel); im.loading = 'lazy'; im.alt = 'Attachment'; im.addEventListener('click', () => openLightbox(fileUrl(rel))); strip.appendChild(im); } box.append(meta, textEl, strip)`.
```js
  let lightbox = null;
  function openLightbox(src) {
    closeLightbox();
    lightbox = el('div', 'lightbox');
    const im = el('img'); im.src = src; im.alt = '';
    lightbox.appendChild(im);
    lightbox.addEventListener('click', closeLightbox);
    root.appendChild(lightbox);
  }
  function closeLightbox() { lightbox?.remove(); lightbox = null; }
```
Escape handler: first branch `if (lightbox) closeLightbox(); else if (state.draft) …`.

- [ ] **Step 3: CSS**
```css
.attach-btn { width: 28px; height: 28px; display: grid; place-items: center; color: var(--muted-fg); border-radius: 6px; }
.attach-btn:hover { background: var(--muted); color: var(--ink); }
.attach-btn svg { width: 16px; height: 16px; }
.attach-input { display: none; }
.attach-strip { display: flex; gap: 6px; padding: 0 12px 8px; flex-wrap: wrap; }
.attach-strip .thumb { position: relative; width: 56px; height: 42px; border-radius: 6px; overflow: hidden; border: 1px solid var(--border); }
.attach-strip .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.attach-strip .thumb button { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border-radius: 9999px; background: rgb(0 0 0 / 0.6); color: #fff; font-size: 10px; line-height: 16px; }
.compose.dragging { outline: 2px dashed var(--ring); outline-offset: -4px; }
.msg .imgs { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.msg .imgs img { max-width: 140px; max-height: 100px; border-radius: 6px; border: 1px solid var(--border); cursor: zoom-in; display: block; }
.lightbox { position: fixed; inset: 0; z-index: 90; background: rgb(0 0 0 / 0.82); display: grid; place-items: center; pointer-events: auto; cursor: zoom-out; animation: fp-fade 150ms var(--ease); }
.lightbox img { max-width: min(96vw, 1600px); max-height: 94vh; border-radius: 8px; box-shadow: var(--shadow-lg); }
@keyframes fp-fade { from { opacity: 0; } }
```
(Confirm `.compose` layout accommodates the button: it is `display:flex` with textarea + send; insert the attach button before `send`.)

- [ ] **Step 4:** `node --check` → commit `"Overlay: image attachments (paste, drop, button), message thumbnails, lightbox"`

---

### Task 7: Overlay — sidebar hover card and preview in the other-screen popover

**Files:** `template/public/overlay.js` (`renderSidebar` rows, `openThread` goto-row), `template/public/overlay.css`.

- [ ] **Step 1: Hover card** — module scope: `let hoverCard = null; let hoverTimer = null;`
```js
  function showPreviewCard(t, row) {
    hidePreviewCard();
    hoverCard = el('div', 'preview-card');
    if (t.preview) {
      const im = el('img'); im.src = fileUrl(t.preview); im.alt = `Screen with comment #${t.n}`;
      im.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(fileUrl(t.preview)); });
      hoverCard.appendChild(im);
    } else {
      hoverCard.appendChild(el('div', 'no-preview', t.screenLabel || 'No preview'));
    }
    const body = el('div', 'body');
    body.append(el('div', 'meta', `#${t.n} · ${t.author} · ${t.resolved ? 'Resolved' : 'Open'}`), el('div', 'text', t.messages[0]?.text || ''));
    hoverCard.appendChild(body);
    root.appendChild(hoverCard);
    const r = row.getBoundingClientRect();
    const w = 300;
    hoverCard.style.left = `${Math.max(12, r.left - w - 12)}px`;
    hoverCard.style.top = `${Math.min(Math.max(12, r.top), innerHeight - 260)}px`;
  }
  function hidePreviewCard() { clearTimeout(hoverTimer); hoverCard?.remove(); hoverCard = null; }
```
In `addRows`, per row: desktop — `row.addEventListener('pointerenter', () => { if (matchMedia('(pointer: coarse)').matches) return; hoverTimer = setTimeout(() => showPreviewCard(t, row), 350); }); row.addEventListener('pointerleave', hidePreviewCard);` — touch: an `eye` icon button `.eye` in `meta` that calls `showPreviewCard(t, row)` (stopPropagation) and a tap anywhere closes it (`document pointerdown` capture already closes popovers; add `hidePreviewCard()` there). `setSidebar(false)` → `hidePreviewCard()`.

- [ ] **Step 2: Popover for another screen** — in `openThread`, inside `if (!pinEl && !onThisScreen(t))`, before the goto-row, when `t.preview`: `const pv = el('img', 'popover-preview'); pv.src = fileUrl(t.preview); pv.alt = 'Where this comment is'; pv.addEventListener('click', () => openLightbox(fileUrl(t.preview))); popover.appendChild(pv);`.

- [ ] **Step 3: CSS**
```css
.preview-card { position: fixed; z-index: 60; width: 300px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow-lg); overflow: hidden; pointer-events: auto; animation: fp-fade 150ms var(--ease); }
.preview-card img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; cursor: zoom-in; background: var(--muted); }
.preview-card .no-preview { aspect-ratio: 16 / 10; display: grid; place-items: center; color: var(--muted-fg); font-size: 12px; background: var(--muted); }
.preview-card .body { padding: 10px 12px; }
.preview-card .meta { font-size: 11px; color: var(--muted-fg); margin-bottom: 4px; font-variant-numeric: tabular-nums; }
.preview-card .text { font-size: 13px; line-height: 1.4; max-height: 3 * 1.4em; overflow: hidden; }
.sb-row .eye { display: none; margin-left: auto; width: 28px; height: 28px; border-radius: 6px; color: var(--muted-fg); }
.sb-row .eye svg { width: 16px; height: 16px; }
@media (pointer: coarse) { .sb-row .eye { display: grid; place-items: center; } }
.popover-preview { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-bottom: 1px solid var(--border); cursor: zoom-in; background: var(--muted); }
```
(`max-height: 3 * 1.4em` is not valid CSS — use `max-height: 4.2em`.)

- [ ] **Step 4:** `node --check` → commit `"Overlay: sidebar hover preview card (eye button on touch), preview image in other-screen popovers"`

---

### Task 8: e2e `media.spec.mjs`, fixture pixel, lab deploy, docs

**Files:** `tests/e2e/media.spec.mjs`, `tests/fixtures/pixel.png`, `tests/e2e/playwright.config.mjs` (testMatch for `local`: `/(place|media)\.spec\.mjs/`), `SKILL.md`, `README.md`.

- [ ] **Step 1: pixel** — `python3 -c "import base64;open('tests/fixtures/pixel.png','wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='))"` (1×1 PNG).

- [ ] **Step 2: Spec**
```js
import { test, expect } from '@playwright/test';
import { login, mouseClick, inOverlay, apiGet } from './helpers.mjs';

const TEAM = 'team-e2e';
const CLIENT = 'client-e2e';
test.describe.configure({ mode: 'serial' });

test('a posted comment gets a viewport preview; the client cannot fetch a designer preview', async ({ page, browser }) => {
  await login(page, 'Designer', TEAM);
  await mouseClick(page, inOverlay(page, '.tb-btn').first());
  await mouseClick(page, page.locator('section[data-route="home"] h1'));
  await inOverlay(page, '.popover textarea').fill('with preview');
  await page.keyboard.press('Enter');
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: 'with preview' })).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await apiGet(page, '/api/comments')).threads.find((t) => t.messages[0].text === 'with preview')?.preview, { timeout: 15_000 }).toMatch(/^previews\//);
  const t = (await apiGet(page, '/api/comments')).threads.find((x) => x.messages[0].text === 'with preview');
  const r = await page.request.get(`/api/file?p=${encodeURIComponent(t.preview)}`);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toBe('image/jpeg');
  expect((await r.body()).length).toBeGreaterThan(1000);
  const client = await browser.newPage();
  await login(client, 'Client', CLIENT);
  expect((await client.request.get(`/api/file?p=${encodeURIComponent(t.preview)}`)).status()).toBe(404);
});

test('an image attached via the paperclip is stored, rendered and opens a lightbox', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await mouseClick(page, inOverlay(page, '.tb-btn').first());
  await mouseClick(page, page.locator('section[data-route="home"] p').first());
  await inOverlay(page, '.attach-input').setInputFiles('tests/fixtures/pixel.png');
  await expect(inOverlay(page, '.attach-strip .thumb')).toHaveCount(1);
  await inOverlay(page, '.popover textarea').fill('see attached');
  await page.keyboard.press('Enter');
  const img = inOverlay(page, '.popover .msg .imgs img');
  await expect(img).toBeVisible({ timeout: 10_000 });
  const t = (await apiGet(page, '/api/comments')).threads.find((x) => x.messages[0].text === 'see attached');
  expect(t.messages[0].img[0]).toMatch(/^attach\//);
  await mouseClick(page, img);
  await expect(inOverlay(page, '.lightbox img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inOverlay(page, '.lightbox')).toHaveCount(0);
});

test('hovering a sidebar row shows the preview card', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1));
  const row = inOverlay(page, '.sb-row').filter({ hasText: 'with preview' });
  const box = await row.boundingBox();
  await page.mouse.move(box.x + 40, box.y + 10);
  const card = inOverlay(page, '.preview-card');
  await expect(card).toBeVisible({ timeout: 3000 });
  await expect(card.locator('img')).toHaveAttribute('src', /api\/file\?p=previews/);
  await page.mouse.move(5, 5);
  await expect(card).toHaveCount(0);
});
```

- [ ] **Step 3: Run** `npm run e2e` (local: place 4 + media 3) → fix overlay until green; then with `LAB_URL` (lab smoke 3) after deploying: rsync `api/ lib/ public/overlay.js public/overlay.css public/screenshot.js` → `vercel deploy --prod --yes` → `scripts/smoke.sh` → e2e all.

- [ ] **Step 4: Docs** — SKILL step 7 prose: "Each comment keeps a picture of the screen it was left on (hover a thread in the sidebar); reviewers can paste or attach screenshots to any message." README same sentence in the reviewers paragraph.

- [ ] **Step 5:** Execution notes in this plan, memory update, commit, `git push origin v2`.

---

## Self-review against the spec

- §8.1 capture viewport, marker, ≤ 960 px JPEG q0.8, idle, 4 s cap, silent failure, `previews/<tid>/<ts>.jpg`, `state {preview}` → Task 5 + 3. §8.2 paste/drop, ≤ 1600 px q0.85, ≤ 1.5 MB, ≤ 3, `attach/<tid>/<ts>-<i>`, `img[]`, lightbox → Tasks 6, 3, 1. §7.4 hover 350 ms, left of sidebar, touch eye button, thumbnail click zoom → Task 7. §4.5 local mode serves the same route from `data/files/` → Task 4. §10 sniffing, caps → Task 1, 3. Out of scope here: §8.3 shots (Phase 4). Added beyond spec: paperclip button (mobile has no paste), `?token=` for embed images, preview image in other-screen popovers.
- Names consistent: `fileUrl`, `capturePreview`, `loadScreenshotLib`, `shrinkImage`, `openLightbox/closeLightbox`, `showPreviewCard/hidePreviewCard`, `applyPreview`, `parseImages/parseImageDataUrl`, `storeImages`.
