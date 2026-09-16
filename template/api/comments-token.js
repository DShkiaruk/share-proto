/* A comments session for a reader the gate has already let in.

   The page and the comments can live on different hosts, and the comments host
   cannot see this one's cookie — so without this, a reader who is already past
   the password is asked for the same password a second time by the overlay.
   The gate does this at sign-in; this route covers everyone whose session was
   issued before, and everyone whose comments token expires mid-review.

   It hands out no more authority than the caller already has: the role comes
   from the signed session, never from the request. */
import { sessionFromRequest } from '../lib/session.js';
import { COMMENTS_HOST, COMMENTS_ROOM } from '../lib/comments-host.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // Nothing to bridge to: this deployment serves its own comments.
  if (!COMMENTS_HOST) return res.status(404).json({ error: 'No remote comments host' });

  const session = await sessionFromRequest(req.headers.cookie || '', process.env.SESSION_SECRET);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const password = session.r === 'designer' ? process.env.DESIGNER_PASSWORD : process.env.CLIENT_PASSWORD;
  if (!password) return res.status(404).json({ error: 'No password for this role' });

  const q = COMMENTS_ROOM ? `?room=${encodeURIComponent(COMMENTS_ROOM)}` : '';
  try {
    const r = await fetch(`${COMMENTS_HOST}/api/login${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: session.n, password }),
    });
    const d = r.ok ? await r.json() : null;
    // A token is the only useful answer. Anything else means the two sides hold
    // different passwords, and the overlay's own login is the way through.
    if (!d?.token) return res.status(502).json({ error: 'The comments host did not accept this deployment' });
    return res.status(200).json({ token: d.token, role: d.role, name: session.n });
  } catch {
    return res.status(502).json({ error: 'The comments host could not be reached' });
  }
}
