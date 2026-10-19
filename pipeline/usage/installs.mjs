#!/usr/bin/env node
// Installs in real projects: how many public GitHub repos have an add-on in their committed setup
// (.mcp.json / mcp.json, .claude/settings.json enabledPlugins, .claude/skills, .claude/agents).
// Free (GitHub code search, 10 queries/min), no model, no tokens. Answers "stars aren't results"
// with what people actually keep in their projects; weekly snapshots give retention later.
//   node pipeline/usage/installs.mjs [--limit N] [--types skill,agent,...]
// Output: site/data/installs.json (latest) + site/data/history/installs-YYYY-MM-DD.json (snapshot).
// Counts are approximate: GitHub indexes default branches only, skips forks, and counts each file.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, '..', '..', 'site');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const LIMIT = Number(arg('--limit', 0)), TYPES = arg('--types', 'mcp-server,plugin,skill,agent').split(',');
const TODAY = new Date().toISOString().slice(0, 10);

const load = (f) => { try { return JSON.parse(fs.readFileSync(path.join(SITE, 'data', f), 'utf8')).entries; } catch { return []; } };
const index = JSON.parse(fs.readFileSync(path.join(SITE, 'dist', 'data', 'index.json'), 'utf8')).entries;
const src = new Map(['catalog.json', 'skills.json', 'agents.json'].flatMap(load).map((e) => [e.id, e]));
const listed = index.filter((x) => TYPES.includes(x.t) && src.has(x.id)).sort((a, b) => (b.s ?? 0) - (a.s ?? 0));

// A skill or subagent is found by its name, so only names that point at one listed add-on count.
// A name shared by two listed add-ons, or a very short one, would count other people's files.
// the name people's files carry: a subagent is installed under its file name, which can differ from our display name
const fileName = (e) => (e.type === 'agent' && e.subpath ? path.basename(e.subpath, '.md') : e.name);
const nameCount = {};
for (const x of listed) if (x.t === 'skill' || x.t === 'agent') { const k = `${x.t}:${fileName(src.get(x.id)).toLowerCase()}`; nameCount[k] = (nameCount[k] || 0) + 1; }
const distinct = (e) => nameCount[`${e.type}:${fileName(e).toLowerCase()}`] === 1 && fileName(e).length >= 8 && /[-_]/.test(fileName(e));

function queryFor(e) {
  const cmds = Object.values(e.install || {}).flat().join('\n');
  if (e.type === 'mcp-server') {
    // hosted: match the host, since configs spell the path differently; template URLs can't be searched
    const host = cmds.match(/https?:\/\/([^\s"'/]+)/)?.[1];
    if (e.hosted) return host && !/[{}<>$]/.test(host) && host.includes('.') ? `filename:mcp.json "${host}"` : null;
    const pkg = cmds.match(/npx\s+(?:-y\s+|--yes\s+)*(@?[\w.-]+(?:\/[\w.-]+)?)@\d/)?.[1] || cmds.match(/(?:uvx|pipx run)\s+(?:--from\s+)?([A-Za-z0-9_.-]+)==/)?.[1];
    return pkg && pkg.length >= 6 ? `filename:mcp.json "${pkg}"` : null;
  }
  if (e.type === 'plugin') {
    const id = cmds.match(/\/plugin install (\S+@\S+)/)?.[1];
    return id ? `filename:settings.json path:.claude "${id}"` : null;
  }
  if (e.type === 'skill') return distinct(e) ? `path:.claude/skills filename:SKILL.md "name: ${e.name}"` : null;
  if (e.type === 'agent') return distinct(e) ? `path:.claude/agents filename:${fileName(e)}.md` : null;
  return null;
}

async function count(q) {
  for (let i = 0; i < 6; i++) {
    try {
      const { stdout } = await run('gh', ['api', '-X', 'GET', 'search/code', '-f', `q=${q}`, '-f', 'per_page=1', '--jq', '.total_count']);
      return Number(stdout.trim());
    } catch (err) {
      const msg = String(err.stderr || err.message);
      if (/rate limit|secondary|403|429/i.test(msg)) { console.log(`rate limited, waiting 2 min (${q.slice(0, 60)})`); await sleep(120000); continue; } // GitHub's secondary limit trips well before the 10/min quota
      if (/422/.test(msg)) return null; // query GitHub won't run
      await sleep(5000 * (i + 1));
    }
  }
  return null;
}

const outFile = path.join(SITE, 'data', 'installs.json');
const prev = (() => { try { return JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { return { entries: {} }; } })();
const entries = prev.entries || {};
const work = listed.map((x) => ({ x, e: src.get(x.id) })).map((w) => ({ ...w, q: queryFor(w.e) }))
  .filter((w) => w.q && entries[w.x.id]?.at !== TODAY);
const todo = LIMIT ? work.slice(0, LIMIT) : work;
console.log(`${listed.length} listed · ${listed.filter((x) => queryFor(src.get(x.id))).length} measurable · ${todo.length} to query (~${Math.ceil((todo.length * 10) / 60)} min)`);

const save = () => {
  const out = { generatedAt: new Date().toISOString(), source: 'GitHub code search, public default branches', entries };
  fs.writeFileSync(outFile, JSON.stringify(out));
  fs.mkdirSync(path.join(SITE, 'data', 'history'), { recursive: true });
  fs.writeFileSync(path.join(SITE, 'data', 'history', `installs-${TODAY}.json`), JSON.stringify(out));
};
let done = 0;
for (const { x, q } of todo) {
  const n = await count(q);
  if (n != null) entries[x.id] = { n, q, at: TODAY };
  if (++done % 25 === 0) { save(); console.log(`${done}/${todo.length}`); }
  await sleep(10000); // 10/min is the quota, but back-to-back calls trip the secondary limit; 6/min holds
}
save();
console.log(`done: ${Object.keys(entries).length} add-ons measured`);
