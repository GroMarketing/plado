// "Alternatives" = something else that does the same job, from a different repo.
// TF-IDF over name words (weighted up), description words, integrations and tasks, cosine
// similarity through an inverted index, then: drop same-repo siblings, one per name (forks and
// copies of the same skill aren't choices), and a floor so weak matches show nothing rather than noise.
const STOP = new Set(`a an and or the of to in on for with without from by as at via into onto over this that these those it its is are be been
being was were will can could should would may might must you your yours we our they their them he she his her i me my any all each every
some more most other such also just only not no yes do does done use used uses using user users when where what which who how why than then
so if else etc eg ie e g about across after before during between within while like based new one two first make makes making get gets help
helps helper helping provide provides providing support supports supported allow allows enable enables work works working need needs want
claude code codex cursor gemini ai llm llms agent agents subagent subagents skill skills mcp server servers plugin plugins tool tools
assistant specialist expert proactively task tasks file files project projects best practice practices guide guidance comprehensive
various way ways including include includes through well built build create creates creating`.split(/\s+/));
const KEEP = new Set(['postgres', 'redis', 'kubernetes', 'aws', 'analytics', 'ios', 'windows', 'news', 'sass', 'jenkins', 'series', 'kubectl']);
const stem = (w) => KEEP.has(w) ? w : (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
const words = (s) => (String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9][a-z0-9+#]*/g) || []).map(stem).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));

// feats(e) → Map(feature → raw weight). Prefixed features can't collide with words.
function toolFeats(e) {
  const f = new Map();
  const add = (k, w) => f.set(k, Math.max(f.get(k) || 0, w));
  for (const w of words(e.name)) add(w, 3);
  // name phrases: "code reviewer" should beat "design reviewer" for a code reviewer
  const nw = (String(e.name || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) || []).map(stem);
  for (let n = 1; n < nw.length; n++) if (!(STOP.has(nw[n - 1]) && STOP.has(nw[n]))) add('p:' + nw[n - 1] + ' ' + nw[n], 3);
  for (const w of words(e.description).slice(0, 60)) if (!f.has(w)) add(w, 1);
  for (const t of e.integrations || []) add('i:' + t, 4);
  for (const t of e.use?.strong || []) add('t:' + t, 3);
  for (const t of e.use?.tasks || []) add('t:' + t, 1.5);
  for (const t of e.jobs || []) add('j:' + t, 1);
  return f;
}
function promptFeats(e) {
  const f = toolFeats(e);
  for (const w of words(e.text).slice(0, 80)) if (!f.has(w)) f.set(w, 0.5);
  if (e.category?.primary) f.set('c:' + e.category.primary, 2);
  return f;
}

// items: array; returns Map(id → [{ item, sim, shared: [feature keys, strongest first] }])
export function similar(items, { prompts = false, k = 5, floor = 0.16, crossType = 0.8, quality = (x) => x.score?.total ?? 0 } = {}) {
  const N = items.length;
  const raw = items.map(prompts ? promptFeats : toolFeats);
  const df = new Map();
  for (const f of raw) for (const key of f.keys()) df.set(key, (df.get(key) || 0) + 1);
  const cap = Math.max(50, N * 0.04); // too common to tell things apart
  const vecs = raw.map((f) => {
    const v = [];
    for (const [key, w] of f) { const d = df.get(key); if (d < 2 || d > cap) continue; v.push([key, w * Math.log(N / d)]); }
    const norm = Math.hypot(...v.map((x) => x[1])) || 1;
    return v.map(([key, w]) => [key, w / norm]);
  });
  const post = new Map();
  vecs.forEach((v, i) => { for (const [key, w] of v) { let p = post.get(key); if (!p) post.set(key, (p = [])); p.push([i, w]); } });
  const repo = (x) => x.github?.repo || x.author || x.origin;
  const nameKey = (x) => words(x.name).join(' ');
  // name words that say what it does (not which tool it talks to), for the purpose boost
  // role words say nothing about the job: "creator" alone doesn't make two things comparable
  const GENERIC = new Set(['creator', 'maker', 'generator', 'builder', 'manager', 'helper', 'pro', 'kit', 'toolkit', 'cli', 'api', 'sdk', 'util', 'utils', 'master', 'mastery', 'ultimate', 'advanced', 'senior', 'junior', 'lead', 'best', 'core', 'basic', 'simple', 'smart', 'auto', 'super', 'mode', 'dev', 'setup', 'init', 'config', 'official', 'my', 'awesome', 'plus', 'lite', 'light', 'v2', 'v3', 'engineer', 'developer', 'expert', 'agent', 'workflow', 'system']);
  const named = items.map((x) => new Set(words(x.name).filter((w) => !GENERIC.has(w))));
  const strong = items.map((x) => new Set(x.use?.strong || []));
  const purpose = items.map((x) => new Set(words(x.name).filter((w) => !GENERIC.has(w) && !(x.integrations || []).includes(w) && (df.get(w) || 0) <= cap)));
  const out = new Map();
  let covered = 0;
  items.forEach((e, i) => {
    const acc = new Map();
    for (const [key, w] of vecs[i]) for (const [j, wj] of post.get(key)) if (j !== i) acc.set(j, (acc.get(j) || 0) + w * wj);
    const own = nameKey(e);
    const cands = [];
    for (const [j, dot] of acc) {
      const x = items[j];
      if (prompts ? false : repo(x) === repo(e)) continue;
      const sim = dot * (x.type === e.type ? 1 : crossType);
      let same = 0; for (const w of purpose[i]) if (purpose[j].has(w)) same++;
      if (sim < (same ? floor * 0.6 : floor)) continue;
      // it has to be FOR the same thing: a shared name word or a named job, not a passing mention
      if (!prompts && ![...named[i]].some((w) => named[j].has(w)) && ![...strong[i]].some((t) => strong[j].has(t))) continue;
      cands.push({ j, sim, rank: sim * (1 + 0.4 * Math.min(2, same)) * (0.7 + 0.3 * Math.min(1, quality(x) / 100)) });
    }
    cands.sort((a, b) => b.rank - a.rank);
    const seen = new Set([own]), repos = new Set(), picked = [];
    for (const c of cands) {
      const x = items[c.j], nk = nameKey(x);
      if (seen.has(nk) || (!prompts && repos.has(repo(x)))) continue; // one per name, one per repo
      seen.add(nk); repos.add(repo(x));
      const mine = new Map(vecs[i]);
      const shared = vecs[c.j].filter(([key]) => mine.has(key)).map(([key, w]) => [key, w * mine.get(key)]).sort((a, b) => b[1] - a[1]).map(([key]) => key);
      picked.push({ item: x, sim: c.sim, shared });
      if (picked.length >= k) break;
    }
    out.set(e.id, picked);
    if (picked.length >= 3) covered++;
  });
  out.coverage = covered / N;
  return out;
}
