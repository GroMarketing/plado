// POST /api/search  body: {"q": "..."} (sendBeacon sends it as text). Counts a finished search.
import { norm, storable, clientId } from './_search-lib.js';

export async function onRequestPost({ request, env }) {
  let q = '';
  try { q = norm(JSON.parse(await request.text()).q); } catch { return new Response(null, { status: 400 }); }
  if (!storable(q) || !env.DB) return new Response(null, { status: 204 });
  const hour = Math.floor(Date.now() / 3600000), client = await clientId(request, env);
  if (!client) return new Response(null, { status: 204 });
  await env.DB.prepare('INSERT OR IGNORE INTO search_hits (q, hour, client) VALUES (?1, ?2, ?3)').bind(q, hour, client).run();
  // keep 30 days; prune now and then instead of running a cron
  if (Math.random() < 0.01) await env.DB.prepare('DELETE FROM search_hits WHERE hour < ?1').bind(hour - 24 * 30).run();
  return new Response(null, { status: 204 });
}
