import {
  clean, canSee, applyCreate, applyReply, applyEdit, applyResolve, applyDelete, navPatch,
  nextNumber, sanitizeTrail,
} from '../lib/threads.js';
import * as storage from '../lib/storage.js';
import { createStateStore } from '../lib/state.js';
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
      threads: state.threads.filter((t) => canSee(role, t)),
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const action = body.action;
  const now = Date.now();
  const eventPath = (tid) => `${root}threads/${tid}/${ts(now)}-${uuid()}.json`;

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
      page: clean(body.page, 300) || null,
      n: nextNumber(before.threads),
      trail: sanitizeTrail(body.trail),
    };
    const thread = {
      id: tid,
      createdAt: now,
      author,
      ...first,
      resolved: false,
      messages: [{ author, role, text, at: now }],
    };
    await storage.appendEvent(eventPath(tid), { type: 'msg', at: now, author, role, text, first });
    const { state, path } = await store.mutate(root, (s) => ({ threads: applyCreate(s.threads, thread) }));
    res.setHeader('X-Store-Path', path);
    return res.status(200).json({ thread: state.threads.find((t) => t.id === tid) });
  }

  const tid = String(body.threadId || '');
  if (!/^[a-f0-9-]{36}$/.test(tid)) return res.status(404).json({ error: 'Thread not found' });
  const { state: cur } = await store.loadState(root);
  const existing = cur.threads.find((t) => t.id === tid);
  if (!existing || !canSee(role, existing)) return res.status(404).json({ error: 'Thread not found' });

  let patch;
  if (action === 'reply') {
    const text = clean(body.text, MAX_TEXT);
    if (!text) return res.status(400).json({ error: 'Missing text' });
    const msg = { author, role, text, at: now };
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
    const resolved = Boolean(body.resolved);
    await storage.appendEvent(eventPath(tid), { type: 'state', at: now, resolved });
    patch = (s) => ({ threads: applyResolve(s.threads, tid, resolved) });
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
