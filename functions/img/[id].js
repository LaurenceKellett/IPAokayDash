/**
 * GET /img/:id
 *
 * Streams a cached beer photo out of R2 (env.DASH_IMAGES). Images are
 * populated during /api/sync — this route never talks to Notion.
 */
export async function onRequestGet({ env, params }) {
  const key = `beer/${params.id}`;
  const obj = await env.DASH_IMAGES.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
