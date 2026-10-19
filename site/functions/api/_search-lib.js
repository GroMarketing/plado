// Shared rules for search logging and trending searches.
export const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
// Never store anything that looks personal or secret: emails, links, long numbers, tokens.
export const storable = (q) => q.length >= 2 && q.split(' ').length <= 8 && !/@|https?:|www\.|\d{5,}|[a-z0-9_-]{24,}/i.test(q);
// Only show queries made entirely of words we know (catalog names, tools, tasks), so nobody
// can push arbitrary text onto a public list.
let vocab = null;
export async function loadVocab(env, request) {
  if (vocab) return vocab;
  try { vocab = new Set(await (await env.ASSETS.fetch(new URL('/data/vocab.json', request.url))).json()); } catch { vocab = new Set(); }
  return vocab;
}
export const displayable = (q, v) => q.split(/[^a-z0-9.+#/-]+/).filter(Boolean).every((w) => v.has(w));
export async function clientId(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const day = new Date().toISOString().slice(0, 10);
  // no salt, no storing: a known salt would let IPv4 hashes be reversed by brute force
  if (!env.SEARCH_SALT) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}|${day}|${env.SEARCH_SALT}`));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
