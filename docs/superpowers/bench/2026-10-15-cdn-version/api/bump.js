// A stand-in for "a comment was written": drop the cached version.
import { dangerouslyDeleteByTag } from '@vercel/functions';
export default {
  async fetch() {
    const t = Date.now();
    await dangerouslyDeleteByTag('state');
    return Response.json({ purged: true, ms: Date.now() - t });
  },
};
