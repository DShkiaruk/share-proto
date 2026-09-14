// Moving a room is only a move if what arrives is the same room. The test that
// matters is the round trip: take a thread as a deployment hands it out, turn it
// into events, fold those events back with assemble(), and require the result to
// be the thread we started with — author, time, number and all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeImport, importEvents, MAX_IMPORT_THREADS } from '../../template/lib/importing.js';
import { assemble } from '../../template/lib/threads.js';

const T = 'aaaaaaaa-1111-4111-8111-111111111111';

const exported = {
  threads: [
    {
      id: T,
      createdAt: 1000,
      authorRole: 'client',
      author: 'Olena',
      screen: 'home',
      screenLabel: 'Home · Dashboard',
      anchor: { path: 'main > h1', t: 'h1', txt: 'Home' },
      proto: 'build-7',
      page: '/#/home',
      n: 12,
      trail: [{ anchor: { path: 'button#sort' }, txt: 'Sort' }],
      theme: { mode: 'dark', marks: { html: { cls: ['dark'], attrs: {} } } },
      status: 'wont',
      statusNote: 'By design',
      kind: 'bug',
      history: [
        { at: 1500, status: 'progress', note: null, author: 'Dima' },
        { at: 1800, status: 'wont', note: 'By design', author: 'Dima' },
      ],
      resolved: true,
      preview: 'shots/home/1000-abc.jpg',
      messages: [
        { author: 'Olena', role: 'client', text: 'the label is cut off', at: 1000, img: ['attach/aaa/1.png'] },
        { author: 'Dima', role: 'designer', text: 'fixed the width', at: 1200, edited: true, reactions: { '👍': ['Olena'] } },
      ],
    },
  ],
  nav: { 'Home>Settings': { anchor: { path: 'a#s', t: 'a', txt: 'Settings' }, at: 900, trail: [] } },
  versions: [{ id: 'build-7', label: 'Sprint 12', at: 800 }],
  shots: { Home: 'shots/home/1000-abc.jpg' },
  mapmeta: { aliases: { Home: 'Start' }, hidden: ['Settings'] },
};

test('a thread survives the round trip through events, verbatim', () => {
  const data = sanitizeImport(exported);
  const events = importEvents(data);
  const [back] = assemble(events);
  const want = data.threads[0];

  for (const key of ['id', 'createdAt', 'authorRole', 'author', 'screen', 'screenLabel', 'proto', 'page', 'n', 'kind', 'status', 'statusNote', 'resolved', 'preview']) {
    assert.deepEqual(back[key], want[key], `${key} did not survive`);
  }
  assert.deepEqual(back.anchor, want.anchor);
  assert.deepEqual(back.trail, want.trail);
  assert.deepEqual(back.theme, want.theme);
  assert.deepEqual(back.history, want.history);
  assert.equal(back.messages.length, 2);
  assert.deepEqual(
    back.messages.map((m) => [m.author, m.role, m.text, m.at, m.edited || false]),
    [
      ['Olena', 'client', 'the label is cut off', 1000, false],
      ['Dima', 'designer', 'fixed the width', 1200, true],
    ]
  );
  assert.deepEqual(back.messages[0].img, ['attach/aaa/1.png']);
  assert.deepEqual(back.messages[1].reactions, { '👍': ['Olena'] });
});

test('replaying the same import twice writes the same pathnames', () => {
  const a = importEvents(sanitizeImport(exported)).map((e) => e.pathname);
  const b = importEvents(sanitizeImport(exported)).map((e) => e.pathname);
  assert.deepEqual(a, b, 'pathnames must be deterministic or a re-run duplicates the room');
  assert.equal(new Set(a).size, a.length, 'and unique, or events overwrite each other');
});

test('nav, versions, shots and map metadata come across', () => {
  const data = sanitizeImport(exported);
  assert.deepEqual(data.nav['Home>Settings'].anchor, exported.nav['Home>Settings'].anchor);
  assert.deepEqual(data.versions, [{ id: 'build-7', label: 'Sprint 12', at: 800 }]);
  assert.deepEqual(data.shots, { Home: 'shots/home/1000-abc.jpg' });
  assert.deepEqual(data.mapmeta, { aliases: { Home: 'Start' }, hidden: ['Settings'] });
  // The public GET hands nav back as the bare anchor; that shape imports too.
  const bare = sanitizeImport({ nav: { 'A>B': { path: 'a', t: 'a', txt: 'B' } } });
  assert.deepEqual(bare.nav['A>B'].anchor, { path: 'a', t: 'a', txt: 'B' });
});

test('an import is untrusted input', () => {
  const junk = sanitizeImport({
    threads: [
      { id: '../../etc/passwd', createdAt: 1, authorRole: 'client', messages: [{ author: 'x', role: 'client', text: 'hi', at: 1 }] },
      // A thread id every server would refuse to look up: importing one would
      // create a comment nobody could reply to, resolve or delete.
      { id: 'not-a-uuid', createdAt: 1, authorRole: 'client', messages: [{ author: 'x', role: 'client', text: 'hi', at: 1 }] },
      { id: '11111111-1111-4111-8111-111111111111', createdAt: 1, authorRole: 'root', messages: [{ author: 'x', role: 'client', text: 'hi', at: 1 }] },
      { id: '22222222-2222-4222-8222-222222222222', createdAt: 1, authorRole: 'client', messages: [] },
      {
        id: '33333333-3333-4333-8333-333333333333',
        createdAt: 1,
        authorRole: 'client',
        status: 'invented',
        kind: 'invented',
        preview: 'https://evil.example/x.jpg',
        page: 'https://evil.example',
        messages: [{ author: 'x', role: 'client', text: 'hi', at: 1, img: ['../secret.png'], reactions: { '💣': ['x'] } }],
      },
    ],
    shots: { Home: 'shots/../../escape.jpg' },
  });
  assert.deepEqual(junk.threads.map((t) => t.id), ['33333333-3333-4333-8333-333333333333'], 'only the well-formed thread survives');
  const [t] = junk.threads;
  assert.equal(t.status, 'open');
  assert.equal(t.kind, null);
  assert.equal(t.preview, null);
  assert.equal(t.page, null);
  assert.equal(t.messages[0].img, undefined);
  assert.equal(t.messages[0].reactions, undefined);
  assert.deepEqual(junk.shots, {});
});

test('one import cannot be unbounded', () => {
  const many = Array.from({ length: MAX_IMPORT_THREADS + 50 }, (_, i) => ({
    id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
    createdAt: 1,
    authorRole: 'client',
    messages: [{ author: 'x', role: 'client', text: 'hi', at: 1 }],
  }));
  assert.equal(sanitizeImport({ threads: many }).threads.length, MAX_IMPORT_THREADS);
});
