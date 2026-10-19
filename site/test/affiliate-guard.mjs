// Fails if affiliate data can reach scoring, ranking or search. Affiliate data may appear in
// exactly three places in build.mjs: its definition, the lookup helper, and the labeled panel
// on an entry page. Any other line naming it (an alias, a call inside a scoring function, a
// new import) fails, and so does any mention in the other ranking and search code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDENT = /\bAFF\w*|\baff[A-Z_]\w*|affiliates\.(json|mjs|js)/;
// the exact lines (whitespace-trimmed); anything appended to them fails too
const ALLOWED = [
  "const AFF = Object.entries(readOpt('../affiliates.json')?.programs || {}).filter(([, p]) => p.url).map(([key, p]) => ({ key, ...p }));",
  "const affFor = (e) => AFF.find((p) => p.owners.includes(String(ownerOf(e) || '').toLowerCase()));",
  "${(() => { const a = affFor(e); return a ? `<div class=\"panel\"><h2>Needs an account</h2><p>This works with ${esc(a.needs)}. <a href=\"${esc(a.url)}\" rel=\"sponsored noopener\" target=\"_blank\">Sign up for ${esc(a.name)}</a> <span class=\"chip\">affiliate link</span></p><p class=\"small muted\">Plado may earn a commission if you sign up. It never changes a score or a position.</p></div>` : ''; })()}"
];
const bad = [];
const lines = fs.readFileSync(path.join(SITE, 'build.mjs'), 'utf8').split('\n');
const hits = lines.map((l, i) => [l, i + 1]).filter(([l]) => IDENT.test(l));
for (const [l, n] of hits) if (!ALLOWED.includes(l.trim())) bad.push(`build.mjs:${n} uses affiliate data outside the allowed places: ${l.trim().slice(0, 100)}`);
for (const a of ALLOWED) if (hits.filter(([l]) => l.trim() === a).length > 1) bad.push('build.mjs: an allowed affiliate line appears more than once');
// everything else that can feed a score, a rank or search: site code, the pipeline, the cron
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (['node_modules', 'cache', 'work', '.venv', 'dist', 'data', 'test'].includes(e.name) ? [] : walk(path.join(d, e.name))) : /\.(m?js|cjs)$/.test(e.name) ? [path.join(d, e.name)] : []);
const OTHER = [...walk(SITE), ...walk(path.join(SITE, '..', 'pipeline')), ...walk(path.join(SITE, '..', 'cron'))].filter((f) => path.basename(f) !== 'build.mjs' || path.dirname(f) !== SITE).map((f) => path.relative(SITE, f));
for (const f of OTHER) fs.readFileSync(path.join(SITE, f), 'utf8').split('\n').forEach((l, i) => { if (IDENT.test(l)) bad.push(`${f}:${i + 1} mentions affiliate data`); });
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log(`affiliate guard: ok (${hits.length} allowed uses, ${OTHER.length} other files clean)`);
