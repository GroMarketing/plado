#!/usr/bin/env node
// Trending: stars each repo gained today, this week, this quarter and this year, plus prompt votes.
//   node site/data/fetch-trending.mjs         (after fetch-catalog / fetch-skills-prompts)
//   MAX_CALLS=60 node .../fetch-trending.mjs                  (limit archive calls, e.g. for a quick test)
// Writes data/trending.json and a daily snapshot in data/history/YYYY-MM-DD.json.
//
// GitHub no longer lists who starred a repo or when (stargazers returns 404, checked
// 2026-09-28), so star timestamps can't come from GitHub. Two sources instead:
// 1. Our own daily snapshots of GitHub's star counts. Once a snapshot old enough exists, a
//    window is stars now minus stars then (src: 'github', exact).
// 2. Until then, the public GitHub event archive through OSS Insight's free API (600 calls/hr
//    per IP). Its counts run lower than GitHub's own totals, so these gains are a trend signal
//    in archive units, labeled as such, and never mixed with GitHub counts (src: 'archive').
//    Each repo's series is cached and refreshed oldest-first within MAX_CALLS per run.
// Prompts: prompts.chat publishes vote counts but not vote dates. Until snapshots cover a
// window, prompt trending means "new in this window, ranked by votes" (src: 'new').
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = 'PladoBot/0.1 (+https://plado.dev)';
const DAY = 86400000;
const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const WINDOWS = { day: 1, week: 7, quarter: 90, year: 365 };
const MAX_CALLS = Number(process.env.MAX_CALLS) || 550; // ~1 hour of archive calls at the paced rate
const ARCHIVE_GAP_MS = 6500;                             // stays under 600 calls/hr
const REFRESH_DAYS = 7;                                  // re-pull a repo's archive series weekly
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readOpt = (f) => { try { return JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8')); } catch { return null; } };
const day = (t) => new Date(t).toISOString().slice(0, 10);

// ---------- inputs ----------
// only repos that passed the listing gates (the last build's index), else everything fetched
const known = {};
const listed = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'dist', 'data', 'index.json'), 'utf8')).entries.filter((e) => ['plugin', 'mcp-server', 'skill'].includes(e.t) && e.r?.includes('/')); } catch { return null; } })();
if (listed) for (const e of listed) known[e.r] = Math.max(known[e.r] || 0, e.st || 0);
else for (const f of ['catalog.json', 'skills.json']) for (const e of readOpt(f)?.entries || []) if (e.github?.repo) known[e.github.repo] = Math.max(known[e.github.repo] || 0, e.github.stars || 0);
const repos = Object.keys(known).sort((a, b) => known[b] - known[a]);
log(`${repos.length} repos`);

// ---------- current star counts from GitHub (GraphQL, 50 per query) ----------
function graphql(q) {
  for (let i = 0; i < 4; i++) {
    let res;
    try { res = JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', `query=${q}`], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString()); }
    catch (e) { try { res = JSON.parse(e.stdout?.toString() || '{}'); } catch { res = {}; } }
    if (res.data) return res.data;
    execFileSync('sleep', [String(5 * (i + 1))]);
  }
  return {};
}
const stars = {};
for (let i = 0; i < repos.length; i += 50) {
  const chunk = repos.slice(i, i + 50);
  const d = graphql(`{ ${chunk.map((r, j) => { const [o, n] = r.split('/'); return `r${j}: repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) { stargazerCount }`; }).join(' ')} }`);
  chunk.forEach((r, j) => { if (d[`r${j}`]) stars[r] = d[`r${j}`].stargazerCount; });
}
log(`current stars for ${Object.keys(stars).length} repos`);

// ---------- our snapshots ----------
const HIST = path.join(HERE, 'history');
fs.mkdirSync(HIST, { recursive: true });
const snaps = fs.readdirSync(HIST).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) !== TODAY)
  .map((f) => ({ t: Date.parse(f.slice(0, 10)), date: f.slice(0, 10), ...JSON.parse(fs.readFileSync(path.join(HIST, f), 'utf8')) }));
// the snapshot at (or just before) the window start, within 15% of the window
const snapFor = (days) => {
  const start = Date.parse(TODAY) - days * DAY, tol = Math.floor(days * 0.15) * DAY;
  return snaps.filter((s) => s.t <= start && s.t >= start - tol).sort((a, b) => b.t - a.t)[0] || null;
};

