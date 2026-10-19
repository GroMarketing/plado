#!/usr/bin/env node
// Builds site/data/skills.json, agents.json, prompts.json and rules.json.
//   node site/data/fetch-skills-prompts.mjs
// Needs `gh` logged in (read-only: the token is used for GitHub API reads only).
//
// Skills: top repos by stars from GitHub repository search (skill topics/queries) + Google's
//   Gemini CLI gallery (extensions that ship skills) + anthropics/skills + vercel-labs/agent-skills,
//   gated like plugins, then every SKILL.md in each repo read at a pinned commit.
// Prompts: prompts.chat. Prompt text from prompts.csv (CC0); votes/featured/category from
//   prompts.chat/prompts.json (robots.txt allows it; /api/ is disallowed and not used).
// Rules: awesome-cursorrules (CC0) Cursor rule files.
// No security scan runs here. Obvious injection patterns are excluded (positive-only listing).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = 'PladoBot/0.1 (catalog build)';
const TOKEN = execFileSync('gh', ['auth', 'token']).toString().trim();
const DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

// ---------- disk cache so an interrupted run resumes (gitignored) ----------
const CACHE = path.join(HERE, '.cache-skills');
fs.mkdirSync(CACHE, { recursive: true });
const ckey = (k) => path.join(CACHE, k.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180));
const cget = (k) => { try { return JSON.parse(fs.readFileSync(ckey(k), 'utf8')); } catch { return undefined; } };
const cset = (k, v) => { try { fs.writeFileSync(ckey(k), JSON.stringify(v)); } catch {} return v; };
const safeFetch = async (u, opts) => { try { return await fetch(u, opts); } catch { return null; } };

// ---------- GitHub REST with rate-limit handling ----------
async function gh(url, { raw = false, cache = false } = {}) {
  if (cache) { const hit = cget('gh-' + url); if (hit !== undefined) return hit; }
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await safeFetch(url.startsWith('http') ? url : `https://api.github.com/${url}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': UA, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!r) { await sleep(3000 * (attempt + 1)); continue; } // network error: retry
    const remaining = Number(r.headers.get('x-ratelimit-remaining'));
    const limit = Number(r.headers.get('x-ratelimit-limit')) || 5000;
    const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000;
    if (r.status === 403 || r.status === 429) {
      const wait = r.headers.get('retry-after') ? Number(r.headers.get('retry-after')) * 1000 : Math.max(5000, reset - Date.now() + 2000);
      log(`rate limited, waiting ${Math.round(wait / 1000)}s`);
      await sleep(Math.min(wait, 3600000));
      continue;
    }
    if (r.status === 404 || r.status === 409 || r.status === 451) return cache ? cset('gh-' + url, null) : null;
    if (!r.ok) { await sleep(2000 * (attempt + 1)); continue; }
    // pause only when close to THIS endpoint's limit (search = 30/min, core = 5,000/hr)
    if (remaining < Math.max(2, Math.min(50, limit * 0.1)) && reset > Date.now()) { log(`near core limit, pausing ${Math.round((reset - Date.now()) / 1000)}s`); await sleep(reset - Date.now() + 2000); }
    let body;
    try { body = raw ? await r.text() : await r.json(); } catch { await sleep(2000); continue; }
    return cache ? cset('gh-' + url, body) : body;
  }
  return null;
}
async function rawFile(repo, sha, p) {
  const k = `raw-${repo}-${sha.slice(0, 12)}-${p}`;
  const hit = cget(k); if (hit !== undefined) return hit;
  for (let i = 0; i < 4; i++) {
    const r = await safeFetch(`https://raw.githubusercontent.com/${repo}/${sha}/${p.split('/').map(encodeURIComponent).join('/')}`, { headers: { 'User-Agent': UA } });
    if (r?.ok) { try { return cset(k, await r.text()); } catch {} }
    if (r?.status === 404) return cset(k, null);
    await sleep(1500 * (i + 1));
  }
  return null;
}
// GraphQL: repo signals + default branch commit, 50 per query
function signals(repos) {
  const out = {};
  const list = [...repos];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const q = 'query{' + chunk.map((r, j) => {
      const [o, n] = r.split('/');
      return `r${j}:repository(owner:${JSON.stringify(o)},name:${JSON.stringify(n)}){nameWithOwner stargazerCount forkCount pushedAt isArchived isFork licenseInfo{spdxId} owner{login ... on User{createdAt} ... on Organization{createdAt}} primaryLanguage{name} defaultBranchRef{name target{oid}}}`;
    }).join(' ') + '}';
    let res;
    try { res = JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', `query=${q}`], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString()); }
    catch (e) { try { res = JSON.parse(e.stdout?.toString() || '{}'); } catch { res = {}; } }
    chunk.forEach((r, j) => { const v = res.data?.[`r${j}`]; if (v) out[r] = v; });
    if (i % 500 === 0) log(`signals ${Math.min(i + 50, list.length)}/${list.length}`);
  }
  return out;
}

