/* One comment room's data and rules — the v2 API contract, minus HTTP.

   A Durable Object is single-threaded, so this needs none of the optimistic
   concurrency the Blob edition carries: it is the local server's model
   (template/server.js) with per-key persistence instead of one JSON file.
   `storage` is injected — { get, put, delete, list } — so the rules are
   unit-testable against a Map (tests/unit/room.test.mjs).

   Keys:
     t:<tid>     one thread            n:<from>><to>  one learned nav edge
     f:<rel>     one image (Uint8Array; rel is the same pathname the Vercel
                 and local editions use, so /api/file?p=… is identical)
     versions | shots | mapmeta | meta ({maxN, bytes})

   Nothing is stored under a key whose value can grow without bound: DO storage
   caps key+value at 2 MB, and an image is capped at 1.5 MB by lib/media.js. */

import {
  clean, canSee, assignNumbers, nextNumber, sanitizeTrail, sanitizePage,
  applyStatus, applyResolve, applyKind, applyReact, applyTrail, STATUSES, KINDS, EMOJI,
} from '../../template/lib/threads.js';
import { applyShot, applyMapMeta, applyVersionEvent, labelKey } from '../../template/lib/state.js';
import { parseImages, parseImageDataUrl } from '../../template/lib/media.js';

const MAX_TEXT = 3000;
const NAV_CAP = 500;
const MAX_SHOTS = 200;
const MAX_VERSIONS = 100;
const VERSION_ID = /^[A-Za-z0-9"/_.:-]{1,80}$/;
const TID_RE = /^[a-f0-9-]{36}$/;
const SAFE_FILE = /^(previews|attach|shots)\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,80}\.(jpe?g|png|webp)$/;
const MIME_IMG = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const pad = (n) => String(n).padStart(14, '0');
const ok = (payload) => ({ status: 200, payload });
const err = (status, error) => ({ status, payload: { error } });
const uuid = () => crypto.randomUUID();

export class Room {
  // mediaBudget caps what one room can store. A review room is a handful of
  // screenshots; the cap is what stops a runaway crawl from eating the account.
  constructor(storage, { mediaBudget = 64 * 1024 * 1024 } = {}) {
    this.s = storage;
    this.mediaBudget = mediaBudget;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const [threadRows, edgeRows, versions, shots, mapmeta, meta] = await Promise.all([
      this.s.list({ prefix: 't:' }),
      this.s.list({ prefix: 'n:' }),
      this.s.get('versions'),
      this.s.get('shots'),
      this.s.get('mapmeta'),
      this.s.get('meta'),
    ]);
    this.threads = [...threadRows.values()].filter(Boolean);
    this.nav = {};
    for (const [key, value] of edgeRows) if (value?.anchor) this.nav[key.slice(2)] = value;
    this.versions = Array.isArray(versions) ? versions : [];
    this.shots = shots || {};
    this.mapmeta = mapmeta || { aliases: {}, hidden: [] };
    this.meta = meta || { maxN: 0, bytes: 0 };
    await this.migrate();
    this.loaded = true;
  }

  // A room the v1 worker wrote: nav lived under a single `nav` key and threads
  // had no number, status, kind, page or trail. Convert once, in place, so an
  // upgraded deployment keeps every comment it had.
  async migrate() {
    const legacyNav = await this.s.get('nav');
    if (legacyNav && typeof legacyNav === 'object') {
      for (const [key, value] of Object.entries(legacyNav)) {
        if (!this.nav[key] && value?.anchor) {
          this.nav[key] = value;
          await this.s.put(`n:${key}`, value);
        }
      }
      await this.s.delete('nav');
    }
    this.threads.sort((a, b) => a.createdAt - b.createdAt);
    // Spread first, then fill the gaps: an already-v2 thread comes out
    // byte-identical, so a cold start does not rewrite the whole room.
    const upgraded = assignNumbers(this.threads).map((t) => ({
      ...t,
      status: t.status || (t.resolved ? 'done' : 'open'),
      history: t.history || [],
      kind: t.kind ?? null,
      page: t.page ?? null,
      trail: t.trail || [],
      preview: t.preview ?? null,
    }));
    for (const [i, t] of upgraded.entries()) {
      if (JSON.stringify(t) !== JSON.stringify(this.threads[i])) await this.s.put(`t:${t.id}`, t);
    }
    this.threads = upgraded;
    const maxN = Math.max(this.meta.maxN || 0, 0, ...this.threads.map((t) => t.n || 0));
    if (maxN !== this.meta.maxN) await this.setMeta({ maxN });
  }

  async setMeta(patch) {
    this.meta = { ...this.meta, ...patch };
    await this.s.put('meta', this.meta);
  }

