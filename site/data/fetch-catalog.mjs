#!/usr/bin/env node
// Builds site/data/catalog.json from public sources:
//   - Anthropic's Claude Code plugin marketplaces (official + community, Apache-2.0)
//   - the official MCP Registry (servers that publish a GitHub repo)
// then enriches every GitHub repo with live signals via the GitHub GraphQL API.
//
//   node site/data/fetch-catalog.mjs
// Needs `gh` logged in (read-only use). No scanning happens here: every entry is
// marked scan: "not-scanned" until the security pipeline exists.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'catalog.json');
const MARKETPLACES = [
  { repo: 'anthropics/claude-plugins-official', tier: 'official' },
  { repo: 'anthropics/claude-plugins-community', tier: 'community' },
];

const getJSON = async (url) => {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': 'PladoBot/0.1 (catalog build)' } });
    if (r.ok) return r.json();
    await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
  }
  throw new Error(`GET failed: ${url}`);
};

const ghRepo = (url) => {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(url || '');
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// ---------- 1. Claude Code plugins ----------
async function plugins() {
  const out = [];
  for (const m of MARKETPLACES) {
    const d = await getJSON(`https://raw.githubusercontent.com/${m.repo}/main/.claude-plugin/marketplace.json`);
    for (const p of d.plugins || []) {
      const src = p.source;
      let repo = null, pin = null, subpath = null;
      if (typeof src === 'object') {
        repo = ghRepo(src.url || (src.repo ? `https://github.com/${src.repo}` : ''));
        pin = src.sha || src.ref || null;
        subpath = src.path || null;
      } else {
        repo = m.repo; subpath = src; // plugin lives inside the marketplace repo itself
      }
      repo = repo || ghRepo(p.homepage || p.repository || '');
      out.push({
        id: `cc-${slug(p.name)}${m.tier === 'community' ? '' : '-official'}`,
        name: p.name,
        description: (p.description || '').trim(),
        type: 'plugin',
        platforms: ['claude-code'],
        origin: m.tier === 'official' ? 'Anthropic official marketplace' : 'Anthropic community marketplace',
        vendorCategory: p.category || null,
        author: p.author?.name || null,
        repo, subpath,
        pin: pin ? { kind: /^[0-9a-f]{40}$/.test(pin) ? 'commit' : 'ref', value: pin } : null,
        install: {
          'claude-code': [
            `/plugin marketplace add ${m.repo}`,
            `/plugin install ${p.name}@${d.name}`,
          ],
        },
      });
    }
  }
  return out;
}

// ---------- 2. MCP servers from the official registry ----------
async function mcpServers() {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const u = new URL('https://registry.modelcontextprotocol.io/v0/servers');
    u.searchParams.set('limit', '100');
    u.searchParams.set('version', 'latest');
    if (cursor) u.searchParams.set('cursor', cursor);
    let d;
    try { d = await getJSON(u.toString()); } catch (e) { console.error(`registry stopped at page ${page}: ${e.message}`); break; }
    for (const { server: s, _meta } of d.servers || []) {
      const status = _meta?.['io.modelcontextprotocol.registry/official']?.status;
      if (status && status !== 'active') continue;
      const repo = ghRepo(s.repository?.url);
      if (!repo) continue; // v1: we only list what we can evaluate from source
      const pkg = (s.packages || []).find((p) => ['npm', 'pypi'].includes(p.registryType || p.registry_type));
      const remote = (s.remotes || [])[0];
      const install = {};
      const short = slug(s.title || s.name.split('/').pop());
      if (pkg) {
        const type = pkg.registryType || pkg.registry_type;
        const id = pkg.identifier || pkg.name;
        const ver = pkg.version || s.version;
        const run = type === 'npm' ? `npx -y ${id}@${ver}` : `uvx ${id}==${ver}`;
        install['claude-code'] = [`claude mcp add ${short} -- ${run}`];
        install['codex'] = [`codex mcp add ${short} -- ${run}`];
        install['any-mcp-client'] = [run];
      } else if (remote?.url) {
        install['claude-code'] = [`claude mcp add --transport http ${short} ${remote.url}`];
        install['any-mcp-client'] = [`Remote server: ${remote.url}`];
      }
      if (!Object.keys(install).length) continue;
      out.push({
        id: `mcp-${slug(s.name)}`,
        name: s.title || s.name.split('/').pop(),
        registryName: s.name,
        description: (s.description || '').trim(),
        type: 'mcp-server',
        platforms: Object.keys(install).includes('codex') ? ['claude-code', 'codex', 'cursor', 'gemini-cli'] : ['claude-code', 'cursor'],
        origin: 'Official MCP Registry',
        vendorCategory: null,
        author: null,
        repo, subpath: s.repository?.subfolder || null,
        pin: pkg ? { kind: 'version', value: pkg.version || s.version } : null,
        hosted: !pkg && !!remote,
        install,
      });
    }
    cursor = d.metadata?.nextCursor;
    if (!cursor) break;
  }
  // one entry per registry name
  return [...new Map(out.map((e) => [e.id, e])).values()];
}

