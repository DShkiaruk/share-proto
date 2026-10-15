import * as storage from '../lib/storage.js';
import { roomFromReq } from '../lib/cors.js';
import { CHANGES_MAX_AGE, VERSION_HEADERS, versionTag } from '../lib/changes.js';

/* GET /api/version[?room=…] → { v } — the room's version, so an open tab can
   ask "has anything changed?" without a full read (lib/changes.js).

   The CDN keeps the answer under the room's tag; api/comments.js purges the
   tag on every write. A cached answer runs no function and reads no storage;
   when it is not cached, this reads the document's ETag (one storage
   operation, no download) — once per purge or expiry, for every tab at once. */
export default async function handler(req, res) {
  for (const [k, v] of Object.entries(VERSION_HEADERS)) res.setHeader(k, v);
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'Method not allowed' });
  const room = roomFromReq(req);
  let v;
  try {
    v = (await storage.headEtag(`${room ? `rooms/${room}/` : ''}state.json`)) || '0';
  } catch {
    // Not cached: the next ask tries again. The overlay reads in full meanwhile.
    return res.status(503).json({ error: 'Version unavailable' });
  }
  res.setHeader('Vercel-CDN-Cache-Control', `public, max-age=${CHANGES_MAX_AGE}`);
  res.setHeader('Vercel-Cache-Tag', versionTag(room));
  return res.status(200).json({ v });
}
