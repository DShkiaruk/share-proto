// The Cloudflare Worker's room, exercised against an in-memory stand-in for
// Durable Object storage. structuredClone on every put/get is deliberate: it
// fails on anything the real DO could not store, and it stops a test from
// passing because two objects happen to be the same reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { Room } from '../../worker/src/room.js';
import { labelKey } from '../../template/lib/state.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const PNG = 'data:image/png;base64,' + readFileSync(new URL('../fixtures/pixel.png', import.meta.url)).toString('base64');

function memStorage() {
  const m = new Map();
  const copy = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    map: m,
    writes: 0,
    async get(k) {
      return copy(m.get(k));
    },
    async put(k, v) {
      this.writes++;
      m.set(k, copy(v));
    },
    async delete(k) {
      m.delete(k);
    },
    async list({ prefix } = {}) {
      const out = new Map();
      for (const k of [...m.keys()].sort()) if (!prefix || k.startsWith(prefix)) out.set(k, copy(m.get(k)));
      return out;
    },
  };
}

const room = (opts) => new Room(memStorage(), opts);
const create = (r, role, author, extra = {}) => r.post(role, author, { action: 'create', text: 'x', ...extra });

test('a comment is stored under its own key and comes back over GET', async () => {
  const r = room();
  const res = await create(r, 'designer', 'Dee', { text: 'the header is off', screenLabel: 'Home' });
  assert.equal(res.status, 200);
  assert.equal(res.payload.thread.n, 1);
  assert.equal(res.payload.thread.status, 'open');
  assert.equal(r.s.map.get(`t:${res.payload.thread.id}`).messages[0].text, 'the header is off');

  const got = await r.get('designer', 'Dee');
  assert.equal(got.v, 2);
  assert.equal(got.threads.length, 1);
  assert.deepEqual(got.mapmeta, { aliases: {}, hidden: [] });
});

test('numbers are never reused after a delete', async () => {
  const r = room();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await create(r, 'designer', 'Dee')).payload.thread.id);
  assert.deepEqual(r.threads.map((t) => t.n), [1, 2, 3]);
  await r.post('designer', 'Dee', { action: 'delete', threadId: ids[2] });
  const again = await create(r, 'designer', 'Dee');
  assert.equal(again.payload.thread.n, 4);
});

test('a client sees only client threads — through GET and through /api/file', async () => {
  const r = room();
  const mine = await create(r, 'client', 'Cliff', { images: [PNG] });
  const theirs = await create(r, 'designer', 'Dee', { images: [PNG] });
  const seen = await r.get('client', 'Cliff');
  assert.deepEqual(seen.threads.map((t) => t.id), [mine.payload.thread.id]);

  const own = mine.payload.thread.messages[0].img[0];
  const other = theirs.payload.thread.messages[0].img[0];
  assert.equal((await r.file('client', own)).status, 200);
  assert.equal((await r.file('client', other)).status, 404);
  assert.equal((await r.file('designer', other)).status, 200);
  assert.equal((await r.file('designer', '../../etc/passwd')).status, 400);
});

test('statuses: the client cannot start work or decline it, and a repeat is a no-op', async () => {
  const r = room();
  const t = (await create(r, 'client', 'Cliff')).payload.thread;
  assert.equal((await r.post('client', 'Cliff', { action: 'status', threadId: t.id, status: 'progress' })).status, 403);
  assert.equal((await r.post('designer', 'Dee', { action: 'status', threadId: t.id, status: 'wont' })).status, 400); // no reason
  const wont = await r.post('designer', 'Dee', { action: 'status', threadId: t.id, status: 'wont', note: 'out of scope' });
  assert.equal(wont.payload.thread.status, 'wont');
  assert.equal(wont.payload.thread.resolved, true);
  assert.equal(wont.payload.thread.history.length, 1);
  const repeat = await r.post('designer', 'Dee', { action: 'status', threadId: t.id, status: 'wont', note: 'out of scope' });
  assert.equal(repeat.payload.thread.history.length, 1); // no duplicate system line
  assert.equal(r.s.map.get(`t:${t.id}`).statusNote, 'out of scope');
});

test('reactions toggle on the stored thread', async () => {
  const r = room();
  const t = (await create(r, 'client', 'Cliff')).payload.thread;
  const at = t.messages[0].at;
  await r.post('designer', 'Dee', { action: 'react', threadId: t.id, at, emoji: '👍', on: true });
  assert.deepEqual(r.s.map.get(`t:${t.id}`).messages[0].reactions, { '👍': ['Dee'] });
  await r.post('designer', 'Dee', { action: 'react', threadId: t.id, at, emoji: '👍', on: false });
  assert.equal(r.s.map.get(`t:${t.id}`).messages[0].reactions, undefined);
  assert.equal((await r.post('designer', 'Dee', { action: 'react', threadId: t.id, at, emoji: '💣', on: true })).status, 400);
  // A client cannot even address a thread it is not allowed to see.
  const hidden = (await create(r, 'designer', 'Dee')).payload.thread;
  assert.equal((await r.post('client', 'Cliff', { action: 'react', threadId: hidden.id, at: hidden.messages[0].at, emoji: '👍', on: true })).status, 404);
});

