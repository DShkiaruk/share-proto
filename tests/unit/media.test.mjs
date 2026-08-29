import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImageDataUrl, parseImages, MAX_IMAGES } from '../../template/lib/media.js';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const PNG = 'data:image/png;base64,' + b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = 'data:image/jpeg;base64,' + b64([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = 'data:image/webp;base64,' + b64([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), 1]);

test('parseImageDataUrl sniffs jpeg/png/webp from bytes, not from the declared type', () => {
  assert.equal(parseImageDataUrl(PNG).ext, 'png');
  assert.equal(parseImageDataUrl(JPG).contentType, 'image/jpeg');
  assert.equal(parseImageDataUrl(WEBP).ext, 'webp');
  assert.equal(parseImageDataUrl('data:image/png;base64,' + b64([0xff, 0xd8, 0xff, 0, 0])).ext, 'jpg'); // lies about type
});

test('parseImageDataUrl rejects junk, svg, oversize', () => {
  assert.equal(parseImageDataUrl('hello'), null);
  assert.equal(parseImageDataUrl('data:image/svg+xml;base64,' + b64(Buffer.from('<svg/>'))), null);
  assert.equal(parseImageDataUrl(JPG, { maxBytes: 3 }), null);
  assert.equal(parseImageDataUrl(null), null);
});

test('parseImages caps the count and skips invalid entries', () => {
  const out = parseImages([JPG, 'junk', PNG, WEBP, JPG]);
  assert.equal(out.length, MAX_IMAGES);
  assert.deepEqual(out.map((p) => p.ext), ['jpg', 'png', 'webp']);
  assert.deepEqual(parseImages('nope'), []);
});
