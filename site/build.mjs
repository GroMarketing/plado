#!/usr/bin/env node
// Plado static site generator. No dependencies: reads data/catalog.json, writes dist/.
//   node site/build.mjs            # BASE=/ , no canonical/sitemap
//   SITE_URL=https://plado.dev node .../build.mjs  # adds canonical URLs + sitemap.xml
// Every third-party string goes through esc(). Nothing from the catalog is trusted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEAMS, TASKS, INDUSTRIES, classify, clientTaxonomy } from './taxonomy.mjs';
import { similar } from './similar.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const BASE = (process.env.BASE || '/').replace(/\/?$/, '/');
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const catalog = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'catalog.json'), 'utf8'));

// ---------- listing gates + shared-repo correction (documented on /how-we-rank/) ----------
// 1. Stars belong to a repo, not to each add-on inside it. When one repo hosts several
//    listed add-ons, each gets popularity/usage from stars ÷ number of add-ons in that repo.
// 2. Preview gates: updated within 12 months, a detectable license, owner account older than
//    90 days, ≥5 stars (after the split above, except Anthropic's official marketplace),
//    and no test/demo names.
// 3. At most 10 add-ons per repo (except Anthropic's official marketplace), best first.
const DAY_MS = 86400000;
// Installs in real projects (pipeline/usage/installs.mjs): public repos with the add-on in their committed setup.
// Where we have that count it carries 25 points and stars drop to 10. Where we don't (names too generic to
// search, or not measured yet), stars keep their 35 points, so an unmeasured add-on is never marked down for it.
// Every MCP server's package or address is searchable, so all of them are on the same footing. Most top
// skills and subagents have generic names ("code-review"), and mixing measured with unmeasured put every
// unmeasured one above every measured one.
// MCP servers only for now. Plugins: community-marketplace ones are mostly installed from their authors' own
// marketplaces under another id, so "name@claude-community" finds ~0; counting only the official ones put every
// uncounted community plugin above them. Needs each author's marketplace name resolved first.
const INSTALL_TYPES = new Set(['mcp-server']);
const countable = (e) => INSTALL_TYPES.has(e.type);
const INSTALLS = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'installs.json'), 'utf8')).entries || {}; } catch { return {}; } })();
// The few in those types we can't search (template URLs, no package name) score as a typical one of their type
// rather than keeping 35 points for stars, which put them above everything we did count.
const TYPICAL = {};
for (const t of INSTALL_TYPES) { const n = catalog.entries.filter((e) => e.type === t && countable(e) && INSTALLS[e.id]).map((e) => INSTALLS[e.id].n).sort((a, b) => a - b); if (n.length) TYPICAL[t] = n[n.length >> 1]; }
function popularityParts(e, stars) {
  const starFrac = Math.min(1, Math.log10(1 + stars) / 5);
  const m = countable(e) ? INSTALLS[e.id] || (TYPICAL[e.type] != null ? { n: TYPICAL[e.type] } : null) : null;
  if (!m) return { popularity: Math.round(starFrac * 35) };
  return { installs: Math.round(Math.min(1, Math.log10(1 + m.n) / 3) * 25), popularity: Math.round(starFrac * 10) }; // 1,000+ installs = full marks
}
// the same add-on can be listed by both Anthropic marketplaces: keep one, prefer official
const dedupe = new Map();
for (const e of catalog.entries) {
  const k = `${e.github.repo}|${e.name.toLowerCase()}|${e.subpath || ''}`;
  const prev = dedupe.get(k);
  if (!prev || (e.origin === 'Anthropic official marketplace' && prev.origin !== e.origin)) dedupe.set(k, e);
}
const unique = [...dedupe.values()];
const perRepo = {};
for (const e of unique) perRepo[e.github.repo] = (perRepo[e.github.repo] || 0) + 1;
function rescore(e) {
  const g = e.github, n = perRepo[g.repo];
  const stars = g.stars / n, forks = g.forks / n;
  const days = (Date.now() - Date.parse(g.pushedAt)) / DAY_MS;
  const fresh = days < 30 ? 1 : days < 90 ? 0.8 : days < 180 ? 0.6 : days < 365 ? 0.35 : 0.1;
  const ownerAge = g.ownerCreatedAt ? (Date.now() - Date.parse(g.ownerCreatedAt)) / DAY_MS : 0;
  const parts = {
    ...popularityParts(e, stars),
    usage: Math.round(Math.min(1, Math.log10(1 + forks) / 3.5) * 15),
    maintenance: Math.round(fresh * 25),
    license: g.license && g.license !== 'NOASSERTION' ? 15 : 5,
    owner: ownerAge > 365 ? 10 : ownerAge > 90 ? 6 : 2,
  };
  return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts, sharedRepo: n > 1 ? n : 0, effectiveStars: Math.round(stars) };
}
const official = (e) => e.origin === 'Anthropic official marketplace';
const TESTY = /\b(test|testing|demo|example|hello[- ]?world|sample|playground|my[-_ ]?mcp|boilerplate)\b/i;
const gateReasons = {};
const gate = (e) => {
  const g = e.github;
  const fail = (r) => { gateReasons[r] = (gateReasons[r] || 0) + 1; return false; };
  if ((Date.now() - Date.parse(g.pushedAt)) / DAY_MS > 365) return fail('no update in 12 months');
  if (!g.license || g.license === 'NOASSERTION') return fail('no detectable license');
  if (!g.ownerCreatedAt || (Date.now() - Date.parse(g.ownerCreatedAt)) / DAY_MS < 90) return fail('owner account under 90 days old');
  if (!official(e) && e.score.effectiveStars < 5) return fail('fewer than 5 stars');
  if (TESTY.test(e.name) || TESTY.test(e.registryName || '')) return fail('test or demo name');
  return true;
};
const GITHUB_STRICT = /\bgithub\b[^.]{0,60}\b(issues?|pull requests?|prs?|actions|repos?|repositor(y|ies)|gists?|projects?|discussions?|releases?|workflows?)\b|\b(issues?|pull requests?|actions|workflows?|repositor(y|ies))\b[^.]{0,40}\bgithub\b|^github\b|\bgithub[- ]?mcp\b/i;
// catalog builds before this rule tagged anything that mentioned GitHub; re-check here
for (const e of unique) if (e.integrations.includes('github') && !GITHUB_STRICT.test(`${e.name} ${e.description}`)) e.integrations = e.integrations.filter((t) => t !== 'github');
let E = unique.map((e) => ({ ...e, score: rescore(e) })).filter(gate)
  .sort((a, b) => b.score.total - a.score.total || b.github.stars - a.github.stars);
const repoCap = {};
E = E.filter((e) => official(e) || (repoCap[e.github.repo] = (repoCap[e.github.repo] || 0) + 1) <= 10);
const funnel = { found: catalog.entries.length, duplicates: catalog.entries.length - unique.length, listed: E.length, reasons: gateReasons, cappedPerRepo: unique.length - Object.values(gateReasons).reduce((a, b) => a + b, 0) - E.length };

// ---------- skills (data/skills.json): same gates, stars split across the skills in a repo ----------
const readOpt = (f) => { try { return JSON.parse(fs.readFileSync(path.join(HERE, 'data', f), 'utf8')); } catch { return null; } };
// security scan (pipeline/scan/full.mjs): facts about what the code does, never a verdict
const SCAN = readOpt('scan.json');
const scanOf = (e) => SCAN?.entries?.[e.id] || null;
const SCAN_LIVE = !!SCAN && SCAN.scanned / SCAN.total >= 0.95; // the preview banner comes down only when nearly everything is scanned
const FACT_LABEL = { envnet: 'Reads environment variables and sends network requests with them', remote: 'Downloads content and runs it', shell: 'Runs shell commands', eval: 'Runs code it builds while running (eval or exec)', network: 'Makes network requests', env: 'Reads environment variables, where API keys usually live', install: 'Installs system packages', deps: 'Uses dependencies without a pinned version', writes: 'Writes files', hidden: 'Includes scripts in hidden folders' };
const FACT_NOTE = { envnet: 'API clients do this to send your key to the service. Check which service it talks to.', remote: 'Whatever it downloads can change after we scanned it.', shell: 'Common for dev tools. Read the commands it runs.', eval: 'Harder to read ahead of time, since the code is assembled while it runs.', deps: 'A later version of a dependency could change what runs.', hidden: 'Folders starting with a dot are easy to miss when you read a repo.' };
const skillsData = readOpt('skills.json');
const OFFICIAL_SKILLS = /^(anthropics\/skills|vercel-labs\/agent-skills)$/i;
let S = [];
if (skillsData) {
  const seen = new Set();
  S = skillsData.entries.filter((e) => !seen.has(e.id) && seen.add(e.id)).map((e) => {
    const g = e.github, n = e.skillsInRepo || 1;
    const stars = g.stars / n, forks = g.forks / n;
    const days = (Date.now() - Date.parse(g.pushedAt)) / DAY_MS;
    const fresh = days < 30 ? 1 : days < 90 ? 0.8 : days < 180 ? 0.6 : days < 365 ? 0.35 : 0.1;
    const ownerAge = (Date.now() - Date.parse(g.ownerCreatedAt)) / DAY_MS;
    const parts = {
      ...popularityParts(e, stars),
      usage: Math.round(Math.min(1, Math.log10(1 + forks) / 3.5) * 15),
      maintenance: Math.round(fresh * 25),
      license: e.license ? 15 : 5,
      owner: ownerAge > 365 ? 10 : ownerAge > 90 ? 6 : 2,
    };
    return { ...e, score: { total: Object.values(parts).reduce((a, b) => a + b, 0), parts, sharedRepo: n > 1 ? n : 0, effectiveStars: Math.round(stars) } };
  }).filter((e) => (OFFICIAL_SKILLS.test(e.github.repo) || e.score.effectiveStars >= 5) && !TESTY.test(e.name));
  funnel.skills = { ...skillsData.funnel, listedAfterStarSplit: S.length };
  E = [...E, ...S].sort((a, b) => b.score.total - a.score.total || b.github.stars - a.github.stars);
}
// ---------- subagents (data/agents.json): same gates as skills, stars split across a repo's agents ----------
const agentsData = readOpt('agents.json');
let A = [];
if (agentsData) {
  const seen = new Set();
  A = agentsData.entries.filter((e) => !seen.has(e.id) && seen.add(e.id)).map((e) => {
    const g = e.github, n = e.agentsInRepo || 1;
    const stars = g.stars / n, forks = g.forks / n;
    const days = (Date.now() - Date.parse(g.pushedAt)) / DAY_MS;
    const fresh = days < 30 ? 1 : days < 90 ? 0.8 : days < 180 ? 0.6 : days < 365 ? 0.35 : 0.1;
    const ownerAge = (Date.now() - Date.parse(g.ownerCreatedAt)) / DAY_MS;
    const parts = {
      ...popularityParts(e, stars),
      usage: Math.round(Math.min(1, Math.log10(1 + forks) / 3.5) * 15),
      maintenance: Math.round(fresh * 25),
      license: e.license ? 15 : 5,
      owner: ownerAge > 365 ? 10 : ownerAge > 90 ? 6 : 2,
    };
    return { ...e, score: { total: Object.values(parts).reduce((a, b) => a + b, 0), parts, sharedRepo: n > 1 ? n : 0, effectiveStars: Math.round(stars) } };
  }).filter((e) => e.score.effectiveStars >= 5 && !TESTY.test(e.name));
  funnel.agents = { ...agentsData.funnel, listedAfterStarSplit: A.length };
  E = [...E, ...A].sort((a, b) => b.score.total - a.score.total || b.github.stars - a.github.stars);
}
// ---------- prompts (prompts.chat, CC0) and Cursor rules (awesome-cursorrules, CC0) ----------
const P = (readOpt('prompts.json')?.entries || []).sort((a, b) => b.score.total - a.score.total || b.community.votes - a.community.votes);
const R = (readOpt('rules.json')?.entries || []).sort((a, b) => a.name.localeCompare(b.name));
// ---------- Plado Originals (templates/originals/**.md). Only `status: approved` publishes;
// DRAFTS=1 shows drafts too, for local review only. Never deploy a DRAFTS=1 build. ----------
const SHOW_DRAFTS = process.env.DRAFTS === '1';
const ORIG_DIR = path.join(HERE, '..', 'templates', 'originals');
const originals = [];
const walk = (d) => { try { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.md')) originals.push(p); } } catch {} };
walk(ORIG_DIR);
const O = originals.map((f) => {
  const raw = fs.readFileSync(f, 'utf8');
  const fm = Object.fromEntries((/^---\n([\s\S]*?)\n---/.exec(raw)?.[1] || '').split('\n').map((l) => l.split(/:\s*(.*)/s)).filter((x) => x[1] !== undefined).map(([k, v]) => [k.trim(), v.trim()]));
  const text = raw.replace(/^---[\s\S]*?---\s*/, '').trim();
  const vars = [...new Map([...text.matchAll(/\$\{([^}:]+)(?::([^}]*))?\}/g)].map((x) => [x[1].trim(), { name: x[1].trim(), def: (x[2] || '').trim() }])).values()];
  return {
    id: `original-${fm.id}`, name: fm.title, description: text.split('\n').find((l) => l.trim()).slice(0, 300), type: 'prompt', promptKind: 'text', original: true, status: fm.status,
    text, variables: vars, platforms: ['claude-code'], origin: 'Plado Originals', license: fm.license || 'CC0-1.0', author: 'Plado',
    community: { votes: 0, featured: false, comments: 0, category: null, tags: [] }, category: { primary: fm.category || 'coding', secondary: null, source: 'author' },
    models: [], tools: [fm.recipeFor].filter(Boolean), recipeFor: fm.recipeFor || null, integrations: [], jobs: [], score: null, quality: null,
  };
}).filter((e) => e.status === 'approved' || (SHOW_DRAFTS && e.status === 'draft'));
P.unshift(...O); // originals lead their tool pages; they carry no score (no community votes yet)
if (SHOW_DRAFTS) console.log(`DRAFTS=1: including ${O.filter((e) => e.status === 'draft').length} unapproved drafts. Local review only, never deploy this build.`);
funnel.prompts = readOpt('prompts.json')?.funnel || null;
funnel.rules = readOpt('rules.json')?.funnel || null;
// tool tags across every type, so one page per tool can gather its skills, servers, plugins and prompts
const TOOL_RE = {
  remotion: /\bremotion\b/i, excel: /\bexcel\b|xlsx/i, nextjs: /next\.?js/i, tailwind: /tailwind/i, wordpress: /wordpress/i,
  playwright: /playwright/i, figma: /figma/i, slack: /\bslack\b/i, notion: /\bnotion\b/i, supabase: /supabase/i, jira: /\bjira\b|atlassian/i,
  linear: /\blinear\b(?!ly)/i, blender: /blender/i, obsidian: /obsidian/i, salesforce: /salesforce/i, n8n: /\bn8n\b/i, aws: /\baws\b|amazon web services/i,
  postgres: /postgres|postgresql/i, 'google-drive': /google drive|gdrive/i, stripe: /\bstripe\b/i, vercel: /\bvercel\b/i, shopify: /shopify/i,
  hubspot: /hubspot/i, docker: /\bdocker\b/i, sentry: /\bsentry\b/i, gitlab: /gitlab/i, confluence: /confluence/i, mongodb: /mongo/i, redis: /\bredis\b/i,
  github: GITHUB_STRICT,
};
for (const e of [...S, ...P, ...R]) {
  const t = `${e.name} ${e.description} ${e.type === 'skill' ? e.github.repo : ''} ${(e.tools || []).join(' ')}`;
  e.integrations = Object.entries(TOOL_RE).filter(([, re]) => re.test(t)).map(([k]) => k);
}
for (const e of E) if (e.type !== 'skill' && TOOL_RE.remotion.test(`${e.name} ${e.description}`) && !e.integrations.includes('remotion')) e.integrations.push('remotion');
for (const e of P) e.jobs = [e.category.primary, e.category.secondary].filter(Boolean);
const ALL = [...E, ...P, ...R];
// ---------- context cost (voice-of-user pain #3: "wasting >50k tokens") ----------
// Estimated at ~4 characters per token. "always" = loaded into every session (name + description);
// "onUse" = loaded when it runs. Subagents run in their own context window, so their body never
// lands in the main conversation. Plugins and MCP servers aren't measured yet (needs their tool lists).
const tok = (chars) => Math.max(1, Math.round((chars || 0) / 4));
const SKCACHE = path.join(HERE, 'data', '.cache-skills');
const ckeyPath = (k) => path.join(SKCACHE, k.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180));
function skillBodyChars(e) {
  if (e.bodyChars) return e.bodyChars;
  const dir = e.subpath || '';
  for (const f of ['SKILL.md', 'skill.md', 'Skill.md']) {
    try { return fs.readFileSync(ckeyPath(`raw-${e.github.repo}-${e.pin.value.slice(0, 12)}-${(dir ? dir + '/' : '') + f}`), 'utf8').length; } catch {}
  }
  return null;
}
for (const e of ALL) {
  if (e.type === 'skill') { const b = skillBodyChars(e); e.ctx = { always: tok(`${e.name} ${e.description}`.length), onUse: b ? tok(b) : null, where: 'main' }; }
  else if (e.type === 'agent') e.ctx = { always: tok(`${e.name} ${e.description}`.length), onUse: tok(e.bodyChars || (e.text || '').length), where: 'own' };
  else if (e.type === 'prompt') e.ctx = { always: 0, onUse: tok((e.text || '').length), where: 'main' };
  else if (e.type === 'rules') e.ctx = { always: /alwaysApply:\s*true/i.test(e.text || '') ? tok((e.text || '').length) : 0, onUse: tok((e.text || '').length), where: 'main' };
  else e.ctx = null;
}
const kfmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const scanBadge = (e) => {
  const x = scanOf(e);
  if (x?.status !== 'scanned') return `<span class="badge unscanned">Not scanned</span>`;
  const n = (x.facts || []).length;
  return `<span class="badge neutral" title="${esc(n ? (x.facts || []).map((f) => FACT_LABEL[f.k]).join('; ') : 'Scanned at the listed version')}">Scanned${n ? ` · ${n} to know` : ''}</span>`;
};
const ctxShort = (e) => !e.ctx ? '' : e.type === 'agent' ? `≈${kfmt(e.ctx.always)} tokens in your chat` : e.ctx.always ? `≈${kfmt(e.ctx.always)} tokens always loaded` : `≈${kfmt(e.ctx.onUse)} tokens when used`;
function ctxLine(e) {
  if (!e.ctx) return `<p class="ctx"><strong>Context cost:</strong> not measured yet. ${e.type === 'plugin' ? 'It depends on which skills, agents and servers the plugin bundles.' : 'It depends on how many tools the server exposes.'}</p>`;
  if (e.type === 'agent') return `<p class="ctx"><strong>Context cost:</strong> ≈${kfmt(e.ctx.always)} tokens sit in your main chat (its name and description, so Claude knows when to call it). Its ≈${kfmt(e.ctx.onUse)}-token instructions run in the agent's own context window, not yours.</p>`;
  if (e.type === 'skill') return `<p class="ctx"><strong>Context cost:</strong> ≈${kfmt(e.ctx.always)} tokens loaded every session (name and description)${e.ctx.onUse ? `, plus ≈${kfmt(e.ctx.onUse)} tokens when the skill is used` : ''}.</p>`;
  return `<p class="ctx"><strong>Context cost:</strong> ≈${kfmt(e.ctx.onUse)} tokens ${e.ctx.always ? 'on every request (it is set to always apply)' : 'when used'}.</p>`;
}
// ---------- uninstall: the exact reverse of each install command we publish ----------
function uninstallFor(e, platform, cmds) {
  const out = [];
  for (const c of cmds) {
    let m;
    if ((m = /^claude mcp add\s+(.*)$/.exec(c))) {
      const t = m[1].split(/\s+/); let scope = '', name = null;
      for (let i = 0; i < t.length; i++) { if (t[i] === '--') break; if (/^(-s|--scope)$/.test(t[i])) { scope = ` -s ${t[++i]}`; continue; } if (/^(--transport|-t|-e|--env|-H|--header)$/.test(t[i])) { i++; continue; } if (t[i].startsWith('-')) continue; name = t[i]; break; }
      if (name) out.push(`claude mcp remove${scope} ${name}`);
    } else if ((m = /^codex mcp add\s+(\S+)/.exec(c))) out.push(`codex mcp remove ${m[1]}`);
    else if ((m = /^\/plugin install\s+(\S+)/.exec(c))) out.push(`/plugin uninstall ${m[1]}`);
    else if ((m = /-o\s+(\S+\.(md|mdc))$/.exec(c))) out.push(`rm ${m[1]}`);
    else if ((m = /^mkdir -p (\.claude\/skills\/\S+)$/.exec(c))) out.push(`rm -rf ${m[1]}`);
  }
  return out.length ? out : null;
}