test('a hidden screen disappears from the client map and from the file endpoint', async () => {
  const r = room();
  await r.post('designer', 'Dee', { action: 'shot', label: 'Secret', image: PNG });
  await r.post('designer', 'Dee', { action: 'shot', label: 'Home', image: PNG });
  const hidden = await r.post('designer', 'Dee', { action: 'mapmeta', hide: 'Secret' });
  assert.deepEqual(hidden.payload.mapmeta.hidden, ['Secret']);

  const asClient = await r.get('client', 'Cliff');
  assert.deepEqual(Object.keys(asClient.shots), ['Home']);
  assert.deepEqual(asClient.mapmeta.hidden, []); // not even the fact that something is hidden
  const path = r.shots['Secret'];
  assert.ok(path.startsWith(`shots/${labelKey('Secret')}/`));
  assert.equal((await r.file('client', path)).status, 404);
  assert.equal((await r.file('designer', path)).status, 200);
});

test('a second shot for the same screen replaces the first and frees its bytes', async () => {
  const r = room();
  await r.post('designer', 'Dee', { action: 'shot', label: 'Home', image: PNG });
  const first = r.shots['Home'];
  const after = r.meta.bytes;
  await r.post('designer', 'Dee', { action: 'shot', label: 'Home', image: PNG });
  assert.notEqual(r.shots['Home'], first);
  assert.equal(r.meta.bytes, after); // one in, one out
  assert.equal(r.s.map.has(`f:${first}`), false);
});

test('a comment preview fills an empty map slot but never overwrites a real shot', async () => {
  const r = room();
  const a = (await create(r, 'designer', 'Dee', { screenLabel: 'Home' })).payload.thread;
  await r.post('designer', 'Dee', { action: 'preview', threadId: a.id, image: PNG });
  const borrowed = r.shots['Home'];
  assert.ok(borrowed?.startsWith('shots/'), 'an empty slot is filled from the preview');

  const b = (await create(r, 'designer', 'Dee', { screenLabel: 'Home' })).payload.thread;
  await r.post('designer', 'Dee', { action: 'preview', threadId: b.id, image: PNG });
  assert.equal(r.shots['Home'], borrowed, 'the slot is already taken');
});

test('deleting a thread purges its pictures and gives the space back', async () => {
  const r = room();
  const t = (await create(r, 'client', 'Cliff', { images: [PNG], screenLabel: 'Home' })).payload.thread;
  await r.post('client', 'Cliff', { action: 'preview', threadId: t.id, image: PNG });
  assert.ok(r.meta.bytes > 0);
  assert.equal([...r.s.map.keys()].filter((k) => k.startsWith('f:')).length, 3); // attach + preview + borrowed shot

  await r.post('client', 'Cliff', { action: 'delete', threadId: t.id });
  assert.equal(r.s.map.has(`t:${t.id}`), false);
  const left = [...r.s.map.keys()].filter((k) => k.startsWith('f:'));
  // The map shot survives: it belongs to the screen, not to the thread.
  assert.deepEqual(left, [`f:${r.shots.Home}`]);
});

test('a full room refuses new pictures instead of growing without limit', async () => {
  const r = room({ mediaBudget: 100 }); // bytes
  const first = await create(r, 'designer', 'Dee', { images: [PNG] });
  assert.equal(first.status, 200);
  const second = await create(r, 'designer', 'Dee', { images: [PNG] });
  assert.equal(second.status, 507);
  const text = await create(r, 'designer', 'Dee', { text: 'words still work' });
  assert.equal(text.status, 200);
});

test('a room written by the v1 worker keeps its comments and gains v2 fields', async () => {
  const s = memStorage();
  const legacy = {
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: 1000,
    authorRole: 'client',
    author: 'Cliff',
    screen: 'home',
    screenLabel: 'Home',
    anchor: { path: 'body>main' },
    proto: null,
    page: null,
    resolved: true,
    messages: [{ author: 'Cliff', role: 'client', text: 'old comment', at: 1000 }],
  };
  s.map.set(`t:${legacy.id}`, legacy);
  s.map.set('nav', { 'Home>Settings': { anchor: { path: 'a' }, at: 900 } });

  const r = new Room(s);
  const got = await r.get('client', 'Cliff');
  assert.equal(got.threads.length, 1);
  assert.equal(got.threads[0].messages[0].text, 'old comment');
  assert.equal(got.threads[0].n, 1, 'legacy threads get a number');
  assert.equal(got.threads[0].status, 'done', 'resolved becomes a status');
  assert.deepEqual(got.nav, { 'Home>Settings': { path: 'a' } });
  assert.equal(s.map.has('nav'), false, 'the old single-key nav is gone');
  assert.ok(s.map.has('n:Home>Settings'), 'edges are one key each now');

  const next = await create(r, 'client', 'Cliff');
  assert.equal(next.payload.thread.n, 2);
});

