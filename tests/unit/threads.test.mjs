import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clean, canSee, assemble, applyReply, applyEdit, applyResolve, applyDelete, applyCreate, navPatch,
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