// ---------- use cases: team → task, plus industry (taxonomy.mjs) ----------
// Tool tags imply a task too: a Slack server is communication, a Figma skill is UI design.
const TOOL_TASK = { slack: 'operations/communication', notion: 'operations/knowledge', obsidian: 'operations/knowledge', confluence: 'operations/knowledge', jira: 'product/project-management', linear: 'product/project-management', figma: 'design/ui-design', postgres: 'engineering/databases', supabase: 'engineering/databases', mongodb: 'engineering/databases', redis: 'engineering/databases', github: 'engineering/git', gitlab: 'engineering/git', playwright: 'engineering/testing', remotion: 'creative/video', docker: 'engineering/devops', aws: 'engineering/devops', vercel: 'engineering/devops', sentry: 'engineering/devops', excel: 'data/spreadsheets', 'google-drive': 'operations/documents', n8n: 'operations/automation', hubspot: 'sales/crm', salesforce: 'sales/crm', wordpress: 'marketing/content', nextjs: 'engineering/frontend', tailwind: 'engineering/frontend' };
const TOOL_IND = { shopify: 'ecommerce', stripe: 'finance' };
for (const e of ALL) {
  const c = classify(e.name, e.description);
  for (const t of e.integrations || []) { if (TOOL_TASK[t] && !c.tasks.includes(TOOL_TASK[t])) c.tasks.push(TOOL_TASK[t]); if (TOOL_IND[t] && !c.industries.includes(TOOL_IND[t])) c.industries.push(TOOL_IND[t]); }
  for (const t of e.integrations || []) if (TOOL_TASK[t] && TOOL_RE[t]?.test(e.name) && !c.strong.includes(TOOL_TASK[t])) c.strong.push(TOOL_TASK[t]);
  c.teams = [...new Set(c.tasks.map((k) => k.split('/')[0]))];
  e.use = c;
}
const byScore = (a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0);
// alternatives: same job, different repo (similar.mjs)
const ALT = similar(E), PALT = similar(P, { prompts: true, quality: (x) => Math.min(100, (x.community?.votes || 0) * 2) });
if (process.env.ALT_DEBUG) { console.log(`coverage (3+ alternatives): tools ${(ALT.coverage * 100).toFixed(0)}%, prompts ${(PALT.coverage * 100).toFixed(0)}%`); for (const id of process.env.ALT_DEBUG.split(',')) { const e = ALL.find((x) => x.id.includes(id)); if (!e) continue; console.log(`\n## ${e.name} (${e.type}, ${e.github?.repo || ''})`); for (const a of (ALT.get(e.id) || PALT.get(e.id) || [])) console.log(`  ${a.sim.toFixed(2)} ${a.item.name} [${a.item.type}] ${a.item.github?.repo || ''} :: ${a.shared.slice(0, 4).join(', ')}`); } process.exit(0); }
// Per-item ranking for a task: listings named for the task first, then score; at most 3 per repo,
// so one big collection can't fill a page on the strength of its repo's stars.
const repoKey = (e) => e.github?.repo || e.origin;
function rankForTask(items, task) {
  const sorted = [...items].sort((a, b) => (b.use.strong.includes(task) - a.use.strong.includes(task)) || byScore(a, b));
  const seen = {}, head = [], tail = [];
  for (const e of sorted) ((seen[repoKey(e)] = (seen[repoKey(e)] || 0) + 1) <= 3 ? head : tail).push(e);
  return [...head, ...tail];
}
const teamGroups = Object.entries(TEAMS).map(([k, t]) => ({
  key: k, label: t.label,
  items: ALL.filter((e) => e.use.teams.includes(k)).sort(byScore),
  tasks: Object.keys(t.tasks).map((tk) => ({ key: `${k}/${tk}`, slug: tk, label: t.tasks[tk].label, items: rankForTask(ALL.filter((e) => e.use.tasks.includes(`${k}/${tk}`)), `${k}/${tk}`) })).filter((x) => x.items.length),
})).filter((g) => g.items.length);
const industryGroups = Object.entries(INDUSTRIES).map(([k, t]) => ({ key: k, label: t.label, items: ALL.filter((e) => e.use.industries.includes(k)).sort(byScore) })).filter((g) => g.items.length >= 5);
const useChips = (e) => [...e.use.tasks.map((k) => `<a class="chip link" href="${url(`for/${k}/`)}">${esc(TEAMS[k.split('/')[0]].label)} › ${esc(TASKS[k].label)}</a>`), ...e.use.industries.filter((k) => industryGroups.some((g) => g.key === k)).map((k) => `<a class="chip link" href="${url(`industries/${k}/`)}">${esc(INDUSTRIES[k].label)}</a>`)].join('');
console.log('funnel', JSON.stringify(funnel));

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const url = (p) => BASE + p.replace(/^\//, '');
const write = (rel, html) => { const f = path.join(DIST, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, html); };
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n ?? 0));
const DAY = 86400000;
const ago = (iso) => { const d = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / DAY)); return d === 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d}d ago` : d < 365 ? `${Math.round(d / 30)}mo ago` : `${Math.round(d / 365)}y ago`; };
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);

const PLATFORM = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', 'gemini-cli': 'Gemini CLI', 'skills-cli': 'Skills CLI', 'claude-code-user': 'Claude Code (all projects)', 'any-mcp-client': 'Any MCP client', 'any-llm': 'Any AI chat' };
const TYPE = { plugin: 'Plugin', 'mcp-server': 'MCP server', skill: 'Skill', agent: 'Subagent', prompt: 'Prompt', rules: 'Rules file' };
const TYPE_PLURAL = { plugin: 'Plugins', 'mcp-server': 'MCP servers', skill: 'Skills', agent: 'Subagents', prompt: 'Prompts', rules: 'Rules files' };
const PROMPT_CAT_LABEL = { image: 'Image', video: 'Video', audio: 'Music & audio', coding: 'Coding', agents: 'Agents & automation', writing: 'Writing', marketing: 'Marketing', business: 'Business & career', education: 'Education', research: 'Research & data', design: 'Design', personal: 'Personal & wellbeing' };
const MODEL_LABEL = { midjourney: 'Midjourney', 'nano-banana': 'Nano Banana', 'gpt-image': 'GPT Image', flux: 'Flux', 'stable-diffusion': 'Stable Diffusion', veo: 'Veo', sora: 'Sora', kling: 'Kling', runway: 'Runway', seedance: 'Seedance', suno: 'Suno', udio: 'Udio', grok: 'Grok' };
const KIND_LABEL = { text: 'Text prompt', image: 'Image prompt', video: 'Video prompt', audio: 'Audio prompt' };
const INTEGRATION_LABEL = { remotion: 'Remotion', excel: 'Excel', nextjs: 'Next.js', tailwind: 'Tailwind CSS', wordpress: 'WordPress', playwright: 'Playwright', figma: 'Figma', github: 'GitHub', slack: 'Slack', notion: 'Notion', supabase: 'Supabase', jira: 'Jira', linear: 'Linear', blender: 'Blender', obsidian: 'Obsidian', salesforce: 'Salesforce', n8n: 'n8n', aws: 'AWS', postgres: 'Postgres', 'google-drive': 'Google Drive', stripe: 'Stripe', vercel: 'Vercel', shopify: 'Shopify', hubspot: 'HubSpot', docker: 'Docker', sentry: 'Sentry', gitlab: 'GitLab', confluence: 'Confluence', mongodb: 'MongoDB', redis: 'Redis' };
const JOB_LABEL = { 'code-quality': 'Code quality & testing', security: 'Security', data: 'Data & databases', devops: 'DevOps & cloud', design: 'Design & frontend', docs: 'Docs & knowledge', 'browser-automation': 'Browser automation', 'project-management': 'Project management', communication: 'Communication', commerce: 'Payments & commerce', marketing: 'Marketing & SEO', media: 'Media: video, image, audio', finance: 'Finance', ai: 'AI & agents', writing: 'Writing', education: 'Education', business: 'Business & sales' };

// ---------- icons (Lucide, ISC license; inline so no icon font or CDN) ----------
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  skill: svg('<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>'),
  agent: svg('<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4H8"/><path d="M2 14h2M20 14h2M9 13v2M15 13v2"/>'),
  plug: svg('<path d="M12 22v-5"/><path d="M9 8V2M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>'),
  puzzle: svg('<path d="M15.4 4.6a2.5 2.5 0 1 1 4 2.6c-.3.3-.4.8-.1 1.2l1.1 1.1a2.4 2.4 0 0 1 0 3.4l-1.4 1.4c-.3.3-.8.3-1.1 0a2.5 2.5 0 1 0-3.5 3.5c.3.3.3.8 0 1.1l-1.4 1.4a2.4 2.4 0 0 1-3.4 0l-1.1-1.1c-.4-.3-.9-.2-1.2.1a2.5 2.5 0 1 1-2.6-4c.4-.1.6-.6.3-1L2.6 13.7a2.4 2.4 0 0 1 0-3.4l1.4-1.4c.3-.3.8-.3 1.1 0a2.5 2.5 0 1 0 3.5-3.5c-.3-.3-.3-.8 0-1.1l1.4-1.4a2.4 2.4 0 0 1 3.4 0l1.1 1.1c.4.3.9.2 1.2-.1Z"/>'),
  prompt: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  rules: svg('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8M13 12h8M13 18h8"/>'),
  trend: svg('<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>'),
  star: svg('<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2-6.2 3.2L7 14.2 2 9.3l6.9-1z"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  check: svg('<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>'),
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  logo: '<svg viewBox="0 0 64 44" aria-hidden="true"><path d="M18 3 H60 V41 H18 L3 22 Z" fill="#F2C230" stroke="#15171B" stroke-width="3" stroke-linejoin="round"/><circle cx="16" cy="22" r="4.2" fill="none" stroke="#15171B" stroke-width="3"/><path d="M28 16 H51 M28 28 H43" stroke="#15171B" stroke-width="3.4" stroke-linecap="round"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>',
  theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
};

// ---------- layout ----------
function page({ title, description, rel, body, jsonld, nav = '' }) {
  const canonical = SITE_URL ? `<link rel="canonical" href="${esc(SITE_URL + '/' + rel.replace(/index\.html$/, ''))}">` : '';
  const cur = (k) => (nav === k ? ' aria-current="page"' : '');
  return `<!doctype html>
<html lang="en" data-base="${esc(BASE)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#F3F4F0" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121418" media="(prefers-color-scheme: dark)">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500&family=Schibsted+Grotesk:wght@400;500;700;800&display=swap">
<link rel="stylesheet" href="${url('assets/styles.css')}">
<link rel="icon" href="${url('assets/favicon.svg')}" type="image/svg+xml">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="logo" href="${url('')}" aria-label="Plado home">${I.logo}plado</a>
    ${rel !== 'index.html' && nav !== 'browse' ? `<form class="search search-top" data-search role="search" action="${url('browse/')}">
      ${I.search}
      <label class="sr-only" for="q-top">Search add-ons</label>
      <input id="q-top" name="q" type="search" autocomplete="off" placeholder="Search ${Math.floor(ALL.length / 1000).toLocaleString()},000+ add-ons" role="combobox" aria-expanded="false" aria-controls="sr-top" aria-autocomplete="list" aria-keyshortcuts="/">
      <kbd class="kbd" aria-hidden="true">/</kbd>
      <ul class="search-results" id="sr-top" role="listbox" hidden></ul>
    </form>
    <button class="icon-btn search-open" type="button" aria-label="Search" aria-expanded="false" aria-controls="q-top">${I.search}</button>` : ''}
    <nav class="nav" aria-label="Main">
      <a href="${url('browse/')}"${cur('browse')}>Browse</a>
      ${hasTrending ? `<a href="${url('trending/')}"${cur('trending')}>Trending</a>` : ''}
      <a class="hide-sm" href="${url('for/')}"${cur('uses')}>Use cases</a>
      <a class="hide-sm" href="${url('leaderboard/')}"${cur('leaderboard')}>Leaderboard</a>
      <a class="hide-sm" href="${url('integrations/')}"${cur('integrations')}>Integrations</a>
      <a class="hide-sm" href="${url('how-we-rank/')}"${cur('rank')}>How we rank</a>
      <button class="icon-btn" id="theme-toggle" type="button" aria-label="Switch light or dark theme">${I.theme}</button>
    </nav>
  </div>
</header>
${SCAN_LIVE ? '' : `<div class="preview" role="note">
  <div class="wrap">${I.alert}<span><strong>Preview build.</strong> Nothing here has had a full security scan yet. Tool scores measure popularity and upkeep from public GitHub data, not whether a tool works, and prompt scores use prompts.chat votes. <a href="${url('how-we-rank/')}">What that means</a></span></div>
</div>`}
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <div class="cols">
      <div><a class="logo" href="${url('')}" aria-label="Plado home">${I.logo}plado</a><p class="small">Know what you're installing. AI coding add-ons ranked on public usage and upkeep data.</p></div>
      <ul><li><a href="${url('browse/')}">Browse all</a></li>${hasTrending ? `<li><a href="${url('trending/')}">Trending</a></li>` : ''}<li><a href="${url('for/')}">Use cases</a></li><li><a href="${url('leaderboard/')}">Leaderboard</a></li><li><a href="${url('integrations/')}">Integrations</a></li></ul>
      <ul><li><a href="${url('how-we-rank/')}">How we rank</a></li><li><a href="${url('about/')}">About &amp; how we make money</a></li><li><a href="${url('data/catalog.json')}">Open data (JSON)</a></li></ul>
    </div>
    <p class="small">Plado is independent and not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, Google, Cursor, xAI or GitHub. Product names are trademarks of their owners. Some interface motion is adapted from <a href="https://skiper-ui.com" rel="noopener">Skiper UI</a>. Listings come from public sources: Anthropic's plugin marketplaces (Apache-2.0), the official MCP Registry, public GitHub repositories, Google's Gemini CLI extensions gallery, prompts.chat (CC0) and awesome-cursorrules (CC0). Data built ${esc(catalog.builtAt.slice(0, 10))}.</p>
  </div>
