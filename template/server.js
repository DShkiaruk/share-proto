#!/usr/bin/env node
/* Local share-proto server — the no-Vercel mode.

   Same contracts as the deployed version (middleware.js + api/*): password
   login with two roles, signed session cookie, /api/comments with
   server-enforced role filtering. But self-contained: plain Node >= 18,
   zero npm dependencies, comments stored in data/comments.json.

   The append-only event log in api/comments.js exists only to dodge Vercel
   Blob's CDN cache; locally there is no CDN, so a single JSON file written
   atomically (tmp + rename) is the honest equivalent.

   Usage:
     node server.js [--port 3456] [--spa]

   --spa serves index.html for extension-less paths that don't exist on disk
   (client-side routing in app builds).

   Share beyond localhost (link dies with the process):
     cloudflared tunnel --url http://localhost:3456 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto; // Node 18

const { createToken, sessionFromHeaders } = await import('./lib/session.js');
const { applyCors, roomFromReq } = await import('./lib/cors.js');
const { clean, canSee, assignNumbers, nextNumber, sanitizeTrail, sanitizePage, applyStatus, applyResolve, applyKind, applyReact, STATUSES, KINDS, EMOJI } = await import('./lib/threads.js');
const { applyVersionEvent } = await import('./lib/state.js');
const { parseImages, parseImageDataUrl } = await import('./lib/media.js');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const COMMENTS_FILE = path.join(DATA, 'comments.json');
const FILES = path.join(DATA, 'files'); // previews/, attach/ (same pathnames as the Blob edition)

const argv = process.argv.slice(2);
const portFlag = argv.indexOf('--port');
const PORT = Number(
  (portFlag >= 0 && argv[portFlag + 1]) || process.env.PORT || 3456
);
const SPA = argv.includes('--spa');

const MAX_TEXT = 3000;
const MAX_NAME = 40;
const NAV_CAP = 500;
const SIXTY_DAYS_S = 60 * 24 * 60 * 60;


/* ---------- secrets: generated on first run, env vars override ---------- */

fs.mkdirSync(DATA, { recursive: true });

function loadSecrets() {
  const file = path.join(DATA, 'secrets.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first run */
  }
  const base = path.basename(ROOT).replace(/-share$/, '') || 'proto';
  const secrets = {
    designerPassword:
      process.env.DESIGNER_PASSWORD ||
      saved.designerPassword ||
      `${base}-team-${randomBytes(2).toString('hex')}`,
    clientPassword:
      process.env.CLIENT_PASSWORD ||
      saved.clientPassword ||
      `${base}-client-${randomBytes(2).toString('hex')}`,
    sessionSecret:
      process.env.SESSION_SECRET || saved.sessionSecret || randomBytes(32).toString('hex'),
  };
  // Persist so passwords and sessions survive restarts.
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2) + '\n');
  return secrets;
}

const SECRETS = loadSecrets();

/* ---------- storage: in-memory, atomic JSON persistence ---------- */

// Rooms partition comments (one per PR preview in embed mode); classic
// same-origin traffic lives in room "_". Old flat files migrate on load.
let store = { rooms: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(COMMENTS_FILE, 'utf8'));
  if (loaded.rooms && typeof loaded.rooms === 'object') {
    store.rooms = loaded.rooms;
  } else if (Array.isArray(loaded.threads)) {
    store.rooms['_'] = { threads: loaded.threads, nav: loaded.nav || {} };
  }
} catch {
  /* first run */
}
// Numbers are global per room; legacy threads get theirs in createdAt order.
for (const room of Object.values(store.rooms)) {
  room.threads = assignNumbers(room.threads || []).map((t) => ({ status: t.resolved ? 'done' : 'open', history: [], kind: null, ...t }));
  room.versions ||= [];
}

function roomStore(room) {
  const key = room || '_';
  return (store.rooms[key] ||= { threads: [], nav: {}, versions: [] });
}

let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain
    .then(async () => {
      const tmp = path.join(DATA, `.comments-${process.pid}.tmp`);
      await fsp.writeFile(tmp, JSON.stringify(store, null, 1));
      await fsp.rename(tmp, COMMENTS_FILE);
    })
    .catch((e) => console.error('persist failed:', e.message));
  return writeChain;
}

