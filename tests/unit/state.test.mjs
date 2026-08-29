import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStateStore, isValidState, labelKey, applyShot, applyMapMeta } from '../../template/lib/state.js';
import { applyCreate } from '../../template/lib/threads.js';
import { normalizeEtag } from '../../template/lib/storage.js';

class ConflictError extends Error {}

// In-memory stand-in for lib/storage.js with the same conditional-write
// semantics: ifAbsent fails when a document exists, ifMatch fails on a stale
// ETag. `conflicts` makes the next N writes fail as if another writer won.
function fakeStorage({ doc = null, events = {}, failReads = false, conflicts = 0 } = {}) {
  let current = doc;
  let etag = doc ? 'e1' : null;
  let n = 1;
  const calls = [];
  return {
    ConflictError,
    calls,
    get doc() {
      return current;
    },
    async readJson(p) {
      if (failReads) throw new Error('503 from blob');
      calls.push(['read', p]);
      return { data: current, etag };
    },
    async writeJson(p, data, opts) {
      calls.push(['write', p, opts]);
      if (conflicts > 0) {
        conflicts--;
        // the other writer landed something we haven't seen
        current = { ...(current || { v: 2, threads: [], nav: {} }), updatedAt: -1 };
        etag = 'e' + ++n;
        throw new ConflictError();
      }
      if (opts.ifAbsent && current) throw new ConflictError();
      if (opts.ifMatch && opts.ifMatch !== etag) throw new ConflictError();
      current = data;
      etag = 'e' + ++n;
      return { etag };
    },
    async readEvents(prefix) {
      if (failReads) throw new Error('503 from blob');
      return Object.entries(events)
        .filter(([k]) => k.startsWith(prefix))
        .map(([pathname, data]) => ({ pathname, data }));
    },
  };
}

const T = '11111111-1111-4111-8111-111111111111';
const firstEvent = {
  type: 'msg', at: 1, author: 'Ann', role: 'client', text: 'hello',
  first: { authorRole: 'client', screen: 'S', screenLabel: 'Home', anchor: { path: 'body' } },
};
const newThread = { id: 'new', createdAt: 9, authorRole: 'designer', author: 'Bob', messages: [{ at: 9 }] };
const addThread = (s) => ({ threads: applyCreate(s.threads, newThread) });

test('loadState: missing document → rebuilt from events and created with ifAbsent', async () => {
  const st = fakeStorage({ events: { [`threads/${T}/00000000000001-a.json`]: firstEvent } });
  const { state, path } = await createStateStore(st).loadState('');
  assert.equal(path, 'rebuild');
  assert.equal(state.threads.length, 1);
  assert.equal(state.threads[0].id, T);
  const write = st.calls.find((c) => c[0] === 'write');
  assert.deepEqual(write[2], { ifAbsent: true });
  assert.ok(isValidState(st.doc));
});

test('loadState: corrupt document (v1 shape) → rebuilt and replaced with ifMatch', async () => {
  const st = fakeStorage({ doc: { threads: 'nope' } });
  const { path } = await createStateStore(st).loadState('');
  assert.equal(path, 'rebuild');
  const write = st.calls.find((c) => c[0] === 'write');
  assert.deepEqual(write[2], { ifMatch: 'e1' });
});

test('mutate: fast path patches the document with the ETag it read', async () => {
  const st = fakeStorage({ doc: { v: 2, threads: [], nav: {}, updatedAt: 0 } });
  const { state, path } = await createStateStore(st).mutate('', addThread);
  assert.equal(path, 'patch');
  assert.equal(state.threads.length, 1);
  assert.equal(st.doc.threads.length, 1);
  const write = st.calls.find((c) => c[0] === 'write');
  assert.deepEqual(write[2], { ifMatch: 'e1' });
});

test('mutate: a conflict re-reads and retries on top of the other writer', async () => {
  const st = fakeStorage({ doc: { v: 2, threads: [], nav: {}, updatedAt: 0 }, conflicts: 1 });
  const { state, path } = await createStateStore(st).mutate('', addThread);
  assert.equal(path, 'retry');
  assert.equal(state.updatedAt !== -1, true);
  assert.equal(st.doc.threads.length, 1);
});