  async saveThread(tid) {
    const t = this.threads.find((x) => x.id === tid);
    if (t) await this.s.put(`t:${tid}`, t);
    return t;
  }

  // assignNumbers() can renumber a neighbour, not just the new thread; persist
  // whatever actually changed.
  async saveChanged(before) {
    const was = new Map(before.map((t) => [t.id, JSON.stringify(t)]));
    for (const t of this.threads) {
      if (was.get(t.id) !== JSON.stringify(t)) await this.s.put(`t:${t.id}`, t);
    }
  }

  /* ---------- media ---------- */

  fits(bytes) {
    return (this.meta.bytes || 0) + bytes <= this.mediaBudget;
  }

  async putFile(rel, buf) {
    // A fresh copy: a Uint8Array view can sit on a much larger pooled buffer,
    // and structured clone would store all of it.
    await this.s.put(`f:${rel}`, new Uint8Array(buf));
    await this.setMeta({ bytes: (this.meta.bytes || 0) + buf.byteLength });
  }

  async delFile(rel) {
    const cur = await this.s.get(`f:${rel}`);
    if (!cur) return;
    await this.s.delete(`f:${rel}`);
    await this.setMeta({ bytes: Math.max(0, (this.meta.bytes || 0) - cur.byteLength) });
  }

  async delFilesUnder(prefix) {
    const rows = await this.s.list({ prefix: `f:${prefix}` });
    let freed = 0;
    for (const [key, value] of rows) {
      await this.s.delete(key);
      freed += value?.byteLength || 0;
    }
    if (rows.size) await this.setMeta({ bytes: Math.max(0, (this.meta.bytes || 0) - freed) });
  }

  // Takes already-parsed images: decoding a 1.5 MB attachment twice (once to
  // size it, once to store it) is real CPU on a Workers free-plan invocation.
  async storeImages(tid, kind, imgs, now) {
    const paths = [];
    for (const [i, img] of imgs.entries()) {
      const rel = `${kind}/${tid}/${pad(now)}-${i}-${uuid().slice(0, 8)}.${img.ext}`;
      await this.putFile(rel, img.buf);
      paths.push(rel);
    }
    return paths;
  }

  // Screens the designer hid are dropped from a client's copy of the map.
  visibleShots(role) {
    if (role === 'designer') return this.shots;
    const hidden = new Set(this.mapmeta?.hidden || []);
    return Object.fromEntries(Object.entries(this.shots).filter(([label]) => !hidden.has(label)));
  }

  /* ---------- reads ---------- */

  async get(role, author) {
    await this.load();
    const nav = {};
    const navAt = {};
    const navTrail = {};
    for (const [k, v] of Object.entries(this.nav)) {
      nav[k] = v.anchor;
      navAt[k] = v.at;
      if (v.trail?.length) navTrail[k] = v.trail;
    }
    return {
      v: 2,
      role,
      name: author,
      nav,
      navAt,
      navTrail,
      versions: this.versions,
      shots: this.visibleShots(role),
      mapmeta:
        role === 'designer'
          ? this.mapmeta
          : { aliases: this.mapmeta?.aliases || {}, hidden: [] },
      threads: this.threads.filter((t) => canSee(role, t)),
    };
  }

  // Private media behind the session — same rules as template/api/file.js.
  async file(role, rel) {
    await this.load();
    if (!SAFE_FILE.test(rel)) return err(400, 'Bad path');
    const [kind, key] = rel.split('/');
    if (kind === 'shots') {
      if (role !== 'designer' && (this.mapmeta?.hidden || []).map(labelKey).includes(key)) {
        return err(404, 'Not found');
      }
    } else {
      const thread = this.threads.find((t) => t.id === key);
      if (!thread || !canSee(role, thread)) return err(404, 'Not found');
    }
    const bytes = await this.s.get(`f:${rel}`);
    if (!bytes) return err(404, 'Not found');
    return { status: 200, bytes, contentType: MIME_IMG[rel.split('.').pop().toLowerCase()] };
  }

  /* ---------- writes ---------- */

