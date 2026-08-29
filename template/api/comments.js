import {
  clean, canSee, applyCreate, applyReply, applyEdit, applyResolve, applyDelete, applyPreview, navPatch,
  nextNumber, sanitizeTrail, sanitizePage, applyStatus, applyKind, applyReact, STATUSES, KINDS, EMOJI,
} from '../lib/threads.js';
import { parseImages, parseImageDataUrl } from '../lib/media.js';
import * as storage from '../lib/storage.js';
import { createStateStore, applyVersionEvent } from '../lib/state.js';
import { sessionFromHeaders } from '../lib/session.js';
import { applyCors, roomFromReq } from '../lib/cors.js';

/* Storage model (v2):
   - events are append-only blobs (source of truth):
       <root>threads/<tid>/<ts>-<uuid>.json   msg | state | edit | tomb
       <root>nav/e-<ts>-<uuid>.json            {from, to, anchor, at}
   - one document, <root>state.json = {v, threads, nav, updatedAt}, patched per
     mutation with optimistic concurrency (ETag ifMatch / ifAbsent) and read
     with useCache:false — see lib/state.js. A poll is one read, no list().
     Missing/corrupt document → rebuilt from events. Designer GET ?rebuild=1
     forces that. Every response carries X-Store-Path (read | rebuild |
     patch | retry | unsaved) so the slow paths are observable.
   <root> is '' for classic installs or rooms/<room>/ in embed mode. */

const MAX_TEXT = 3000;
const MAX_NAME = 40;
const PAD = 14;
const NAV_CAP = 500;
const ts = (at) => String(at).padStart(PAD, '0');
const uuid = () => crypto.randomUUID();

const store = createStateStore(storage, { navCap: NAV_CAP });
const publicNav = (nav) => Object.fromEntries(Object.entries(nav).map(([k, v]) => [k, v.anchor]));