test('learned navigation is capped and evicts the oldest edge from storage', async () => {
  const r = room();
  r.loaded = true; // skip load(); set up the caps by hand
  r.threads = [];
  r.nav = {};
  r.versions = [];
  r.shots = {};
  r.mapmeta = { aliases: {}, hidden: [] };
  r.meta = { maxN: 0, bytes: 0 };
  for (let i = 0; i < 502; i++) {
    await r.post('designer', 'Dee', { action: 'edge', from: `S${i}`, to: `S${i + 1}`, anchor: { path: 'a' } });
  }
  const keys = [...r.s.map.keys()].filter((k) => k.startsWith('n:'));
  assert.equal(keys.length, 500);
  assert.equal(r.s.map.has('n:S0>S1'), false, 'the oldest edge was deleted, not just forgotten');
});

test('renaming a screen to the name it already has does not write', async () => {
  const r = room();
  await r.post('designer', 'Dee', { action: 'mapmeta', alias: { label: 'Home', name: 'Dashboard' } });
  const before = JSON.stringify(r.s.map.get('mapmeta'));
  const noop = await r.post('designer', 'Dee', { action: 'mapmeta', alias: { label: 'Home', name: 'Dashboard' } });
  assert.equal(noop.status, 200);
  assert.equal(JSON.stringify(r.s.map.get('mapmeta')), before);
  assert.equal((await r.post('client', 'Cliff', { action: 'mapmeta', hide: 'Home' })).status, 403);
});

test('versions register once and only a designer may name one', async () => {
  const r = room();
  assert.equal((await r.post('client', 'Cliff', { action: 'version', id: 'abc123' })).status, 200);
  const dup = await r.post('client', 'Cliff', { action: 'version', id: 'abc123' });
  assert.equal(dup.payload.known, true);
  assert.equal((await r.post('client', 'Cliff', { action: 'version-label', id: 'abc123', label: 'v2' })).status, 403);
  const named = await r.post('designer', 'Dee', { action: 'version-label', id: 'abc123', label: 'v2' });
  assert.equal(named.payload.versions[0].label, 'v2');
  assert.equal((await r.post('designer', 'Dee', { action: 'version-label', id: 'nope', label: 'x' })).status, 404);
});

test('bad requests are refused without writing anything', async () => {
  const r = room();
  assert.equal((await r.post('designer', 'Dee', { action: 'reply', threadId: 'not-a-uuid', text: 'x' })).status, 404);
  assert.equal((await create(r, 'designer', 'Dee', { text: '   ' })).status, 400);
  assert.equal((await create(r, 'designer', 'Dee', { images: ['data:image/png;base64,zz'] })).status, 400);
  assert.equal((await r.post('designer', 'Dee', { action: 'edge', from: 'A', to: 'A', anchor: {} })).status, 400);
  assert.equal(r.s.map.size, 0);

  // An action nobody implements is only reachable once the thread resolves.
  const t = (await create(r, 'designer', 'Dee')).payload.thread;
  assert.equal((await r.post('designer', 'Dee', { action: 'nope', threadId: t.id })).status, 400);
});

test('a cold start reads a room without rewriting it', async () => {
  const s = memStorage();
  const first = new Room(s);
  for (let i = 0; i < 3; i++) await create(first, 'designer', 'Dee');
  await first.post('designer', 'Dee', { action: 'edge', from: 'A', to: 'B', anchor: { path: 'a' } });
  await first.post('designer', 'Dee', { action: 'shot', label: 'Home', image: PNG });

  // The object was evicted; a new one loads the same storage.
  s.writes = 0;
  const second = new Room(s);
  const got = await second.get('designer', 'Dee');
  assert.equal(got.threads.length, 3);
  assert.deepEqual(got.nav, { 'A>B': { path: 'a' } });
  assert.equal(s.writes, 0, 'loading a v2 room writes nothing');
});

test('a thread learns the way back once, and only once', async () => {
  const r = room();
  const t = (await create(r, 'client', 'Cliff')).payload.thread;
  assert.deepEqual(t.trail, []);
  const steps = [{ anchor: { path: '#row', t: 'button', txt: 'Acme' }, txt: 'Acme' }];
  const taught = await r.post('designer', 'Dee', { action: 'trail', threadId: t.id, trail: steps });
  assert.equal(taught.payload.thread.trail.length, 1);
  assert.equal(r.s.map.get(`t:${t.id}`).trail[0].txt, 'Acme');

  // A thread that knows the way is not re-taught by the next person to open it.
  const again = await r.post('designer', 'Dee', {
    action: 'trail',
    threadId: t.id,
    trail: [{ anchor: { path: '#other' }, txt: 'Other' }],
  });
  assert.equal(again.payload.thread.trail[0].txt, 'Acme');
  assert.equal((await r.post('designer', 'Dee', { action: 'trail', threadId: t.id, trail: [] })).status, 400);
});
