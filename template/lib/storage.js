import { list, put, get, del, BlobPreconditionFailedError } from '@vercel/blob';

/* Blob adapter (private store only). Two kinds of objects live in the store:
   - events (append-only, unique pathnames)         → appendEvent / readEvents
   - documents (fixed pathnames, overwritten with
     optimistic concurrency via ETag)               → readJson / writeJson
   Reads use useCache:false so a document is fresh right after its overwrite —
   verified in docs/superpowers/specs/spike-blob-overwrite.md (0 stale reads in
   50; the same call returns 403 on public stores, which is why legacy public
   stores are migrated rather than read). */

const ACCESS = 'private';
const JSON_OPTS = { access: ACCESS, addRandomSuffix: false, contentType: 'application/json' };

export class ConflictError extends Error {
  constructor(pathname) {
    super(`conflict writing ${pathname}`);
    this.name = 'ConflictError';
  }
}

export async function readJson(pathname) {
  let r;
  try {
    r = await get(pathname, { access: ACCESS, useCache: false });
  } catch {
    return { data: null, etag: null };
  }
  if (!r || r.statusCode !== 200 || !r.stream) return { data: null, etag: null };
  const etag = r.blob?.etag || null;
  try {
    return { data: JSON.parse(await new Response(r.stream).text()), etag };
  } catch {
    return { data: null, etag };
  }
}

export async function writeJson(pathname, data, { ifMatch } = {}) {
  try {
    const res = await put(pathname, JSON.stringify(data), {
      ...JSON_OPTS,
      allowOverwrite: true,
      ...(ifMatch ? { ifMatch } : {}),
    });
    return { etag: res.etag };
  } catch (e) {
    if (e instanceof BlobPreconditionFailedError) throw new ConflictError(pathname);
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
  let r;
  try {
    r = await get(pathname, { access: ACCESS, useCache: true });
  } catch {
    return null;
  }
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