test('mutate: after repeated conflicts the rebuild fallback still applies the patch', async () => {
  const st = fakeStorage({
    doc: { v: 2, threads: [], nav: {}, updatedAt: 0 },
    events: { [`threads/${T}/00000000000001-a.json`]: firstEvent },
    conflicts: 4,
  });
  const { state, path } = await createStateStore(st, { attempts: 4 }).mutate('', addThread);
  assert.equal(path, 'rebuild');
  assert.deepEqual(state.threads.map((t) => t.id).sort(), [T, 'new'].sort());
  assert.equal(st.doc.threads.length, 2);
});

test('mutate: a read failure propagates and nothing is written', async () => {
  const st = fakeStorage({ failReads: true });
  await assert.rejects(() => createStateStore(st).mutate('', addThread), /503/);
  assert.equal(st.calls.some((c) => c[0] === 'write'), false);
});

test('forceRebuild: writes conditionally against the current ETag', async () => {
  const st = fakeStorage({
    doc: { v: 2, threads: [{ id: 'stale' }], nav: {}, updatedAt: 0 },
    events: { [`threads/${T}/00000000000001-a.json`]: firstEvent },
  });
  const { state } = await createStateStore(st).forceRebuild('');
  assert.deepEqual(state.threads.map((t) => t.id), [T]);
  const write = st.calls.find((c) => c[0] === 'write');
  assert.deepEqual(write[2], { ifMatch: 'e1' });
});

test('rebuild: nav edges are ordered by time and capped', async () => {
  const st = fakeStorage({
    events: {
      'nav/e-2.json': { from: 'B', to: 'C', anchor: { p: 2 }, at: 2 },
      'nav/e-1.json': { from: 'A', to: 'B', anchor: { p: 1 }, at: 1 },
      'nav/broken.json': null,
    },
  });
  const { nav } = await createStateStore(st, { navCap: 1 }).rebuild('');
  assert.deepEqual(Object.keys(nav), ['B>C']);
});

test('normalizeEtag strips the weak-validator prefix and keeps strong tags intact', () => {
  assert.equal(normalizeEtag('W/"abc"'), '"abc"');
  assert.equal(normalizeEtag('"abc"'), '"abc"');
  assert.equal(normalizeEtag(undefined), null);
});

test('labelKey is URL-safe, bounded and stable', () => {
  const k = labelKey('Dashboard · Platform Pulse');
  assert.match(k, /^[A-Za-z0-9_-]{1,80}$/);
  assert.equal(k, labelKey('Dashboard · Platform Pulse'));
  assert.equal(labelKey('x'.repeat(500)).length, 80);
  assert.equal(labelKey(''), '_');
});

test('applyShot keeps the latest path per label; applyMapMeta folds alias/hide/show', () => {
  let shots = applyShot({}, { label: 'Home', path: 'shots/a/1.jpg' });
  shots = applyShot(shots, { label: 'Home', path: 'shots/a/2.jpg' });
  assert.deepEqual(shots, { Home: 'shots/a/2.jpg' });
  let meta = applyMapMeta(undefined, { alias: { label: 'Home', name: 'Start' } });
  meta = applyMapMeta(meta, { hide: 'Debug' });
  meta = applyMapMeta(meta, { hide: 'Debug' });
  assert.deepEqual(meta, { aliases: { Home: 'Start' }, hidden: ['Debug'] });
  assert.deepEqual(applyMapMeta(meta, { show: 'Debug' }).hidden, []);
  assert.deepEqual(applyMapMeta(meta, { alias: { label: 'Home', name: '' } }).aliases, {});
});

test('rebuild folds shotlog and mapmeta events', async () => {
  const st = fakeStorage({
    events: {
      'shotlog/1.json': { label: 'Home', path: 'shots/a/1.jpg', at: 1 },
      'mapmeta/2.json': { alias: { label: 'Home', name: 'Start' }, at: 2 },
    },
  });
  const s = await createStateStore(st).rebuild('');
  assert.deepEqual(s.shots, { Home: 'shots/a/1.jpg' });
  assert.deepEqual(s.mapmeta, { aliases: { Home: 'Start' }, hidden: [] });
});