// ---------- 3. GitHub signals (GraphQL, 50 repos per query) ----------
function github(repos) {
  const signals = {};
  const list = [...repos];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const q = 'query{' + chunk.map((r, j) => {
      const [o, n] = r.split('/');
      return `r${j}:repository(owner:${JSON.stringify(o)},name:${JSON.stringify(n)}){nameWithOwner stargazerCount forkCount pushedAt isArchived isFork description licenseInfo{spdxId} owner{login ... on User{createdAt} ... on Organization{createdAt}} primaryLanguage{name} repositoryTopics(first:10){nodes{topic{name}}}}`;
    }).join(' ') + '}';
    let res;
    try {
      res = JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', `query=${q}`], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    } catch (e) {
      // partial errors (renamed/deleted repos) still return data on stdout
      try { res = JSON.parse(e.stdout?.toString() || '{}'); } catch { res = {}; }
    }
    chunk.forEach((r, j) => { const v = res.data?.[`r${j}`]; if (v) signals[r] = v; });
    process.stderr.write(`github ${Math.min(i + 50, list.length)}/${list.length}\r`);
  }
  process.stderr.write('\n');
  return signals;
}

// ---------- 4. Tags: integrations + jobs ----------
const INTEGRATIONS = {
  playwright: /playwright/i, figma: /figma/i, github: /\bgithub\b[^.]{0,60}\b(issues?|pull requests?|prs?|actions|repos?|repositor(y|ies)|gists?|projects?|discussions?|releases?|workflows?)\b|\b(issues?|pull requests?|actions|workflows?|repositor(y|ies))\b[^.]{0,40}\bgithub\b|^github\b|\bgithub[- ]?mcp\b/i, slack: /\bslack\b/i, notion: /\bnotion\b/i,
  supabase: /supabase/i, jira: /\bjira\b|atlassian/i, linear: /\blinear\b(?!ly)/i, blender: /blender/i,
  obsidian: /obsidian/i, salesforce: /salesforce/i, n8n: /\bn8n\b/i, aws: /\baws\b|amazon web services/i,
  postgres: /postgres|postgresql/i, 'google-drive': /google drive|gdrive/i, stripe: /\bstripe\b/i,
  vercel: /\bvercel\b/i, shopify: /shopify/i, hubspot: /hubspot/i, docker: /\bdocker\b/i,
  sentry: /\bsentry\b/i, gitlab: /gitlab/i, confluence: /confluence/i, mongodb: /mongo/i, redis: /\bredis\b/i,
};
const JOBS = {
  'code-quality': /review|lint|refactor|test|debug|quality/i, security: /secur|vulnerab|secret|audit|owasp/i,
  data: /\bsql\b|database|data|analytics|query|warehouse/i, devops: /deploy|kubernetes|k8s|ci\/cd|infra|cloud|terraform|monitor|observab/i,
  design: /design|figma|\bui\b|ux|frontend/i, docs: /documentation|docs|knowledge|wiki|notes/i,
  'browser-automation': /browser|scrap|crawl|playwright|puppeteer/i, 'project-management': /jira|linear|issue|project|task|ticket/i,
  communication: /slack|email|gmail|discord|teams/i, commerce: /stripe|shopify|payment|commerce|billing/i,
  marketing: /seo|marketing|social|ads\b|content/i, media: /video|image|audio|voice|music|3d|blender/i,
  finance: /financ|trading|crypto|stock|accounting/i, ai: /\bllm\b|model|agent|rag|embedding|prompt/i,
};
const tagsFor = (text, table) => Object.entries(table).filter(([, re]) => re.test(text)).map(([k]) => k);