export default async function handler(req, res) {
  if (applyCors(req, res, process.env.ALLOWED_ORIGINS)) return;
  const session = await sessionFromHeaders(
    req.headers.cookie || '',
    req.headers.authorization || '',
    process.env.SESSION_SECRET
  );
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const room = roomFromReq(req);
  const root = room ? `rooms/${room}/` : '';
  const role = session.r;
  // Author identity comes from the signed session (set at login), never from
  // the request body — client sees only client threads, so authorship must be
  // trustworthy.
  const author = clean(session.n, MAX_NAME) || (role === 'designer' ? 'Designer' : 'Client');
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET') {
    const wantRebuild = url.searchParams.get('rebuild') === '1' && role === 'designer';
    const { state, path } = wantRebuild ? await store.forceRebuild(root) : await store.loadState(root);
    res.setHeader('X-Store-Path', path);
    return res.status(200).json({
      role,
      name: author,
      nav: publicNav(state.nav),
      navAt: Object.fromEntries(Object.entries(state.nav).map(([k, v]) => [k, v.at])),
      versions: state.versions || [],
      threads: state.threads.filter((t) => canSee(role, t)),
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const action = body.action;
  const now = Date.now();
  const eventPath = (tid) => `${root}threads/${tid}/${ts(now)}-${uuid()}.json`;
  // Attachments arrive as data URLs; the payload cap keeps the request under
  // the platform body limit. Pathnames are stored relative to <root>.
  if (Array.isArray(body.images) && JSON.stringify(body.images).length > 3.2e6) {
    return res.status(413).json({ error: 'Images too large' });
  }
  async function storeImages(tid, kind, images) {
    const paths = [];
    for (const [i, img] of parseImages(images).entries()) {
      const rel = `${kind}/${tid}/${ts(now)}-${i}.${img.ext}`;
      await storage.putFile(`${root}${rel}`, img.buf, img.contentType);
      paths.push(rel);
    }
    return paths;
  }

  if (action === 'edge') {
    const from = clean(body.from, 64);
    const to = clean(body.to, 64);
    const anchor = body.anchor && typeof body.anchor === 'object' ? body.anchor : null;
    if (!from || !to || from === to || !anchor || JSON.stringify(anchor).length > 3000) {
      return res.status(400).json({ error: 'Bad edge' });
    }
    await storage.appendEvent(`${root}nav/e-${ts(now)}-${uuid()}.json`, { from, to, anchor, at: now });
    const { path } = await store.mutate(root, (s) => ({ nav: navPatch(s.nav, from, to, anchor, now, NAV_CAP) }));
    res.setHeader('X-Store-Path', path);
    return res.status(200).json({ ok: true });
  }

  if (action === 'create') {
    const text = clean(body.text, MAX_TEXT);
    if (!text) return res.status(400).json({ error: 'Missing text' });
    const anchor = body.anchor && typeof body.anchor === 'object' ? body.anchor : null;
    if (JSON.stringify(anchor || {}).length > 4000) return res.status(400).json({ error: 'Anchor too large' });
    const tid = uuid();
    // The number is taken from the state we can see now and persisted on the
    // event; assignNumbers() in the patch (and in any rebuild) repairs a race.
    const { state: before } = await store.loadState(root);
    const first = {
      authorRole: role,
      screen: clean(body.screen, 64),
      screenLabel: clean(body.screenLabel, 120),
      anchor,
      proto: clean(body.proto, 64) || null,
      page: sanitizePage(body.page),
      // Never reuse a number: max over live threads AND the document's high-water mark.
      n: Math.max(nextNumber(before.threads), (before.maxN || 0) + 1),
      trail: sanitizeTrail(body.trail),
      kind: KINDS.includes(body.kind) ? body.kind : null,
    };
    const img = await storeImages(tid, 'attach', body.images);
    const firstMsg = { author, role, text, at: now, ...(img.length ? { img } : {}) };
    const thread = {
      id: tid,
      createdAt: now,
      author,
      ...first,
      resolved: false,
      preview: null,
      messages: [firstMsg],
    };
    await storage.appendEvent(eventPath(tid), { type: 'msg', ...firstMsg, first });
    const { state, path } = await store.mutate(root, (s) => {
      const threads = applyCreate(s.threads, thread);
      return { threads, maxN: Math.max(s.maxN || 0, ...threads.map((t) => t.n || 0)) };
    });
    res.setHeader('X-Store-Path', path);
    return res.status(200).json({ thread: state.threads.find((t) => t.id === tid) });
  }

  // Prototype versions carry no thread.
  const VERSION_ID = /^[A-Za-z0-9"/_.:-]{1,80}$/;
  if (action === 'version' || action === 'version-label') {
    const id = String(body.id || '');
    if (!VERSION_ID.test(id)) return res.status(400).json({ error: 'Bad version id' });
    if (action === 'version-label' && role !== 'designer') return res.status(403).json({ error: 'Not allowed' });
    const ev = action === 'version' ? { id, at: now } : { id, label: clean(body.label, 60), at: now };
    const { state: cur } = await store.loadState(root);
    if (action === 'version' && (cur.versions || []).some((v) => v.id === id)) {
      return res.status(200).json({ ok: true, known: true });
    }
    await storage.appendEvent(`${root}versions/${ts(now)}-${uuid()}.json`, ev);
    const { state, path } = await store.mutate(root, (s) => ({ versions: applyVersionEvent(s.versions, ev) }));
    res.setHeader('X-Store-Path', path);
    return res.status(200).json({ ok: true, versions: state.versions });
  }

  const tid = String(body.threadId || '');
  if (!/^[a-f0-9-]{36}$/.test(tid)) return res.status(404).json({ error: 'Thread not found' });
  const { state: cur } = await store.loadState(root);
  const existing = cur.threads.find((t) => t.id === tid);
  if (!existing || !canSee(role, existing)) return res.status(404).json({ error: 'Thread not found' });

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

  let patch;
  if (action === 'reply') {
    const text = clean(body.text, MAX_TEXT);
    if (!text) return res.status(400).json({ error: 'Missing text' });
    const img = await storeImages(tid, 'attach', body.images);
    const msg = { author, role, text, at: now, ...(img.length ? { img } : {}) };
    await storage.appendEvent(eventPath(tid), { type: 'msg', ...msg });
    patch = (s) => ({ threads: applyReply(s.threads, tid, msg) });
  } else if (action === 'edit') {
    const text = clean(body.text, MAX_TEXT);
    const target = Number(body.at);
    if (!text || !target) return res.status(400).json({ error: 'Missing text or target' });
    const msg = existing.messages.find((m) => m.at === target);
    if (!msg || msg.author !== author || msg.role !== role) {
      return res.status(403).json({ error: 'Not your message' });
    }
    await storage.appendEvent(eventPath(tid), { type: 'edit', at: now, target, text });
    patch = (s) => ({ threads: applyEdit(s.threads, tid, target, text) });
  } else if (action === 'resolve') {
    // v1 action: resolve ⇔ done, reopen ⇔ open (kept for old overlays).
    const resolved = Boolean(body.resolved);
    await storage.appendEvent(eventPath(tid), { type: 'state', at: now, status: resolved ? 'done' : 'open', author, role });
    patch = (s) => ({ threads: applyResolve(s.threads, tid, resolved, author, now) });
  } else if (action === 'status') {
    const status = String(body.status || '');
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Bad status' });
    if ((status === 'progress' || status === 'wont') && role !== 'designer') {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const note = clean(body.note, 200);
    if (status === 'wont' && !note) return res.status(400).json({ error: 'Reason required' });
    await storage.appendEvent(eventPath(tid), {
      type: 'state', at: now, status, ...(status === 'wont' ? { note } : {}), author, role,
    });
    patch = (s) => ({ threads: applyStatus(s.threads, tid, { status, note, author, at: now }) });
  } else if (action === 'kind') {
    if (role !== 'designer') return res.status(403).json({ error: 'Not allowed' });
    const kind = KINDS.includes(body.kind) ? body.kind : null;
    await storage.appendEvent(eventPath(tid), { type: 'state', at: now, kind: kind || 'none', author, role });
    patch = (s) => ({ threads: applyKind(s.threads, tid, kind) });
  } else if (action === 'react') {
    const emoji = String(body.emoji || '');
    const target = Number(body.at);
    const on = Boolean(body.on);
    if (!EMOJI.includes(emoji) || !existing.messages.some((m) => m.at === target)) {
      return res.status(400).json({ error: 'Bad reaction' });
    }
    await storage.appendEvent(eventPath(tid), { type: 'react', at: now, target, emoji, on, author, role });
    patch = (s) => ({ threads: applyReact(s.threads, tid, { target, emoji, on, author }) });
  } else if (action === 'delete') {
    const own = existing.authorRole === role && existing.author === author;
    if (role !== 'designer' && !own) return res.status(403).json({ error: 'Not allowed' });
    // Tombstone first, then purge the thread's content blobs (the tombstone
    // carries `now` in its pathname, so it survives the filter).
    await storage.appendEvent(eventPath(tid), { type: 'tomb', at: now });
    const old = await storage.listAll(`${root}threads/${tid}/`);
    await storage.delAll(old.filter((b) => !b.pathname.includes(ts(now))).map((b) => b.pathname));
    patch = (s) => ({ threads: applyDelete(s.threads, tid) });
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }

  const { state, path } = await store.mutate(root, patch);
  res.setHeader('X-Store-Path', path);
  if (action === 'delete') return res.status(200).json({ ok: true });
  return res.status(200).json({ thread: state.threads.find((t) => t.id === tid) });
}