// ---------- archive series (OSS Insight), cached per repo ----------
const CACHE = path.join(HERE, '.cache-trending');
fs.mkdirSync(CACHE, { recursive: true });
const cfile = (r) => path.join(CACHE, r.replace('/', '__') + '.json');
const cread = (r) => { try { return JSON.parse(fs.readFileSync(cfile(r), 'utf8')); } catch { return null; } };
async function archive(r) {
  const from = day(NOW - 400 * DAY);
  for (let i = 0; i < 4; i++) {
    let res;
    try { res = await fetch(`https://api.ossinsight.io/v1/repos/${r}/stargazers/history/?per=day&from=${from}&to=${TODAY}`, { headers: { 'User-Agent': UA } }); } catch { await sleep(5000 * (i + 1)); continue; }
    if (res.status === 429) { log('archive rate limited, waiting 10 min'); await sleep(600000); continue; }
    if (res.status === 404) return { fetchedAt: TODAY, series: [] };
    if (!res.ok) { await sleep(5000 * (i + 1)); continue; }
    try {
      const rows = (await res.json()).data?.rows || [];
      return { fetchedAt: TODAY, series: rows.map((x) => [x.date, Number(x.stargazers)]) };
    } catch { await sleep(3000); }
  }
  return null;
}
const stale = repos.filter((r) => { const c = cread(r); return !c || (NOW - Date.parse(c.fetchedAt)) / DAY >= REFRESH_DAYS; })
  .sort((a, b) => (cread(a)?.fetchedAt || '').localeCompare(cread(b)?.fetchedAt || '') || known[b] - known[a]);
let calls = 0;
for (const r of stale) {
  if (calls >= MAX_CALLS) break;
  const x = await archive(r); calls++;
  if (x) fs.writeFileSync(cfile(r), JSON.stringify(x));
  if (calls % 50 === 0) log(`archive ${calls}/${Math.min(MAX_CALLS, stale.length)} (${stale.length} stale)`);
  await sleep(ARCHIVE_GAP_MS);
}
log(`archive calls this run: ${calls}; still stale: ${Math.max(0, stale.length - calls)}`);
// cumulative archive count on or before a date
const at = (series, d) => { let v = 0; for (const [date, n] of series) { if (date <= d) v = n; else break; } return v; };

// ---------- windows ----------
const out = { generatedAt: new Date(NOW).toISOString(), windows: WINDOWS, repos: {}, prompts: {}, method: {} };
// Both measures are kept when available; the build ranks each window on one source only
// (GitHub snapshots once they cover most repos, the archive before that), never a mix.
const srcCount = { gh: 0, ar: 0 };
for (const r of repos) {
  if (stars[r] == null) continue;
  const c = cread(r), gained = {};
  for (const [w, days] of Object.entries(WINDOWS)) {
    const g = {};
    const s = snapFor(days);
    if (s?.stars?.[r] != null) { g.gh = { n: Math.max(0, stars[r] - s.stars[r]), base: s.stars[r] }; srcCount.gh++; }
    if (c?.series) {
      // measured back from the day the series was pulled, so "today" isn't cut short
      const startDay = day(Date.parse(c.fetchedAt) - days * DAY), base = at(c.series, startDay);
      g.ar = { n: Math.max(0, at(c.series, c.fetchedAt) - base), base, asOf: c.fetchedAt }; srcCount.ar++;
    }
    if (g.gh || g.ar) gained[w] = g;
  }
  out.repos[r] = { stars: stars[r], gained };
}

// ---------- prompts ----------
const P = readOpt('prompts.json')?.entries || [];
let meta = [];
try { meta = (await (await fetch('https://prompts.chat/prompts.json', { headers: { 'User-Agent': UA } })).json()).prompts || []; } catch { log('prompts.chat unavailable; prompt trending uses stored votes only'); }
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const byTitle = new Map(meta.map((m) => [norm(m.title), m]));
for (const e of P) {
  const m = byTitle.get(norm(e.name));
  const votes = m?.voteCount ?? e.community.votes, createdAt = m?.createdAt || null, gained = {};
  for (const [w, days] of Object.entries(WINDOWS)) {
    const s = snapFor(days);
    if (s?.votes?.[e.id] != null) gained[w] = { n: Math.max(0, votes - s.votes[e.id]), src: 'snapshot' };
    else if (createdAt && Date.parse(createdAt) >= NOW - days * DAY) gained[w] = { n: votes, src: 'new' };
  }
  out.prompts[e.id] = { votes, createdAt, gained };
}

out.method = { snapshotsUsed: Object.fromEntries(Object.entries(WINDOWS).map(([w, d]) => [w, snapFor(d)?.date || null])), sources: srcCount, archiveCallsThisRun: calls };
fs.writeFileSync(path.join(HERE, 'trending.json'), JSON.stringify(out));

// today's snapshot: keep the first value seen each day, add repos and prompts not seen yet
const snapFile = path.join(HIST, `${TODAY}.json`);
const snap = (() => { try { return JSON.parse(fs.readFileSync(snapFile, 'utf8')); } catch { return { stars: {}, votes: {} }; } })();
for (const [r, n] of Object.entries(stars)) if (!(r in snap.stars)) snap.stars[r] = n;
for (const [id, x] of Object.entries(out.prompts)) if (!(id in snap.votes)) snap.votes[id] = x.votes;
fs.writeFileSync(snapFile, JSON.stringify(snap));
log(`wrote trending.json (${Object.keys(out.repos).length} repos; windows by source ${JSON.stringify(srcCount)}) and history/${TODAY}.json`);
