// GET /api/trending-searches?w=day|week → the most-searched queries, counted as distinct people.
import { loadVocab, displayable } from './_search-lib.js';

const HOURS = { hour: 1, day: 24, week: 168 };
export async function onRequestGet({ request, env }) {
  const w = HOURS[new URL(request.url).searchParams.get('w')] ? new URL(request.url).searchParams.get('w') : 'day';
  const h = HOURS[w], now = Math.floor(Date.now() / 3600000), min = Number(env.TRENDING_MIN_PEOPLE || 3);
  if (!env.DB) return Response.json({ window: w, items: [] });
  const q = 'SELECT q, COUNT(DISTINCT client) AS n FROM search_hits WHERE hour > ?1 AND hour <= ?2 GROUP BY q HAVING n >= ?3 ORDER BY n DESC LIMIT 60';
  const [cur, prev] = await Promise.all([
    env.DB.prepare(q).bind(now - h, now, min).all(),
    env.DB.prepare(q).bind(now - 2 * h, now - h, 1).all(),
  ]);
  const before = Object.fromEntries((prev.results || []).map((r) => [r.q, r.n]));
  const v = await loadVocab(env, request);
  const items = (cur.results || []).filter((r) => displayable(r.q, v)).slice(0, 12)
    .map((r) => ({ q: r.q, n: r.n, change: before[r.q] ? Math.round(((r.n - before[r.q]) / before[r.q]) * 100) : null }));
  return Response.json({ window: w, updated: new Date().toISOString(), minPeople: min, items }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}
