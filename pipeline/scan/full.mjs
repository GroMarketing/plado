#!/usr/bin/env node
// Full scan: every listed add-on, at the exact commit or package version we list, with Cisco
// skill-scanner (static + behavioral analyzers, offline, no LLM, no API keys: zero tokens).
//   node pipeline/scan/full.mjs [--jobs 12] [--limit N] [--minutes N] [--only skill,agent,...]
//   --minutes N: start no new scans after N minutes; what is left stays pending for the next run
//   node pipeline/scan/full.mjs --report     # rewrite the outputs from the cache, scan nothing
//   node pipeline/scan/full.mjs --hosts      # add web addresses to cached scans that predate them (downloads, no scanner)
// Cache: pipeline/scan/cache/ (one file per commit/version), so reruns only scan what changed.
// Output:
//   site/data/scan.json               public: plain facts about what the code does
//   research/private/scan-review.json private: patterns that look malicious. Never published until a
//                                     person has reviewed them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SITE = path.join(ROOT, 'site');
const CACHE = path.join(HERE, 'cache');
const TMP = path.join(HERE, 'work', `full-${process.pid}`); // per run, so two runs never delete each other's files
const BIN = path.join(HERE, '.venv', 'bin', 'skill-scanner');
const UA = 'PladoBot/0.1 (+https://plado.pages.dev)';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const REPORT_ONLY = process.argv.includes('--report');
const HOSTS_ONLY = process.argv.includes('--hosts');
const JOBS = Number(arg('--jobs', 12)), LIMIT = Number(arg('--limit', 0)), MINUTES = Number(arg('--minutes', 0)), ONLY = arg('--only', '')?.split(',').filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);
const MAX_FILES = 300, MAX_BYTES = 512 * 1024;
const SKIP_DIR = /(^|\/)(node_modules|\.git|vendor|dist|build|\.venv|__pycache__|\.next|coverage)\//;
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|woff2?|ttf|otf|eot|mp[34]|mov|wav|ogg|webm|m4a|avi|psd|ai|sketch|fig|exe|dll|so|dylib|bin|class|pyc|o|a|wasm|db|sqlite|parquet|pkl|pt|onnx|h5|npy|lock)$/i;

