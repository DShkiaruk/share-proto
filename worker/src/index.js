/* Hosted comments server on Cloudflare Workers — the embed-mode backend.

   Same v2 API as template/api/* and template/server.js, minus the
   prototype-serving parts (an embedded overlay lives on someone else's page;
   this host only serves /overlay.js, /overlay.css and /api/*).

   One Durable Object per comment room (= one per PR preview). The rules live
   in src/room.js over the DO's storage; this file is transport only: CORS,
   login, the session check, and forwarding to the right room. Author identity
   is decided here from the signed session and handed to the room — the room
   never reads it off the request body. */

import { DurableObject } from 'cloudflare:workers';
import { createToken, sessionFromHeaders } from '../../template/lib/session.js';
import { originAllowed, ROOM_RE } from '../../template/lib/cors.js';
import { clean } from '../../template/lib/threads.js';
import { Room } from './room.js';

const MAX_NAME = 40;
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_BODY = 4.5 * 1024 * 1024; // three 1.5 MB images as base64
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 10;
// The login brake lives in one reserved object. `_auth` is a name the room
// regex can never produce, so it cannot collide with a PR's room.
const AUTH_ROOM = '_auth';

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin || !originAllowed(origin, env.ALLOWED_ORIGINS)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

const json = (status, payload, extra = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

/* ---------- the room ---------- */

export class CommentsRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const mb = Number(env.ROOM_MEDIA_BUDGET_MB) || 64;
    this.room = new Room(ctx.storage, { mediaBudget: Math.max(1, mb) * 1024 * 1024 });
    this.chain = Promise.resolve();
  }

  // A DO's input gate closes around storage I/O; reading a request body is
  // network I/O, so two POSTs can in principle interleave between parsing and
  // writing — and two creates that both read the thread list before either
  // writes would hand out the same comment number. Local runs did not produce
  // that interleaving, so this queue is insurance, not a fix for an observed
  // bug: it costs one promise per request and gives the room exactly the
  // single-threaded model the local server has.
  run(fn) {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  async handle(request) {
    const url = new URL(request.url);
    const role = request.headers.get('X-Fp-Role') === 'designer' ? 'designer' : 'client';
    const author = decodeURIComponent(request.headers.get('X-Fp-Author') || '');

    if (url.pathname === '/api/file') {
      const res = await this.run(() => this.room.file(role, url.searchParams.get('p') || ''));
      if (res.status !== 200) return json(res.status, res.payload);
      return new Response(res.bytes, {
        headers: {
          'Content-Type': res.contentType || 'application/octet-stream',
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    if (request.method === 'GET') return json(200, await this.run(() => this.room.get(role, author)));
    let body;
    try {
      body = JSON.parse((await request.text()) || '{}');
    } catch {
      body = {};
    }
    const { status, payload } = await this.run(() => this.room.post(role, author, body));
    return json(status, payload);
  }

  // The overlay reads `error` off a JSON body; an unhandled throw would reach
  // it as workerd's HTML error page and show up as an unexplained failure.
  /* Brute-force brake for /api/login, kept in the reserved `_auth` object.
     The other two editions count failures in the instance's own memory, which
     is a speed bump — a Durable Object is one place for every request that
     reaches this worker, so here it is an actual limit. Per IP: a locked-out
     attacker never locks out the reviewer next to them. */
  async loginBlocked(ip) {
    const e = await this.ctx.storage.get(`fail:${ip}`);
    return Boolean(e && Date.now() - e.since <= FAIL_WINDOW_MS && e.n >= MAX_FAILS);
  }

  async noteLogin(ip, ok) {
    return this.run(async () => {
      const key = `fail:${ip}`;
      if (ok) return this.ctx.storage.delete(key);
      const now = Date.now();
      const e = (await this.ctx.storage.get(key)) || { n: 0, since: now };
      if (now - e.since > FAIL_WINDOW_MS) {
        e.n = 0;
        e.since = now;
      }
      e.n++;
      await this.ctx.storage.put(key, e);
      // Expired counters would otherwise stay for the life of the deployment.
      const rows = await this.ctx.storage.list({ prefix: 'fail:' });
      if (rows.size > 200) {
        for (const [k, v] of rows) {
          if (now - v.since > FAIL_WINDOW_MS) await this.ctx.storage.delete(k);
        }
      }
    });
  }

  async fetch(request) {
    try {
      return await this.handle(request);
    } catch (e) {
      console.error(`room ${this.ctx.id}: ${e?.stack || e}`);
      return json(500, { error: 'Server error' });
    }
  }
}

/* ---------- the worker ---------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // Overlay assets: public script, served with open CORS so the overlay's
    // cross-origin HEAD version-check works.
    if (url.pathname === '/overlay.js' || url.pathname === '/overlay.css') {
      const r = await env.ASSETS.fetch(req);
      const h = new Headers(r.headers);
      h.set('Access-Control-Allow-Origin', '*');
      h.set('Access-Control-Expose-Headers', 'ETag');
      return new Response(r.body, { status: r.status, headers: h });
    }

    if (url.pathname === '/api/login') {
      if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, cors);
      const body = await req.json().catch(() => ({}));
      const cleanName = clean(body.name, MAX_NAME);
      if (!cleanName) return json(400, { error: 'Missing name' }, cors);
      // Set by Cloudflare, not by the caller. Local runs have no such header.
      const ip = req.headers.get('CF-Connecting-IP') || (req.headers.get('X-Forwarded-For') || 'local').split(',')[0].trim();
      const auth = env.ROOM.getByName(AUTH_ROOM);
      if (await auth.loginBlocked(ip)) return json(429, { error: 'Too many attempts' }, cors);
      const password = body.password;
      const role =
        password && password === env.DESIGNER_PASSWORD
          ? 'designer'
          : password && password === env.CLIENT_PASSWORD
            ? 'client'
            : null;
      await auth.noteLogin(ip, Boolean(role));
      if (!role) {
        await new Promise((r) => setTimeout(r, 800));
        return json(401, { error: 'Wrong password' }, cors);
      }
      const token = await createToken(
        { r: role, n: cleanName, exp: Date.now() + SIXTY_DAYS_MS },
        env.SESSION_SECRET
      );
      return json(200, { role, token }, cors);
    }

    if (url.pathname === '/api/comments' || url.pathname === '/api/file') {
      const session = await sessionFromHeaders(
        req.headers.get('cookie') || '',
        req.headers.get('authorization') || '',
        env.SESSION_SECRET
      );
      if (!session) return json(401, { error: 'Not authenticated' }, cors);
      if (req.method !== 'GET' && req.method !== 'POST') {
        return json(405, { error: 'Method not allowed' }, cors);
      }
      if (url.pathname === '/api/file' && req.method !== 'GET') {
        return json(405, { error: 'Method not allowed' }, cors);
      }
      const role = session.r === 'designer' ? 'designer' : 'client';
      const author = clean(session.n, MAX_NAME) || (role === 'designer' ? 'Designer' : 'Client');
      const q = (url.searchParams.get('room') || '').toLowerCase();
      const stub = env.ROOM.getByName(ROOM_RE.test(q) ? q : '_');

      // The body is buffered here, not streamed, so an oversized payload is
      // refused before it reaches the room's storage.
      let body;
      if (req.method === 'POST') {
        body = await req.text();
        if (body.length > MAX_BODY) return json(413, { error: 'Payload too large' }, cors);
      }
      const headers = new Headers({
        'X-Fp-Role': role,
        // Names are not latin-1 (a reviewer may be "Дмитро"), and header values are.
        'X-Fp-Author': encodeURIComponent(author),
      });
      if (body !== undefined) headers.set('Content-Type', 'application/json');
      const res = await stub.fetch(
        new Request(url.toString(), { method: req.method, headers, body })
      );
      const out = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) out.set(k, v);
      return new Response(res.body, { status: res.status, headers: out });
    }

    if (url.pathname.startsWith('/api/')) return json(404, { error: 'Not found' }, cors);

    // Built-in playground: a fake screen with the overlay attached, so the
    // interface can be tried (and shown to reviewers) before any real PR
    // preview carries it. Same origin — data-embed forces embed mode, and
    // data-room keeps demo comments out of real PR rooms.
    if (url.pathname === '/demo') {
      return new Response(
        `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Overlay demo — fake screen</title>
<style>body{font-family:system-ui,sans-serif;margin:0;color:#171717;background:#fafafa}
header{background:#fff;border-bottom:1px solid #e5e5e5;padding:14px 28px;display:flex;gap:24px;align-items:center}
header b{font-size:15px}header span{color:#737373;font-size:13px}
main{max-width:720px;margin:32px auto;padding:0 24px}
.hint{background:#eef6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 16px;font-size:13px;color:#1e40af;margin-bottom:24px}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:20px;margin-bottom:16px}
.card h2{margin:0 0 6px;font-size:16px}.card p{margin:0;color:#525252;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{text-align:left;padding:10px 12px;border-bottom:1px solid #f0f0f0}th{color:#737373;font-weight:500;font-size:12px}
button.cta{background:#171717;color:#fff;border:none;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer}
</style></head><body>
<header><b>Demo Screen</b><span>a fake app page for trying the comment overlay</span></header>
<main>
<div class="hint">Sign in with the review password you received, then press <b>C</b> (or tap Comment) and click anywhere — on the heading, a table row, the button. Threads live in the sidebar on the right.</div>
<div class="card"><h2>Budget Adjustments</h2><p>This card pretends to be a real component. Leave a pin on it.</p></div>
<div class="card"><table><tr><th>Line item</th><th>Requested draw</th></tr>
<tr><td>Foundation works</td><td>$18,500.00</td></tr>
<tr><td>Framing</td><td>$42,300.00</td></tr>
<tr><td>Electrical rough-in</td><td>$9,780.00</td></tr></table></div>
<button class="cta">Submit for review</button>
</main>
<script src="/overlay.js" data-embed data-room="demo" defer></script>
</body></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
    }

    // The bare host has no prototype to serve (embed-only install) — show a
    // small status page instead of a naked 404: this URL gets clicked from
    // Slack/PR descriptions and must not look broken.
    if (url.pathname === '/') {
      return new Response(
        `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review comments service</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto 0;padding:0 24px;color:#171717;line-height:1.6}
h1{font-size:20px}code{background:#f5f5f5;border-radius:4px;padding:1px 5px;font-size:13px}
p{color:#525252}.ok{color:#16a34a;font-weight:600}</style></head><body>
<h1>Review comments service <span class="ok">● operational</span></h1>
<p>This service powers the design-review comment overlay on PR previews.
There is nothing to browse here — the overlay appears on the preview pages
themselves (press <code>C</code> to comment).</p>
<p>It stores only comment text, commenter names and the pictures reviewers
attach, partitioned per PR. Endpoints: <code>/overlay.js</code>,
<code>/api/login</code>, <code>/api/comments</code>, <code>/api/file</code>.</p>
<p>Want to try the interface? <a href="/demo">Open the demo screen</a> and sign
in with a review password.</p>
</body></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
    }
    return env.ASSETS.fetch(req);
  },
};
