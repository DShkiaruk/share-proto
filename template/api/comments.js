import {
  clean, canSee, assemble, applyCreate, applyReply, applyEdit, applyResolve, applyDelete, navPatch,
} from '../lib/threads.js';
import { readJson, writeJson, appendEvent, readEvents, listAll, delAll, ConflictError } from '../lib/storage.js';
import { sessionFromHeaders } from '../lib/session.js';
import { applyCors, roomFromReq } from '../lib/cors.js';

/* Storage model (v2):
   - events are append-only blobs (source of truth):
       <root>threads/<tid>/<ts>-<uuid>.json   msg | state | edit | tomb
       <root>nav/e-<ts>-<uuid>.json            {from, to, anchor, at}
   - one document, <root>state.json = {v, threads, nav, updatedAt}, patched per
     mutation with optimistic concurrency (ETag ifMatch) and read with
     useCache:false. A poll is one read, no list(). Missing/corrupt document
     → rebuilt from events. Designer GET ?rebuild=1 forces that.
   <root> is '' for classic installs or rooms/<room>/ in embed mode. */

const MAX_TEXT = 3000;
const MAX_NAME = 40;
const PAD = 14;
const NAV_CAP = 500;
const ts = (at) => String(at).padStart(PAD, '0');
const uuid = () => crypto.randomUUID();

const emptyState = () => ({ v: 2, threads: [], nav: {}, updatedAt: 0 });

async function rebuild(root) {
  const [threadEvents, navBlobs] = await Promise.all([
    readEvents(`${root}threads/`),
    readEvents(`${root}nav/`),
  ]);
  const threads = assemble(threadEvents, root);
  let nav = {};
  for (const { data: e } of navBlobs.filter((b) => b.data).sort((a, b) => a.data.at - b.data.at)) {
    nav = navPatch(nav, e.from, e.to, e.anchor, e.at, NAV_CAP);
  }
  return { ...emptyState(), threads, nav, updatedAt: Date.now() };
}

async function loadState(root) {
  const { data, etag } = await readJson(`${root}state.json`);
  if (data && data.v === 2 && Array.isArray(data.threads)) return { state: data, etag };
  const state = await rebuild(root);
  await writeJson(`${root}state.json`, state).catch(() => {});
  return { state, etag: null };
}

// Apply a pure patch to the document; retry on ETag conflicts; fall back to a
// full rebuild (events already contain this mutation) if writers keep racing.
async function mutate(root, patch) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { state, etag } = await loadState(root);
    const next = { ...state, ...patch(state), updatedAt: Date.now() };
    try {
      await writeJson(`${root}state.json`, next, etag ? { ifMatch: etag } : {});
      return next;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  const rebuilt = await rebuild(root);
  await writeJson(`${root}state.json`, rebuilt);
  return rebuilt;
}

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
    let state;
    if (url.searchParams.get('rebuild') === '1' && role === 'designer') {
      state = await rebuild(root);
      await writeJson(`${root}state.json`, state);
    } else {
      ({ state } = await loadState(root));
    }
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

  if (action === 'edge') {
    const from = clean(body.from, 64);
    const to = clean(body.to, 64);
    const anchor = body.anchor && typeof body.anchor === 'object' ? body.anchor : null;
    if (!from || !to || from === to || !anchor || JSON.stringify(anchor).length > 3000) {
      return res.status(400).json({ error: 'Bad edge' });
    }
    await appendEvent(`${root}nav/e-${ts(now)}-${uuid()}.json`, { from, to, anchor, at: now });
    await mutate(root, (s) => ({ nav: navPatch(s.nav, from, to, anchor, now, NAV_CAP) }));
    return res.status(200).json({ ok: true });
  }

  if (action === 'create') {
    const text = clean(body.text, MAX_TEXT);
    if (!text) return res.status(400).json({ error: 'Missing text' });
    const tid = uuid();
    const first = {
      authorRole: role,
      screen: clean(body.screen, 64),
      screenLabel: clean(body.screenLabel, 120),
      anchor: body.anchor && typeof body.anchor === 'object' ? body.anchor : null,
      proto: clean(body.proto, 64) || null,
      page: clean(body.page, 200) || null,
    };
    const thread = {
      id: tid,
      createdAt: now,
      author,
      ...first,
      resolved: false,
      messages: [{ author, role, text, at: now }],
    };
    await appendEvent(`${root}threads/${tid}/${ts(now)}-${uuid()}.json`, {
      type: 'msg', at: now, author, role, text, first,
    });
    const state = await mutate(root, (s) => ({ threads: applyCreate(s.threads, thread) }));
    return res.status(200).json({ thread: state.threads.find((t) => t.id === tid) });
  }

  const tid = String(body.threadId || '');
  if (!/^[a-f0-9-]{36}$/.test(tid)) return res.status(404).json({ error: 'Thread not found' });
  const { state: cur } = await loadState(root);
  const existing = cur.threads.find((t) => t.id === tid);
  if (!existing || !canSee(role, existing)) return res.status(404).json({ error: 'Thread not found' });

  let patch;
  if (action === 'reply') {
    const text = clean(body.text, MAX_TEXT);
    if (!text) return res.status(400).json({ error: 'Missing text' });
    const msg = { author, role, text, at: now };
    await appendEvent(`${root}threads/${tid}/${ts(now)}-${uuid()}.json`, { type: 'msg', ...msg });
    patch = (s) => ({ threads: applyReply(s.threads, tid, msg) });
  } else if (action === 'edit') {
    const text = clean(body.text, MAX_TEXT);
    const target = Number(body.at);
    if (!text || !target) return res.status(400).json({ error: 'Missing text or target' });
    const msg = existing.messages.find((m) => m.at === target);
    if (!msg || msg.author !== author || msg.role !== role) {
      return res.status(403).json({ error: 'Not your message' });
    }
    await appendEvent(`${root}threads/${tid}/${ts(now)}-${uuid()}.json`, { type: 'edit', at: now, target, text });
    patch = (s) => ({ threads: applyEdit(s.threads, tid, target, text) });
  } else if (action === 'resolve') {
    const resolved = Boolean(body.resolved);
    await appendEvent(`${root}threads/${tid}/${ts(now)}-${uuid()}.json`, { type: 'state', at: now, resolved });
    patch = (s) => ({ threads: applyResolve(s.threads, tid, resolved) });
  } else if (action === 'delete') {
    const own = existing.authorRole === role && existing.author === author;
    if (role !== 'designer' && !own) return res.status(403).json({ error: 'Not allowed' });
    await appendEvent(`${root}threads/${tid}/${ts(now)}-${uuid()}.json`, { type: 'tomb', at: now });
    const old = await listAll(`${root}threads/${tid}/`);
    await delAll(old.filter((b) => !b.pathname.includes(ts(now))).map((b) => b.pathname));
    patch = (s) => ({ threads: applyDelete(s.threads, tid) });
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }

  const state = await mutate(root, patch);
  if (action === 'delete') return res.status(200).json({ ok: true });
  return res.status(200).json({ thread: state.threads.find((t) => t.id === tid) });
}
