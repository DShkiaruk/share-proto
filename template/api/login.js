import { createToken } from '../lib/session.js';
import { applyCors } from '../lib/cors.js';

const SIXTY_DAYS_S = 60 * 24 * 60 * 60;

// Best-effort brute-force brake: serverless instances don't share memory, so
// this is a speed bump, not a wall — the real defence is password entropy.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 10;
const fails = new Map(); // ip → { n, since }

function tooMany(ip) {
  const now = Date.now();
  const e = fails.get(ip);
  if (!e || now - e.since > WINDOW_MS) return false;
  return e.n >= MAX_FAILS;
}
function noteFail(ip) {
  const now = Date.now();
  const e = fails.get(ip);
  if (!e || now - e.since > WINDOW_MS) fails.set(ip, { n: 1, since: now });
  else e.n++;
  if (fails.size > 5000) fails.clear();
}
const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '')
    .split(',')[0]
    .trim();

export default async function handler(req, res) {
  if (applyCors(req, res, process.env.ALLOWED_ORIGINS)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const ip = clientIp(req);
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many attempts' });

  const { password, name } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 40);
  if (!cleanName) {
    return res.status(400).json({ error: 'Missing name' });
  }
  const role =
    password && password === process.env.DESIGNER_PASSWORD
      ? 'designer'
      : password && password === process.env.CLIENT_PASSWORD
        ? 'client'
        : null;
  if (!role) {
    noteFail(ip);
    await new Promise((r) => setTimeout(r, 800));
    return res.status(401).json({ error: 'Wrong password' });
  }
  fails.delete(ip);
  const token = await createToken(
    { r: role, n: cleanName, exp: Date.now() + SIXTY_DAYS_S * 1000 },
    process.env.SESSION_SECRET
  );
  res.setHeader(
    'Set-Cookie',
    `fp_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SIXTY_DAYS_S}`
  );
  // The token also goes in the body: embed mode (overlay on a foreign page)
  // can't use cross-site cookies and sends it back as a Bearer header.
  return res.status(200).json({ role, token });
}