// ---------- what the findings mean, in plain words ----------
// Public facts describe design. REVIEW patterns suggest intent and stay private.
const FACTS = [
  ['envnet', 'Reads environment variables and makes network requests with them (API clients do this with keys)', ['BEHAVIOR_ENV_VAR_EXFILTRATION', 'BEHAVIOR_CROSSFILE_ENV_VAR_EXFILTRATION', 'BEHAVIOR_CROSSFILE_EXFILTRATION_CHAIN', 'CORRELATED_SENSITIVE_NETWORK_FLOW']],
  ['shell', 'Runs shell commands', ['FIND_EXEC_PATTERN', 'COMMAND_INJECTION_JS_CHILD_PROCESS', 'COMMAND_INJECTION_SHELL_TRUE', 'MDBLOCK_PYTHON_SUBPROCESS', 'MDBLOCK_BASH', 'COMPOUND_FIND_EXEC', 'ACTIVE_DYNAMIC_EXECUTION', 'PIPELINE_TAINT_FLOW', 'BEHAVIOR_BASH_TAINT_FLOW', 'COMMAND_INJECTION_OS_SYSTEM', 'COMMAND_INJECTION_SUBPROCESS']],
  ['eval', 'Runs code it builds while running (eval or exec)', ['COMMAND_INJECTION_EVAL', 'BEHAVIOR_EVAL_SUBPROCESS', 'COMMAND_INJECTION_EXEC', 'COMMAND_INJECTION_JS_FUNCTION_CONSTRUCTOR']],
  ['network', 'Makes network requests', ['DATA_EXFIL_NETWORK_REQUESTS', 'TOOL_ABUSE_UNDECLARED_NETWORK', 'ALLOWED_TOOLS_NETWORK_USAGE', 'MDBLOCK_PYTHON_HTTP', 'MDBLOCK_CURL', 'MDBLOCK_WGET']],
  ['env', 'Reads environment variables, where API keys usually live', ['DATA_EXFIL_ENV_VARS', 'BEHAVIOR_ENV_VAR_ACCESS']],
  ['install', 'Installs system packages', ['TOOL_ABUSE_SYSTEM_PACKAGE_INSTALL']],
  ['deps', 'Uses dependencies without a pinned version', ['SUPPLY_CHAIN_UNPINNED_DEPENDENCY']],
  ['writes', 'Writes files', ['ALLOWED_TOOLS_WRITE_VIOLATION']],
  ['hidden', 'Includes scripts in hidden folders', ['HIDDEN_EXECUTABLE_SCRIPT', 'CORRELATED_HIDDEN_EXECUTABLE']],
  ['remote', 'Downloads content and runs it', ['CORRELATED_NETWORK_EXECUTION', 'ACTIVE_REMOTE_ACQUIRE_EXECUTE']],
];
const REVIEW_RULES = ['CORRELATED_OBFUSCATION', 'ACTIVE_SENSITIVE_EXFILTRATION', 'SECRET_', 'ACTIVE_REMOTE_ACQUIRE_EXECUTE', 'ACTIVE_OS_PERSISTENCE', 'ASCII_SMUGGLING', 'PROMPT_INJECTION', 'YARA_prompt_injection', 'OBFUSCATION_', 'YARA_SUSP_', 'CREDENTIAL', 'BACKDOOR'];
const REVIEW_CATS = new Set(['malware', 'prompt_injection', 'unicode_steganography', 'obfuscation']);
const NOT_REVIEW = ['FILE_MAGIC_MISMATCH', 'HIDDEN_DATA_FILE', 'OBFUSCATION_XOR_ENCODING', 'YARA_script_injection_generic', 'SECRET_PASSWORD_VAR', 'SECRET_CONNECTION_STRING'];
// tests exercise dangerous things on purpose and never run on the user's machine
const TESTISH = /(^|\/)(\.github|tests?|__tests__|spec|e2e|fixtures?|mocks?|examples?)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/i;
const SEV = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
function classify(findings, stub, dir, root = dir) {
  const facts = {}, review = [];
  // the scanner mixes absolute paths and paths relative to the scan folder; show them relative to the package
  const rel = (p) => { if (!p) return null; const abs = path.isAbsolute(p) ? p : path.join(dir, p); const r = path.relative(root, abs); return r.startsWith('..') ? path.relative(dir, abs) : r; };
  for (const f of findings) {
    const rule = String(f.rule_id || '');
    if (stub && f.file_path && path.relative(dir, path.isAbsolute(f.file_path) ? f.file_path : path.join(dir, f.file_path)) === 'SKILL.md') continue; // our own stub manifest, not their code
    const file = rel(f.file_path);
    if (file && TESTISH.test(file)) continue;
    const where = file ? { f: file, l: f.line_number || null } : null;
    const fact = FACTS.find(([, , rules]) => rules.some((r) => rule.startsWith(r)));
    const isReview = !NOT_REVIEW.some((r) => rule.startsWith(r)) && !fact && (REVIEW_RULES.some((r) => rule.startsWith(r)) || REVIEW_CATS.has(f.category));
    if (isReview) { review.push({ rule, sev: f.severity, title: f.title, ...where }); continue; }
    if (!fact) continue;
    const x = (facts[fact[0]] ||= { k: fact[0], n: 0, where: [] });
    x.n++;
    if (where && x.where.length < 3 && !x.where.some((w) => w.f === where.f)) x.where.push(where);
  }
  return { facts: FACTS.map(([k]) => facts[k]).filter(Boolean), review };
}

