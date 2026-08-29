import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clean, canSee, assemble, applyReply, applyEdit, applyResolve, applyDelete, applyCreate, navPatch,
  assignNumbers, nextNumber, sanitizeTrail, applyPreview, sanitizePage,
} from '../../template/lib/threads.js';

const T = '11111111-1111-4111-8111-111111111111';
const ev = (tid, at, data) => ({ pathname: `threads/${tid}/${String(at).padStart(14, '0')}-x.json`, data });
const first = (tid, at, role = 'client') =>
  ev(tid, at, {
    type: 'msg', at, author: 'Ann', role, text: 'hello',
    first: { authorRole: role, screen: 'S', screenLabel: 'Home', anchor: { path: 'body' }, proto: 'v1', page: '/' },
  });

test('clean trims and caps', () => {
  assert.equal(clean('  hi  ', 10), 'hi');
  assert.equal(clean('abcdef', 3), 'abc');
  assert.equal(clean(null, 3), '');
});

test('canSee: designer sees all, client sees client threads only', () => {
  assert.equal(canSee('designer', { authorRole: 'designer' }), true);
  assert.equal(canSee('client', { authorRole: 'designer' }), false);
  assert.equal(canSee('client', { authorRole: 'client' }), true);
});

test('assemble builds a thread from msg/edit/state events in pathname order', () => {
  const threads = assemble([
    ev(T, 3, { type: 'state', at: 3, resolved: true }),
    ev(T, 2, { type: 'msg', at: 2, author: 'Bob', role: 'designer', text: 'reply' }),
    first(T, 1),
    ev(T, 4, { type: 'edit', at: 4, target: 2, text: 'reply (fixed)' }),
  ]);
  assert.equal(threads.length, 1);
  const t = threads[0];
  assert.equal(t.id, T);
  assert.equal(t.author, 'Ann');
  assert.equal(t.authorRole, 'client');
  assert.equal(t.page, '/');
  assert.equal(t.resolved, true);
  assert.deepEqual(t.messages.map((m) => m.text), ['hello', 'reply (fixed)']);
  assert.equal(t.messages[1].edited, true);
});

test('assemble drops tombstoned threads and threads without a first message', () => {
  const T2 = '22222222-2222-4222-8222-222222222222';
  const threads = assemble([
    first(T, 1), ev(T, 2, { type: 'tomb', at: 2 }),
    ev(T2, 1, { type: 'msg', at: 1, author: 'X', role: 'client', text: 'orphan' }),
  ]);
  assert.equal(threads.length, 0);
});

test('assemble strips a room root and ignores foreign pathnames', () => {
  const rooted = { ...first(T, 1), pathname: `rooms/pr-1/threads/${T}/00000000000001-x.json` };
  assert.equal(assemble([rooted], 'rooms/pr-1/').length, 1);
  assert.equal(assemble([{ pathname: 'snap/foo.json', data: { type: 'msg' } }]).length, 0);
});

test('patch helpers are pure and idempotent where it matters', () => {
  const base = assemble([first(T, 1)]);
  const msg = { author: 'Bob', role: 'designer', text: 'r', at: 5 };
  const r1 = applyReply(base, T, msg);
  const r2 = applyReply(r1, T, msg); // same at+author → no duplicate
  assert.equal(base[0].messages.length, 1);
  assert.equal(r1[0].messages.length, 2);
  assert.equal(r2[0].messages.length, 2);
  assert.equal(applyEdit(r1, T, 5, 'edited')[0].messages[1].text, 'edited');
  assert.equal(applyResolve(base, T, true)[0].resolved, true);
  assert.equal(applyDelete(base, T).length, 0);
  const created = applyCreate(base, { id: 'x', createdAt: 0, messages: [] });
  assert.equal(created.length, 2);
  assert.equal(applyCreate(created, { id: 'x', createdAt: 0, messages: [] }).length, 2);
});

test('navPatch adds an edge and evicts the oldest beyond cap', () => {
  let nav = navPatch({}, 'A', 'B', { path: 'p' }, 1);
  nav = navPatch(nav, 'B', 'C', { path: 'q' }, 2, 1);
  assert.deepEqual(Object.keys(nav), ['B>C']);
  assert.deepEqual(nav['B>C'], { anchor: { path: 'q' }, at: 2 });
});

test('assemble accepts the exact v1 first-message shape (no page, no proto)', () => {
  const v1 = ev(T, 1, {
    type: 'msg', at: 1, author: 'Ann', role: 'client', text: 'hello',
    first: { authorRole: 'client', screen: 'S', screenLabel: 'Home', anchor: { path: 'body', ox: 0.5, oy: 0.5, fx: 0.1, fy: 0.2 } },
  });
  const [t] = assemble([v1, ev(T, 2, { type: 'state', at: 2, resolved: true })]);
  assert.equal(t.page, null);
  assert.equal(t.proto, null);
  assert.equal(t.resolved, true);
  assert.equal(t.anchor.fx, 0.1);
});