  async post(role, author, body) {
    await this.load();
    const action = body.action;
    const now = Date.now();

    if (Array.isArray(body.images) && (body.images.length > 3 || body.images.some((x) => !parseImageDataUrl(x)))) {
      return err(400, 'Bad image');
    }

    if (action === 'edge') {
      const from = clean(body.from, 64);
      const to = clean(body.to, 64);
      const anchor = body.anchor && typeof body.anchor === 'object' ? body.anchor : null;
      if (!from || !to || from === to || !anchor || JSON.stringify(anchor).length > 3000) {
        return err(400, 'Bad edge');
      }
      const key = `${from}>${to}`;
      const edgeTrail = sanitizeTrail(body.trail);
      const keep = edgeTrail.length ? edgeTrail : this.nav[key]?.trail || [];
      this.nav[key] = { anchor, at: now, ...(keep.length ? { trail: keep } : {}) };
      await this.s.put(`n:${key}`, this.nav[key]);
      const keys = Object.keys(this.nav);
      if (keys.length > NAV_CAP) {
        keys.sort((a, b) => this.nav[a].at - this.nav[b].at);
        while (keys.length > NAV_CAP) {
          const drop = keys.shift();
          delete this.nav[drop];
          await this.s.delete(`n:${drop}`);
        }
      }
      return ok({ ok: true });
    }

    if (action === 'create') {
      const text = clean(body.text, MAX_TEXT);
      if (!text) return err(400, 'Missing text');
      if (JSON.stringify(body.anchor || {}).length > 4000) return err(400, 'Anchor too large');
      const imgs = parseImages(body.images);
      const need = imgs.reduce((n, i) => n + i.buf.byteLength, 0);
      if (!this.fits(need)) return err(507, 'Room storage full');
      const tid = uuid();
      const thread = {
        id: tid,
        createdAt: now,
        authorRole: role,
        author,
        screen: clean(body.screen, 64),
        screenLabel: clean(body.screenLabel, 120),
        anchor: body.anchor && typeof body.anchor === 'object' ? body.anchor : null,
        proto: clean(body.proto, 80) || null,
        page: sanitizePage(body.page),
        // Never reuse a number: max over live threads AND the high-water mark.
        n: Math.max(nextNumber(this.threads), (this.meta.maxN || 0) + 1),
        trail: sanitizeTrail(body.trail),
        kind: KINDS.includes(body.kind) ? body.kind : null,
        status: 'open',
        history: [],
        resolved: false,
        preview: null,
        messages: [{ author, role, text, at: now }],
      };
      const img = await this.storeImages(tid, 'attach', imgs, now);
      if (img.length) thread.messages[0].img = img;
      const before = this.threads;
      this.threads = assignNumbers([...before, thread]);
      await this.setMeta({ maxN: Math.max(this.meta.maxN || 0, ...this.threads.map((t) => t.n || 0)) });
      await this.saveChanged(before);
      return ok({ thread: this.threads.find((t) => t.id === tid) });
    }

    if (action === 'shot') {
      if (role !== 'designer') return err(403, 'Not allowed');
      const label = clean(body.label, 120);
      const img = parseImageDataUrl(body.image);
      if (!label || !img) return err(400, 'Bad shot');
      const previous = this.shots[label];
      if (!previous && Object.keys(this.shots).length >= MAX_SHOTS) return err(400, 'Too many screens');
      if (!this.fits(img.buf.byteLength)) return err(507, 'Room storage full');
      const rel = `shots/${labelKey(label)}/${pad(now)}-${uuid().slice(0, 8)}.${img.ext}`;
      await this.putFile(rel, img.buf);
      this.shots = applyShot(this.shots, { label, path: rel });
      await this.s.put('shots', this.shots);
      // The shot this one replaces is nobody's now (one borrowed from a comment
      // preview belongs to its thread, so it is left alone).
      if (previous && previous.startsWith('shots/')) await this.delFile(previous);
      return ok({ path: rel });
    }

    if (action === 'mapmeta') {
      if (role !== 'designer') return err(403, 'Not allowed');
      const ev = { at: now };
      if (body.alias && typeof body.alias === 'object') {
        ev.alias = { label: clean(body.alias.label, 120), name: clean(body.alias.name, 60) };
      }
      if (typeof body.hide === 'string') ev.hide = clean(body.hide, 120);
      if (typeof body.show === 'string') ev.show = clean(body.show, 120);
      if (!ev.alias?.label && !ev.hide && !ev.show) return err(400, 'Nothing to change');
      const next = applyMapMeta(this.mapmeta, ev);
      if (JSON.stringify(next) === JSON.stringify(applyMapMeta(this.mapmeta, null))) {
        return ok({ mapmeta: next }); // no-op: don't write
      }
      this.mapmeta = next;
      await this.s.put('mapmeta', this.mapmeta);
      return ok({ mapmeta: this.mapmeta });
    }

    if (action === 'version' || action === 'version-label') {
      const id = String(body.id || '');
      if (!VERSION_ID.test(id)) return err(400, 'Bad version id');
      if (action === 'version-label' && role !== 'designer') return err(403, 'Not allowed');
      const known = this.versions.some((v) => v.id === id);
      if (action === 'version' && known) return ok({ ok: true, known: true });
      if (action === 'version-label' && !known) return err(404, 'Unknown version');
      if (action === 'version' && this.versions.length >= MAX_VERSIONS) return err(400, 'Too many versions');
      this.versions = applyVersionEvent(
        this.versions,
        action === 'version' ? { id, at: now } : { id, label: clean(body.label, 60), at: now }
      );
      await this.s.put('versions', this.versions);
      return ok({ ok: true, versions: this.versions });
    }

    const tid = String(body.threadId || '');
    if (!TID_RE.test(tid)) return err(404, 'Thread not found');
    const thread = this.threads.find((t) => t.id === tid);
    if (!thread || !canSee(role, thread)) return err(404, 'Thread not found');

    if (action === 'preview') {
      const own = thread.author === author && thread.authorRole === role;
      if (!own && role !== 'designer') return err(403, 'Not allowed');
      const img = parseImageDataUrl(body.image);
      if (!img) return err(400, 'Bad image');
      // ×2: the picture may be copied into an empty map slot below.
      if (!this.fits(img.buf.byteLength * 2)) return err(507, 'Room storage full');
      const rel = `previews/${tid}/${pad(now)}.${img.ext}`;
      await this.putFile(rel, img.buf);
      thread.preview = rel;
      // A screen with no shot borrows this picture as its own copy under shots/:
      // a previews/ path is gated on the thread and would 404 for the client.
      if (thread.screenLabel && !this.shots[thread.screenLabel]) {
        const shotRel = `shots/${labelKey(thread.screenLabel)}/${pad(now)}-${uuid().slice(0, 8)}.${img.ext}`;
        await this.putFile(shotRel, img.buf);
        this.shots = applyShot(this.shots, { label: thread.screenLabel, path: shotRel, from: 'preview' });
        await this.s.put('shots', this.shots);
      }
      await this.saveThread(tid);
      return ok({ preview: rel });
    }

    if (action === 'reply') {
      const text = clean(body.text, MAX_TEXT);
      if (!text) return err(400, 'Missing text');
      const imgs = parseImages(body.images);
      if (!this.fits(imgs.reduce((n, i) => n + i.buf.byteLength, 0))) return err(507, 'Room storage full');
      const img = await this.storeImages(tid, 'attach', imgs, now);
      thread.messages.push({ author, role, text, at: now, ...(img.length ? { img } : {}) });
    } else if (action === 'edit') {
      const text = clean(body.text, MAX_TEXT);
      const target = Number(body.at);
      if (!text || !target) return err(400, 'Missing text or target');
      const msg = thread.messages.find((m) => m.at === target);
      if (!msg || msg.author !== author || msg.role !== role) return err(403, 'Not your message');
      msg.text = text;
      msg.edited = true;
    } else if (action === 'resolve') {
      this.threads = applyResolve(this.threads, tid, Boolean(body.resolved), author, now);
    } else if (action === 'status') {
      const status = String(body.status || '');
      if (!STATUSES.includes(status)) return err(400, 'Bad status');
      if ((status === 'progress' || status === 'wont') && role !== 'designer') return err(403, 'Not allowed');
      const note = clean(body.note, 200);
      if (status === 'wont' && !note) return err(400, 'Reason required');
      const current = thread.status || (thread.resolved ? 'done' : 'open');
      if (current === status && (thread.statusNote || null) === (status === 'wont' ? note : null)) {
        return ok({ thread }); // no-op: no duplicate system line
      }
      this.threads = applyStatus(this.threads, tid, { status, note, author, at: now });
    } else if (action === 'kind') {
      if (role !== 'designer') return err(403, 'Not allowed');
      this.threads = applyKind(this.threads, tid, KINDS.includes(body.kind) ? body.kind : null);
    } else if (action === 'react') {
      const emoji = String(body.emoji || '');
      const target = Number(body.at);
      if (!EMOJI.includes(emoji) || !thread.messages.some((m) => m.at === target)) return err(400, 'Bad reaction');
      this.threads = applyReact(this.threads, tid, { target, emoji, on: Boolean(body.on), author });
    } else if (action === 'trail') {
      const trail = sanitizeTrail(body.trail);
      if (!trail.length) return err(400, 'Empty trail');
      if (thread.trail?.length) return ok({ thread });
      this.threads = applyTrail(this.threads, tid, trail);
    } else if (action === 'delete') {
      const own = thread.authorRole === role && thread.author === author;
      if (role !== 'designer' && !own) return err(403, 'Not allowed');
      this.threads = this.threads.filter((t) => t.id !== tid);
      await this.s.delete(`t:${tid}`);
      // Media belongs to the thread: purge previews and attachments with it.
      for (const kind of ['previews', 'attach']) await this.delFilesUnder(`${kind}/${tid}/`);
      return ok({ ok: true });
    } else {
      return err(400, 'Unknown action');
    }

    return ok({ thread: await this.saveThread(tid) });
  }
}