</footer>
<script src="${url('assets/app.js')}" defer></script>
</body>
</html>`;
}

const platformChips = (e) => `<div class="chips">${e.platforms.map((p) => `<span class="chip">${esc(PLATFORM[p] || p)}</span>`).join('')}</div>`;
const scoreChip = (e) => e.score
  ? `<div class="score" title="${e.type === 'prompt' ? 'Score out of 100 from community votes and prompt quality.' : 'Popularity and upkeep, out of 100, from public GitHub signals. It does not measure whether the add-on works. The security scan is shown separately.'}">${e.score.total}<small>${e.type === 'prompt' ? 'score' : 'popular'}</small></div>`
  : `<div class="score" title="No ranking signal yet for this source">–<small>unranked</small></div>`;
const anyCard = (e) => (e.type === 'prompt' ? promptCard(e) : e.type === 'rules' ? rulesCard(e) : card(e));
// Card anatomy: avatar, name + maker mark, owner/repo + type,
// one line, stats (stars, weekly trend, updated, platforms, check state), then score + copy.
const TYPE_ICON = { skill: I.skill, agent: I.agent, 'mcp-server': I.plug, plugin: I.puzzle, prompt: I.prompt, rules: I.rules };
const ownerOf = (e) => e.github?.owner || e.github?.repo?.split('/')[0];
// Platform companies' avatars are their logos: show the type icon instead
const PLATFORM_OWNERS = /^(anthropics?|openai|google|google-[a-z-]+|googleapis|googlecloudplatform|github|microsoft|azure|azure-samples|modelcontextprotocol|cursor|getcursor|xai-org|x-ai)$/i;
const avatar = (e, size = 44) => e.github && !PLATFORM_OWNERS.test(ownerOf(e))
  ? `<span class="av" style="--s:${size}px"><img src="https://avatars.githubusercontent.com/${encodeURIComponent(ownerOf(e))}?s=${size * 2}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async"></span>`
  : `<span class="av av-icon" style="--s:${size}px">${TYPE_ICON[e.type] || I.prompt}</span>`;
const makerMark = (e) => e.verifiedOrg
  ? `<span class="maker" title="From the maker: published by a GitHub-verified organization">${I.check}<span class="sr-only">From the maker</span></span>`
  : '';
const primaryInstall = (e) => { const k = Object.keys(e.install || {})[0]; return k ? e.install[k].join('\n') : null; };
const platList = (e) => { const ps = e.platforms.map((p) => PLATFORM[p] || p); return ps.slice(0, 3).map((p) => `<span class="plat">${esc(p)}</span>`).join('') + (ps.length > 3 ? `<span class="plat">+${ps.length - 3}</span>` : ''); };
function card(e) {
  const g = e.github, wk = trend.weekByRepo?.[g.repo], ic = primaryInstall(e);
  return `<article class="card" data-t="${esc(e.type)}">
  ${avatar(e)}
  <div class="card-main">
    <div class="card-title"><h3><a href="${url(`e/${e.id}/`)}">${esc(e.name)}</a></h3>${makerMark(e)}</div>
    <div class="card-sub"><span class="mono">${esc(g.repo)}</span><span class="type">${TYPE_ICON[e.type] || ''}${esc(TYPE[e.type])}</span></div>
    <p class="desc">${esc(clip(e.description, 200))}</p>
    <div class="stats">
      <span title="GitHub stars">${I.star}${fmt(g.stars)}</span>
      ${wk ? `<span class="up" title="Stars gained this week">${I.trend}+${fmt(wk)} this week</span>` : ''}
      <span title="Last update">${I.clock}${ago(g.pushedAt)}</span>
      ${e.ctx ? `<span class="ctx-chip" title="Estimated context cost">${esc(ctxShort(e))}</span>` : ''}
      ${platList(e)}
      ${scanBadge(e)}
    </div>
  </div>
  <div class="card-side">
    ${scoreChip(e)}
    ${ic ? `<button class="btn copy-install" type="button" data-copy="${esc(ic)}" aria-label="Copy install command for ${esc(e.name)}">${I.copy}<span>Copy install</span></button>` : ''}
  </div>
</article>`;
}
function promptCard(e) {
  return `<article class="card" data-t="prompt">
  ${avatar(e)}
  <div class="card-main">
    <div class="card-title"><h3><a href="${url(`e/${e.id}/`)}">${esc(e.name)}</a></h3></div>
    <div class="card-sub"><span>${e.original ? `Plado Original${e.status === 'draft' ? ' · DRAFT' : ''}` : `prompts.chat${e.author ? ` · @${esc(e.author)}` : ''}`}</span><span class="type">${I.prompt}${esc(e.recipeFor ? `${INTEGRATION_LABEL[e.recipeFor] || e.recipeFor} recipe` : PROMPT_CAT_LABEL[e.category?.primary] || KIND_LABEL[e.promptKind] || 'Prompt')}</span></div>
    <p class="desc">${esc(clip(e.description, 200))}</p>
    <div class="stats">
      ${e.original ? '<span>Written by Plado</span>' : `<span title="Votes on prompts.chat">▲ ${e.community.votes} vote${e.community.votes === 1 ? '' : 's'}</span>`}
      ${e.community.featured ? '<span class="plat">Editor pick</span>' : ''}
      ${e.variables.length ? `<span>${e.variables.length} fill-in field${e.variables.length > 1 ? 's' : ''}</span>` : ''}
      <span>CC0</span>
    </div>
  </div>
  <div class="card-side">
    ${scoreChip(e)}
    ${e.text ? `<button class="btn copy-install" type="button" data-copy="${esc(e.text)}" aria-label="Copy prompt ${esc(e.name)}">${I.copy}<span>Copy prompt</span></button>` : ''}
  </div>
</article>`;
}
function rulesCard(e) {
  const ic = primaryInstall(e);
  return `<article class="card" data-t="rules">
  ${avatar(e)}
  <div class="card-main">
    <div class="card-title"><h3><a href="${url(`e/${e.id}/`)}">${esc(e.name)}</a></h3></div>
    <div class="card-sub"><span>awesome-cursorrules</span><span class="type">${I.rules}Cursor rules</span></div>
    <p class="desc">${esc(clip(e.description, 200))}</p>
    <div class="stats"><span class="plat">Cursor</span><span>CC0</span></div>
  </div>
  <div class="card-side">
    ${scoreChip(e)}
    ${ic ? `<button class="btn copy-install" type="button" data-copy="${esc(ic)}" aria-label="Copy install command for ${esc(e.name)}">${I.copy}<span>Copy install</span></button>` : ''}
  </div>
</article>`;
}
// stars belong to the repo: in trend rows, name the repo unless the add-on clearly is the repo
const rowName = (e, more) => { if (!e.github) return e.name; const a = String(e.name).toLowerCase().replace(/[^a-z0-9]/g, ''), b = e.github.repo.split('/')[1].toLowerCase().replace(/[^a-z0-9]/g, ''); return !more && (a.includes(b) || b.includes(a)) ? e.name : e.github.repo; };
// compact numbered row (Top charts, Trending this week)
const rowItem = (e, i, right, more = 0) => `<li class="row"><span class="rank mono">${i + 1}</span>${avatar(e, 36)}<div class="row-main"><a class="row-name" href="${url(`e/${e.id}/`)}">${esc(rowName(e, more))}</a><span class="row-desc">${esc(clip(e.description, 80))}</span></div><span class="row-right">${right}</span></li>`;
const twoCols = (items, render) => { const h = Math.ceil(items.length / 2); return `<div class="rows-2"><ol class="rows">${items.slice(0, h).map((x, i) => render(x, i)).join('')}</ol><ol class="rows" start="${h + 1}">${items.slice(h).map((x, i) => render(x, i + h)).join('')}</ol></div>`; };

// ---------- groupings ----------
const hubs = [
  { key: 'skills', title: 'Claude & agent skills', seo: 'Best Claude skills & agent skills', f: (e) => e.type === 'skill', q: 'type=skill' },
  { key: 'claude-code/subagents', title: 'Claude Code subagents', seo: 'Best Claude Code subagents & agents', f: (e) => e.type === 'agent', q: 'type=agent' },
  { key: 'claude-code/plugins', title: 'Claude Code plugins', f: (e) => e.type === 'plugin', q: 'type=plugin' },
  { key: 'claude-code/mcp-servers', title: 'MCP servers for Claude Code', f: (e) => e.type === 'mcp-server' && e.platforms.includes('claude-code'), q: 'type=mcp-server&platform=claude-code' },
  { key: 'codex/mcp-servers', title: 'MCP servers for Codex', f: (e) => e.type === 'mcp-server' && e.platforms.includes('codex'), q: 'type=mcp-server&platform=codex' },
  { key: 'cursor/mcp-servers', title: 'MCP servers for Cursor', f: (e) => e.type === 'mcp-server' && e.platforms.includes('cursor'), q: 'type=mcp-server&platform=cursor' },
  { key: 'gemini-cli/mcp-servers', title: 'MCP servers for Gemini CLI', f: (e) => e.type === 'mcp-server' && e.platforms.includes('gemini-cli'), q: 'type=mcp-server&platform=gemini-cli' },
].map((h) => ({ ...h, items: E.filter(h.f) }));

const integrations = Object.keys(INTEGRATION_LABEL)
  .map((k) => ({ key: k, label: INTEGRATION_LABEL[k], items: E.filter((e) => e.integrations.includes(k)), prompts: P.filter((e) => e.integrations.includes(k)) }))
  .map((g) => ({ ...g, skills: g.items.filter((e) => e.type === 'skill'), agents: g.items.filter((e) => e.type === 'agent'), tools: g.items.filter((e) => e.type !== 'skill' && e.type !== 'agent') }))
  .filter((g) => g.items.length + g.prompts.length >= 3)
  .sort((a, b) => b.items.length - a.items.length);

const ALL_JOB_LABEL = { ...JOB_LABEL, ...PROMPT_CAT_LABEL };
const jobs = Object.keys(ALL_JOB_LABEL).map((k) => ({ key: k, label: ALL_JOB_LABEL[k], items: ALL.filter((e) => e.jobs.includes(k)) })).filter((g) => g.items.length);
const skillJobs = Object.keys(JOB_LABEL).map((k) => ({ key: k, label: JOB_LABEL[k], items: S.filter((e) => e.jobs.includes(k)) })).filter((g) => g.items.length >= 5);
const promptGroups = Object.keys(PROMPT_CAT_LABEL).map((k) => ({
  key: k,
  label: ['image', 'video', 'audio'].includes(k) ? `${PROMPT_CAT_LABEL[k]} generation prompts` : k === 'agents' ? 'Prompts for AI agents & automation' : `AI prompts for ${PROMPT_CAT_LABEL[k].toLowerCase()}`,
  items: P.filter((e) => e.jobs.includes(k)),
})).filter((g) => g.items.length >= 5);

// ---------- trending (data/trending.json from data/fetch-trending.mjs) ----------
// Each window ranks on ONE source: our GitHub star snapshots once they cover most repos,
// otherwise the public GitHub event archive (OSS Insight), whose counts run lower than
// GitHub's own totals. The two are never mixed in one ranking.
const trending = readOpt('trending.json');
const TW = [
  { key: 'day', tab: 'Today', label: 'today', span: 'the past 24 hours' },
  { key: 'week', tab: 'This week', label: 'this week', span: 'the past 7 days' },
  { key: 'quarter', tab: 'This quarter', label: 'this quarter', span: 'the past 90 days' },
  { key: 'year', tab: 'This year', label: 'this year', span: 'the past 12 months' },
];
const RISING_MIN = { day: 5, week: 25, quarter: 100, year: 300 };
const trend = { src: {}, asOf: {}, hot: {}, rising: {}, prompts: {}, weekByRepo: {} };
if (trending) {
  const byRepo = new Map(); // one row per repo: its best-ranked listed add-on stands in for the rest
  for (const e of E) { const r = e.github.repo; if (!byRepo.has(r)) byRepo.set(r, { e, more: 0 }); else byRepo.get(r).more++; }
  for (const { key: w } of TW) {
    const withAny = [...byRepo.keys()].filter((r) => trending.repos[r]?.gained?.[w]);
    const gh = withAny.filter((r) => trending.repos[r].gained[w].gh).length;
    const src = withAny.length && gh / withAny.length >= 0.8 ? 'gh' : 'ar';
    trend.src[w] = src;
    const rows = [...byRepo.values()].map(({ e, more }) => {
      const g = trending.repos[e.github.repo]?.gained?.[w]?.[src];
      if (!g || g.n <= 0) return null;
      if (src === 'ar' && g.asOf) trend.asOf[w] = trend.asOf[w] && trend.asOf[w] < g.asOf ? trend.asOf[w] : g.asOf;
      return { e, more, n: g.n, base: g.base, pct: g.n / Math.max(10, g.base) };
    }).filter(Boolean);
    trend.hot[w] = [...rows].sort((a, b) => b.n - a.n).slice(0, 60);
    trend.rising[w] = rows.filter((x) => x.n >= RISING_MIN[w]).sort((a, b) => b.pct - a.pct).slice(0, 60);
    if (w === 'week') for (const x of rows) trend.weekByRepo[x.e.github.repo] = x.n;
    trend.prompts[w] = P.filter((e) => !e.original && trending.prompts?.[e.id]?.gained?.[w]?.n > 0)
      .map((e) => ({ e, ...trending.prompts[e.id].gained[w] })).sort((a, b) => b.n - a.n || b.e.score.total - a.e.score.total).slice(0, 30);
  }
}
const hasTrending = !!trending && TW.some((w) => trend.hot[w.key]?.length);
const pctFmt = (x) => (x >= 10 ? `${Math.round(x)}×` : `+${Math.round(x * 100)}%`);
const srcNote = (w) => trend.src[w] === 'gh'
  ? `Stars gained in ${TW.find((t) => t.key === w).span}, from GitHub's own star counts (our daily snapshots).`
  : `Stars gained in ${TW.find((t) => t.key === w).span}, counted from the public GitHub event archive (OSS Insight)${trend.asOf[w] ? `, as of ${trend.asOf[w]}` : ''}. Archive counts run lower than GitHub's own totals, so read them as a trend, not an exact count.`;
