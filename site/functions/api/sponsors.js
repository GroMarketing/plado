// GET /api/sponsors: the sponsor slots that are live (paid, passed the rules, past the
// 48-hour hold, not cancelled). Never used by rankings or search.
const SLOTS = 4;
export async function onRequestGet({ env }) {
  if (!env.DB) return Response.json({ items: [] });
  const r = await env.DB.prepare("SELECT name, url, tagline FROM sponsors WHERE status = 'ok' AND live_at <= ?1 ORDER BY created_at LIMIT ?2").bind(Date.now(), SLOTS).all().catch(() => ({ results: [] }));
  const taken = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sponsors WHERE status IN ('ok','unpaid','paused')").first().catch(() => null))?.n ?? 0;
  return Response.json({ items: r.results || [], left: Math.max(0, SLOTS - taken) }, { headers: { 'Cache-Control': 'public, max-age=300' } });
}
