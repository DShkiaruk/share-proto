/* Moving a room from one deployment to another.

   Replaying an export through the ordinary actions would not move the room: the
   server stamps the author from the session and the time from the clock, so
   every comment would come back written by whoever ran the move, dated today
   and renumbered. A room is its history — who said what, when, in what order,
   and under which number people refer to it on a call.

   So an import materialises threads verbatim. The price is that the whole
   payload is untrusted input, and it is checked here, once, for all three
   servers. The event-sourced edition (Vercel) additionally needs the history as
   events, because its document is derived and a later rebuild would otherwise
   erase whatever we wrote — `importEvents` produces a stream that assemble()
   folds back into the very same thread, which is what the round-trip test
   pins down. */

import { STATUSES, KINDS, EMOJI, THREAD_ID, clean, sanitizeTrail, sanitizeTheme, sanitizePage, isResolvedStatus } from './threads.js';
import { applyVersionEvent, applyShot, applyMapMeta } from './state.js';

const MAX_TEXT = 3000;
export const MAX_IMPORT_THREADS = 200;
const MAX_MESSAGES = 300;

const ID = THREAD_ID;
// The same shape template/api/file.js will serve, so an import cannot smuggle
// in a path the media endpoint would refuse (or, worse, one it would not).
const MEDIA = /^(previews|attach|shots)\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,80}\.(jpe?g|png|webp)$/;

const int = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
const role = (r) => (r === 'client' || r === 'designer' ? r : null);
const media = (p) => (typeof p === 'string' && MEDIA.test(p) ? p : null);
const mediaList = (v) => (Array.isArray(v) ? v.map(media).filter(Boolean).slice(0, 3) : []);

function sanitizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = int(raw.at);
  const r = role(raw.role);
  const author = clean(raw.author, 60);
  const text = clean(raw.text, MAX_TEXT);
  if (!at || !r || !author) return null;
  const img = mediaList(raw.img);
  const reactions = {};
  for (const [emoji, who] of Object.entries(raw.reactions || {})) {
    if (!EMOJI.includes(emoji) || !Array.isArray(who)) continue;
    const names = [...new Set(who.map((w) => clean(w, 60)).filter(Boolean))].slice(0, 50);
    if (names.length) reactions[emoji] = names;
  }
  return {
    author,
    role: r,
    text,
    at,
    ...(img.length ? { img } : {}),
    ...(raw.edited ? { edited: true } : {}),
    ...(Object.keys(reactions).length ? { reactions } : {}),
  };
}