// ---------- web addresses written in the code ----------
// Answers "where can my data go?" with hosts named in the code, each with its first file:line. Not a full
// answer: code can build addresses while running, and some hits are links rather than calls. The page says so.
const CODE = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|tsx|jsx|rb|go|ps1|php|pl|rs|java|kt|swift|cs)$/i;
const NOT_CALLS = /(^|\/)(readme|changelog|license|contributing|security|code_of_conduct)[^/]*$|(^|\/)docs?\//i;
const CALL_LINE = /\b(curl|wget|fetch|requests\.|httpx|urllib|axios|http\.(get|post|request)|Invoke-WebRequest|Invoke-RestMethod|WebFetch|base_?url|endpoint|api_?url)\b|\b(GET|POST|PUT|PATCH|DELETE)\s+https?:/i;
const COMMENT = /^\s*(\/\/|#(?!!)|\*|\/\*|<!--|--\s)/;
const URL_RE = /\b(?:https?|wss?):\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,})(?=[:/?#\s'"`)\]>,;]|$)/gi;
// links, not calls: the exact site only, so api.github.com still counts
const LINK_HOST = /^(w3\.org|json-schema\.org|schema\.org|xmlsoap\.org|purl\.org|ietf\.org|opensource\.org|spdx\.org|creativecommons\.org|img\.shields\.io|shields\.io|badge\.fury\.io|github\.com|gitlab\.com|npmjs\.com|pypi\.org|semver\.org|keepachangelog\.com|apache\.org|developer\.mozilla\.org|en\.wikipedia\.org|stackoverflow\.com)$/i;
// placeholders in examples, including their subdomains
const NOT_HOST = /^(localhost|.*\.(local|localhost|test|invalid|example|internal|lan))$|(^|\.)(example\.(com|org|net)|yourdomain\.com|your-domain\.com|domain\.com|acme\.com|foo\.com|bar\.com|attacker\.com|evil\.com|target\.com|victim\.com|malicious\.com|company\.com|mycompany\.com)$|^schemas?\.|^(xxx|your|my)[-.]/i;
function hostsOf(root) {
  const seen = new Map();
  const walk = (d) => {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, x.name), rel = path.relative(root, p);
      if (x.isDirectory()) { walk(p); continue; }
      if (TESTISH.test(rel) || NOT_CALLS.test(rel)) continue;
      const code = CODE.test(x.name), md = /\.(md|mdc)$/i.test(x.name);
      if (!code && !md) continue;
      if (md && x.name === 'SKILL.md' && /^---\nname: plado-scan-stub\n/.test(fs.readFileSync(p, 'utf8').slice(0, 40))) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 2000 || (code && COMMENT.test(line)) || (md && !CALL_LINE.test(line))) continue;
        for (const m of line.matchAll(URL_RE)) {
          const h = m[1].toLowerCase().replace(/^www\./, '');
          if (NOT_HOST.test(h) || LINK_HOST.test(h) ||/^\d+(\.\d+){3}$/.test(h)) continue;
          const hit = seen.get(h) || { h, n: 0, f: rel, l: i + 1 };
          hit.n++; seen.set(h, hit);
        }
      }
    }
  };
  try { walk(root); } catch {}
  const all = [...seen.values()].sort((a, b) => b.n - a.n || a.h.localeCompare(b.h));
  return { hosts: all.slice(0, 15).map(({ h, f, l }) => ({ h, f, l })), hostCount: all.length };
}