test('assemble keeps one copy of a message written twice under different pathnames', () => {
  const dup = { type: 'msg', at: 2, author: 'Bob', role: 'designer', text: 'reply' };
  const [t] = assemble([
    first(T, 1),
    { pathname: `threads/${T}/00000000000002-aaaa.json`, data: dup },
    { pathname: `threads/${T}/00000000000002-bbbb.json`, data: dup },
  ]);
  assert.equal(t.messages.length, 2);
});

test('assignNumbers keeps valid numbers, fills gaps in createdAt order, resolves collisions to the later thread', () => {
  const out = assignNumbers([
    { id: 'a', createdAt: 1, n: 1 },
    { id: 'b', createdAt: 2 },            // legacy → 2
    { id: 'c', createdAt: 3, n: 4 },
    { id: 'd', createdAt: 4, n: 4 },      // collision → next free (3)
    { id: 'e', createdAt: 5, n: 0 },      // invalid → next free (5)
  ]);
  assert.deepEqual(Object.fromEntries(out.map((t) => [t.id, t.n])), { a: 1, b: 2, c: 4, d: 3, e: 5 });
});

test('nextNumber is max+1 and starts at 1', () => {
  assert.equal(nextNumber([]), 1);
  assert.equal(nextNumber([{ n: 3 }, { n: 7 }, {}]), 8);
});

test('sanitizeTrail caps to 8 steps, drops junk, rejects oversized trails', () => {
  const step = (i) => ({ anchor: { path: `p${i}` }, txt: `t${i}` });
  const ten = Array.from({ length: 10 }, (_, i) => step(i));
  const out = sanitizeTrail([...ten, 'junk', { txt: 'no anchor' }]);
  assert.equal(out.length, 8);
  assert.equal(out[0].txt, 't2');
  assert.deepEqual(sanitizeTrail('nope'), []);
  assert.deepEqual(sanitizeTrail([{ anchor: { path: 'x'.repeat(7000) }, txt: null }]), []);
});

test('assemble exposes n and trail from the creating event and numbers legacy threads', () => {
  const T2 = '22222222-2222-4222-8222-222222222222';
  const withN = ev(T2, 5, {
    type: 'msg', at: 5, author: 'Bob', role: 'designer', text: 'x',
    first: { authorRole: 'designer', screen: 'S', screenLabel: 'Home', anchor: { path: 'body' }, n: 7, trail: [{ anchor: { path: 'b' }, txt: 'Open' }] },
  });
  const threads = assemble([first(T, 1), withN]);
  const legacy = threads.find((t) => t.id === T);
  const numbered = threads.find((t) => t.id === T2);
  assert.equal(numbered.n, 7);
  assert.deepEqual(numbered.trail, [{ anchor: { path: 'b' }, txt: 'Open' }]);
  assert.equal(legacy.n, 1);
  assert.deepEqual(legacy.trail, []);
});

test('applyCreate numbers the new thread and repairs a racing duplicate', () => {
  const base = [{ id: 'a', createdAt: 1, n: 1, messages: [] }];
  const out = applyCreate(base, { id: 'b', createdAt: 2, n: 1, messages: [] });
  assert.deepEqual(out.map((t) => [t.id, t.n]), [['a', 1], ['b', 2]]);
});

test('assemble carries message images and the latest preview', () => {
  const f = first(T, 1);
  const [t] = assemble([
    { ...f, data: { ...f.data, img: ['attach/a/1.jpg'] } },
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

test('sanitizePage accepts same-origin paths with hashes and rejects anything URL-like', () => {
  assert.equal(sanitizePage('/'), '/');
  assert.equal(sanitizePage('/index.html#/settings'), '/index.html#/settings');
  assert.equal(sanitizePage('javascript:alert(1)//'), null);
  assert.equal(sanitizePage('//evil.com/a'), null);
  assert.equal(sanitizePage('https://evil.com'), null);
  assert.equal(sanitizePage('/a b'), null);
  assert.equal(sanitizePage('/' + 'x'.repeat(300)), null);
  assert.equal(sanitizePage(42), null);
});

test('assignNumbers breaks createdAt ties by id so live and rebuilt documents agree', () => {
  const a = assignNumbers([{ id: 'b', createdAt: 5 }, { id: 'a', createdAt: 5 }]);
  const b = assignNumbers([{ id: 'a', createdAt: 5 }, { id: 'b', createdAt: 5 }]);
  assert.deepEqual(Object.fromEntries(a.map((t) => [t.id, t.n])), Object.fromEntries(b.map((t) => [t.id, t.n])));
  assert.equal(a.find((t) => t.id === 'a').n, 1);
});
