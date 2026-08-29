import { list, put, get, del, BlobPreconditionFailedError } from '@vercel/blob';

/* Blob adapter (private store only). Two kinds of objects live in the store:
   - events (append-only, unique pathnames)         → appendEvent / readEvents
   - documents (fixed pathnames, overwritten only
     conditionally: ifMatch ETag or ifAbsent)       → readJson / writeJson
   Reads use useCache:false so a document is fresh right after its overwrite —
   verified in docs/superpowers/specs/spike-blob-overwrite.md (0 stale reads in
   50; get().blob.etag === head().etag and works as ifMatch; the same read
   returns 403 on public stores, which is why legacy public stores are
   migrated rather than read). */

const ACCESS = 'private';
const JSON_OPTS = { access: ACCESS, addRandomSuffix: false, contentType: 'application/json' };

// get() may return a weak validator (W/"…", e.g. when the CDN compressed the
// body) while put({ifMatch}) only accepts the strong form the blob carries.
// Found on the lab: every state.json write "conflicted" until this strip.
export const normalizeEtag = (etag) => (etag ? String(etag).replace(/^W\//, '') : null);

export class ConflictError extends Error {
  constructor(pathname) {
    super(`conflict writing ${pathname}`);
    this.name = 'ConflictError';
  }
}

// get() returns null for a missing blob. Any other failure (403, 5xx, rate
// limit) propagates: a swallowed error here would be turned into an empty
// state document by the caller's rebuild.
export async function readJson(pathname) {
  const r = await get(pathname, { access: ACCESS, useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return { data: null, etag: null };
  const etag = normalizeEtag(r.blob?.etag);
  let data = null;
  try {
    data = JSON.parse(await new Response(r.stream).text());
  } catch {
    data = null; // corrupt document → the caller rebuilds it
  }
  return { data, etag };
}

// Conditional document write. ifMatch: only if the blob still has that ETag.
// ifAbsent: only if no blob exists (put without allowOverwrite throws
// "already exists"). Both map to ConflictError. Without either flag the write
// is unconditional — callers in this codebase never do that.
export async function writeJson(pathname, data, { ifMatch, ifAbsent } = {}) {
  try {
    const res = await put(pathname, JSON.stringify(data), {
      ...JSON_OPTS,
      ...(ifAbsent ? {} : { allowOverwrite: true }),
      ...(ifMatch ? { ifMatch } : {}),
    });
    return { etag: res.etag };
  } catch (e) {
    if (e instanceof BlobPreconditionFailedError) throw new ConflictError(pathname);
    if (ifAbsent && /already exists/i.test(e?.message || '')) throw new ConflictError(pathname);
    throw e;
  }
}

export async function appendEvent(pathname, data) {
  await put(pathname, JSON.stringify(data), JSON_OPTS);
}

export async function listAll(prefix) {
  const blobs = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const page = await list({ prefix, limit: 1000, cursor });
    blobs.push(...page.blobs);
    if (!page.hasMore) break;
    cursor = page.cursor;
  }
  return blobs.map((b) => ({ pathname: b.pathname, url: b.url }));
}

// An event deleted between list() and get() comes back as data:null and is
// skipped by assemble(); a real read error propagates so a rebuild never
// produces a truncated document.
export async function readEvents(prefix) {
  const blobs = await listAll(prefix);
  return Promise.all(
    blobs.map(async ({ pathname }) => {
      const { data } = await readJson(pathname);
      return { pathname, data };
    })
  );
}

export async function putFile(pathname, body, contentType) {
  await put(pathname, body, { access: ACCESS, addRandomSuffix: false, contentType });
  return { pathname };
}

export async function getFile(pathname) {
  const r = await get(pathname, { access: ACCESS, useCache: true });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return {
    stream: r.stream,
    contentType: r.blob?.contentType || 'application/octet-stream',
    size: r.blob?.size,
  };
}

export async function delAll(pathnames) {
  if (!pathnames.length) return;
  await del(pathnames).catch(() => {});
}
