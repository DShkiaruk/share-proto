// A prototype that routes on the client (React Router, Vue Router, anything
// with real paths rather than a hash) is served from one index.html. Without a
// catch-all rewrite the first deep link a reviewer opens — or the first reload
// on an inner screen — is a Vercel 404, and the comment that lives on that
// screen becomes unreachable. The local server has had `--spa` since the
// beginning; the Vercel edition did not, and nothing failed loudly enough to
// notice, because assembling a single-file prototype never exercises it.
//
// The rewrite is unconditional on purpose. `update.py` copies vercel.json over
// every install, so a flag written into one project's config would be silently
// erased on the next update — the one class of bug this repo keeps paying for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../../template/vercel.json', import.meta.url), 'utf8'));

// Vercel compiles `source` with path-to-regexp and anchors it at both ends.
const matches = (source, path) => new RegExp(`^${source}$`).test(path);

test('the SPA rewrite sends extensionless paths to index.html', () => {
  const rule = cfg.rewrites?.find((r) => r.destination === '/index.html');
  assert.ok(rule, 'no catch-all rewrite to /index.html');
  for (const path of ['/', '/campaigns', '/campaigns/new/target', '/settings']) {
    assert.ok(matches(rule.source, path), `${path} should reach index.html`);
  }
});

test('it never swallows the API or a real file', () => {
  const rule = cfg.rewrites.find((r) => r.destination === '/index.html');
  // An asset served as HTML is worse than a 404: the browser reports a MIME
  // type error from a file that is on disk, and the cause reads as a build bug.
  for (const path of [
    '/api/comments',
    '/api/login',
    '/overlay.js',
    '/overlay.css',
    '/login.html',
    '/favicon.svg',
    '/assets/index-D4xk9q.js',
    '/screen-2.html', // snapshot sets are several real pages, not one app
  ]) {
    assert.ok(!matches(rule.source, path), `${path} must be served as itself`);
  }
});

test('the document is never cached, whichever path it was reached by', () => {
  // The old rule only covered `/` and `/index.html`. A deep link is the same
  // document under a different URL, and a stale copy of it points at hashed
  // assets that the next deploy removes — a white screen with no error.
  const noStore = cfg.headers.filter((h) =>
    h.headers.some((x) => x.key === 'Cache-Control' && x.value === 'no-store')
  );
  const doc = noStore.find((h) => matches(h.source, '/campaigns/new/target'));
  assert.ok(doc, 'no no-store header covers a client-routed path');
  assert.ok(matches(doc.source, '/'), 'the same rule must cover the root');
  assert.ok(!matches(doc.source, '/assets/index-D4xk9q.js'), 'assets are hashed — let them cache');
});