/* ---------- media files ---------- */

const SAFE_FILE = /^(previews|attach|shots)\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,80}\.(jpe?g|png|webp)$/;
const MIME_IMG = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function putFileLocal(room, rel, buf) {
  const file = path.join(FILES, room ? `rooms/${room}/` : '', rel);
  if (!file.startsWith(FILES + path.sep)) throw new Error('bad path');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, buf);
}

async function storeImagesLocal(room, tid, kind, images, now) {
  const paths = [];
  for (const [i, img] of parseImages(images).entries()) {
    const rel = `${kind}/${tid}/${String(now).padStart(14, '0')}-${i}.${img.ext}`;
    await putFileLocal(room, rel, img.buf);
    paths.push(rel);
  }
  return paths;
}

/* ---------- helpers ---------- */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { // three 1.5 MB images as base64
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function setSessionCookie(req, res, token, maxAge) {
  const proto = String(req.headers['x-forwarded-proto'] || '');
  const secure = proto.includes('https') ? ' Secure;' : '';
  res.setHeader(
    'Set-Cookie',
    `fp_session=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`
  );
}

/* ---------- api handlers (contracts mirror api/*.js) ---------- */

async function apiLogin(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const body = (await readBody(req)) || {};
  const cleanName = clean(body.name, MAX_NAME);
  if (!cleanName) return json(res, 400, { error: 'Missing name' });
  const password = body.password;
  const role =
    password && password === SECRETS.designerPassword
      ? 'designer'
      : password && password === SECRETS.clientPassword
        ? 'client'
        : null;
  if (!role) {
    await new Promise((r) => setTimeout(r, 800));
    return json(res, 401, { error: 'Wrong password' });
  }
  const token = await createToken(
    { r: role, n: cleanName, exp: Date.now() + SIXTY_DAYS_S * 1000 },
    SECRETS.sessionSecret
  );
  setSessionCookie(req, res, token, SIXTY_DAYS_S);
  // Token in the body too: embed mode (overlay on a foreign page) can't use
  // cross-site cookies and sends it back as a Bearer header.
  return json(res, 200, { role, token });
}

function apiLogout(req, res) {
  setSessionCookie(req, res, '', 0);
  res.writeHead(302, { Location: '/' });
  res.end();
}

async function apiComments(req, res, session) {
  const role = session.r;
  const S = roomStore(roomFromReq(req));
  // Author identity comes from the signed session, never from the body —
  // role filtering is only as trustworthy as authorship (same as api/comments.js).
  const author = clean(session.n, MAX_NAME) || (role === 'designer' ? 'Designer' : 'Client');

  if (req.method === 'GET') {
    const nav = {};
    for (const [k, v] of Object.entries(S.nav)) nav[k] = v.anchor;
    const navAt = {};
    for (const [k, v] of Object.entries(S.nav)) navAt[k] = v.at;
    return json(res, 200, {
      role,
      name: author,
      nav,
      navAt,
      versions: S.versions || [],
      threads: S.threads.filter((t) => canSee(role, t)),
    });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const body = (await readBody(req)) || {};
  const action = body.action;
  const now = Date.now();
  const room = roomFromReq(req);

  if (action === 'edge') {
    const from = clean(body.from, 64);
    const to = clean(body.to, 64);
    const anchor = body.anchor && typeof body.anchor === 'object' ? body.anchor : null;
    if (!from || !to || from === to || !anchor || JSON.stringify(anchor).length > 3000) {
      return json(res, 400, { error: 'Bad edge' });
    }
    S.nav[`${from}>${to}`] = { anchor, at: now };
    const keys = Object.keys(S.nav);
    if (keys.length > NAV_CAP) {
      keys.sort((a, b) => S.nav[a].at - S.nav[b].at);
      while (keys.length > NAV_CAP) delete S.nav[keys.shift()];
    }
    await persist();
    return json(res, 200, { ok: true });
  }

  if (action === 'create') {
    const text = clean(body.text, MAX_TEXT);
    if (!text) return json(res, 400, { error: 'Missing text' });
    if (JSON.stringify(body.anchor || {}).length > 4000) return json(res, 400, { error: 'Anchor too large' });
    const thread = {
      id: crypto.randomUUID(),
      createdAt: now,
      authorRole: role,
      author,
      screen: clean(body.screen, 64),
      screenLabel: clean(body.screenLabel, 120),
      anchor: body.anchor && typeof body.anchor === 'object' ? body.anchor : null,
      proto: clean(body.proto, 64) || null,
      page: sanitizePage(body.page),
      n: Math.max(nextNumber(S.threads), (S.maxN || 0) + 1),
      trail: sanitizeTrail(body.trail),
      kind: KINDS.includes(body.kind) ? body.kind : null,
      status: 'open',
      history: [],
      resolved: false,
      preview: null,
      messages: [{ author, role, text, at: now }],
    };
    const img = await storeImagesLocal(room, thread.id, 'attach', body.images, now);
    if (img.length) thread.messages[0].img = img;
    S.threads = assignNumbers([...S.threads, thread]);
    S.maxN = Math.max(S.maxN || 0, ...S.threads.map((t) => t.n || 0));
    await persist();
    return json(res, 200, { thread: S.threads.find((t) => t.id === thread.id) });
  }

  if (action === 'version' || action === 'version-label') {
    const id = String(body.id || '');
    if (!/^[A-Za-z0-9"/_.:-]{1,80}$/.test(id)) return json(res, 400, { error: 'Bad version id' });
    if (action === 'version-label' && role !== 'designer') return json(res, 403, { error: 'Not allowed' });
    S.versions ||= [];
    if (action === 'version' && S.versions.some((v) => v.id === id)) return json(res, 200, { ok: true, known: true });
    S.versions = applyVersionEvent(S.versions, action === 'version' ? { id, at: now } : { id, label: clean(body.label, 60), at: now });
    await persist();
    return json(res, 200, { ok: true, versions: S.versions });
  }

  const tid = String(body.threadId || '');
  if (!/^[a-f0-9-]{36}$/.test(tid)) return json(res, 404, { error: 'Thread not found' });
  const thread = S.threads.find((t) => t.id === tid);
  if (!thread || !canSee(role, thread)) {
    return json(res, 404, { error: 'Thread not found' });
  }

  if (action === 'preview') {
    const own = thread.author === author && thread.authorRole === role;
    if (!own && role !== 'designer') return json(res, 403, { error: 'Not allowed' });
    const img = parseImageDataUrl(body.image);
    if (!img) return json(res, 400, { error: 'Bad image' });
    const rel = `previews/${tid}/${String(now).padStart(14, '0')}.${img.ext}`;
    await putFileLocal(room, rel, img.buf);
    thread.preview = rel;
    await persist();
    return json(res, 200, { preview: rel });
  }

  if (action === 'reply') {
    const text = clean(body.text, MAX_TEXT);
    if (!text) return json(res, 400, { error: 'Missing text' });
    const img = await storeImagesLocal(room, tid, 'attach', body.images, now);
    thread.messages.push({ author, role, text, at: now, ...(img.length ? { img } : {}) });
  } else if (action === 'edit') {
    const text = clean(body.text, MAX_TEXT);
    const target = Number(body.at);
    if (!text || !target) return json(res, 400, { error: 'Missing text or target' });
    const msg = thread.messages.find((m) => m.at === target);
    if (!msg || msg.author !== author || msg.role !== role) {
      return json(res, 403, { error: 'Not your message' });
    }
    msg.text = text;
    msg.edited = true;
  } else if (action === 'resolve') {
    S.threads = applyResolve(S.threads, tid, Boolean(body.resolved), author, now);
  } else if (action === 'status') {
    const status = String(body.status || '');
    if (!STATUSES.includes(status)) return json(res, 400, { error: 'Bad status' });
    if ((status === 'progress' || status === 'wont') && role !== 'designer') return json(res, 403, { error: 'Not allowed' });
    const note = clean(body.note, 200);
    if (status === 'wont' && !note) return json(res, 400, { error: 'Reason required' });
    S.threads = applyStatus(S.threads, tid, { status, note, author, at: now });
  } else if (action === 'kind') {
    if (role !== 'designer') return json(res, 403, { error: 'Not allowed' });
    S.threads = applyKind(S.threads, tid, KINDS.includes(body.kind) ? body.kind : null);
  } else if (action === 'react') {
    const emoji = String(body.emoji || '');
    const target = Number(body.at);
    if (!EMOJI.includes(emoji) || !thread.messages.some((m) => m.at === target)) return json(res, 400, { error: 'Bad reaction' });
    S.threads = applyReact(S.threads, tid, { target, emoji, on: Boolean(body.on), author });
  } else if (action === 'delete') {
    const own = thread.authorRole === role && thread.author === author;
    if (role !== 'designer' && !own) return json(res, 403, { error: 'Not allowed' });
    S.threads = S.threads.filter((t) => t.id !== tid);
    await persist();
    return json(res, 200, { ok: true });
  } else {
    return json(res, 400, { error: 'Unknown action' });
  }

  await persist();
  return json(res, 200, { thread: S.threads.find((t) => t.id === tid) });
}

/* ---------- static files ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

function resolveFile(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  let file = path.normalize(path.join(PUBLIC, rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return null; // traversal
  let st = fs.statSync(file, { throwIfNoEntry: false });
  if (st?.isDirectory()) {
    file = path.join(file, 'index.html');
    st = fs.statSync(file, { throwIfNoEntry: false });
  }
  if (!st && SPA && !path.extname(rel)) {
    file = path.join(PUBLIC, 'index.html');
    st = fs.statSync(file, { throwIfNoEntry: false });
  }
  return st?.isFile() ? { file, st } : null;
}

function sendFile(req, res, file, st, status = 200) {
  const ext = path.extname(file).toLowerCase();
  const isHtml = ext === '.html';
  const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // Reviews iterate fast; correctness beats caching. ETag keeps it cheap.
    'Cache-Control': isHtml ? 'no-store' : 'no-cache',
    ETag: etag,
  };
  if (status === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['Content-Length'] = st.size;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ---------- server ---------- */

const OPEN_PATHS = new Set(['/login.html', '/favicon.svg']);

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://local').pathname;

    if (pathname.startsWith('/api/')) {
      if (applyCors(req, res, process.env.ALLOWED_ORIGINS)) return;
    }
    if (pathname === '/api/login') return await apiLogin(req, res);
    if (pathname === '/api/logout') return apiLogout(req, res);

    const session = await sessionFromHeaders(
      req.headers.cookie || '',
      req.headers.authorization || '',
      SECRETS.sessionSecret
    );

    if (pathname === '/api/comments') {
      if (!session) return json(res, 401, { error: 'Not authenticated' });
      return await apiComments(req, res, session);
    }
    if (pathname === '/api/file') {
      const u = new URL(req.url, 'http://local');
      const token = u.searchParams.get('token');
      const s2 = session || (await sessionFromHeaders('', token ? `Bearer ${token}` : '', SECRETS.sessionSecret));
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
      res.writeHead(200, {
        'Content-Type': MIME_IMG[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      return fs.createReadStream(file).pipe(res);
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

    // Overlay assets are loaded cross-origin by embedded installs (script/link
    // tags don't need CORS, but the overlay's HEAD version-check does).
    if (pathname === '/overlay.js' || pathname === '/overlay.css') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'ETag');
      const hit = resolveFile(pathname);
      if (hit) return sendFile(req, res, hit.file, hit.st);
    }

    if (!session && !OPEN_PATHS.has(pathname)) {
      // Same behavior as middleware.js: rewrite (not redirect) to the login
      // page so deep links like /?comment=<id> survive the login round-trip.
      const login = resolveFile('/login.html');
      if (!login) return json(res, 500, { error: 'login.html missing' });
      return sendFile(req, res, login.file, login.st);
    }

    const hit = resolveFile(pathname);
    if (!hit) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    return sendFile(req, res, hit.file, hit.st);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`
  share-proto local server ${SPA ? '(SPA mode)' : ''}

  Local URL:        http://localhost:${PORT}
  Team password:    ${SECRETS.designerPassword}
  Client password:  ${SECRETS.clientPassword}

  Comments live in  data/comments.json  (delete the file to wipe)
  Share online:     cloudflared tunnel --url http://localhost:${PORT}
                    (temporary link; dies when you stop the process)
`);
});