// ---------- 5. Preview score (NO security scan, NO fake-star check yet) ----------
const DAY = 86400000;
function previewScore(s) {
  if (!s) return null;
  const stars = Math.min(1, Math.log10(1 + s.stargazerCount) / 4.5);            // ~30k stars → 1
  const days = (Date.now() - Date.parse(s.pushedAt)) / DAY;
  const fresh = days < 30 ? 1 : days < 90 ? 0.8 : days < 180 ? 0.6 : days < 365 ? 0.35 : 0.1;
  const forks = Math.min(1, Math.log10(1 + s.forkCount) / 3.5);
  const license = s.licenseInfo?.spdxId && s.licenseInfo.spdxId !== 'NOASSERTION' ? 1 : 0.3;
  const ownerAge = s.owner?.createdAt ? (Date.now() - Date.parse(s.owner.createdAt)) / DAY : 0;
  const owner = ownerAge > 365 ? 1 : ownerAge > 90 ? 0.6 : 0.2;
  const parts = {
    popularity: Math.round(stars * 35),
    usage: Math.round(forks * 15),
    maintenance: Math.round(fresh * 25),
    license: Math.round(license * 15),
    owner: Math.round(owner * 10),
  };
  const total = s.isArchived ? Math.round(Object.values(parts).reduce((a, b) => a + b, 0) * 0.4) : Object.values(parts).reduce((a, b) => a + b, 0);
  return { total, parts };
}

// ---------- run ----------
const [pl, mcp] = await Promise.all([plugins(), mcpServers()]);
console.error(`plugins ${pl.length}, mcp servers ${mcp.length}`);
const all = [...pl, ...mcp];
const repos = new Set(all.map((e) => e.repo).filter(Boolean));
const sig = github(repos);

const entries = all.map((e) => {
  const s = e.repo ? sig[e.repo] : null;
  const text = `${e.name} ${e.description} ${e.registryName || ''} ${(s?.repositoryTopics?.nodes || []).map((n) => n.topic.name).join(' ')}`;
  return {
    ...e,
    github: s ? {
      repo: s.nameWithOwner, stars: s.stargazerCount, forks: s.forkCount, pushedAt: s.pushedAt,
      archived: s.isArchived, license: s.licenseInfo?.spdxId || null, owner: s.owner?.login,
      ownerCreatedAt: s.owner?.createdAt || null, language: s.primaryLanguage?.name || null,
    } : null,
    integrations: tagsFor(text, INTEGRATIONS),
    jobs: tagsFor(text, JOBS),
    score: previewScore(s),
    scan: { status: 'not-scanned' },
  };
}).filter((e) => e.github && !e.github.archived && e.description);

// ids must be unique across sources
const seen = new Map();
for (const e of entries) { const n = (seen.get(e.id) || 0) + 1; seen.set(e.id, n); if (n > 1) e.id += `-${n}`; }
entries.sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));

fs.writeFileSync(OUT, JSON.stringify({
  builtAt: new Date().toISOString(),
  sources: MARKETPLACES.map((m) => m.repo).concat('registry.modelcontextprotocol.io'),
  note: 'Preview data. Scores use popularity, usage, maintenance, license and owner-age signals only. No security scan and no fake-star check has been run on any entry.',
  count: entries.length,
  entries,
}));
console.error(`wrote ${entries.length} entries → ${path.relative(process.cwd(), OUT)}`);
