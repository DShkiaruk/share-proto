/* Image payload validation — pure, shared by the Vercel API and server.js.
   Images arrive as data URLs inside JSON. The content type is decided by the
   magic bytes, never by the declared MIME (an SVG "image" would be a script). */

export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
export const MAX_IMAGES = 3;

const KINDS = [
  { sig: [0xff, 0xd8, 0xff], contentType: 'image/jpeg', ext: 'jpg' },
  { sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], contentType: 'image/png', ext: 'png' },
  { riff: true, contentType: 'image/webp', ext: 'webp' },
];

function decodeBase64(s) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseImageDataUrl(str, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (typeof str !== 'string') return null;
  const m = /^data:([\w/+.-]+)?;base64,([A-Za-z0-9+/=\s]+)$/.exec(str);
  if (!m) return null;
  const b64 = m[2].replace(/\s+/g, '');
  if ((b64.length * 3) / 4 > maxBytes + 4) return null; // cheap pre-check before decoding
  let buf;
  try {
    buf = decodeBase64(b64);
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.length > maxBytes) return null;
  for (const k of KINDS) {
    if (k.riff) {
      const s = (o, t) => [...t].every((c, i) => buf[o + i] === c.charCodeAt(0));
      if (buf.length >= 12 && s(0, 'RIFF') && s(8, 'WEBP')) return { buf, contentType: k.contentType, ext: k.ext };
    } else if (k.sig.every((b, i) => buf[i] === b)) {
      return { buf, contentType: k.contentType, ext: k.ext };
    }
  }
  return null;
}

export function parseImages(arr, opts) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    const p = parseImageDataUrl(s, opts);
    if (p) out.push(p);
    if (out.length === MAX_IMAGES) break;
  }
  return out;
}