// stars belong to the repo: title the card by the repo unless the add-on is clearly the repo itself
const squash = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
function trendTitle(e, more) {
  const repoName = e.github.repo.split('/')[1], a = squash(e.name), b = squash(repoName);
  if (!more && (a.includes(b) || b.includes(a))) return `<h3><a href="${url(`e/${e.id}/`)}">${esc(e.name)}</a></h3><span class="small muted mono">${esc(e.github.repo)}</span>`;
  return `<h3><a href="${url(`e/${e.id}/`)}">${esc(e.github.repo)}</a></h3><span class="small muted">Listed here: ${esc(e.name)}${more ? ` and ${more} more` : ''}</span>`;
}
// real star history (archive series cached by data/fetch-trending.mjs); no series, no line
const SPARK_DAYS = { day: 14, week: 30, quarter: 90, year: 365 };
function spark(repo, w) {
  let c; try { c = JSON.parse(fs.readFileSync(path.join(HERE, 'data', '.cache-trending', repo.replace('/', '__') + '.json'), 'utf8')); } catch { return ''; }
  const ser = c.series || []; if (ser.length < 3) return '';
  const days = SPARK_DAYS[w], end = Date.parse(c.fetchedAt), pts = [];
  let j = 0, v = 0;
  for (let d = days; d >= 0; d -= Math.max(1, Math.round(days / 30))) {
    const day = new Date(end - d * 86400000).toISOString().slice(0, 10);
    while (j < ser.length && ser[j][0] <= day) v = ser[j++][1];
    pts.push(v);
  }
  const lo = Math.min(...pts), hi = Math.max(...pts); if (hi - lo < 2) return '';
  const xy = pts.map((y, i) => `${(i / (pts.length - 1) * 118 + 1).toFixed(1)},${(34 - ((y - lo) / (hi - lo)) * 32).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 120 36" role="img" aria-label="Star history, ${SPARK_DAYS[w]} days"><polyline pathLength="1" points="${xy}"/></svg>`;
}
function trendCard({ e, more, n, base, pct }, i, w) {
  const label = TW.find((t) => t.key === w).label;
  return `<article class="card trend" data-t="${esc(e.type)}" data-q="${esc(`${e.name} ${e.github.repo} ${e.description}`.toLowerCase())}">
  <div class="trend-head"><span class="rank mono">${i + 1}</span>${avatar(e, 40)}<div>${trendTitle(e, more)}</div></div>
  <div class="score gain" title="Stars gained ${esc(label)}">+${fmt(n)}<small>stars</small></div>
  <p class="desc">${esc(clip(e.description, 200))}</p>
  <div class="meta">
    <span class="meta-item"><strong>+<span data-odo="${n}">${n.toLocaleString()}</span></strong>&nbsp;${esc(label)}</span>
    ${spark(e.github.repo, w)}
    <span class="meta-item">${base < 10 ? `New ${esc(label)}` : pctFmt(pct)}</span>
    <span class="meta-item">★ ${fmt(e.github.stars)} total</span>
    <span class="meta-item">${esc(TYPE[e.type])}</span>
    ${scanBadge(e)}
  </div>
</article>`;
}
function trendPromptCard({ e, n, src }, i, w) {
  const label = TW.find((t) => t.key === w).label;
  return `<article class="card trend" data-t="prompt" data-q="${esc(`${e.name} ${e.description}`.toLowerCase())}">
  <div class="trend-head"><span class="rank mono">${i + 1}</span>${avatar(e, 40)}<div><h3><a href="${url(`e/${e.id}/`)}">${esc(e.name)}</a></h3><span class="small muted mono">prompts.chat${e.author ? ` · @${esc(e.author)}` : ''}</span></div></div>
  <div class="score gain" title="${src === 'new' ? `New ${esc(label)}; total votes` : `Votes gained ${esc(label)}`}">${src === 'new' ? '' : '+'}${fmt(n)}<small>votes</small></div>
  <p class="desc">${esc(clip(e.description, 200))}</p>
  <div class="meta">${src === 'new' ? `<span class="badge official">New ${esc(label)}</span>` : ''}<span class="badge neutral">${esc(e.recipeFor ? `${INTEGRATION_LABEL[e.recipeFor] || e.recipeFor} recipe` : PROMPT_CAT_LABEL[e.category?.primary] || 'Prompt')}</span><span class="meta-item">▲ ${e.community.votes} vote${e.community.votes === 1 ? '' : 's'} total</span></div>
</article>`;
}

// ---------- pages ----------
fs.rmSync(DIST, { recursive: true, force: true });

// home (search + popular chips, trending leaderboard, categories, top charts)
{
  const POPULAR = ['playwright', 'postgres', 'code review', 'figma', 'remotion', 'supabase', 'security', 'testing'];
  const nType = (t) => E.filter((e) => e.type === t).length;
  const CATS = [
    { t: 'skill', title: 'Skills', sub: 'Instructions your agent loads when it needs them', href: 'skills/', n: S.length },
    { t: 'agent', title: 'Subagents', sub: 'Specialists your agent can hand work to', href: 'claude-code/subagents/', n: A.length },
    { t: 'mcp-server', title: 'MCP servers', sub: 'Connect your agent to the tools you use', href: 'browse/?type=mcp-server', n: nType('mcp-server') },
    { t: 'plugin', title: 'Plugins', sub: 'Bundles of commands, agents and hooks for Claude Code', href: 'claude-code/plugins/', n: nType('plugin') },
    { t: 'prompt', title: 'Prompts', sub: 'Copy, fill in the blanks, run', href: 'prompts/', n: P.length },
    { t: 'rules', title: 'Cursor rules', sub: 'Project rules files for Cursor', href: 'rules/cursor/', n: R.length },
  ].filter((c) => c.n);
  const CHARTS = [['skill', 'Skills'], ['agent', 'Subagents'], ['mcp-server', 'MCP servers'], ['plugin', 'Plugins']].map(([t, label]) => ({ t, label, items: E.filter((e) => e.type === t).slice(0, 10) })).filter((c) => c.items.length);
  const jobChips = Object.keys(JOB_LABEL).map((k) => ({ k, n: E.filter((e) => e.jobs.includes(k)).length })).filter((x) => x.n >= 10).sort((a, b) => b.n - a.n).slice(0, 12);
  // plain-text names only: no vendor logos
  const RIBBON = ['Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'Claude', 'ChatGPT', 'Grok', 'Gemini', ...integrations.slice(0, 16).map((g) => g.label), 'Midjourney', 'Suno', 'Veo'].filter((x, i, a) => a.indexOf(x) === i);
  const body = `
<section class="hero"><div class="wrap">
  <h1>Most AI add‑ons are noise. <span class="draw-line">Find the few worth installing.<svg class="underline" viewBox="0 0 400 14" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M3 9 C 90 3, 200 12, 300 6 S 390 8, 397 5"/></svg></span></h1>
  <p class="lead">Skills, subagents and MCP servers for Claude Code, Codex and Cursor, ranked by popularity and upkeep. See what each skill and subagent costs your context before you add it, and remove anything just as easily.</p>
  <form class="search" data-search role="search" action="${url('browse/')}">
    ${I.search}
    <label class="sr-only" for="q-hero">Search add-ons</label>
    <input id="q-hero" name="q" type="search" autocomplete="off" placeholder="Try: marketing agent for social media posts" role="combobox" aria-expanded="false" aria-controls="sr-hero" aria-autocomplete="list">
    <ul class="search-results" id="sr-hero" role="listbox" hidden></ul>
  </form>
  <div class="popular" data-trending-searches><span class="muted small">Popular:</span>${POPULAR.map((q) => `<a class="chip link" href="${url('browse/?q=' + encodeURIComponent(q))}">${esc(q)}</a>`).join('')}</div>
</div></section>

<section class="ribbon" aria-label="Platforms and tools we cover">
  <p class="ribbon-label wrap small muted">Works with the AI tools you use, and connects them to the rest of your stack</p>
  <div class="marquee">
    ${[0, 1].map((dup) => `<ul class="marquee-track"${dup ? ' aria-hidden="true"' : ''}>${RIBBON.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`).join('')}
  </div>
</section>

<section class="block"><div class="wrap">
  <div class="section-head"><h2>What do you want to get done?</h2><a href="${url('for/')}">All use cases ${I.arrow}</a></div>
  <div class="teams">${teamGroups.slice().sort((a, b) => b.items.length - a.items.length).slice(0, 8).map((g) => `<div class="team"><a class="team-head" href="${url(`for/${g.key}/`)}"><strong>${esc(g.label)}</strong><span class="muted small mono">${g.items.length.toLocaleString()}</span></a><ul>${g.tasks.slice().sort((a, b) => b.items.length - a.items.length).slice(0, 4).map((t) => `<li><a href="${url(`for/${t.key}/`)}">${esc(t.label)}</a></li>`).join('')}</ul></div>`).join('')}</div>
</div></section>

${hasTrending && trend.hot.week?.length ? `<section class="block"><div class="wrap">
  <div class="section-head"><h2>Trending this week</h2><a href="${url('trending/')}">Today, this quarter, this year ${I.arrow}</a></div>
  ${twoCols(trend.hot.week.slice(0, 10), (x, i) => rowItem(x.e, i, `<span class="up">${I.trend}+${fmt(x.n)}</span>`, x.more))}
  <p class="small muted" style="margin-top:12px">${esc(srcNote('week'))}</p>
</div></section>` : ''}

<section class="block"><div class="wrap">
  <div class="section-head"><h2>Browse by category</h2><a href="${url('browse/')}">Everything ${I.arrow}</a></div>
  <div class="stats-row" style="margin:0 0 16px">
    ${CATS.map((c) => `<span><strong data-odo="${c.n}">${c.n.toLocaleString()}</strong>${esc(c.title)}</span>`).join('')}
  </div>
  <div class="cats">
    ${CATS.map((c) => `<a class="cat" href="${url(c.href)}"><span class="cat-icon">${TYPE_ICON[c.t]}</span><span class="cat-text"><strong>${esc(c.title)}</strong><span class="muted small">${esc(c.sub)}</span></span><span class="cat-n mono">${c.n.toLocaleString()}</span></a>`).join('')}
  </div>
  ${industryGroups.length ? `<div class="popular" style="margin-top:16px"><span class="muted small">By industry:</span>${industryGroups.map((g) => `<a class="chip link" href="${url(`industries/${g.key}/`)}">${esc(g.label)}</a>`).join('')}</div>` : ''}
</div></section>

<section class="block"><div class="wrap tabs">
  <div class="section-head"><h2>Top charts</h2><a href="${url('leaderboard/')}">Full leaderboard ${I.arrow}</a></div>
  <div role="tablist" aria-label="Top charts by type" class="seg">${CHARTS.map((c, i) => `<button role="tab" type="button" id="chart-tab-${i}" aria-controls="chart-${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(c.label)}</button>`).join('')}</div>
  ${CHARTS.map((c, i) => `<div role="tabpanel" id="chart-${i}" aria-labelledby="chart-tab-${i}"${i ? ' hidden' : ''} style="margin-top:16px">${twoCols(c.items, (e, j) => rowItem(e, j, `<span class="mono small">${e.score.total}</span>`))}</div>`).join('')}
</div></section>

<section class="block"><div class="wrap">
  <div class="section-head"><h2>By the tool you already use</h2><a href="${url('integrations/')}">All tools ${I.arrow}</a></div>
  <div class="tools">
    ${integrations.slice(0, 18).map((g) => `<a class="tool" href="${url(`integrations/${g.key}/`)}"><span class="mono-mark" aria-hidden="true">${esc(g.label.slice(0, 1))}</span><span><strong>${esc(g.label)}</strong><span class="muted small">${(g.items.length + g.prompts.length).toLocaleString()} listed</span></span></a>`).join('')}
  </div>
</div></section>

${P.length ? `<section class="block"><div class="wrap">
  <div class="section-head"><h2>Prompts people love</h2><a href="${url('prompts/')}">Prompt library ${I.arrow}</a></div>
  <div class="card-grid">${P.filter((e) => !e.original).slice(0, 4).map(promptCard).join('')}</div>
</div></section>` : ''}

<section class="block"><div class="wrap">
  <h2>How Plado works</h2>
  <div class="stack">
    <div class="stack-card" style="--i:0"><span class="label-mono">1 · Less noise</span><h3>Ranked by popularity and upkeep</h3><p class="muted">Stars, forks and how recently the code changed. One big collection can't crowd out a page, and every score shows its breakdown. It doesn't say whether a tool works. We're building that next.</p></div>
    <div class="stack-card" style="--i:1"><span class="label-mono">2 · Know the cost</span><h3>See what it costs your context</h3><p class="muted">Every skill and subagent shows roughly how many tokens it adds to each session, before you install it.</p></div>
    <div class="stack-card" style="--i:2"><span class="label-mono">3 · Easy in, easy out</span><h3>One line to install, one line to remove</h3><p class="muted">Installs point at the exact version we list, so a later update can't slip in. The remove command sits right next to it.</p></div>
    <div class="stack-card" style="--i:3"><span class="label-mono">4 · Know what you're installing</span><h3>See what the code does</h3><p class="muted">We scan each add-on at the exact version we list. Its page says what the code does, like running shell commands or reading your API keys, and which sites it talks to, with the file and line.</p></div>
  </div>
</div></section>`;
  write('index.html', page({ title: 'Plado: the AI add-ons worth installing, for Claude Code, Codex and Cursor', description: 'Most skills, subagents and MCP servers are noise. Find the few worth installing for Claude Code, Codex and Cursor, ranked by popularity and upkeep, with the context cost of skills and subagents shown and a one-line install you can undo.', rel: 'index.html', body }));
}

// browse
{
  const allIntegrations = integrations.map((g) => `<option value="${esc(g.key)}">${esc(g.label)} (${g.items.length})</option>`).join('');
  const allJobs = jobs.map((g) => `<option value="${esc(g.key)}">${esc(g.label)} (${g.items.length})</option>`).join('');
  const body = `
<div class="wrap"><div class="browse" id="browse">
  <form class="filters" id="filters" aria-label="Filters">
    <div class="field"><label for="f-q">Search</label><input class="input" id="f-q" name="q" type="search" placeholder="Name, tool or keyword"></div>
    <fieldset><legend>Platform</legend>
      ${Object.entries(PLATFORM).filter(([k]) => k !== 'any-mcp-client' && k !== 'claude-code-user').map(([k, v]) => `<label><input type="checkbox" name="platform" value="${k}"> ${esc(v)}</label>`).join('')}
    </fieldset>
    <fieldset><legend>Type</legend>
      ${Object.entries(TYPE).map(([k, v]) => `<label><input type="checkbox" name="type" value="${k}"> ${esc(v)}</label>`).join('')}
    </fieldset>
    <div class="field"><label for="f-int">Integration</label><select id="f-int" name="integration"><option value="">Any</option>${allIntegrations}</select></div>
    <div class="field"><label for="f-use">Team or task</label><select id="f-use" name="use"><option value="">Any</option>${teamGroups.map((g) => `<optgroup label="${esc(g.label)}"><option value="${g.key}">All of ${esc(g.label)} (${g.items.length})</option>${g.tasks.map((t) => `<option value="${t.key}">${esc(t.label)} (${t.items.length})</option>`).join('')}</optgroup>`).join('')}</select></div>
    <div class="field"><label for="f-ind">Industry</label><select id="f-ind" name="ind"><option value="">Any</option>${industryGroups.map((g) => `<option value="${g.key}">${esc(g.label)} (${g.items.length})</option>`).join('')}</select></div>
    <div class="field"><label for="f-min">Minimum popularity score</label><select id="f-min" name="min"><option value="0">Any</option><option value="40">40+</option><option value="60">60+</option><option value="75">75+</option></select></div>
    <label><input type="checkbox" name="license" value="1"> Has a license</label>
    <button class="btn" id="reset" type="button">Clear filters</button>
  </form>
  <div>
    <div class="toolbar">
      <h1 style="font-size:1.5rem;margin:0">Browse everything</h1>
      <p class="small muted interp" id="interp" aria-live="polite" style="margin:0;flex-basis:100%"></p>
      <div class="field" style="grid-auto-flow:column;align-items:center"><label for="f-sort" class="small">Sort</label>
        <select id="f-sort" name="sort" form="filters"><option value="match">Best match</option><option value="score">Popularity score</option><option value="stars">GitHub stars / votes</option><option value="light">Lightest on context</option>${hasTrending ? '<option value="trending">Trending this week</option>' : ''}<option value="updated">Recently updated</option><option value="name">Name</option></select></div>
    </div>
    <p class="muted small" id="result-count" aria-live="polite">Loading…</p>
    <div class="list" id="results"><noscript><p>Filtering needs JavaScript. Browse by <a href="${url('')}">platform</a> or <a href="${url('integrations/')}">integration</a> instead.</p></noscript></div>
    <p style="margin-top:16px"><button class="btn" id="load-more" type="button" hidden>Show more</button></p>
  </div>
</div></div>`;
  write('browse/index.html', page({ title: 'Browse AI coding add-ons | Plado', description: 'Filter Claude Code plugins and MCP servers by platform, integration, purpose and score.', rel: 'browse/index.html', body, nav: 'browse' }));
}

// hubs
for (const h of hubs) {
  const top = h.items.slice(0, 60);
  let body = `<div class="wrap">
  <p class="crumbs"><a href="${url('')}">Home</a> / ${esc(h.title)}</p>
  <div class="section-head" style="margin-top:12px"><h1>${esc(h.title)}</h1><a class="btn" href="${url('browse/?' + h.q)}">Filter all ${h.items.length.toLocaleString()} →</a></div>
  <p class="muted">The top ${top.length} by popularity score. The score uses public GitHub signals only, so it shows what is popular and maintained, not what works best.</p>
  <div class="list" style="padding-bottom:64px">${top.map(card).join('')}</div>
</div>`;
  const extra = h.key === 'skills' && skillJobs.length ? `<div class="grid" style="margin:0 0 24px">${skillJobs.map((g) => `<a class="tile" href="${url(`skills/${g.key}/`)}"><strong>Skills for ${esc(g.label.toLowerCase())}</strong><span class="count">${g.items.length} skills</span></a>`).join('')}</div>` : '';
  if (extra) body = body.replace('<div class="list"', extra + '<div class="list"');
  write(`${h.key}/index.html`, page({ title: `${h.seo || h.title}: top ${top.length} ranked | Plado`, description: `The ${h.items.length} ${h.title.toLowerCase()} we track, ranked on usage and upkeep, with pinned install commands.`, rel: `${h.key}/index.html`, body,
    jsonld: { '@context': 'https://schema.org', '@type': 'ItemList', name: h.title, itemListElement: top.slice(0, 20).map((e, i) => ({ '@type': 'ListItem', position: i + 1, name: e.name, url: SITE_URL ? `${SITE_URL}/e/${e.id}/` : undefined })) } }));
}

// skills by job
for (const g of skillJobs) {
  const top = g.items.slice(0, 60);
  const label = g.label.toLowerCase();
  const body = `<div class="wrap">
  <p class="crumbs"><a href="${url('')}">Home</a> / <a href="${url('skills/')}">Skills</a> / ${esc(g.label)}</p>
  <h1 style="margin-top:12px">Claude skills for ${esc(label)}</h1>
  <p class="muted">${g.items.length} agent skills for ${esc(label)}, ranked on usage and upkeep. Each installs pinned to the exact commit listed. None has been security-scanned yet.</p>
  <div class="list" style="padding-bottom:64px">${top.map(card).join('')}</div>
</div>`;
  write(`skills/${g.key}/index.html`, page({ title: `Claude skills for ${label} (${g.items.length} ranked) | Plado`, description: `The best Claude and agent skills for ${label}, ranked on usage and upkeep, with pinned installs.`, rel: `skills/${g.key}/index.html`, body }));
}

// prompt library
if (P.length) {
  const tiles = promptGroups.map((g) => `<a class="tile" href="${url(`prompts/${g.key}/`)}"><strong>${esc(g.label)}</strong><span class="count">${g.items.length} prompts</span></a>`).join('');
  const body = `<div class="wrap">
  <p class="crumbs"><a href="${url('')}">Home</a> / Prompt library</p>
  <h1 style="margin-top:12px">Prompt library</h1>
  <p class="muted">${P.length} free AI prompts, ranked by community votes and editor picks on prompts.chat. All public domain (CC0), so copy, change and reuse them freely. ${P.filter((e) => e.variables.length).length} have fill-in fields.</p>
  <div class="grid" style="margin:16px 0 24px">${tiles}</div>
  <div class="list" style="padding-bottom:64px">${P.slice(0, 60).map(promptCard).join('')}</div>
</div>`;
  write('prompts/index.html', page({ title: `Prompt library: ${P.length} free AI prompts, ranked | Plado`, description: `${P.length} free prompts for ChatGPT, Claude, Gemini and Grok, plus image and video prompts. Ranked by community votes, all CC0.`, rel: 'prompts/index.html', body }));
  for (const g of promptGroups) {
    const b = `<div class="wrap">
  <p class="crumbs"><a href="${url('')}">Home</a> / <a href="${url('prompts/')}">Prompts</a> / ${esc(g.label)}</p>
  <h1 style="margin-top:12px">${esc(g.label)}</h1>
  <p class="muted">${g.items.length} prompts, ranked by community votes. Public domain (CC0).</p>
  <div class="list" style="padding-bottom:64px">${g.items.slice(0, 80).map(promptCard).join('')}</div>
</div>`;
    write(`prompts/${g.key}/index.html`, page({ title: `${g.label}: ${g.items.length} free, ranked | Plado`, description: `${g.items.length} free ${g.label.toLowerCase()}, ranked by community votes. Copy and reuse, all CC0.`, rel: `prompts/${g.key}/index.html`, body: b }));
  }
}

// cursor rules
if (R.length) {
  const body = `<div class="wrap">
  <p class="crumbs"><a href="${url('')}">Home</a> / Cursor rules</p>
  <h1 style="margin-top:12px">Cursor rules</h1>
  <p class="muted">${R.length} rules files for Cursor from the awesome-cursorrules collection (CC0). There's no ranking signal for these yet, so they're listed A to Z.</p>
  <div class="list" style="padding-bottom:64px">${R.map(rulesCard).join('')}</div>
</div>`;
  write('rules/cursor/index.html', page({ title: `Cursor rules: ${R.length} free .mdc rules files | Plado`, description: `${R.length} Cursor rules files for frameworks and languages, public domain, with a one-line install.`, rel: 'rules/cursor/index.html', body }));
}

// trending
if (hasTrending) {
  const tabs = TW.map((t) => `<button type="button" role="tab" id="tw-${t.key}" aria-selected="${t.key === 'week'}" data-w="${t.key}">${t.tab}</button>`).join('');
  const panels = TW.flatMap((t) => ['hot', 'rising'].map((sort) => {
    const rows = trend[sort][t.key] || [];
    return `<div class="list trend-panel" data-panel="${t.key}-${sort}"${t.key === 'week' && sort === 'hot' ? '' : ' hidden'}>
    <p class="small muted trend-note">${esc(srcNote(t.key))}${sort === 'rising' ? ` Rising ranks by growth relative to size, among repos that gained at least ${RISING_MIN[t.key]} stars.` : ''}</p>
    ${rows.length ? rows.map((x, i) => trendCard(x, i, t.key)).join('') : `<div class="empty">Nothing measured for ${esc(t.label)} yet.</div>`}
  </div>`;
  })).join('');
  const pPanels = TW.map((t) => {
    const rows = trend.prompts[t.key] || [];
    const isNew = rows.length && rows.every((x) => x.src === 'new');
    return `<div class="list trend-ppanel" data-ppanel="${t.key}"${t.key === 'week' ? '' : ' hidden'}>
    <p class="small muted trend-note">${isNew ? `prompts.chat doesn't publish when votes were cast, so until our own snapshots cover ${esc(t.span)}, this lists prompts added ${esc(t.label)}, ranked by votes.` : `Votes gained in ${esc(t.span)}, from our daily snapshots of prompts.chat.`}</p>
    ${rows.length ? rows.map((x, i) => trendPromptCard(x, i, t.key)).join('') : `<div class="empty">No prompt activity measured for ${esc(t.label)} yet.</div>`}
  </div>`;
  }).join('');
  const body = `<div class="wrap trending" style="padding-bottom:64px">
  <p class="crumbs"><a href="${url('')}">Home</a> / Trending</p>
  <h1 style="margin-top:12px">Trending</h1>
  <p class="muted">The add-ons gaining stars fastest. Hot ranks by stars gained; Rising ranks by growth for their size, which surfaces smaller projects taking off. Stars can be bought, and our fake-star check isn't live yet, so treat a sudden spike with care.</p>
  <section class="panel live-searches" id="live-searches" style="margin-top:32px" hidden>
    <div class="section-head" style="margin:0 0 8px"><h2 style="margin:0">What people are searching on Plado <span class="live-dot" aria-hidden="true"></span></h2>
      <div class="seg" role="group" aria-label="Search window"><button type="button" data-sw="day" aria-pressed="true">Today</button><button type="button" data-sw="week" aria-pressed="false">This week</button></div></div>
    <ol class="rows" id="live-searches-list"></ol>
    <p class="small muted" style="margin:8px 0 0">Counted anonymously, one per person per day. A search shows here once at least 3 people have made it. Updates every minute.</p>
  </section>
  <div class="trend-controls">
    <div class="seg" role="tablist" aria-label="Time window">${tabs}</div>
    <div class="seg" role="group" aria-label="Rank by">
      <button type="button" data-sort="hot" aria-pressed="true">Hot</button>
      <button type="button" data-sort="rising" aria-pressed="false">Rising</button>
    </div>
    <div class="trend-search"><label class="sr-only" for="trend-q">Search trending</label>${I.search}<input id="trend-q" class="input" type="search" autocomplete="off" placeholder="Search trending…"></div>
    <div class="chips trend-types" role="group" aria-label="Type">
      <button type="button" class="chip" data-type="" aria-pressed="true">All</button>
      <button type="button" class="chip" data-type="skill" aria-pressed="false">Skills</button>
      <button type="button" class="chip" data-type="agent" aria-pressed="false">Subagents</button>
      <button type="button" class="chip" data-type="plugin" aria-pressed="false">Plugins</button>
      <button type="button" class="chip" data-type="mcp-server" aria-pressed="false">MCP servers</button>
      <button type="button" class="chip" data-type="prompt" aria-pressed="false">Prompts</button>
    </div>
  </div>
  <div id="trend-tools">${panels}</div>
  <div class="empty" id="trend-none" hidden>Nothing matches that search in this window.</div>
  <section id="trend-prompts" style="margin-top:40px">
    <h2>Prompts</h2>
    ${pPanels}
  </section>
</div>`;
  write('trending/index.html', page({ title: 'Trending AI coding add-ons: today, this week, this quarter, this year | Plado', description: 'The Claude Code skills, plugins, MCP servers and prompts gaining stars fastest today, this week, this quarter and this year.', rel: 'trending/index.html', body, nav: 'trending' }));
}

// leaderboard
{
  const top = E.slice(0, 100);
  const rows = top.map((e, i) => `<tr><td class="num">${i + 1}</td><td><a href="${url(`e/${e.id}/`)}">${esc(e.name)}</a><div class="small muted mono">${esc(e.github.repo)}</div></td><td>${esc(TYPE[e.type])}</td><td class="num">${e.score.total}</td><td class="num">${fmt(e.github.stars)}</td><td>${ago(e.github.pushedAt)}</td></tr>`).join('');
  const body = `<div class="wrap" style="padding:32px 16px 64px">
  <h1>Leaderboard</h1>
  <p class="muted">The top 100 add-ons by popularity score. <a href="${url('how-we-rank/')}">How the score works</a>, and what it doesn't include yet.</p>
  <div class="table-wrap"><table><caption class="sr-only">Top 100 add-ons by popularity score</caption><thead><tr><th scope="col">#</th><th scope="col">Add-on</th><th scope="col">Type</th><th scope="col">Score</th><th scope="col">Stars</th><th scope="col">Updated</th></tr></thead><tbody>${rows}</tbody></table></div>
</div>`;
  write('leaderboard/index.html', page({ title: 'Leaderboard: top 100 AI coding add-ons | Plado', description: 'The 100 highest-ranked Claude Code plugins and MCP servers by usage, upkeep and license.', rel: 'leaderboard/index.html', body, nav: 'leaderboard' }));
}

// use cases: /for/ (all teams), /for/<team>/, /for/<team>/<task>/, /industries/<ind>/
const TYPE_ORDER = ['agent', 'skill', 'mcp-server', 'plugin', 'prompt', 'rules'];
const typeFilter = (items) => { const n = (t) => items.filter((e) => e.type === t).length; return `<div class="chips type-filter" role="group" aria-label="Type"><button type="button" class="chip" data-type="" aria-pressed="true">All ${items.length}</button>${TYPE_ORDER.filter(n).map((t) => `<button type="button" class="chip" data-type="${t}" aria-pressed="false">${esc(TYPE_PLURAL[t])} ${n(t)}</button>`).join('')}</div>`; };
const listOf = (items, n = 60) => `<div class="list filterable">${items.slice(0, n).map(anyCard).join('')}</div>`;
{
  const body = `<div class="wrap" style="padding:32px 16px 64px">
  <p class="crumbs"><a href="${url('')}">Home</a> / Use cases</p>
  <h1 style="margin-top:12px">What do you want to get done?</h1>
  <p class="muted">Every skill, subagent, MCP server, plugin and prompt, sorted by the team that uses it and the task it helps with.</p>
  <div class="teams">${teamGroups.map((g) => `<div class="team"><a class="team-head" href="${url(`for/${g.key}/`)}"><strong>${esc(g.label)}</strong><span class="muted small mono">${g.items.length.toLocaleString()}</span></a><ul>${g.tasks.map((t) => `<li><a href="${url(`for/${t.key}/`)}">${esc(t.label)}</a> <span class="muted small">${t.items.length}</span></li>`).join('')}</ul></div>`).join('')}</div>
  ${industryGroups.length ? `<h2 style="margin-top:40px">By industry</h2><div class="popular">${industryGroups.map((g) => `<a class="chip link" href="${url(`industries/${g.key}/`)}">${esc(g.label)} <span class="muted">${g.items.length}</span></a>`).join('')}</div>` : ''}
</div>`;
  write('for/index.html', page({ title: 'AI coding add-ons by team and task: marketing, sales, engineering and more | Plado', description: 'Find skills, subagents, MCP servers and prompts by what you want to get done: social media, SEO, code review, testing, CRM, video and more.', rel: 'for/index.html', body, nav: 'uses' }));
  for (const g of teamGroups) {
    const b = `<div class="wrap" style="padding-bottom:64px">
  <p class="crumbs"><a href="${url('')}">Home</a> / <a href="${url('for/')}">Use cases</a> / ${esc(g.label)}</p>
  <h1 style="margin-top:12px">AI agents, skills and tools for ${esc(g.label.toLowerCase())}</h1>
  <p class="muted">${g.items.length.toLocaleString()} skills, subagents, MCP servers, plugins and prompts for ${esc(g.label.toLowerCase())}, ranked on usage. Pick a task to narrow it down.</p>
  <div class="popular">${g.tasks.map((t) => `<a class="chip link" href="${url(`for/${t.key}/`)}">${esc(t.label)} <span class="muted">${t.items.length}</span></a>`).join('')}</div>
  ${g.tasks.map((t) => `<section style="margin-top:36px"><div class="section-head"><h2>${esc(t.label)}</h2><a href="${url(`for/${t.key}/`)}">All ${t.items.length} ${I.arrow}</a></div><div class="list">${t.items.slice(0, 4).map(anyCard).join('')}</div></section>`).join('')}
</div>`;
    write(`for/${g.key}/index.html`, page({ title: `AI agents, skills & prompts for ${g.label.toLowerCase()} (${g.items.length.toLocaleString()} ranked) | Plado`, description: `The best Claude Code skills, subagents, MCP servers and prompts for ${g.label.toLowerCase()}: ${g.tasks.slice(0, 5).map((t) => t.label.toLowerCase()).join(', ')}.`, rel: `for/${g.key}/index.html`, body: b, nav: 'uses' }));
    for (const t of g.tasks) {
      const tb = `<div class="wrap" style="padding-bottom:64px">
  <p class="crumbs"><a href="${url('')}">Home</a> / <a href="${url('for/')}">Use cases</a> / <a href="${url(`for/${g.key}/`)}">${esc(g.label)}</a> / ${esc(t.label)}</p>
  <h1 style="margin-top:12px">${esc(t.label)}: AI agents, skills &amp; prompts</h1>
  <p class="muted">${t.items.length.toLocaleString()} ways to get ${esc(t.label.toLowerCase())} done with Claude Code, Codex, Cursor or Gemini CLI, ranked on usage. Filter by type below.</p>
  ${typeFilter(t.items)}
  ${listOf(t.items)}
  ${t.items.length > 60 ? `<p style="margin-top:16px"><a class="btn" href="${url(`browse/?use=${encodeURIComponent(t.key)}`)}">See all ${t.items.length} with filters ${I.arrow}</a></p>` : ''}
</div>`;
      write(`for/${t.key}/index.html`, page({ title: `${t.label} with AI: ${t.items.length} agents, skills & prompts, ranked | Plado`, description: `The best Claude Code subagents, skills, MCP servers and prompts for ${t.label.toLowerCase()}, ranked on usage, with pinned installs.`, rel: `for/${t.key}/index.html`, body: tb, nav: 'uses' }));
    }
  }
  for (const g of industryGroups) {
    const b = `<div class="wrap" style="padding-bottom:64px">
  <p class="crumbs"><a href="${url('')}">Home</a> / <a href="${url('for/')}">Use cases</a> / ${esc(g.label)}</p>
  <h1 style="margin-top:12px">AI agents, skills &amp; tools for ${esc(g.label.toLowerCase())}</h1>
  <p class="muted">${g.items.length} listings that mention ${esc(g.label.toLowerCase())} work, ranked on usage.</p>
  ${typeFilter(g.items)}
  ${listOf(g.items)}
</div>`;
    write(`industries/${g.key}/index.html`, page({ title: `AI tools for ${g.label.toLowerCase()}: agents, skills & prompts | Plado`, description: `Claude Code skills, subagents, MCP servers and prompts for ${g.label.toLowerCase()}, ranked on usage.`, rel: `industries/${g.key}/index.html`, body: b, nav: 'uses' }));
  }
}

// integrations
{
  const body = `<div class="wrap" style="padding:32px 16px 64px">
  <h1>Integrations</h1>
  <p class="muted">Every add-on that connects your AI coding tool to something you already use.</p>
  <div class="grid">${integrations.map((g) => `<a class="tile" href="${url(`integrations/${g.key}/`)}"><strong>${esc(g.label)}</strong><span class="count">${(g.items.length + g.prompts.length).toLocaleString()} listed</span></a>`).join('')}</div>
</div>`;
  write('integrations/index.html', page({ title: 'Integrations: MCP servers and plugins by tool | Plado', description: 'Find the best MCP servers and Claude Code plugins for GitHub, Figma, Postgres, Slack and more.', rel: 'integrations/index.html', body, nav: 'integrations' }));

  for (const g of integrations) {
    const table = (list, caption) => `<div class="table-wrap"><table><caption class="sr-only">${esc(caption)}</caption><thead><tr><th scope="col">#</th><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Works with</th><th scope="col">Score</th><th scope="col">Stars</th><th scope="col">Updated</th></tr></thead><tbody>${list.map((e, i) => `<tr><td class="num">${i + 1}</td><td><a href="${url(`e/${e.id}/`)}">${esc(e.name)}</a><div class="small muted">${esc(clip(e.description, 110))}</div></td><td>${esc(TYPE[e.type])}</td><td>${e.platforms.map((p) => esc(PLATFORM[p])).join(', ')}</td><td class="num">${e.score.total}</td><td class="num">${fmt(e.github.stars)}</td><td>${ago(e.github.pushedAt)}</td></tr>`).join('')}</tbody></table></div>`;
    const makerExamples = g.skills.flatMap((sk) => (sk.examples || []).map((x) => ({ x, sk }))).slice(0, 8);
    const hasSkills = g.skills.length > 0;
    const heading = hasSkills ? `${g.label} skills, MCP servers & prompts for Claude Code` : g.prompts.length && !g.tools.length ? `${g.label} prompts` : `${g.label} MCP servers &amp; plugins, ranked`;
    const counts = [g.skills.length && `${g.skills.length} skill${g.skills.length > 1 ? 's' : ''}`, g.tools.length && `${g.tools.length} MCP server${g.tools.length > 1 ? 's' : ''} and plugins`, g.prompts.length && `${g.prompts.length} prompt${g.prompts.length > 1 ? 's' : ''}`].filter(Boolean).join(', ');
    const body = `<div class="wrap" style="padding-bottom:64px">
  <p class="crumbs"><a href="${url('')}">Home</a> / <a href="${url('integrations/')}">Tools &amp; integrations</a> / ${esc(g.label)}</p>
  <h1 style="margin-top:12px">${heading}</h1>
  <p class="muted">Everything we list for working with ${esc(g.label)} from an AI coding tool: ${counts}. Start with a skill if there is one, since it teaches your agent how ${esc(g.label)} works, then add a server or plugin for live access and use the prompts to get going.</p>
  ${hasSkills ? `<h2 style="margin-top:32px">Skills</h2><div class="list">${g.skills.slice(0, 12).map(card).join('')}</div>` : ''}
  ${g.agents.length ? `<h2 style="margin-top:32px">Subagents</h2><div class="list">${g.agents.slice(0, 12).map(card).join('')}</div>` : ''}
  ${makerExamples.length ? `<h2 style="margin-top:32px">Example prompts from the makers</h2><ul class="examples">${makerExamples.map(({ x, sk }) => `<li><code>${esc(clip(x, sk.license ? 300 : 120))}</code> <span class="small muted">from <a href="${url(`e/${sk.id}/`)}">${esc(sk.name)}</a></span></li>`).join('')}</ul>` : ''}
  ${g.prompts.length ? `<h2 style="margin-top:32px">Prompts &amp; recipes</h2><div class="list">${g.prompts.slice(0, 12).map(promptCard).join('')}</div>` : ''}
  ${g.tools.length ? `<h2 style="margin-top:32px">MCP servers &amp; plugins</h2>${table(g.tools.slice(0, 50), `${g.label} MCP servers and plugins by popularity score`)}` : ''}
  <p class="small muted" style="margin-top:16px">${SCAN_LIVE ? '' : 'Preview data: not everything here has been scanned yet. '}<a href="${url(`browse/?integration=${g.key}`)}">Filter all ${(g.items.length + g.prompts.length).toLocaleString()}</a>.</p>
</div>`;
    const title = hasSkills ? `${g.label} skills, MCP servers & prompts for Claude Code | Plado` : `Best ${g.label} MCP servers & plugins (${g.items.length} ranked) | Plado`;
    write(`integrations/${g.key}/index.html`, page({ title, description: `${counts} for ${g.label}, for Claude Code, Codex, Cursor and Gemini CLI. Ranked on usage and upkeep, with pinned installs.`, rel: `integrations/${g.key}/index.html`, body,
      jsonld: { '@context': 'https://schema.org', '@type': 'ItemList', name: heading.replace(/&amp;/g, '&'), itemListElement: [...g.skills, ...g.tools].slice(0, 20).map((e, i) => ({ '@type': 'ListItem', position: i + 1, name: e.name })) } }));
  }
}

// subagent: what it can use, and the file itself
const CAN = { all: 'Every tool, because it sets no tools list (it inherits all of yours, including shell and MCP tools)', shell: 'Run shell commands', edit: 'Edit and write files', web: 'Fetch web pages and search', read: 'Read and search files', mcp: 'Use MCP server tools', agents: 'Start other agents' };
function agentPanels(e) {
  const risky = e.can.includes('all') || e.can.includes('shell') || e.can.includes('web');
  return `<div class="panel"><h2>What it can use</h2>
    <ul class="checklist" style="grid-template-columns:minmax(0,1fr)">${e.can.map((k) => `<li class="${k === 'all' || k === 'shell' ? 'no' : 'ok'}"><span aria-hidden="true">${k === 'all' || k === 'shell' ? '!' : '✓'}</span> ${esc(CAN[k])}</li>`).join('')}</ul>
    ${e.tools ? `<p class="small muted" style="margin:10px 0 0">Tools listed in the file: <span class="mono">${esc(e.tools.join(', '))}</span></p>` : ''}
    ${e.model ? `<p class="small muted" style="margin:6px 0 0">Model: <span class="mono">${esc(e.model)}</span></p>` : ''}
    ${risky ? `<p class="small" style="margin:10px 0 0">This agent can act outside your files. Read it before installing, and narrow its <code>tools:</code> line if it needs less.</p>` : ''}
  </div>
  ${e.text ? `<div class="panel"><h2>The agent file</h2><pre class="prompt-text">${esc(e.text)}</pre><button class="btn" type="button" data-copy="${esc(e.text)}">${I.copy}<span>Copy the file</span></button><p class="small muted" style="margin:8px 0 0">${esc(e.license)} license, from ${esc(e.github.repo)} at commit ${esc(e.pin.value.slice(0, 12))}.</p></div>` : `<div class="panel"><h2>The agent file</h2><p style="margin:0">This repo has no license file, so we link to it instead of copying it. <a href="https://github.com/${esc(e.github.repo)}/blob/${esc(e.pin.value)}/${esc(e.subpath)}" rel="noopener nofollow" target="_blank">Read it on GitHub</a>.</p></div>`}`;
}

// Alternatives: a side-by-side table, this item first, then other makers doing the same job.
const altWhy = (shared) => {
  const t = shared.find((k) => k.startsWith('t:')), i = shared.find((k) => k.startsWith('i:')), c = shared.find((k) => k.startsWith('c:'));
  const w = shared.filter((k) => !k.includes(':')).slice(0, 2);
  const out = [];
  if (t && TASKS[t.slice(2)]) out.push(`Same job: ${TASKS[t.slice(2)].label.toLowerCase()}`);
  else if (c && PROMPT_CAT_LABEL[c.slice(2)]) out.push(`Same category: ${PROMPT_CAT_LABEL[c.slice(2)].toLowerCase()}`);
  if (i && INTEGRATION_LABEL[i.slice(2)]) out.push(`also for ${INTEGRATION_LABEL[i.slice(2)]}`);
  if (!out.length && w.length) out.push(`Both about ${w.join(' and ')}`);
  return out.join(', ').replace(/^./, (x) => x.toUpperCase());
};
const ctxCell = (x) => !x.ctx ? '<span class="muted">not measured</span>' : x.type === 'agent' ? `≈${kfmt(x.ctx.always)} in chat` : x.ctx.always ? `≈${kfmt(x.ctx.always)} always` : `≈${kfmt(x.ctx.onUse)} when used`;
function altPanel(e) {
  const isPrompt = e.type === 'prompt';
  const alts = (isPrompt ? PALT : ALT).get(e.id) || [];
  const title = isPrompt ? 'Similar prompts' : 'Alternatives';
  if (!alts.length) {
    const t = (e.integrations || [])[0];
    return isPrompt ? '' : `<div class="panel"><h2>${title}</h2><p style="margin:0">Nothing from another maker does quite the same job yet.${t ? ` <a href="${url(`integrations/${t}/`)}">See everything for ${esc(INTEGRATION_LABEL[t])}</a>.` : ''}</p></div>`;
  }
  const row = (x, why, self) => `<tr${self ? ' class="is-self"' : ''}>
    <th scope="row">${self ? `<span class="self-tag">This one</span><strong>${esc(x.name)}</strong>` : `<a href="${url(`e/${x.id}/`)}"><strong>${esc(x.name)}</strong></a>`}
      <span class="cmp-sub">${isPrompt ? esc(PROMPT_CAT_LABEL[x.category?.primary] || '') : `<span class="mono">${esc(x.github.repo)}</span> · ${esc(TYPE[x.type])}`}</span>
      ${why ? `<span class="cmp-why">${esc(why)}</span>` : ''}</th>
    ${isPrompt
      ? `<td data-label="Votes">▲ ${x.community.votes}</td><td data-label="Score">${x.score?.total ?? '–'}</td>`
      : `<td data-label="Score">${x.score?.total ?? '–'}</td><td data-label="Stars">★ ${fmt(x.github.stars)}</td><td data-label="Context">${ctxCell(x)}</td><td data-label="Updated">${ago(x.github.pushedAt)}</td>`}
  </tr>`;
  return `<div class="panel"><h2>${title}</h2>
    <p class="small muted" style="margin:0 0 12px">${isPrompt ? 'Prompts that do the same job, most voted first.' : 'Other makers\' add-ons that do the same job, next to this one.'}</p>
    <div class="cmp-wrap"><table class="cmp">
      <thead><tr><th scope="col">Name</th>${isPrompt ? '<th scope="col">Votes</th><th scope="col">Score</th>' : '<th scope="col">Score</th><th scope="col">Stars</th><th scope="col">Context</th><th scope="col">Updated</th>'}</tr></thead>
      <tbody>${row(e, '', true)}${alts.map((a) => row(a.item, altWhy(a.shared), false)).join('')}</tbody>
    </table></div>
  </div>`;
}

// Security panel: what the scan found, at which version, with file links. Never "safe".
function securityPanel(e) {
  const x = scanOf(e);
  const caveat = `<p class="small muted" style="margin:12px 0 0">A scan lists patterns in the code. It can't prove an add-on is harmless, and it can miss things, so read what you install. <a href="${url('how-we-rank/#security-scan')}">How we scan</a></p>`;
  if (!x || x.status === 'pending' || x.status === 'error') return `<div class="panel"><h2>Security</h2><p style="margin:0">We haven't been able to scan this version yet.</p>${caveat}</div>`;
  if (x.status === 'none') return `<div class="panel"><h2>Security</h2><p style="margin:0">${x.why === 'hosted' ? 'This server runs on the vendor\'s side, so there\'s no code for us to scan. You\'re trusting the vendor with whatever you send it.' : 'This listing doesn\'t point at a fixed version, so there\'s nothing stable for us to scan.'}</p>${caveat}</div>`;
  const at = x.at.kind === 'commit' ? `commit <code>${esc(x.at.value.slice(0, 12))}</code>` : x.at.kind === 'text' ? 'the text shown on this page' : `the ${x.at.kind === 'npm' ? 'npm' : 'PyPI'} package <code>${esc(x.at.value)}</code>`;
  const base = e.github?.repo && x.at.kind === 'commit' ? `https://github.com/${e.github.repo}/blob/${x.at.value}/` : null;
  const single = e.type === 'agent' || e.type === 'rules';
  const own = e.type === 'rules' ? e.path : e.subpath || '';
  const link = (w) => {
    const p = single && w.f === 'SKILL.md' ? own : (own && !single ? own.replace(/\/$/, '') + '/' : '') + w.f;
    const label = `${esc(single ? p.split('/').pop() : w.f)}${w.l ? `:${w.l}` : ''}`;
    return base ? `<a class="mono" href="${esc(base + p.split('/').map(encodeURIComponent).join('/'))}${w.l ? `#L${w.l}` : ''}" rel="noopener nofollow" target="_blank">${label}</a>` : `<span class="mono">${label}</span>`;
  };
  const facts = x.facts || [];
  const body = facts.length
    ? `<p style="margin:0 0 10px">What its code does:</p><ul class="scan-facts">${facts.map((f) => `<li><strong>${esc(FACT_LABEL[f.k] || f.k)}</strong>${FACT_NOTE[f.k] ? `<span class="muted small"> ${esc(FACT_NOTE[f.k])}</span>` : ''}${f.where?.length ? `<span class="scan-where small">${f.where.map(link).join(', ')}${f.n > f.where.length ? ` and ${f.n - f.where.length} more` : ''}</span>` : ''}</li>`).join('')}</ul>`
      + (x.hosts?.length && !x.held && facts.some((f) => ['network', 'envnet', 'remote'].includes(f.k))
        ? `<p style="margin:16px 0 10px">Web addresses in its code:</p><ul class="scan-facts">${x.hosts.map((h) => `<li><strong class="mono">${esc(h.h)}</strong><span class="scan-where small">${link({ f: h.f, l: h.l })}</span></li>`).join('')}</ul>${x.hostCount ? `<p class="small muted" style="margin:6px 0 0">And ${x.hostCount - x.hosts.length} more.</p>` : ''}
        <p class="small muted" style="margin:10px 0 0">These are the sites named in the code, so it's where your data could go. It isn't a complete list: code can build addresses while it runs, and a few of these may be links rather than calls. Whatever you send also goes to the AI model you use.</p>`
        : '')
    : x.held ? `<p style="margin:0">Results for this version aren't published yet.</p>`
    : `<p style="margin:0">None of the patterns we list turned up: shell commands, network requests, reading environment variables, downloading and running code, or installing packages.</p>`;
  return `<div class="panel"><h2>Security</h2>
    <p class="small muted" style="margin:0 0 12px">Scanned ${new Date(x.date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })} at ${at}${x.partial ? ', first 300 source files (it\'s a large repo)' : ''}, with Cisco's open-source skill-scanner.</p>
    ${body}${caveat}</div>`;
}

// entry pages
for (const e of E) {
  const g = e.github;
  const platforms = Object.keys(e.install);
  const tabs = platforms.map((p, i) => `<button role="tab" id="tab-${i}" aria-controls="panel-${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" type="button">${esc(PLATFORM[p] || p)}</button>`).join('');
  const panels = platforms.map((p, i) => `<div role="tabpanel" id="panel-${i}" aria-labelledby="tab-${i}"${i ? ' hidden' : ''}>
    ${e.install[p].map((c) => `<div class="cmd"><code>${esc(c)}</code><button type="button" data-copy="${esc(c)}" aria-label="Copy command">${I.copy}<span>Copy</span></button></div>`).join('')}
    ${(() => { const u = uninstallFor(e, p, e.install[p]); return u ? `<p class="small muted" style="margin:10px 0 6px">To remove it later:</p>${u.map((c) => `<div class="cmd cmd-remove"><code>${esc(c)}</code><button type="button" data-copy="${esc(c)}" aria-label="Copy remove command">${I.copy}<span>Copy</span></button></div>`).join('')}` : ''; })()}
  </div>`).join('');
  const pinNote = e.pin
    ? `Pinned to ${e.pin.kind === 'commit' ? `commit <code>${esc(e.pin.value.slice(0, 12))}</code>` : `${esc(e.pin.kind)} <code>${esc(e.pin.value)}</code>`} as listed by ${esc(e.origin)}.`
    : e.hosted ? 'Hosted server: the code runs on the vendor\'s side, so there is nothing to pin or scan locally.' : 'This source doesn\'t pin a version. What you install may change after listing.';
  const parts = e.score?.parts || {};
  const measured = parts.installs != null, counted = measured && !!INSTALLS[e.id];
  const MAX = measured ? { installs: 25, popularity: 10, usage: 15, maintenance: 25, license: 15, owner: 10 } : { popularity: 35, usage: 15, maintenance: 25, license: 15, owner: 10 };
  const LABEL = { installs: 'Installs in real projects', popularity: 'Stars', usage: 'Usage (forks)', maintenance: 'Upkeep', license: 'License', owner: 'Owner history' };
  const bars = Object.keys(MAX).map((k) => `<div class="bar"><span>${LABEL[k]}</span><div class="track" role="img" aria-label="${LABEL[k]}: ${parts[k] ?? 0} of ${MAX[k]}"><div class="fill" style="width:${Math.round(((parts[k] ?? 0) / MAX[k]) * 100)}%"></div></div><span class="val">${parts[k] ?? 0}/${MAX[k]}</span></div>`).join('');
  const ghUrl = `https://github.com/${g.repo}${e.subpath ? `/${e.type === 'agent' ? 'blob' : 'tree'}/${e.pin?.value || 'HEAD'}/${e.subpath.replace(/^\.\//, '')}` : ''}`;
  const tags = [...e.integrations.map((t) => `<a class="chip link" href="${url(`integrations/${t}/`)}">${esc(INTEGRATION_LABEL[t])}</a>`), ...e.jobs.map((t) => `<a class="chip link" href="${url(`browse/?job=${t}`)}">${esc(JOB_LABEL[t])}</a>`)].join('');

  const body = `<div class="wrap">
  <p class="crumbs"><a href="${url('')}">Home</a> / <a href="${url('browse/?type=' + e.type)}">${esc(TYPE_PLURAL[e.type])}</a> / ${esc(e.name)}</p>
  <div class="entry-head">
    <div class="entry-id">
      ${avatar(e, 64)}
      <div>
      <h1>${esc(e.name)} ${makerMark(e)}</h1>
      <p class="card-sub" style="margin:-4px 0 10px"><a class="mono" href="${esc(ghUrl)}" rel="noopener nofollow" target="_blank">${esc(g.repo)}</a><span class="type">${TYPE_ICON[e.type] || ''}${esc(TYPE[e.type])}</span></p>
      <p class="muted" style="max-width:70ch">${esc(e.description)}</p>
      <div class="chips" style="gap:8px">${scanBadge(e)}<span class="badge neutral">${esc(TYPE[e.type])}</span><span class="badge neutral">Source: ${esc(e.origin)}</span>${e.type === 'skill' && e.hasScripts ? '<span class="badge neutral">Contains scripts</span>' : ''}${e.sourceAvailableOnly ? '<span class="badge neutral">Source-available, not open source</span>' : ''}${e.officialNoLicense ? '<span class="badge neutral">From the maker (verified org) · no license file</span>' : ''}</div>
      <div class="stat-strip">
        <span>${I.star}<strong>${g.stars.toLocaleString()}</strong> stars</span>
        ${trend.weekByRepo?.[g.repo] ? `<span class="up">${I.trend}<strong>+${trend.weekByRepo[g.repo].toLocaleString()}</strong> this week</span>` : ''}
        <span>${I.clock}Updated <strong>${ago(g.pushedAt)}</strong></span>
        <span>License <strong>${esc(g.license && g.license !== 'NOASSERTION' ? g.license : e.officialNoLicense ? 'none (maker)' : 'not detected')}</strong></span>
        ${e.ctx ? `<span title="Estimated context cost">Context <strong>${esc(ctxShort(e).replace(/^≈/, '≈'))}</strong></span>` : ''}
      </div>
      </div>
    </div>
    ${scoreChip(e)}
  </div>
  <div class="entry-grid">
    <div>
      <div class="panel"><h2>Why this score</h2>
        <div class="bars">${bars}</div>
        ${counted && measured ? `<p class="small" style="margin-top:12px"><strong>${INSTALLS[e.id].n.toLocaleString()}</strong> public GitHub projects have this in their committed setup (counted ${esc(INSTALLS[e.id].at)}). That counts people who kept it, not people who starred it. Private projects aren't visible, so the real number is higher.</p>` : (measured ? `<p class="small muted" style="margin-top:12px">Installs in real projects: we can't search for this one (it has no fixed package name or address), so it's scored as a typical ${esc(TYPE[e.type] || e.type)}.</p>` : '')}
        ${e.score.sharedRepo ? `<p class="small muted" style="margin-top:12px">This repo hosts ${e.score.sharedRepo} ${e.type === 'skill' ? 'skills' : e.type === 'agent' ? 'subagents' : 'add-ons'}, so its ${g.stars.toLocaleString()} stars are split between them (about ${e.score.effectiveStars.toLocaleString()} each) for scoring.</p>` : ''}
        <p class="small muted" style="margin-top:12px">Popularity score: ${e.score.total}/100 from public GitHub signals only. It shows how widely used and maintained this is, not how well it works. Not included yet: the fake-star check. The security scan is shown separately and doesn't change the score. <a href="${url('how-we-rank/')}">How we rank</a></p>
      </div>
      ${e.type === 'agent' ? agentPanels(e) : ''}
      ${securityPanel(e)}
      ${e.type === 'skill' && (e.examples || []).length ? `<div class="panel"><h2>Example prompts from the maker</h2><ul class="examples">${e.examples.map((x) => `<li><code>${esc(clip(x, e.license ? 300 : 120))}</code> <button class="btn" type="button" data-copy="${esc(x)}" aria-label="Copy example prompt">${I.copy}<span>Copy</span></button></li>`).join('')}</ul><p class="small muted" style="margin:8px 0 0">From the skill's own docs${e.license ? '' : '. Quoted briefly because the repo has no license file'}.</p></div>` : ''}
      ${(() => { const rel = P.filter((x) => x.integrations.some((t) => e.integrations.includes(t))).slice(0, 5); return rel.length ? `<div class="panel"><h2>Prompts that use ${esc(INTEGRATION_LABEL[e.integrations.find((t) => rel[0].integrations.includes(t))] || 'this tool')}</h2><div class="list">${rel.map((x) => `<a class="tile" href="${url(`e/${x.id}/`)}"><strong>${esc(x.name)}</strong><span class="count">▲ ${x.community.votes} votes · ${esc(PROMPT_CAT_LABEL[x.category.primary])}</span></a>`).join('')}</div></div>` : ''; })()}
      ${altPanel(e)}
    </div>
    <aside>
      <div class="sticky-install">
      <div class="panel tabs install-box" id="install"><h2>Install</h2>
        <div role="tablist" aria-label="Install for">${tabs}</div>
        ${panels}
        <p class="pin-note">${pinNote}</p>
        ${ctxLine(e)}
        ${e.type === 'agent' ? `<p class="pin-note">Downloads this one agent file at the pinned commit. "Claude Code" puts it in <code>.claude/agents/</code> for this project; "all projects" puts it in <code>~/.claude/agents/</code>. Claude Code picks it up next session, or run <code>/agents</code> to see it.</p>` : ''}
        ${e.type === 'skill' ? `<p class="pin-note">The Claude Code command downloads this skill folder at the pinned commit into <code>.claude/skills/</code>. The Skills CLI (<code>npx skills</code>) works with many agents but can't pin a version, so it installs whatever is current.</p>` : ''}
      </div>
      </div>
      ${e.use.tasks.length || e.use.industries.length ? `<div class="panel"><h2>Used for</h2><div class="chips">${useChips(e)}</div></div>` : ''}
      ${e.integrations.length ? `<div class="panel"><h2>Tool pages</h2><div class="chips">${e.integrations.filter((t) => integrations.some((g) => g.key === t)).map((t) => `<a class="chip link" href="${url(`integrations/${t}/`)}">${esc(INTEGRATION_LABEL[t])}</a>`).join('')}</div></div>` : ''}
      <div class="panel"><h2>Facts</h2>
        <dl class="facts">
          <dt>Repo</dt><dd><a href="${esc(ghUrl)}" rel="noopener nofollow" target="_blank">${esc(g.repo)}</a></dd>
          <dt>Stars</dt><dd>${g.stars.toLocaleString()}</dd>
          <dt>Forks</dt><dd>${g.forks.toLocaleString()}</dd>
          <dt>Last push</dt><dd>${esc(g.pushedAt.slice(0, 10))} (${ago(g.pushedAt)})</dd>
          <dt>License</dt><dd>${esc(g.license && g.license !== 'NOASSERTION' ? g.license : e.officialNoLicense ? 'No license file (official maker)' : 'Not detected')}</dd>
          <dt>Owner</dt><dd>${esc(g.owner)}${g.ownerCreatedAt ? ` · since ${esc(g.ownerCreatedAt.slice(0, 4))}` : ''}</dd>
          ${g.language ? `<dt>Language</dt><dd>${esc(g.language)}</dd>` : ''}
          <dt>Works with</dt><dd>${e.platforms.map((p) => esc(PLATFORM[p])).join(', ')}</dd>
        </dl>
      </div>
      ${tags ? `<div class="panel"><h2>Tags</h2><div class="chips">${tags}</div></div>` : ''}
      <p><a class="btn" href="${esc(ghUrl)}" rel="noopener nofollow" target="_blank">View source on GitHub ${I.ext}</a></p>
    </aside>
  </div>
</div>`;
  write(`e/${e.id}/index.html`, page({
    title: `${e.name}: ${TYPE[e.type]} for ${e.platforms.map((p) => PLATFORM[p]).slice(0, 2).join(' & ')} | Plado`,
    description: clip(`${e.name}: ${e.description}`, 155),
    rel: `e/${e.id}/index.html`, body,
    jsonld: { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: e.name, description: clip(e.description, 300), applicationCategory: 'DeveloperApplication', operatingSystem: 'Cross-platform', codeRepository: `https://github.com/${g.repo}`, license: g.license || undefined },
  }));
}

// prompt pages
for (const e of P) {
  const vars = e.variables;
  const form = vars.length ? `<form class="panel" id="vars" aria-label="Fill in the prompt"><h2>Fill in</h2>
    ${vars.map((v, i) => `<div class="field" style="margin-bottom:10px"><label for="v${i}">${esc(v.name)}</label><input class="input" id="v${i}" data-var="${esc(v.name)}" value="${esc(v.def)}" placeholder="${esc(v.def || v.name)}"></div>`).join('')}
    <p class="small muted" style="margin:0">The prompt below updates as you type.</p></form>` : '';
  const parts = e.score?.parts || {};
  const MAX = { quality: 40, votes: 30, featured: 15, reusable: 10, discussion: 5 };
  const LABEL = { quality: 'Quality checklist', votes: 'Community votes', featured: 'Editor pick', reusable: 'Fill-in fields', discussion: 'Discussion' };
  const q = e.quality;
  const checklist = q ? `<ul class="checklist">${Object.keys(q.labels).map((k) => `<li class="${q.passed.includes(k) ? 'ok' : 'no'}"><span aria-hidden="true">${q.passed.includes(k) ? '✓' : '✗'}</span> ${esc(q.labels[k])}<span class="sr-only">: ${q.passed.includes(k) ? 'yes' : 'no'}</span></li>`).join('')}</ul>` : '';
  const bars = Object.keys(MAX).map((k) => `<div class="bar"><span>${LABEL[k]}</span><div class="track" role="img" aria-label="${LABEL[k]}: ${parts[k]} of ${MAX[k]}"><div class="fill" style="width:${Math.round((parts[k] / MAX[k]) * 100)}%"></div></div><span class="val">${parts[k]}/${MAX[k]}</span></div>`).join('');
  const body = `<div class="wrap">
  <p class="crumbs"><a href="${url('')}">Home</a> / <a href="${url('prompts/')}">Prompts</a> / ${esc(e.name)}</p>
  <div class="entry-head">
    <div>
      <h1>${esc(e.name)}</h1>
      <div class="chips" style="gap:8px"><span class="badge neutral">${esc(e.recipeFor ? `${INTEGRATION_LABEL[e.recipeFor] || e.recipeFor} recipe` : KIND_LABEL[e.promptKind])}</span><span class="badge neutral">${esc(PROMPT_CAT_LABEL[e.category.primary])}</span>${(e.models || []).map((m) => `<span class="badge neutral">Written for ${esc(MODEL_LABEL[m] || m)}</span>`).join('')}<span class="badge neutral">Public domain (CC0)</span>${e.community.featured ? '<span class="badge official">Editor pick on prompts.chat</span>' : ''}</div>
    </div>
    ${scoreChip(e)}
  </div>
  <div class="entry-grid">
    <div>
      ${(() => { const t = e.recipeFor || e.integrations.find((x) => S.some((sk) => sk.integrations.includes(x))); const sk = t ? S.find((x) => x.integrations.includes(t)) : null; return sk ? `<div class="panel"><h2>Install the skill first</h2><p style="margin:0 0 10px">This prompt works best with <a href="${url(`e/${sk.id}/`)}">${esc(sk.name)}</a> installed, so your agent knows ${esc(INTEGRATION_LABEL[t] || t)}'s best practices.</p>${(sk.install['claude-code'] || []).map((c) => `<div class="cmd"><code>${esc(c)}</code><button type="button" data-copy="${esc(c)}" aria-label="Copy command">${I.copy}<span>Copy</span></button></div>`).join('')}<p class="pin-note">Claude Code, pinned to commit <code>${esc(sk.pin.value.slice(0, 12))}</code>. Other agents: see the <a href="${url(`e/${sk.id}/`)}">skill page</a>.</p></div>` : ''; })()}
      ${form}
      <div class="panel"><h2>Prompt</h2>
        <pre class="prompt-text" id="prompt-text" data-template="${esc(e.text)}">${esc(e.text)}</pre>
        <p><button class="btn primary" type="button" id="copy-prompt" data-copy="${esc(e.text)}">${I.copy}<span>Copy prompt</span></button></p>
        ${ctxLine(e)}
      </div>
      ${e.original
        ? `<div class="panel"><h2>About this recipe</h2><p style="margin:0">Written by Plado from a working video pipeline, not collected from the web. It carries no score until people vote on it.${e.status === 'draft' ? ' <strong>Draft: not yet approved for publishing.</strong>' : ''}</p></div>`
        : `<div class="panel"><h2>Why this score</h2><div class="bars">${bars}</div>
        ${checklist ? `<h3 style="margin-top:16px">Quality checklist</h3>${checklist}` : ''}
        <p class="small muted" style="margin-top:12px">The checklist is automatic and applies the same rules to every prompt. It checks structure, not whether the output is good. Prompt scores aren't comparable with tool scores. <a href="${url('how-we-rank/')}">How we rank</a></p></div>`}
      ${securityPanel(e)}
      ${altPanel(e)}
    </div>
    <aside>
      <div class="panel"><h2>Facts</h2><dl class="facts">
        ${e.original ? '<dt>Source</dt><dd>Plado Originals</dd>' : `<dt>Source</dt><dd><a href="https://prompts.chat" rel="noopener" target="_blank">prompts.chat</a></dd>
        ${e.author ? `<dt>Author</dt><dd>@${esc(e.author)}</dd>` : ''}
        <dt>Votes</dt><dd>${e.community.votes}</dd>`}
        ${e.community.category ? `<dt>Category</dt><dd>${esc(e.community.category)}</dd>` : ''}
        <dt>License</dt><dd>CC0-1.0</dd>
        <dt>Works with</dt><dd>${e.recipeFor ? `Claude Code or another agent with the ${esc(INTEGRATION_LABEL[e.recipeFor] || e.recipeFor)} skill` : e.promptKind === 'text' ? 'Claude, ChatGPT, Gemini, Grok' : e.promptKind === 'image' ? 'Image models (e.g. Midjourney, GPT Image, Nano Banana)' : 'Video and audio models'}</dd>
      </dl></div>
      <div class="panel"><h2>Categories</h2><div class="chips">${e.jobs.map((t) => `<a class="chip link" href="${url(`prompts/${t}/`)}">${esc(PROMPT_CAT_LABEL[t])}</a>`).join('')}${e.integrations.filter((t) => integrations.some((g) => g.key === t)).map((t) => `<a class="chip link" href="${url(`integrations/${t}/`)}">${esc(INTEGRATION_LABEL[t])}</a>`).join('')}</div></div>
    </aside>
  </div>
</div>`;
  write(`e/${e.id}/index.html`, page({ title: `${e.name}: free ${KIND_LABEL[e.promptKind].toLowerCase()} | Plado`, description: clip(e.description, 155), rel: `e/${e.id}/index.html`, body,
    jsonld: { '@context': 'https://schema.org', '@type': 'CreativeWork', name: e.name, description: clip(e.description, 300), license: 'https://creativecommons.org/publicdomain/zero/1.0/' } }));
}

// rules pages
for (const e of R) {
  const cmd = e.install.cursor[0];
  const body = `<div class="wrap">
  <p class="crumbs"><a href="${url('')}">Home</a> / <a href="${url('rules/cursor/')}">Cursor rules</a> / ${esc(e.name)}</p>
  <div class="entry-head"><div><h1>${esc(e.name)}</h1><p class="muted" style="max-width:70ch">${esc(e.description)}</p>
    <div class="chips" style="gap:8px"><span class="badge neutral">Cursor rules (.mdc)</span><span class="badge neutral">Public domain (CC0)</span></div></div>${scoreChip(e)}</div>
  <div class="entry-grid"><div>
    <div class="panel"><h2>Install</h2><div class="cmd"><code>${esc(cmd)}</code><button type="button" data-copy="${esc(cmd)}" aria-label="Copy command">${I.copy}<span>Copy</span></button></div>
      <p class="pin-note">Downloads the file at commit <code>${esc(e.pin.value.slice(0, 12))}</code> into <code>.cursor/rules/</code>.</p>
      ${(uninstallFor(e, 'cursor', [cmd]) || []).map((c) => `<p class="small muted" style="margin:10px 0 6px">To remove it later:</p><div class="cmd cmd-remove"><code>${esc(c)}</code><button type="button" data-copy="${esc(c)}" aria-label="Copy remove command">${I.copy}<span>Copy</span></button></div>`).join('')}
      ${ctxLine(e)}</div>
    <div class="panel"><h2>Rules file</h2><pre class="prompt-text">${esc(e.text)}</pre><p><button class="btn" type="button" data-copy="${esc(e.text)}">${I.copy}<span>Copy file</span></button></p></div>
    ${securityPanel(e)}
  </div><aside><div class="panel"><h2>Facts</h2><dl class="facts">
    <dt>Source</dt><dd><a href="https://github.com/PatrickJS/awesome-cursorrules/blob/${esc(e.pin.value)}/${esc(e.path)}" rel="noopener nofollow" target="_blank">awesome-cursorrules</a></dd>
    <dt>License</dt><dd>CC0-1.0</dd><dt>Works with</dt><dd>Cursor</dd></dl></div></aside></div>
</div>`;
  write(`e/${e.id}/index.html`, page({ title: `${e.name} Cursor rules (.mdc) | Plado`, description: clip(`Cursor rules for ${e.name}: ${e.description}`, 155), rel: `e/${e.id}/index.html`, body }));
}

// how we rank
write('how-we-rank/index.html', page({ title: 'How Plado ranks add-ons | Plado', description: 'What goes into the Plado popularity score, what it does not measure, and why every entry shows its breakdown.', rel: 'how-we-rank/index.html', nav: 'rank', body: `<div class="wrap"><div class="prose">
  <h1>How we rank</h1>
  <p>Every entry shows its score and the parts that make it up. Nobody can pay to change a score or a position, including sponsors.</p>
  <h2>The popularity score (live now)</h2>
  <p>Out of 100, built only from public GitHub data. It tells you what is popular and maintained. It does not tell you whether an add-on works, or works better than the alternatives. Keep that in mind when you compare two entries.</p>
  <ul>
    <li><strong>Installs in real projects, 25 points.</strong> How many public GitHub projects have the add-on in their committed setup: <code>.mcp.json</code> or <code>mcp.json</code>, the files where Claude Code, Cursor and VS Code keep MCP servers. On a log scale, full marks at 1,000. We found stars barely predict this: across the top 50 of each type, star rank and install rank were close to unrelated. Private projects aren't visible, so every count is a floor. This applies to MCP servers for now. Plugins are often installed from their authors' own marketplaces under a different name, and many skills and subagents share generic names like "code-review", so a search would miss real installs or count other people's files. Until we can count those reliably, they're scored on stars alone.</li>
    <li><strong>Stars, 10 points.</strong> GitHub stars on a log scale. Where installs aren't counted yet, stars get 35 points instead.</li>
    <li><strong>Upkeep, 25 points.</strong> How recently the code changed. Full marks within 30 days, very little after a year.</li>
    <li><strong>Usage, 15 points.</strong> Forks, on a log scale.</li>
    <li><strong>License, 15 points.</strong> Whether the repo has a detectable license.</li>
    <li><strong>Owner history, 10 points.</strong> How long the owning account has existed. Brand-new accounts score lower.</li>
  </ul>
  <p>Stars belong to a repository, not to each add-on inside it. When one repo holds several add-ons, we split its stars and forks evenly between them before scoring. Otherwise a single popular monorepo would fill the top of every list.</p>
  <h2>What gets listed</h2>
  <p>An add-on is listed only if all of these are true:</p>
  <ul>
    <li>The code changed in the last 12 months.</li>
    <li>The repo has a detectable license.</li>
    <li>The owning account is older than 90 days.</li>
    <li>It has at least 5 stars after the split above. Anthropic's official marketplace is the one exception, because it curates its own entries.</li>
    <li>It isn't a test, demo or sample.</li>
  </ul>
  <p>We also show at most 10 add-ons from any one repo. Anthropic's official marketplace is exempt here too.</p>
  <h2>This build's numbers</h2>
  <p>We checked <strong>${funnel.found.toLocaleString()}</strong> add-ons and listed <strong>${E.length.toLocaleString()}</strong>. Why the rest were left out:</p>
  <ul>
    ${Object.entries(funnel.reasons).sort((a, b) => b[1] - a[1]).map(([r, n]) => `<li>${esc(r)}: ${n.toLocaleString()}</li>`).join('')}
    <li>more than 10 from the same repo: ${funnel.cappedPerRepo.toLocaleString()}</li>
    <li>listed twice by different sources (merged): ${funnel.duplicates.toLocaleString()}</li>
  </ul>
  <p>Archived repos are left out before any of this.</p>
  <h2>Not included yet</h2>
  <ul>
    <li><strong>Whether it works.</strong> The score is GitHub stats, and stars are not results. We want to run each add-on on a fixed set of tasks, first checking that a skill actually switches on for the requests it claims, then comparing results with and without it. Runs cost money, so this will start with the top add-ons in each category. Each result will be pinned to the commit we ran.</li>
    <li><strong>Fake-star check.</strong> Stars can be bought. We will discount stars from throwaway accounts and sudden spikes. Until then, treat popularity as a rough signal.</li>
    <li><strong>Real install counts.</strong> Where a registry publishes downloads, we will use them in place of forks.</li>
  </ul>
  <h2>Skills</h2>
  <p>Skills are scored the same way, with one change: a repo's stars and forks are split evenly across all the skills it contains. We find skills in the most-starred repos for skill-related GitHub searches, in Google's Gemini CLI extensions gallery, and in the official Anthropic and Vercel collections. Each is read at a pinned commit. The same gates apply, and at most 10 skills are listed from any one repo (the official collections are exempt).${funnel.skills ? ` This build read ${funnel.skills.skillFiles.toLocaleString()} skill files from ${funnel.skills.reposPassingGates.toLocaleString()} repos and listed ${S.length.toLocaleString()}.` : ''}</p>
  <h2>Prompts</h2>
  <p>Prompts come from prompts.chat, whose prompt text is public domain (CC0). Prompts don't have stars, so they get their own score out of 100:</p>
  <ul>
    <li><strong>Quality checklist, 40 points.</strong> For text prompts: sets a role, states a clear task, gives context, sets constraints, defines the output, and breaks the work into steps. For image, video and audio prompts: subject, style, lighting, camera or composition, detail, and size or parameters. Hype words cost points.</li>
    <li><strong>Community votes, 30 points.</strong> Votes on prompts.chat, on a log scale.</li>
    <li><strong>Editor pick, 15 points.</strong> Chosen by prompts.chat's editors.</li>
    <li><strong>Fill-in fields, 10 points.</strong> Prompts with blanks you fill in are easier to reuse.</li>
    <li><strong>Discussion, 5 points.</strong> Comments on prompts.chat.</li>
  </ul>
  <p>To be listed, a prompt needs at least 2 votes or an editor pick (one vote is too easy to get), and it has to pass the checklist bar: 4 of 6 checks, or 3 including a role or a task (3 of 6 for media prompts). Near-duplicates are merged, keeping the best version.${funnel.prompts ? ` This build: ${funnel.prompts.csvPrompts.toLocaleString()} prompts checked, ${funnel.prompts.belowCommunityBar.toLocaleString()} below the vote bar, ${funnel.prompts.belowQualityBar.toLocaleString()} below the quality bar, ${funnel.prompts.nearDuplicates} near-duplicates, <strong>${funnel.prompts.listed.toLocaleString()} listed</strong>.` : ''}</p>
  <p>What this doesn't do yet: test whether a prompt's output is actually good. The checklist checks structure only. Reddit isn't used, because its API needs approval for commercial use and we don't scrape around that. Coming next: how many GitHub projects reuse each prompt, and mentions on Hacker News.</p>
  <h2>How prompts are categorized</h2>
  <p>Each prompt gets one main category and at most one secondary. Image, video and audio prompts go by their type. For text prompts, the author's own category on prompts.chat comes first, mapped onto our list. Keywords only fill gaps or correct an obvious mismatch, and a clear signal in the title wins. Generic words like "prompt" or "agent" don't count. On a fresh hand-checked sample, about 4 in 5 text prompts land in the right main category. The misses are mostly prompts that honestly fit two places.</p>
  <h2>Recipes and tool pages</h2>
  <p>Some prompts are written to drive a specific tool, like a Remotion prompt that plans scenes, timing and the render. We call those recipes and score them against a different checklist: names the skill or tool, describes the deliverable, lists the content or scenes, sets the style, and says how to finish. Each tool gets one page that gathers its skills, MCP servers, plugins, prompts and recipes, plus example prompts published by the skill's own maker.</p>
  <h2>Skills from the maker without a license file</h2>
  <p>We normally only list repos with a license. The exception is skills published by a GitHub-verified organization, which is usually the tool's own maker. Those are labeled "From the maker (verified org), no license file". We link to them and give install commands, but we don't copy their content, and we only quote their example prompts briefly.</p>
  <h2>Plado Originals</h2>
  <p>Where people need a recipe and nothing good exists, we write our own, based on a working production pipeline. Originals are public domain (CC0), are labeled "Plado Original", and carry no score until people vote on them.</p>
  <h2>Subagents</h2>
  <p>Subagents are Markdown files with a name, a description and an optional list of tools, which Claude Code loads from <code>.claude/agents/</code>. We find them in GitHub repos and the well-known collections, read each file at a pinned commit, screen it for the same injection patterns as skills, and apply the same repo gates. A repo's stars are split across its agents, and we list at most 40 per repo. Every agent page shows what it can use. An agent with no tools list inherits every tool you have, including the shell, so we say so plainly.</p>
  <h2>Context cost</h2>
  <p>Every skill and subagent you add takes up part of your AI's context window, which is the space it has for your actual work. We estimate the cost at about 4 characters per token (real counts vary by model). For a skill, the name and description load in every session, and the full instructions load when it's used. For a subagent, only its name and description sit in your chat; its instructions run in its own context window. MCP servers and plugins aren't measured yet, because their cost depends on how many tools they expose.</p>
  <h2>Trending searches</h2>
  <p>When someone finishes a search on Plado (presses Enter, or opens a result), we count it. We store the search text and a code made from a one-way hash of their connection that changes every day, so one person counts once and nobody can be traced. We don't store IP addresses or set cookies. Searches that look personal (email addresses, links, long numbers) are never stored. A search appears publicly only after at least 3 different people have made it, and only if every word in it is a word from our catalog, like a tool, task or listing name. Counts are kept for 30 days.</p>
  <h2>How trending works</h2>
  <p>Trending shows stars gained today, this week, this quarter and this year. GitHub no longer publishes when each star was given, so we measure it two ways. Every day we save GitHub's own star count for every listed repo, and once those snapshots reach back far enough, a window is simply stars now minus stars then. Until then, we use the public GitHub event archive through OSS Insight. Its counts run lower than GitHub's totals, so it's a trend signal, and each window ranks on one source only, never a mix. Hot ranks by stars gained. Rising ranks by growth for the repo's size, among repos that gained a minimum number of stars. When one repo holds several listed add-ons, it appears once. For prompts, prompts.chat doesn't publish when votes were cast, so until our snapshots cover a window, trending prompts are the new ones, ranked by votes.</p>
  <h2>Cursor rules</h2>
  <p>Rules files come from the awesome-cursorrules collection (CC0). There's no fair ranking signal for them yet, so they're listed alphabetically and marked "unranked".</p>
  <h2>Screening before listing</h2>
  <p>Every skill, prompt and rules file is checked for known prompt-injection and exfiltration patterns before listing: hidden "ignore previous instructions" text, piping downloads into a shell, long encoded blobs, links to data-capture services, and reads of credential files. Anything that matches is left out.</p>
  <h2 id="security-scan">Security scan</h2>
  <p>After listing, we scan each add-on at the exact version we list: the pinned commit for skills, subagents, plugins and rules files, and the published npm or PyPI package for MCP servers. The scanner is Cisco's open-source skill-scanner (Apache-2.0), run on our own machines with its static and behavior checks. Nothing is sent to an AI model. Large repos are scanned up to their first 300 source files, and test folders are skipped because they don't run on your machine.</p>
  <p>Each page says what the code does, in plain words, with the file and line: runs shell commands, makes network requests, reads environment variables, downloads content and runs it, installs system packages, or uses unpinned dependencies. These describe how an add-on works. They aren't accusations, and plenty of good tools do all of them.</p>
  <p>When an add-on makes network requests, its page also lists the web addresses written in its code, each with the file and line where it first appears. That's the quickest answer to "where can my data go?" for a security review. It isn't complete: code can build addresses while it runs, and some hits may be links rather than calls. It also can't tell you anything about the AI model itself, which sees whatever you send it whichever add-ons you use.</p>
  <p>We don't label anything "safe". When we tested the scanner against known malicious skills, it caught about half of them, so a clean scan is not proof of anything. When a scan turns up something that looks deliberate, like hidden instructions or disguised code, a person reviews it before anything about it is published, and we contact the maintainer first. When the listed version changes, the page says "Not scanned" until we've scanned the new one. Hosted MCP servers run on the vendor's side, so there's no code for us to scan.</p>
  <h2>Where the listings come from</h2>
  <p>Anthropic's official and community Claude Code plugin marketplaces (Apache-2.0), and servers in the official MCP Registry that publish a GitHub repository. Install commands keep the commit or version those sources list.</p>
</div></div>` }));

// about
write('about/index.html', page({ title: 'About Plado and how it makes money | Plado', description: 'Who runs Plado, how it stays independent, and exactly how it makes money.', rel: 'about/index.html', body: `<div class="wrap"><div class="prose">
  <h1>About Plado</h1>
  <p>Plado is an independent directory of add-ons for AI coding tools. It exists because the good ones are scattered across marketplaces, registries and GitHub lists, and it's hard to tell which are maintained, popular, or what they actually do.</p>
  <h2>How we make money</h2>
  <p>Right now, we don't. When we do, it will be from:</p>
  <ul>
    <li><strong>Sponsors</strong> in clearly labeled spots, never inside rankings or search results.</li>
    <li><strong>Affiliate links</strong> to paid services, labeled on the link. Affiliate status never affects a score or a position.</li>
  </ul>
  <p>We won't sell a better rank, a badge, or a verdict.</p>
  <h2>Independence</h2>
  <p>Plado is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, Google, Cursor, xAI or GitHub.</p>
  <h2>Open data</h2>
  <p>The full catalog is available as <a href="${url('data/catalog.json')}">JSON</a>.</p>
</div></div>` }));

// 404
write('404.html', page({ title: 'Not found | Plado', description: 'Page not found.', rel: '404.html', body: `<div class="wrap"><div class="prose"><h1>That page isn't here.</h1><p>Try <a href="${url('browse/')}">browsing everything</a> or searching from the <a href="${url('')}">home page</a>.</p></div></div>` }));

// data + assets
write('data/index.json', JSON.stringify({ builtAt: catalog.builtAt, entries: ALL.map((e) => e.github
  ? { id: e.id, n: e.name, d: clip(e.description, 110), t: e.type, p: e.platforms, r: e.github.repo, o: PLATFORM_OWNERS.test(e.github.owner || e.github.repo.split('/')[0]) ? '' : (e.github.owner || e.github.repo.split('/')[0]), vo: e.verifiedOrg ? 1 : 0, st: e.github.stars, tw: trend.weekByRepo[e.github.repo] || 0, u: e.github.pushedAt, s: e.score?.total ?? null, i: e.integrations, j: e.jobs, f: e.use.teams, k2: e.use.tasks, ks: e.use.strong.length ? e.use.strong : undefined, x: e.use.industries, cx: e.ctx ? (e.type === 'agent' || e.ctx.always ? e.ctx.always : e.ctx.onUse) : undefined, l: !!(e.github.license && e.github.license !== 'NOASSERTION'), sc: scanOf(e)?.status === 'scanned' ? (scanOf(e).facts || []).length : undefined }
  : { id: e.id, n: e.name, d: clip(e.description, 110), t: e.type, p: e.platforms, r: e.origin, st: e.community?.votes ?? 0, v: e.type === 'prompt' ? 1 : 0, k: e.promptKind || null, u: null, s: e.score?.total ?? null, i: e.integrations, j: e.jobs, f: e.use.teams, k2: e.use.tasks, ks: e.use.strong.length ? e.use.strong : undefined, x: e.use.industries, cx: e.ctx ? (e.type === 'agent' || e.ctx.always ? e.ctx.always : e.ctx.onUse) : undefined, l: true }) }));
write('data/catalog.json', JSON.stringify(catalog));
write('data/taxonomy.json', JSON.stringify(clientTaxonomy()));
// words allowed on the public "Trending searches" list (functions/api/trending-searches.js)
{
  const words = new Set('a an the for to of in on and or with my me i want need help best good top tool tools app how make find agent agents subagent subagents skill skills mcp server servers plugin plugins prompt prompts template templates rules cursor claude code codex gemini cli grok chatgpt ai llm'.split(' '));
  const add = (t) => String(t || '').toLowerCase().split(/[^a-z0-9.+#/-]+/).filter((w) => w.length > 1 && w.length < 30).forEach((w) => words.add(w));
  const tax = clientTaxonomy();
  for (const g of [tax.teams, tax.tasks, tax.industries]) for (const x of Object.values(g)) { add(x.label); (x.q || []).forEach(add); }
  Object.values(INTEGRATION_LABEL).forEach(add); Object.values(PLATFORM).forEach(add);
  for (const e of ALL) add(e.name);
  write('data/vocab.json', JSON.stringify([...words]));
}
for (const f of ['styles.css', 'app.js']) write(`assets/${f}`, fs.readFileSync(path.join(HERE, 'assets', f)));
write('assets/favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -10 64 64"><path d="M18 3 H60 V41 H18 L3 22 Z" fill="#F2C230" stroke="#15171B" stroke-width="3" stroke-linejoin="round"/><circle cx="16" cy="22" r="4.2" fill="none" stroke="#15171B" stroke-width="3"/><path d="M28 16 H51 M28 28 H43" stroke="#15171B" stroke-width="3.4" stroke-linecap="round"/></svg>`);
// security + caching headers for Cloudflare Pages
write('_headers', `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Content-Security-Policy: default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self' https://cloudflareinsights.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
/assets/*
  Cache-Control: public, max-age=3600
/data/*
  Cache-Control: public, max-age=300
`);
write('robots.txt', `User-agent: *\nAllow: /\n${SITE_URL ? `Sitemap: ${SITE_URL}/sitemap.xml\n` : ''}`);
if (SITE_URL) {
  const pages = ['', 'browse/', 'for/', ...teamGroups.flatMap((g) => [`for/${g.key}/`, ...g.tasks.map((t) => `for/${t.key}/`)]), ...industryGroups.map((g) => `industries/${g.key}/`), ...(hasTrending ? ['trending/'] : []), 'leaderboard/', 'integrations/', 'how-we-rank/', 'about/', ...hubs.map((h) => h.key + '/'), ...integrations.map((g) => `integrations/${g.key}/`), ...skillJobs.map((g) => `skills/${g.key}/`), ...(P.length ? ['prompts/', ...promptGroups.map((g) => `prompts/${g.key}/`)] : []), ...(R.length ? ['rules/cursor/'] : []), ...ALL.map((e) => `e/${e.id}/`)];
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `<url><loc>${esc(SITE_URL + '/' + p)}</loc></url>`).join('\n')}\n</urlset>\n`);
}

console.log(`built ${E.length - S.length - A.length} plugins/MCP, ${S.length} skills, ${A.length} subagents, ${P.length} prompts, ${R.length} rules; ${hubs.length} hubs, ${integrations.length} integrations, ${skillJobs.length} skill-job pages, ${promptGroups.length} prompt groups → ${path.relative(process.cwd(), DIST)}`);
// Cloudflare Pages (free) allows 20,000 files per deploy. Fail early instead of at deploy time.
{
  let n = 0; const walkN = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walkN(path.join(d, f.name)) : n++; };
  walkN(DIST);
  if (n > 19500) { console.error(`dist has ${n} files; Cloudflare Pages allows 20,000. Trim entry pages before deploying.`); process.exit(1); }
  console.log(`${n} files in dist (Cloudflare Pages limit 20,000)`);
}