// ---------- what to scan ----------
const listed = new Set(JSON.parse(fs.readFileSync(path.join(SITE, 'dist', 'data', 'index.json'), 'utf8')).entries.map((e) => e.id));
const load = (f) => { try { return JSON.parse(fs.readFileSync(path.join(SITE, 'data', f), 'utf8')).entries; } catch { return []; } };
const all = ['skills.json', 'agents.json', 'catalog.json', 'rules.json', 'prompts.json'].flatMap(load).filter((e) => listed.has(e.id) && (!ONLY.length || ONLY.includes(e.type)));
// first copy of a duplicated id wins, the same one build.mjs shows (keeps the scan and the page describing one thing)
{ const seen = new Set(); for (let i = 0; i < all.length; i++) if (seen.has(all[i].id)) all.splice(i--, 1); else seen.add(all[i].id); }
function pkgOf(e) {
  const cmds = Object.values(e.install || {}).flat().join(' ');
  let m = cmds.match(/npx\s+(?:-y\s+|--yes\s+)*(@?[\w.-]+(?:\/[\w.-]+)?)@(\d[\w.+-]*)/);
  if (m) return { eco: 'npm', name: m[1], ver: m[2] };
  m = cmds.match(/(?:uvx|pip install|pipx run)\s+(?:--from\s+)?([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?==([\w.+-]+)/);
  if (m) return { eco: 'pypi', name: m[1], ver: m[2] };
  return null;
}
const units = all.map((e) => {
  if (e.type === 'prompt') return { e, kind: 'text', key: 'text-' + crypto.createHash('sha256').update(e.text || '').digest('hex').slice(0, 24) };
  if (e.pin?.kind === 'commit') {
    const p = e.type === 'rules' ? e.path : e.subpath || '';
    return { e, kind: 'commit', repo: e.github?.repo || e.repo, sha: e.pin.value, p, single: /\.(md|mdc)$/i.test(p), key: `c-${crypto.createHash('sha256').update(`${e.github?.repo || e.repo}@${e.pin.value}:${p}`).digest('hex').slice(0, 24)}` };
  }
  const pkg = e.pin?.kind === 'version' ? pkgOf(e) : null;
  if (pkg) return { e, kind: 'package', pkg, key: `p-${pkg.eco}-${pkg.name.replace(/[^\w.-]/g, '_')}-${pkg.ver}` };
  return { e, kind: 'none', why: e.hosted ? 'hosted' : e.pin?.kind === 'version' ? 'package source not found' : 'not pinned' };
});

// ---------- fetching ----------
const treeCache = new Map();
async function tree(repo, sha) {
  if (!treeCache.has(repo + sha)) treeCache.set(repo + sha, (async () => {
    for (let i = 0; i < 5; i++) {
      try { const { stdout } = await run('gh', ['api', `repos/${repo}/git/trees/${sha}?recursive=1`], { maxBuffer: 256 << 20 }); const j = JSON.parse(stdout); return { files: j.tree || [], truncated: !!j.truncated }; }
      catch (err) {
        const msg = String(err.stderr || err.message);
        if (/rate limit/i.test(msg)) { const { stdout } = await run('gh', ['api', 'rate_limit', '--jq', '.resources.core.reset']).catch(() => ({ stdout: '' })); const wait = Math.max(60, Number(stdout) - Date.now() / 1000 + 5); console.log(`rate limited, waiting ${Math.round(wait)}s`); await sleep(wait * 1000); continue; }
        if (/Not Found|404|409|422/.test(msg)) return null;
        await sleep(2000 * (i + 1));
      }
    }
    return null;
  })());
  return treeCache.get(repo + sha);
}
async function get(url, asBuffer = true) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120000) }); // a hung download must not hold up the time budget
      if (r.ok) return asBuffer ? Buffer.from(await r.arrayBuffer()) : r.json();
      if (r.status === 404 || r.status === 410) return null;
      if (r.status === 429 || r.status >= 500) { await sleep(5000 * (i + 1)); continue; }
      return null;
    } catch { await sleep(2000 * (i + 1)); }
  }
  return null;
}
const raw = (repo, sha, p) => get(`https://raw.githubusercontent.com/${repo}/${sha}/${p.split('/').map(encodeURIComponent).join('/')}`);
const rank = (p) => (/\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|go|ps1|php|pl)$/i.test(p) ? 0 : /(^|\/)(SKILL|AGENT|CLAUDE)\.md$|\.md$|\.json$|\.ya?ml$|\.toml$/i.test(p) ? 1 : 2);