// ---------- shared: tags + injection screen ----------
const JOBS = {
  'code-quality': /review|lint|refactor|\btest|debug|quality/i, security: /secur|vulnerab|secret|audit|owasp|pentest/i,
  data: /\bsql\b|database|\bdata\b|analytics|spreadsheet|excel/i, devops: /deploy|kubernetes|k8s|ci\/cd|infra|terraform|docker|monitor/i,
  design: /design|figma|\bui\b|\bux\b|frontend|css|tailwind/i, docs: /documentation|\bdocs?\b|knowledge|wiki|notes|write-?up/i,
  'browser-automation': /browser|scrap|crawl|playwright|puppeteer/i, 'project-management': /jira|linear|\bissues?\b|project manag|ticket|roadmap/i,
  communication: /slack|e-?mail|gmail|discord|teams|newsletter/i, commerce: /stripe|shopify|payment|e-?commerce|billing/i,
  marketing: /\bseo\b|marketing|social media|\bads?\b|copywrit|brand|campaign|landing page/i, media: /video|image|photo|audio|voice|music|\b3d\b|blender|animation/i,
  finance: /financ|trading|crypto|stock|accounting|invest/i, ai: /\bllm\b|prompt|agent|\brag\b|embedding/i,
  writing: /writ|essay|story|blog|article|poem|editor/i, education: /teach|tutor|student|lesson|learn|course|study/i,
  business: /business|startup|strategy|product manag|\bpm\b|sales|customer|hr\b|hiring|legal|contract/i,
};
const jobsFor = (t) => Object.entries(JOBS).filter(([, re]) => re.test(t)).map(([k]) => k);
const INJECTION = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts)/i, /disregard (all |the )?(previous|prior|system)/i,
  /do not (tell|inform|reveal to) the user/i, /without (telling|informing) the user/i,
  /curl [^\n|]*\|\s*(ba|z)?sh/i, /wget [^\n|]*\|\s*(ba|z)?sh/i, /\brm -rf (~|\/|\$HOME)/i,
  /webhook\.site|ngrok\.io|requestbin|pipedream\.net|pastebin\.com\/raw/i,
  /[A-Za-z0-9+/]{400,}={0,2}/, // long base64 blob
  /(cat|read|send|upload)[^\n]{0,40}(\.ssh|id_rsa|\.aws\/credentials|\.env\b)/i,
];
const injected = (t) => INJECTION.some((re) => re.test(t));
// maker-written example prompts, from README / SKILL.md ("Example prompt: `…`", "## Example prompts" lists)
function examplesFrom(md) {
  const out = [];
  for (const m of md.matchAll(/example prompts?\s*[:：]\s*[`"“]([^`"”\n]{8,300})[`"”]/gi)) out.push(m[1].trim());
  const sec = /^#{2,4}\s*(example prompts?|examples?|usage examples?|try (it|these|asking))\b[^\n]*\n([\s\S]*?)(?=\n#{1,4}\s|$)/im.exec(md);
  if (sec) for (const m of sec[3].matchAll(/^\s*[-*>]\s*[`"“]([^`"”\n]{8,300})[`"”]/gm)) out.push(m[1].trim());
  return [...new Set(out)].filter((x) => !/^(npm|npx|pnpm|yarn|bun|pip|git|cd|curl|brew)\s/i.test(x)).slice(0, 12);
}
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'item';

