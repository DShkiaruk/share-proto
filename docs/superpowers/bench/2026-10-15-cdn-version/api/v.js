// A stand-in for "the comments' version": cached on the CDN under a tag,
// generated anew only when the cache has nothing.
export default {
  async fetch() {
    return Response.json({ generatedAt: Date.now() }, {
      headers: {
        'Vercel-CDN-Cache-Control': 'public, max-age=3600',
        'Cache-Control': 'no-store',
        'Vercel-Cache-Tag': 'state',
      },
    });
  },
};
