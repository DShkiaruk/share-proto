const enc = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function b64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function createToken(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${sig}`;
}

export async function verifyToken(token, secret) {
  if (!token || !secret) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/* A session is issued for one room and is not a key to the others.

   Rooms were built for one client's many PR previews, where a single pair of
   passwords over all of them is the point. The moment one deployment hosts
   rooms for *different* clients — which is what happens when someone hosts the
   comments for several projects — that same property means anyone holding one
   room's password can read and write the rest by changing ?room=. Two things
   close it: a token that names the room it was minted for (here), and
   passwords that can differ per room (roomPasswords, below).

   A token from before this carries no room claim. It is honoured for the
   default room only, so existing links keep working and an old token still
   cannot roam. */
export const sessionAllowsRoom = (session, room) =>
  Boolean(session) && (session.room || '') === (room || '');

/* Which passwords open a room. `perRoom` is JSON — {"<room>": {"designer": …,
   "client": …}} — and a room named there is opened by its own pair only: the
   deployment-wide password must not be a master key to a client's room. Rooms
   not named there keep the deployment-wide pair, which is the single-client
   case and stays as simple as it was. */
export function roomPasswords({ designer, client, perRoom }, room) {
  if (perRoom && room) {
    let table = perRoom;
    if (typeof table === 'string') {
      try {
        table = JSON.parse(table);
      } catch {
        table = null; // a malformed table must not silently open every room
      }
    }
    const own = table && typeof table === 'object' ? table[room] : null;
    if (own && typeof own === 'object') {
      return { designer: own.designer || null, client: own.client || null };
    }
  }
  return { designer: designer || null, client: client || null };
}

export function roleFor(password, passwords) {
  if (!password) return null;
  if (passwords.designer && password === passwords.designer) return 'designer';
  if (passwords.client && password === passwords.client) return 'client';
  return null;
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export async function sessionFromRequest(cookieHeader, secret) {
  const cookies = parseCookies(cookieHeader);
  return verifyToken(cookies.fp_session, secret);
}

// Embed mode sends the session as `Authorization: Bearer <token>` because
// cross-site cookies don't survive. Cookie wins ties (same-origin installs).
export async function sessionFromHeaders(cookieHeader, authHeader, secret) {
  const viaCookie = await sessionFromRequest(cookieHeader, secret);
  if (viaCookie) return viaCookie;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader || '');
  return m ? verifyToken(m[1].trim(), secret) : null;
}