function sanitizeThread(raw) {
  if (!raw || typeof raw !== 'object' || !ID.test(String(raw.id || ''))) return null;
  const createdAt = int(raw.createdAt);
  const authorRole = role(raw.authorRole);
  if (!createdAt || !authorRole) return null;
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .slice(0, MAX_MESSAGES)
    .map(sanitizeMessage)
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
  if (!messages.length) return null;

  const history = (Array.isArray(raw.history) ? raw.history : [])
    .map((h) => {
      const at = int(h?.at);
      const status = STATUSES.includes(h?.status) ? h.status : null;
      if (!at || !status) return null;
      return {
        at,
        status,
        note: status === 'wont' ? clean(h.note, 200) || null : null,
        author: clean(h.author, 60) || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
  const status = history.length ? history.at(-1).status : 'open';
  const anchor = raw.anchor && typeof raw.anchor === 'object' ? raw.anchor : null;

  return {
    id: raw.id,
    createdAt,
    authorRole,
    author: clean(raw.author, 60) || messages[0].author,
    screen: clean(raw.screen, 64),
    screenLabel: clean(raw.screenLabel, 120),
    anchor: JSON.stringify(anchor || {}).length > 4000 ? null : anchor,
    proto: clean(raw.proto, 80) || null,
    page: sanitizePage(raw.page),
    n: Number.isInteger(raw.n) && raw.n > 0 ? raw.n : null,
    trail: sanitizeTrail(raw.trail),
    theme: sanitizeTheme(raw.theme),
    status,
    statusNote: status === 'wont' ? history.at(-1).note : null,
    kind: KINDS.includes(raw.kind) ? raw.kind : null,
    history,
    resolved: isResolvedStatus(status),
    preview: media(raw.preview),
    messages,
  };
}

/* Pictures travel one per request: a room's media is far larger than any
   platform's body limit, and one file per call also means a failed transfer
   costs one retry rather than the whole move. */
export function importFile(raw) {
  const path = media(raw?.path);
  return path && typeof raw.image === 'string' ? { path, image: raw.image } : null;
}

export function sanitizeImport(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const threads = (Array.isArray(src.threads) ? src.threads : [])
    .slice(0, MAX_IMPORT_THREADS)
    .map(sanitizeThread)
    .filter(Boolean);

  const nav = {};
  for (const [key, v] of Object.entries(src.nav || {})) {
    if (!/^[^>]{1,120}>[^>]{1,120}$/.test(key) || !v || typeof v !== 'object') continue;
    // An export hands nav back as either the public shape (the anchor itself)
    // or the stored one ({anchor, at, trail}); both arrive here.
    const anchor = v.anchor && typeof v.anchor === 'object' ? v.anchor : v.path || v.t ? v : null;
    if (!anchor) continue;
    nav[key] = { anchor, at: int(v.at) || 1, ...(sanitizeTrail(v.trail).length ? { trail: sanitizeTrail(v.trail) } : {}) };
  }

  const versions = (Array.isArray(src.versions) ? src.versions : [])
    .map((v) => {
      const id = clean(v?.id, 80);
      // A deployment hands versions out as {id, firstSeen, label}; an older
      // export said `at`. Take whichever is there.
      return id ? { id, label: clean(v.label, 60) || null, at: int(v.firstSeen) || int(v.at) || 1 } : null;
    })
    .filter(Boolean)
    .slice(0, 100);

  const shots = {};
  for (const [label, p] of Object.entries(src.shots || {})) {
    const path = media(p);
    if (path && label) shots[clean(label, 120)] = path;
  }

  const mapmeta = { aliases: {}, hidden: [] };
  for (const [label, name] of Object.entries(src.mapmeta?.aliases || {})) {
    const n = clean(name, 60);
    if (label && n) mapmeta.aliases[clean(label, 120)] = n;
  }
  for (const label of Array.isArray(src.mapmeta?.hidden) ? src.mapmeta.hidden : []) {
    const l = clean(label, 120);
    if (l) mapmeta.hidden.push(l);
  }

  return { threads, nav, versions, shots, mapmeta };
}

/* The same history, as the append-only events the Blob edition rebuilds from.
   `seq` keeps pathnames unique and ordered when two things share a millisecond;
   they are deterministic, so re-running an import writes nothing new. */
export function importEvents(data, root = '') {
  const out = [];
  const ts = (at) => String(at).padStart(14, '0');
  for (const t of data.threads) {
    let seq = 0;
    const path = (at) => `${root}threads/${t.id}/${ts(at)}-imp-${String(seq++).padStart(3, '0')}.json`;
    const [head, ...rest] = t.messages;
    out.push({
      pathname: path(head.at),
      data: {
        type: 'msg',
        at: head.at,
        author: head.author,
        role: head.role,
        text: head.text,
        ...(head.img ? { img: head.img } : {}),
        first: {
          authorRole: t.authorRole,
          screen: t.screen,
          screenLabel: t.screenLabel,
          anchor: t.anchor,
          proto: t.proto,
          page: t.page,
          n: t.n,
          trail: t.trail,
          theme: t.theme,
          kind: t.kind,
        },
      },
    });
    for (const m of rest) {
      out.push({
        pathname: path(m.at),
        data: { type: 'msg', at: m.at, author: m.author, role: m.role, text: m.text, ...(m.img ? { img: m.img } : {}) },
      });
    }
    // An edit only carries the text it left behind, so replaying it with that
    // same text is what restores the "· edited" mark.
    for (const m of t.messages) {
      if (m.edited) out.push({ pathname: path(m.at), data: { type: 'edit', at: m.at, target: m.at, text: m.text } });
    }
    for (const m of t.messages) {
      for (const [emoji, who] of Object.entries(m.reactions || {})) {
        for (const author of who) {
          out.push({ pathname: path(m.at), data: { type: 'react', at: m.at, target: m.at, emoji, on: true, author } });
        }
      }
    }
    for (const h of t.history) {
      out.push({
        pathname: path(h.at),
        data: { type: 'state', at: h.at, status: h.status, ...(h.note ? { note: h.note } : {}), ...(h.author ? { author: h.author } : {}) },
      });
    }
    if (t.preview) {
      const at = (t.messages.at(-1)?.at || t.createdAt) + 1;
      out.push({ pathname: path(at), data: { type: 'state', at, preview: t.preview } });
    }
  }
  let i = 0;
  for (const [key, edge] of Object.entries(data.nav)) {
    const [from, to] = key.split('>');
    out.push({
      pathname: `${root}nav/e-${ts(edge.at)}-imp-${String(i++).padStart(3, '0')}.json`,
      data: { from, to, anchor: edge.anchor, at: edge.at, ...(edge.trail ? { trail: edge.trail } : {}) },
    });
  }
  for (const [j, v] of data.versions.entries()) {
    out.push({
      pathname: `${root}versions/${ts(v.at)}-imp-${String(j).padStart(3, '0')}.json`,
      data: { id: v.id, at: v.at, ...(v.label ? { label: v.label } : {}) },
    });
  }
  let k = 0;
  for (const [label, path_] of Object.entries(data.shots)) {
    out.push({ pathname: `${root}shotlog/${ts(1)}-imp-${String(k++).padStart(3, '0')}.json`, data: { label, path: path_, at: 1 } });
  }
  let m = 0;
  for (const [label, name] of Object.entries(data.mapmeta.aliases)) {
    out.push({ pathname: `${root}mapmeta/${ts(1)}-imp-${String(m++).padStart(3, '0')}.json`, data: { alias: { label, name }, at: 1 } });
  }
  for (const label of data.mapmeta.hidden) {
    out.push({ pathname: `${root}mapmeta/${ts(1)}-imp-${String(m++).padStart(3, '0')}.json`, data: { hide: label, at: 1 } });
  }
  return out;
}

/* Everything in a room that is not a thread, folded onto what is already there.
   The three servers keep this in different shapes underneath, so the folding
   itself lives here — otherwise each edition ends up with its own idea of what
   a merge means. */
export function mergeImport(state, data) {
  const versions = data.versions.reduce((acc, v) => applyVersionEvent(acc, { id: v.id, at: v.at, ...(v.label ? { label: v.label } : {}) }), state.versions || []);
  const shots = Object.entries(data.shots).reduce((acc, [label, path]) => applyShot(acc, { label, path }), state.shots || {});
  let mapmeta = state.mapmeta || { aliases: {}, hidden: [] };
  for (const [label, name] of Object.entries(data.mapmeta.aliases)) mapmeta = applyMapMeta(mapmeta, { alias: { label, name } });
  for (const label of data.mapmeta.hidden) mapmeta = applyMapMeta(mapmeta, { hide: label });
  // An edge already learned here is at least as true as an imported one.
  return { nav: { ...data.nav, ...(state.nav || {}) }, versions, shots, mapmeta };
}