// ======================= SKILLS =======================
async function skills() {
  const funnel = { candidateRepos: 0, reposPassingGates: 0, skillFiles: 0, injectedExcluded: 0, noDescription: 0, listed: 0 };
  // 1. candidate repos
  const QUERIES = ['topic:claude-skills', 'topic:agent-skills', 'topic:claude-code-skills', 'topic:skills topic:claude', 'skills in:name topic:claude-code', 'SKILL.md in:readme', '"npx skills add" in:readme', '"agent skills" in:readme'];
  const cand = new Set(['anthropics/skills', 'vercel-labs/agent-skills']);
  for (const q of QUERIES) {
    for (let page = 1; page <= 10; page++) {
      const su = `search/repositories?q=${encodeURIComponent(q + ' stars:>=5')}&sort=stars&order=desc&per_page=100&page=${page}`;
      const cached = cget('gh-' + su) !== undefined;
      const d = await gh(su, { cache: true });
      if (!cached) await sleep(2200); // search API: 30 requests/min
      if (!d?.items?.length) break;
      d.items.forEach((it) => cand.add(it.full_name.toLowerCase()));
      if (d.items.length < 100) break;
    }
    log(`search "${q}" → ${cand.size} candidates so far`);
  }
  const gallery = cget('gemini-gallery') ?? cset('gemini-gallery', await (await fetch('https://geminicli.com/extensions.json', { headers: { 'User-Agent': UA } })).json());
  const geminiRepos = new Map();
  for (const x of gallery) if (x.hasSkills && x.fullName) { const r = x.fullName.toLowerCase(); cand.add(r); geminiRepos.set(r, x); }
  funnel.candidateRepos = cand.size;
  log(`${cand.size} candidate repos (${geminiRepos.size} from the Gemini gallery)`);

  // 2. repo gates
  // cache is merged per repo, so repos found by newly added searches still get their stats
  const cachedSig = cget('skills-signals') || {};
  const missing = [...cand].filter((r) => !(r in cachedSig));
  if (missing.length) log(`fetching stats for ${missing.length} repos not in cache`);
  const fresh = missing.length ? signals(missing) : {};
  for (const r of missing) cachedSig[r] = fresh[r] || null; // null = looked up, not found
  cset('skills-signals', cachedSig);
  const sig = Object.fromEntries(Object.entries(cachedSig).filter(([r, v]) => v && cand.has(r)));
  // Official-maker exception: a repo with no license file can still be listed when it's owned
  // by a GitHub-verified organization (the tool's maker, e.g. remotion-dev). We link and give
  // install commands; we don't copy its content.
  const unlicensed = Object.entries(sig).filter(([, s]) => !s.licenseInfo?.spdxId || s.licenseInfo.spdxId === 'NOASSERTION').map(([, s]) => s.owner?.login).filter(Boolean);
  const verifiedOrgs = cset('verified-orgs', (() => {
    const out = {}, owners = [...new Set(unlicensed)];
    for (let i = 0; i < owners.length; i += 50) {
      const chunk = owners.slice(i, i + 50);
      const q = 'query{' + chunk.map((o, j) => `o${j}:repositoryOwner(login:${JSON.stringify(o)}){login ... on Organization{isVerified}}`).join(' ') + '}';
      let res; try { res = JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', `query=${q}`], { maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString()); } catch (e) { try { res = JSON.parse(e.stdout?.toString() || '{}'); } catch { res = {}; } }
      chunk.forEach((o, j) => { if (res.data?.[`o${j}`]?.isVerified) out[o.toLowerCase()] = true; });
    }
    return out;
  })());
  const officialRepo = (s) => !!verifiedOrgs[s.owner?.login?.toLowerCase()];
  const pass = Object.entries(sig).filter(([, s]) => {
    if (s.isArchived || s.isFork || !s.defaultBranchRef?.target?.oid) return false;
    if ((Date.now() - Date.parse(s.pushedAt)) / DAY > 365) return false;
    if (!s.licenseInfo?.spdxId || s.licenseInfo.spdxId === 'NOASSERTION') return s.nameWithOwner === 'anthropics/skills' || (officialRepo(s) && s.stargazerCount >= 5);
    if (!s.owner?.createdAt || (Date.now() - Date.parse(s.owner.createdAt)) / DAY < 90) return false;
    return s.stargazerCount >= 5;
  });
  log(`${Object.keys(verifiedOrgs).length} verified orgs among unlicensed repo owners`);
  funnel.reposPassingGates = pass.length;
  log(`${pass.length} repos pass the gates`);

  // 3. SKILL.md files per repo (at the pinned commit), max 10 per repo except official collections
  const out = [];
  let n = 0;
  for (const [key, s] of pass) {
    n++;
    try {
    const repo = s.nameWithOwner, sha = s.defaultBranchRef.target.oid;
    const tree = await gh(`repos/${repo}/git/trees/${sha}?recursive=1`, { cache: true });
    if (!tree?.tree) continue;
    const files = tree.tree.filter((t) => t.type === 'blob');
    let paths = files.map((t) => t.path).filter((p) => /(^|\/)SKILL\.md$/i.test(p) && !/(^|\/)(node_modules|\.git|test|tests|examples?|fixtures|templates?)\//i.test(p));
    paths.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    const official = /^(anthropics\/skills|vercel-labs\/agent-skills)$/i.test(repo);
    const verified = officialRepo(s);
    const readme = files.find((f) => /^readme\.md$/i.test(f.path));
    const repoExamples = readme && paths.length ? examplesFrom((await rawFile(repo, sha, readme.path)) || '') : [];
    if (!official) paths = paths.slice(0, 10);
    funnel.skillFiles += paths.length;
    const per = paths.length;
    for (const p of paths) {
      const txt = await rawFile(repo, sha, p);
      if (!txt) continue;
      if (injected(txt)) { funnel.injectedExcluded++; continue; }
      const fm = /^---\s*\n([\s\S]*?)\n---/.exec(txt)?.[1] || '';
      const field = (k) => { const m = new RegExp(`^${k}:\\s*(?:>-?|\\|-?)?\\s*\\n?([\\s\\S]*?)(?=\\n[a-zA-Z_-]+:|$)`, 'm').exec(fm); return m ? m[1].replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim() : ''; };
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      const name = field('name') || (dir ? dir.split('/').pop() : repo.split('/')[1]);
      const description = field('description');
      if (!description) { funnel.noDescription++; continue; }
      const siblings = files.filter((f) => (dir ? f.path.startsWith(dir + '/') : !f.path.includes('/')));
      const hasScripts = siblings.some((f) => /\.(py|sh|js|mjs|ts|rb|ps1|go)$/i.test(f.path));
      const folderLicense = siblings.find((f) => /(^|\/)LICENSE(\.txt|\.md)?$/i.test(f.path));
      let license = s.licenseInfo?.spdxId && s.licenseInfo.spdxId !== 'NOASSERTION' ? s.licenseInfo.spdxId : null;
      if (folderLicense) {
        const lt = (await rawFile(repo, sha, folderLicense.path)) || '';
        license = /Apache License/i.test(lt) ? 'Apache-2.0' : /MIT License/i.test(lt) ? 'MIT' : /source-available|proprietary|all rights reserved/i.test(lt) ? 'source-available' : license;
      }
      if (!license && !verified) continue;
      const depth = dir ? dir.split('/').length : 0;
      const safeName = slug(name);
      const install = {
        'claude-code': [
          `mkdir -p .claude/skills/${safeName}`,
          dir
            ? `curl -sL https://codeload.github.com/${repo}/tar.gz/${sha} | tar -xz -C .claude/skills/${safeName} --strip-components=${depth + 1} "${repo.split('/')[1]}-${sha}/${dir}"`
            : `curl -sL https://codeload.github.com/${repo}/tar.gz/${sha} | tar -xz -C .claude/skills/${safeName} --strip-components=1`,
        ],
        'skills-cli': [`npx skills add ${repo}${dir ? ` --skill ${name}` : ''}`],
      };
      if (geminiRepos.has(key)) install['gemini-cli'] = [`gemini extensions install https://github.com/${repo} --ref=${sha}`];
      out.push({
        id: `skill-${slug(repo.replace('/', '-'))}-${safeName}`.slice(0, 110),
        name, description: description.slice(0, 600), type: 'skill',
        platforms: ['claude-code', 'skills-cli', ...(geminiRepos.has(key) ? ['gemini-cli'] : [])],
        origin: geminiRepos.has(key) ? 'Gemini CLI extensions gallery' : official ? 'Official skills collection' : 'GitHub',
        repo: repo.toLowerCase(), subpath: dir || null, pin: { kind: 'commit', value: sha },
        hasScripts, license, sourceAvailableOnly: license === 'source-available', officialNoLicense: !license && verified, verifiedOrg: verified,
        examples: [...examplesFrom(txt), ...repoExamples.filter((x) => x.toLowerCase().includes(`/${name.toLowerCase()}`) || x.toLowerCase().includes(name.toLowerCase()))].filter((x, i, a) => a.indexOf(x) === i).slice(0, 6),
        repoExamples: repoExamples.slice(0, 10),
        skillsInRepo: per, bodyChars: txt.length, // for the context-cost estimate
        github: { repo, stars: s.stargazerCount, forks: s.forkCount, pushedAt: s.pushedAt, archived: false, license, owner: s.owner.login, ownerCreatedAt: s.owner.createdAt, language: s.primaryLanguage?.name || null },
        integrations: [], jobs: jobsFor(`${name} ${description}`), install,
        scan: { status: 'not-scanned', heuristicScreen: 'passed' },
      });
    }
    } catch (err) { log(`skipped ${s.nameWithOwner}: ${err.message}`); }
    if (n % 100 === 0) log(`repos read ${n}/${pass.length}, skills so far ${out.length}`);
  }
  funnel.listed = out.length;
  return { entries: out, funnel };
}

// ======================= AGENTS / SUBAGENTS =======================
// Claude Code subagents are Markdown files with frontmatter (name, description, optional tools
// and model), kept in .claude/agents/ or ~/.claude/agents/. Found through repo search plus the
// known collections, read at the pinned commit, screened like skills.
const TOOL_GROUPS = {
  shell: /^(Bash|BashOutput|KillShell|KillBash)$/i, edit: /^(Edit|MultiEdit|Write|NotebookEdit)$/i,
  web: /^(WebFetch|WebSearch)$/i, read: /^(Read|Grep|Glob|LS|NotebookRead)$/i, mcp: /^mcp__/i, agents: /^(Task|Agent)$/i,
};
async function agents() {
  const funnel = { candidateRepos: 0, reposPassingGates: 0, agentFiles: 0, injectedExcluded: 0, noFrontmatter: 0, listed: 0 };
  const QUERIES = ['topic:claude-code-subagents', 'topic:subagents', 'topic:claude-code-agents', 'topic:claude-subagents', 'topic:claude-agents', 'subagents in:name', 'sub-agents in:name', '"subagents" in:readme topic:claude-code', '".claude/agents" in:readme'];
  const SEEDS = ['wshobson/agents', 'voltagent/awesome-claude-code-subagents', '0xfurai/claude-code-subagents', 'lst97/claude-code-sub-agents', 'iannuttall/claude-agents', 'davila7/claude-code-templates', 'vijaythecoder/awesome-claude-agents', 'contains-studio/agents'];
  const cand = new Set(SEEDS);
  for (const q of QUERIES) {
    for (let page = 1; page <= 10; page++) {
      const su = `search/repositories?q=${encodeURIComponent(q + ' stars:>=5')}&sort=stars&order=desc&per_page=100&page=${page}`;
      const cached = cget('gh-' + su) !== undefined;
      const d = await gh(su, { cache: true });
      if (!cached) await sleep(2200);
      if (!d?.items?.length) break;
      d.items.forEach((it) => cand.add(it.full_name.toLowerCase()));
      if (d.items.length < 100) break;
    }
    log(`agents search "${q}" → ${cand.size} candidates so far`);
  }
  funnel.candidateRepos = cand.size;
  const cachedSig = cget('agents-signals') || {};
  const missing = [...cand].filter((r) => !(r in cachedSig));
  const fresh = missing.length ? signals(missing) : {};
  for (const r of missing) cachedSig[r] = fresh[r] || null;
  cset('agents-signals', cachedSig);
  const verifiedOrgs = cget('verified-orgs') || {};
  const pass = Object.values(cachedSig).filter((s) => {
    if (!s || !cand.has(s.nameWithOwner.toLowerCase()) || s.isArchived || s.isFork || !s.defaultBranchRef?.target?.oid) return false;
    if ((Date.now() - Date.parse(s.pushedAt)) / DAY > 365) return false;
    if (!s.licenseInfo?.spdxId || s.licenseInfo.spdxId === 'NOASSERTION') return !!verifiedOrgs[s.owner?.login?.toLowerCase()] && s.stargazerCount >= 5;
    if (!s.owner?.createdAt || (Date.now() - Date.parse(s.owner.createdAt)) / DAY < 90) return false;
    return s.stargazerCount >= 5;
  });
  funnel.reposPassingGates = pass.length;
  log(`agents: ${pass.length} repos pass the gates`);
  const out = [];
  let n = 0;
  for (const s of pass) {
    n++;
    try {
      const repo = s.nameWithOwner, sha = s.defaultBranchRef.target.oid;
      const tree = await gh(`repos/${repo}/git/trees/${sha}?recursive=1`, { cache: true });
      if (!tree?.tree) continue;
      let paths = tree.tree.filter((t) => t.type === 'blob').map((t) => t.path)
        .filter((p) => /(^|\/)agents\/(?:[^/]+\/)?[^/]+\.md$/i.test(p) && !/(^|\/)(readme|license|contributing|changelog|index)\.md$/i.test(p) && !/(^|\/)(node_modules|\.git|test|tests|fixtures|docs?)\//i.test(p));
      paths.sort((a, b) => a.localeCompare(b));
      paths = paths.slice(0, 40); // collections can hold hundreds; 40 per repo keeps one repo from flooding
      const license = s.licenseInfo?.spdxId && s.licenseInfo.spdxId !== 'NOASSERTION' ? s.licenseInfo.spdxId : null;
      const verified = !!verifiedOrgs[s.owner?.login?.toLowerCase()];
      const found = [];
      for (const p of paths) {
        const txt = await rawFile(repo, sha, p);
        if (!txt) continue;
        const fm = /^---\s*\n([\s\S]*?)\n---/.exec(txt)?.[1];
        const field = (k) => { const m = new RegExp(`^${k}:\\s*(?:>-?|\\|-?)?\\s*\\n?([\\s\\S]*?)(?=\\n[a-zA-Z_-]+:|$)`, 'm').exec(fm || ''); return m ? m[1].replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim() : ''; };
        const name = field('name'), description = field('description');
        if (!fm || !name || !description) { funnel.noFrontmatter++; continue; }
        funnel.agentFiles++;
        if (injected(txt)) { funnel.injectedExcluded++; continue; }
        found.push({ p, txt, name, description, toolsRaw: field('tools'), model: field('model') });
      }
      for (const a of found) {
        const tools = a.toolsRaw ? a.toolsRaw.replace(/^\[|\]$/g, '').split(/[,\n]|\s-\s/).map((t) => t.replace(/^[-\s"']+|["'\s]+$/g, '')).filter(Boolean) : null;
        const can = tools ? Object.entries(TOOL_GROUPS).filter(([, re]) => tools.some((t) => re.test(t))).map(([k]) => k) : ['all'];
        const safeName = slug(a.name);
        const rawUrl = `https://raw.githubusercontent.com/${repo}/${sha}/${a.p.split('/').map(encodeURIComponent).join('/')}`;
        const body = a.txt.replace(/^---[\s\S]*?---\s*/, '');
        out.push({
          id: `agent-${slug(repo.replace('/', '-'))}-${safeName}`.slice(0, 110),
          name: a.name, description: a.description.replace(/\\n/g, ' ').slice(0, 600), type: 'agent',
          platforms: ['claude-code'], origin: 'GitHub', repo: repo.toLowerCase(), subpath: a.p, pin: { kind: 'commit', value: sha },
          tools, can, model: a.model || null, license, officialNoLicense: !license && verified, verifiedOrg: verified,
          // text is shown only when the license allows copying; otherwise we link to it
          text: license ? a.txt.slice(0, 20000) : null, bodyChars: body.length,
          agentsInRepo: found.length,
          github: { repo, stars: s.stargazerCount, forks: s.forkCount, pushedAt: s.pushedAt, archived: false, license, owner: s.owner.login, ownerCreatedAt: s.owner.createdAt, language: s.primaryLanguage?.name || null },
          integrations: [], jobs: jobsFor(`${a.name} ${a.description}`),
          install: {
            'claude-code': [`mkdir -p .claude/agents && curl -fsSL ${rawUrl} -o .claude/agents/${safeName}.md`],
            'claude-code-user': [`mkdir -p ~/.claude/agents && curl -fsSL ${rawUrl} -o ~/.claude/agents/${safeName}.md`],
          },
          scan: { status: 'not-scanned', heuristicScreen: 'passed' },
        });
      }
    } catch (err) { log(`agents: skipped ${s.nameWithOwner}: ${err.message}`); }
    if (n % 50 === 0) log(`agents: repos read ${n}/${pass.length}, agents so far ${out.length}`);
  }
  funnel.listed = out.length;
  return { entries: out, funnel };
}

// ======================= PROMPTS =======================
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [h, ...rest] = rows;
  return rest.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}
// ---------- prompt quality checklist (deterministic, same rules for every prompt) ----------
// Text prompts: what a good prompt contains. Media prompts (image/video/audio): what a good
// generation prompt specifies. Each check is worth an equal share of 40 points.
const TEXT_CHECKS = {
  role: { label: 'Sets a role', re: /"(role|persona|identity)"\s*:|\b(assume the role|you['’]?re (an?|the) [a-z]|act as|you are (an?|the)|as an? [a-z- ]{2,30}(expert|specialist|consultant|engineer|writer|assistant|coach|analyst|strategist|teacher)|your role)\b/i },
  task: { label: 'States a clear task', re: /"(task|objective|goal|instructions?)"\s*:|^[\s#*>_-]*(rewrite|write|create|generate|summari[sz]e|translate|build|design|analy[sz]e|help|review|explain|draft|plan|turn|convert|make|improve|develop|produce|compose|outline|evaluate|identify|extract|research|audit|refactor|optimi[sz]e|brainstorm)\b|\bhelp (the user|users|me) |\byou will (generate|create|write|produce|analy[sz]e|review|design|build|draft|plan|translate|summari[sz]e|evaluate|identify|develop|provide)\b|\b(your (task|job|goal|mission) is|i want you to|i need you to|please (write|create|generate|analy[sz]e|review|design|build|draft|summari[sz]e|explain)|(write|create|generate|analy[sz]e|review|design|build|draft|summari[sz]e|translate|explain|evaluate|plan) (a|an|the|my|this|these|all)\b)/i },
  context: { label: 'Gives context', re: /"(context|background|audience|input)"\s*:|\b(context|background|audience|target (audience|users?|market)|the user (is|will)|for (a|an|my) [a-z]+ (who|that|with)|situation|scenario)\b/i },
  constraints: { label: 'Sets constraints', re: /"(constraints|rules|requirements|guidelines)"\s*:|\b(must|do not|don't|avoid|never|only (use|include|return|respond)|no more than|at most|at least|maximum|minimum|limit (it|the|your)|ensure|keep it)\b/i },
  format: { label: 'Defines the output', re: /"(output|format|output_format|response_format|sections|deliverables?)"\s*:|\b(format|output|respond (with|in)|return (a|an|the|only)|structure|table|json|markdown|bullet|numbered list|sections?|headings?|template)\b/i },
  steps: { label: 'Breaks work into steps', re: /(^|\n)\s*(\d+[.)]|[-*•]|step \d|phase \d|##)|\b[1-3]\)\s|"(steps|workflow|process|phases)"\s*:|\b(first,? .{3,80}then\b)/i },
};
const MEDIA_CHECKS = {
  subject: { label: 'Describes the subject', re: /\b(a|an|the) [a-z]+/i },
  style: { label: 'Names a style', re: /\b(style|cinematic|photoreal|realistic|illustration|anime|watercolor|oil painting|3d render|minimalist|editorial|film|vintage|surreal|studio)\b/i },
  lighting: { label: 'Specifies lighting', re: /\b(light(ing)?|golden hour|backlit|soft light|shadows?|rim light|neon|natural light|sunset|moody)\b/i },
  camera: { label: 'Specifies camera or composition', re: /\b(shot|angle|lens|\d+ ?mm|close-?up|wide|framing|composition|depth of field|bokeh|aerial|portrait|macro|camera)\b/i },
  detail: { label: 'Sets quality or detail', re: /\b(detailed|high[- ]detail|8k|4k|hd|sharp|texture|resolution|intricate|ultra)\b/i },
  params: { label: 'Gives size, duration or parameters', re: /(--ar|aspect ratio|\d+:\d+|\bseconds?\b|\bfps\b|duration|--v |--style|negative prompt|resolution)/i },
};
// ---------- prompt categories: one primary + at most one secondary ----------
// Primary comes from the author's own prompts.chat category when there is one; keyword scoring
// (title weighted 3x, generic words like "prompt"/"model"/"agent" ignored) only fills gaps.
const PROMPT_CATS = {
  image: 'Image', video: 'Video', audio: 'Music & audio', coding: 'Coding', agents: 'Agents & automation',
  writing: 'Writing', marketing: 'Marketing', business: 'Business & career', education: 'Education',
  research: 'Research & data', design: 'Design', personal: 'Personal & wellbeing',
};
const CAT_MAP = [
  [/image/i, 'image'], [/video/i, 'video'], [/music|audio|podcast/i, 'audio'],
  [/web dev|vibe cod|coding|mobile dev|software|devops|programming/i, 'coding'],
  [/agent|workflow|automation/i, 'agents'],
  [/writing|creative|blog|copy|story/i, 'writing'], [/marketing|market analysis|seo|social/i, 'marketing'],
  [/business|startup|hr|recruit|finance|budget|sales|product/i, 'business'],
  [/educat|learning|exam|teach|study/i, 'education'], [/research|analysis|data/i, 'research'],
  [/design|ui|ux/i, 'design'], [/health|wellness|mindset|motivation|personal|life/i, 'personal'],
];
const CAT_WORDS = {
  coding: /\b(code|coding|developer|programming|debug|refactor|api|repository|react|python|javascript|typescript|sql|bug|frontend|backend|builder|stripe|it expert|technical|app)\b/gi,
  agents: /\b(workflow|automat\w*|pipeline|orchestrat\w*|n8n|zapier|mcp)\b/gi,
  writing: /\b(write|writing|essay|story|blog|article|poem|novel|rewrite|copywrit\w*|headline|newsletter)\b/gi,
  marketing: /\b(marketing|seo|campaign|brand|ads?|social media|instagram|linkedin|tiktok|audience|conversion|landing page)\b/gi,
  business: /\b(business|startup|strategy|investor|pitch|sales|customer|revenue|pricing|hiring|recruit\w*|resume|résumé|cv|job|jobs|career|interview|cover letter|consult\w*|finance|budget)\b/gi,
  education: /\b(teach\w*|student|lesson|learn\w*|tutor|exam|course|study|explain like|translat\w*|language)\b/gi,
  research: /\b(research|analy[sz]\w*|data|report|summari[sz]\w*|paper|sources|statistics)\b/gi,
  design: /\b(design|ui|ux|logo|typography|layout|figma|interface|wireframe)\b/gi,
  personal: /\b(health|fitness|diet|meditation|therapy|mindset|habit|motivation|relationship|travel|recipe)\b/gi,
};
function categorize(title, text, authorCat, kind) {
  if (kind !== 'text') return { primary: kind, secondary: null, source: 'kind' };
  let primary = null, source = 'keywords';
  if (authorCat) for (const [re, c] of CAT_MAP) if (re.test(authorCat)) { primary = c; source = 'author'; break; }
  const scores = {};
  for (const [c, re] of Object.entries(CAT_WORDS)) {
    const t = (title.match(re) || []).length * 3, b = (text.slice(0, 1500).match(re) || []).length;
    if (t + b) scores[c] = t + b;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  // a strong title signal (two or more keyword hits) overrides the author's category
  const titleTop = Object.entries(CAT_WORDS).map(([c, re]) => [c, (title.match(re) || []).length]).sort((a, b) => b[1] - a[1])[0];
  if (titleTop && titleTop[1] >= 2 && titleTop[0] !== primary) { primary = titleTop[0]; source = 'title'; }
  // single title hit for career/coding beats a generic author category like Marketing or Business
  else if (titleTop && titleTop[1] === 1 && ['business', 'coding'].includes(titleTop[0]) && ['marketing', 'business', 'agents'].includes(primary) && titleTop[0] !== primary) { primary = titleTop[0]; source = 'title'; }
  if (!primary) primary = ranked[0] || 'writing';
  const second = ranked.find((c) => c !== primary);
  return { primary, secondary: second && scores[second] >= 3 ? second : null, source };
}
// models (media prompts go stale when models change) and tools (for recipes + tool pages)
const MODELS = { midjourney: /midjourney|--v \d|--ar /i, 'nano-banana': /nano ?banana|gemini (2\.5 )?flash image/i, 'gpt-image': /gpt[- ]?image|dall-?e|chatgpt image/i, flux: /\bflux\b/i, 'stable-diffusion': /stable diffusion|sdxl|comfyui/i, veo: /\bveo ?\d?\b/i, sora: /\bsora\b/i, kling: /\bkling\b/i, runway: /\brunway\b/i, seedance: /seedance/i, suno: /\bsuno\b/i, udio: /\budio\b/i, grok: /\bgrok\b|aurora/i };
const TOOLS = { remotion: /\bremotion\b/i, playwright: /\bplaywright\b/i, figma: /\bfigma\b/i, blender: /\bblender\b/i, n8n: /\bn8n\b/i, supabase: /\bsupabase\b/i, excel: /\bexcel\b|spreadsheet/i, notion: /\bnotion\b/i, github: /\bgithub\b/i, 'google-sheets': /google sheets/i, wordpress: /wordpress/i, shopify: /shopify/i, tailwind: /tailwind/i, nextjs: /next\.?js/i };
const tagsIn = (t, table) => Object.entries(table).filter(([, re]) => re.test(t)).map(([k]) => k);
// recipe checklist: prompts that drive a specific tool (Remotion, Playwright, Blender…)
const RECIPE_TOOLS = new Set(['remotion', 'playwright', 'blender', 'figma', 'n8n']);
const RECIPE_CHECKS = {
  tool: { label: 'Names the skill or tool', re: /./ },
  deliverable: { label: 'Describes the deliverable', re: /\b(\d+ ?(s|sec|seconds|fps|px)|1080|1920|4k|resolution|duration|mp4|png|pdf|report|page|file|format|aspect)\b/i },
  content: { label: 'Lists the content or scenes', re: /\b(scene|slide|section|step|shot|frame|layout|component|screen|title card|intro|outro)\w*/i },
  style: { label: 'Sets the style', re: /\b(style|font|colou?r|theme|brand|animat\w*|transition|tone|palette|easing|motion)\b/i },
  finish: { label: 'Says how to finish', re: /\b(render|export|run|test|preview|deploy|save|output|publish|verify)\b/i },
};
const FILLER = /\b(ultimate|mind-?blowing|revolutionary|insane|best ever|game-?changing|100% guaranteed|secret (trick|hack))\b/i;
function quality(text, kind) {
  const checks = kind === 'recipe' ? RECIPE_CHECKS : kind === 'text' ? TEXT_CHECKS : MEDIA_CHECKS;
  const passed = Object.entries(checks).filter(([, c]) => c.re.test(text)).map(([k]) => k);
  const filler = FILLER.test(text) || (text.match(/[A-Z]{6,}/g) || []).length > 6;
  const points = Math.max(0, Math.round((passed.length / Object.keys(checks).length) * 40) - (filler ? 5 : 0));
  return { points, passed, failed: Object.keys(checks).filter((k) => !passed.includes(k)), labels: Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, c.label])), filler };
}
// near-duplicate detection: word 5-gram shingles, Jaccard similarity
const shingles = (t) => { const w = t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean); const s = new Set(); for (let i = 0; i + 5 <= w.length; i++) s.add(w.slice(i, i + 5).join(' ')); return s; };
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

async function prompts() {
  const funnel = { csvPrompts: 0, matchedToCommunityData: 0, nonEnglishSkipped: 0, injectedExcluded: 0, tooShortOrLong: 0, belowCommunityBar: 0, belowQualityBar: 0, nearDuplicates: 0, listed: 0 };
  const csv = parseCSV(await (await fetch('https://raw.githubusercontent.com/f/prompts.chat/main/prompts.csv', { headers: { 'User-Agent': UA } })).text());
  const meta = (await (await fetch('https://prompts.chat/prompts.json', { headers: { 'User-Agent': UA } })).json()).prompts;
  funnel.csvPrompts = csv.length;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const byTitle = new Map(meta.map((m) => [norm(m.title), m]));
  const out = [];
  const seen = new Set();
  const rejected = []; // notable rejections (≥4 votes or editor pick), for auditing the bar
  const note = (title, m, reason, extra = {}) => { if ((m?.voteCount || 0) >= 4 || m?.isFeatured) rejected.push({ title, votes: m?.voteCount || 0, featured: !!m?.isFeatured, reason, ...extra }); };
  for (const r of csv) {
    const text = (r.prompt || '').trim(), title = (r.act || '').trim();
    if (!text || !title) continue;
    const letters = (text.match(/\p{L}/gu) || []).length, ascii = (text.match(/[A-Za-z]/g) || []).length;
    const m = byTitle.get(norm(title));
    if (!letters || ascii / letters < 0.9) { funnel.nonEnglishSkipped++; note(title, m, 'not English'); continue; }
    if (text.length < 80 || text.length > 12000) { funnel.tooShortOrLong++; note(title, m, `length ${text.length}`); continue; }
    if (injected(text)) { funnel.injectedExcluded++; note(title, m, 'injection pattern'); continue; }
    if (m) funnel.matchedToCommunityData++;
    const votes = m?.voteCount || 0, featured = !!m?.isFeatured, comments = m?.commentCount || 0;
    // community bar: at least 2 votes, or an editor pick (1 vote is too easy to get)
    if (votes < 2 && !featured) { funnel.belowCommunityBar++; continue; }
    const vars = [...new Set([...text.matchAll(/\$\{([^}:]+)(?::([^}]*))?\}/g)].map((x) => JSON.stringify({ name: x[1].trim(), def: (x[2] || '').trim() })))].map((x) => JSON.parse(x));
    const kind = { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' }[m?.type || r.type] || 'text';
    const tools = tagsIn(`${title} ${text.slice(0, 3000)}`, TOOLS);
    const recipeFor = tools.find((t) => RECIPE_TOOLS.has(t)) || null;
    const q = quality(text, recipeFor ? 'recipe' : kind);
    // quality bar: text prompts pass 4 of 6 checks, or 3 including a role or task;
    // media prompts pass at least 3 of 6
    const okText = q.passed.length >= 4 || (q.passed.length >= 3 && (q.passed.includes('task') || q.passed.includes('role')));
    if (recipeFor ? q.passed.length < 3 : kind === 'text' ? !okText : q.passed.length < 3) { funnel.belowQualityBar++; note(title, m, 'quality bar', { kind, passed: q.passed }); continue; }
    const parts = {
      votes: Math.round(Math.min(1, Math.log10(1 + votes) / Math.log10(22)) * 30),
      featured: featured ? 15 : 0,
      discussion: Math.round(Math.min(1, comments / 5) * 5),
      quality: q.points,
      reusable: vars.length ? 10 : 0,
    };
    let id = `prompt-${slug(title)}`; while (seen.has(id)) id += '-2'; seen.add(id);
    out.push({
      id, name: title, description: (m?.description || text).replace(/\s+/g, ' ').slice(0, 300), type: 'prompt', promptKind: kind,
      text, variables: vars, forDevs: r.for_devs === 'TRUE',
      platforms: ['any-llm'], origin: 'prompts.chat', license: 'CC0-1.0', author: r.contributor || m?.author?.username || null,
      community: { votes, featured, comments, category: m?.category?.name || null, tags: (m?.tags || []).map((t) => t.name) },
      category: categorize(title, text, m?.category?.name, kind),
      models: kind === 'text' ? [] : tagsIn(`${title} ${text}`, MODELS), tools, recipeFor,
      integrations: [], jobs: [],
      score: { total: Object.values(parts).reduce((a, b) => a + b, 0), parts },
      quality: q,
      scan: { status: 'not-scanned', heuristicScreen: 'passed' },
    });
  }
  // drop near-duplicates (≥0.6 Jaccard on 5-word shingles), keeping the higher score
  out.sort((a, b) => b.score.total - a.score.total);
  const kept = [];
  for (const e of out) {
    const sh = shingles(e.text);
    const dup = kept.find((k) => k.promptKind === e.promptKind && jaccard(k._sh, sh) >= 0.6);
    if (dup) { funnel.nearDuplicates++; (dup.similar ||= []).push(e.name); continue; }
    e._sh = sh; kept.push(e);
  }
  kept.forEach((e) => delete e._sh);
  funnel.listed = kept.length;
  return { entries: kept, funnel, rejected: rejected.sort((a, b) => b.votes - a.votes) };
}

// ======================= RULES (Cursor, CC0) =======================
async function rules() {
  const tree = await gh('repos/PatrickJS/awesome-cursorrules/git/trees/main?recursive=1');
  const sig = signals(['patrickjs/awesome-cursorrules'])['patrickjs/awesome-cursorrules'];
  const sha = sig?.defaultBranchRef?.target?.oid || 'main';
  const files = (tree?.tree || []).filter((t) => t.type === 'blob' && /^rules\/[^/]+\.mdc$/.test(t.path));
  const out = []; let injectedCount = 0;
  for (const f of files) {
    const txt = await rawFile('PatrickJS/awesome-cursorrules', sha, f.path);
    if (!txt || txt.length < 200) continue;
    if (injected(txt)) { injectedCount++; continue; }
    const fm = /^---\s*\n([\s\S]*?)\n---/.exec(txt)?.[1] || '';
    const desc = /^description:\s*(.+)$/m.exec(fm)?.[1]?.replace(/^["']|["']$/g, '').trim() || '';
    const base = f.path.replace(/^rules\//, '').replace(/\.mdc$/, '').replace(/-cursorrules-prompt-file$/, '');
    const name = base.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const body = txt.replace(/^---[\s\S]*?---\s*/, '');
    out.push({
      id: `rules-cursor-${slug(base)}`, name, description: (desc || body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || name).slice(0, 300),
      type: 'rules', rulesFor: 'cursor', text: txt.slice(0, 20000), platforms: ['cursor'], origin: 'awesome-cursorrules', license: 'CC0-1.0',
      repo: 'patrickjs/awesome-cursorrules', path: f.path, pin: { kind: 'commit', value: sha },
      install: { cursor: [`mkdir -p .cursor/rules && curl -sL https://raw.githubusercontent.com/PatrickJS/awesome-cursorrules/${sha}/${f.path} -o .cursor/rules/${slug(base)}.mdc`] },
      integrations: [], jobs: jobsFor(`${name} ${desc}`), score: null,
      scan: { status: 'not-scanned', heuristicScreen: 'passed' },
    });
  }
  return { entries: out, funnel: { files: files.length, injectedExcluded: injectedCount, listed: out.length } };
}

// ---------- run ----------
const which = process.argv[2] || 'all';
const save = (name, obj) => { fs.writeFileSync(path.join(HERE, name), JSON.stringify({ builtAt: new Date().toISOString(), ...obj })); log(`wrote ${name}: ${obj.entries.length} entries`, JSON.stringify(obj.funnel)); };
if (which === 'all' || which === 'prompts') save('prompts.json', await prompts());
if (which === 'all' || which === 'rules') save('rules.json', await rules());
if (which === 'all' || which === 'skills') save('skills.json', await skills());
if (which === 'all' || which === 'agents') save('agents.json', await agents());