async function prepare(u, dir) {
  const e = u.e;
  let stub = false, partial = false;
  if (u.kind === 'text') {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${e.id.slice(0, 60)}\ndescription: ${JSON.stringify(String(e.name))}\n---\n\n${e.text}`);
    return { stub: false };
  }
  if (u.kind === 'commit') {
    const t = await tree(u.repo, u.sha);
    if (!t) return { error: 'commit not found on GitHub' };
    if (u.single) {
      const b = await raw(u.repo, u.sha, u.p);
      if (!b) return { error: 'file not found at commit' };
      const txt = b.toString('utf8');
      fs.writeFileSync(path.join(dir, 'SKILL.md'), /^---\n[\s\S]*?\nname:/.test(txt) ? txt : `---\nname: ${e.id.slice(0, 60)}\ndescription: file\n---\n\n${txt}`);
      return { stub: false, files: 1 };
    }
    const pre = u.p ? u.p.replace(/\/$/, '') + '/' : '';
    let files = t.files.filter((f) => f.type === 'blob' && (!pre || f.path.startsWith(pre)) && !SKIP_DIR.test(f.path) && !BINARY.test(f.path) && (f.size || 0) <= MAX_BYTES);
    if (files.length > MAX_FILES) { partial = true; files = files.sort((a, b) => rank(a.path) - rank(b.path) || a.path.length - b.path.length).slice(0, MAX_FILES); }
    if (t.truncated) partial = true;
    let n = 0;
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(files.slice(i, i + 8).map(async (f) => {
        const b = await raw(u.repo, u.sha, f.path);
        if (!b) return;
        const out = path.join(dir, f.path.slice(pre.length));
        fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, b); n++;
      }));
    }
    if (!n) return { error: 'no readable files at commit' };
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) { stub = true; fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: plado-scan-stub\ndescription: stub\n---\n`); }
    return { stub, partial, files: n };
  }
  if (u.kind === 'package') {
    const { eco, name, ver } = u.pkg;
    let url = null, zip = false;
    if (eco === 'npm') url = (await get(`https://registry.npmjs.org/${name.replace('/', '%2F')}/${ver}`, false))?.dist?.tarball;
    else {
      const j = await get(`https://pypi.org/pypi/${name}/${ver}/json`, false);
      const pick = (j?.urls || []).find((x) => x.packagetype === 'sdist') || (j?.urls || []).find((x) => x.packagetype === 'bdist_wheel');
      url = pick?.url; zip = pick?.packagetype === 'bdist_wheel';
    }
    if (!url) return { error: `${eco} package ${name}@${ver} not found` };
    const b = await get(url);
    if (!b) return { error: 'package download failed' };
    if (b.length > 40 << 20) return { error: 'package over 40 MB, skipped' };
    const f = path.join(dir, '..', path.basename(dir) + (zip ? '.zip' : '.tgz'));
    fs.writeFileSync(f, b);
    try { await run(zip ? 'unzip' : 'tar', zip ? ['-q', '-o', f, '-d', dir] : ['-xzf', f, '-C', dir]); } catch { fs.rmSync(f, { force: true }); return { error: 'could not unpack package' }; }
    fs.rmSync(f, { force: true });
    // drop what we wouldn't read anyway, then cap the file count like repos
    const keep = [];
    const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, x.name), rel = path.relative(dir, p); if (x.isDirectory()) { if (SKIP_DIR.test(rel + '/')) fs.rmSync(p, { recursive: true, force: true }); else walk(p); } else if (BINARY.test(x.name) || fs.statSync(p).size > MAX_BYTES) fs.rmSync(p, { force: true }); else keep.push(rel); } };
    walk(dir);
    if (keep.length > MAX_FILES) { partial = true; keep.sort((a, b) => rank(a) - rank(b) || a.length - b.length).slice(MAX_FILES).forEach((r) => fs.rmSync(path.join(dir, r), { force: true })); }
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) { stub = true; fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: plado-scan-stub\ndescription: stub\n---\n`); }
    const tops = fs.readdirSync(dir).filter((x) => x !== 'SKILL.md');
    return { stub, partial, files: Math.min(keep.length, MAX_FILES), root: tops.length === 1 && fs.statSync(path.join(dir, tops[0])).isDirectory() ? path.join(dir, tops[0]) : dir };
  }
}

function scan(dir, out) {
  return new Promise((resolve) => {
    const p = spawn(BIN, ['scan', dir, '--use-behavioral', '--lenient', '--format', 'json', '--output-json', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    const timer = setTimeout(() => p.kill('SIGKILL'), 240000);
    p.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(fs.readFileSync(out, 'utf8'))); } catch { resolve({ error: err || 'scanner failed' }); } });
  });
}

// ---------- run ----------
fs.mkdirSync(CACHE, { recursive: true });
fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
const NET = new Set(['network', 'envnet', 'remote']); // only these pages show addresses
const cached = (u) => { try { return JSON.parse(fs.readFileSync(path.join(CACHE, u.key + '.json'), 'utf8')); } catch { return null; } };
const todo = HOSTS_ONLY
  ? units.filter((u) => u.kind !== 'none' && u.kind !== 'text' && (() => { const r = cached(u); return r && !('hostCount' in r) && (r.facts || []).some((x) => NET.has(x.k)); })())
  : units.filter((u) => u.kind !== 'none' && !fs.existsSync(path.join(CACHE, u.key + '.json')));
const queue = REPORT_ONLY ? [] : LIMIT ? todo.slice(0, LIMIT) : todo;
const seen = new Set(); const work = queue.filter((u) => !seen.has(u.key) && seen.add(u.key));
console.log(`${units.length} listed · ${units.filter((u) => u.kind === 'none').length} not scannable · ${units.length - todo.length} cached · ${work.length} to scan with ${JOBS} jobs`);
let done = 0, fails = 0; const t0 = Date.now();
const overTime = () => MINUTES > 0 && Date.now() - t0 > MINUTES * 60000;
async function worker(w) {
  while (work.length && !overTime()) {
    const u = work.shift();
    const dir = path.join(TMP, `${w}-${u.key}`), out = dir + '.json';
    fs.mkdirSync(dir, { recursive: true });
    let rec;
    if (HOSTS_ONLY) {
      const prep = await prepare(u, dir).catch((err) => ({ error: String(err.message || err) }));
      if (!prep.error) fs.writeFileSync(path.join(CACHE, u.key + '.json'), JSON.stringify({ ...cached(u), ...hostsOf(prep.root || dir) }));
      else fails++;
      fs.rmSync(dir, { recursive: true, force: true });
      if (++done % 100 === 0 || !work.length) console.log(`${done} backfilled, ${fails} failed`);
      continue;
    }
    try {
      const prep = await prepare(u, dir);
      if (prep.error) rec = { error: prep.error };
      else {
        const j = await scan(dir, out);
        if (j.error) rec = { error: String(j.error).slice(-200) };
        else rec = { ...classify(j.findings || [], prep.stub, dir, prep.root || dir), ...hostsOf(prep.root || dir), partial: !!prep.partial, files: prep.files ?? null, scanner: `skill-scanner ${j.scan_metadata?.scanner_version || '2.1.0'}` };
      }
    } catch (err) { rec = { error: String(err.message || err).slice(0, 200) }; }
    rec.at = new Date().toISOString().slice(0, 10);
    if (rec.error) fails++;
    // errors aren't cached for good: a failed download gets another try next run
    fs.writeFileSync(path.join(CACHE, u.key + '.json'), JSON.stringify(rec));
    if (rec.error) fs.renameSync(path.join(CACHE, u.key + '.json'), path.join(CACHE, u.key + '.json.err'));
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { force: true });
    if (++done % 100 === 0 || !work.length) { const s = (Date.now() - t0) / 1000; console.log(`${done} scanned, ${fails} failed, ${(s / done).toFixed(2)}s each, ~${Math.round(((s / done) * work.length) / 60)} min left`); }
  }
}
await Promise.all(Array.from({ length: JOBS }, (_, i) => worker(i)));
if (work.length) console.log(`time budget (${MINUTES} min) reached: ${work.length} left pending for the next run`);
fs.rmSync(TMP, { recursive: true, force: true });

// ---------- write outputs from the cache (every listed item, not only this run's) ----------
if (ONLY.length) { console.log('--only run: outputs not rewritten (they must cover the whole catalog)'); process.exit(0); }
const pub = {}, priv = [];
let scanned = 0;
for (const u of units) {
  const e = u.e;
  if (u.kind === 'none') { pub[e.id] = { status: 'none', why: u.why }; continue; }
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(path.join(CACHE, u.key + '.json'), 'utf8')); } catch {}
  if (!rec) { let err = null; try { err = JSON.parse(fs.readFileSync(path.join(CACHE, u.key + '.json.err'), 'utf8')); } catch {} pub[e.id] = { status: err ? 'error' : 'pending', why: err?.error }; continue; }
  scanned++;
  const at = u.kind === 'commit' ? { kind: 'commit', value: u.sha } : u.kind === 'package' ? { kind: u.pkg.eco, value: `${u.pkg.name}@${u.pkg.ver}` } : { kind: 'text' };
  pub[e.id] = { status: 'scanned', date: rec.at, at, facts: rec.facts, partial: rec.partial || undefined, files: rec.files ?? undefined, held: rec.review.length ? 1 : undefined, hosts: rec.hosts?.length ? rec.hosts : undefined, hostCount: rec.hostCount > 15 ? rec.hostCount : undefined, scanner: rec.scanner };
  if (rec.review.length) priv.push({ id: e.id, name: e.name, type: e.type, repo: e.github?.repo || '', at, findings: rec.review });
}
fs.writeFileSync(path.join(SITE, 'data', 'scan.json'), JSON.stringify({ generatedAt: new Date().toISOString(), scanner: 'Cisco skill-scanner 2.1.0, static + behavioral, offline', total: units.length, scanned, entries: pub }));
fs.mkdirSync(path.join(ROOT, 'research', 'private'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'research', 'private', 'scan-review.json'), JSON.stringify(priv, null, 1));
const factCount = {}; for (const v of Object.values(pub)) for (const f of v.facts || []) factCount[f.k] = (factCount[f.k] || 0) + 1;
console.log(`\nscanned ${scanned}/${units.length} listed (${Math.round((100 * scanned) / units.length)}%) · for review (private): ${priv.length} · facts:`, factCount);
