import { Readable } from 'node:stream';
import { getFile, readJson } from '../lib/storage.js';
import { canSee } from '../lib/threads.js';
import { sessionFromHeaders } from '../lib/session.js';
import { applyCors, roomFromReq } from '../lib/cors.js';

/* Serves private media (thread previews, attachments, screen shots) behind
   the session. Pathnames are content-unique, so responses are immutable.
     previews/<tid>/<file>  attach/<tid>/<file>   → visible thread only
     shots/<key>/<file>                            → any signed-in role */

const SAFE = /^(previews|attach|shots)\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,80}\.(jpe?g|png|webp)$/;

export default async function handler(req, res) {
  if (applyCors(req, res, process.env.ALLOWED_ORIGINS)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const session = await sessionFromHeaders(
    req.headers.cookie || '',
    req.headers.authorization || '',
    process.env.SESSION_SECRET
  );
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const room = roomFromReq(req);
  const root = room ? `rooms/${room}/` : '';
  const url = new URL(req.url, 'http://x');
  const rel = String(url.searchParams.get('p') || '');
  if (!SAFE.test(rel) || rel.includes('..')) return res.status(400).json({ error: 'Bad path' });

  const [kind, key] = rel.split('/');
  if (kind !== 'shots') {
    const { data: state } = await readJson(`${root}state.json`);
    const thread = state?.threads?.find((t) => t.id === key);
    if (!thread || !canSee(session.r, thread)) return res.status(404).json({ error: 'Not found' });
  }

  const file = await getFile(`${root}${rel}`);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (file.size) res.setHeader('Content-Length', String(file.size));
  res.status(200);
  Readable.fromWeb(file.stream).pipe(res);
}
