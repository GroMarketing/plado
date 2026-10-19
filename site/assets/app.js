// Plado client script. No dependencies. Third-party text (names, descriptions) is only
// ever inserted with textContent / createElement, never innerHTML.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const BASE = document.documentElement.dataset.base || '/';
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v);
    }
    for (const k of kids) if (k) n.append(k);
    return n;
  };

  // ---------- theme toggle (per-viewer convenience; storage may be unavailable) ----------
  const root = document.documentElement;
  try { const t = localStorage.getItem('plado-theme'); if (t) root.dataset.theme = t; } catch {}
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('#theme-toggle')?.addEventListener('click', (ev) => {
    const flip = () => {
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
      root.dataset.theme = dark ? 'light' : 'dark';
      try { localStorage.setItem('plado-theme', root.dataset.theme); } catch {}
    };
    // circle grows from the button (View Transitions); instant where unsupported or motion is reduced
    if (!document.startViewTransition || reduced) { flip(); return; }
    const r = ev.currentTarget.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.startViewTransition(flip).ready.then(() => root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] }, { duration: 550, easing: 'cubic-bezier(.4,0,.2,1)', pseudoElement: '::view-transition-new(root)' })).catch(() => {});
  });

  // ---------- small SVG helper (DOM calls only) ----------
  const svgPaths = (paths, cls, viewBox = '0 0 24 24') => {
    const NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', viewBox); s.setAttribute('aria-hidden', 'true'); if (cls) s.setAttribute('class', cls);
    for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('pathLength', '1'); s.append(p); }
    return s;
  };
  // 7c: an empty tag for "nothing found"
  const emptyTag = (text) => el('div', { class: 'empty empty-tag' }, svgPaths(['M18 3 H60 V41 H18 L3 22 Z', 'M20.2 22 a4.2 4.2 0 1 1 -8.4 0 a4.2 4.2 0 1 1 8.4 0'], 'tag-outline', '0 0 64 44'), el('p', { text }));

  // ---------- toast ----------
  let toastTimer;
  const toast = (msg) => {
    let t = $('.toast');
    if (!t) { t = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
  };

  // ---------- copy buttons ----------
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const text = b.getAttribute('data-copy');
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = el('textarea'); ta.value = text; document.body.append(ta); ta.select();
      try { document.execCommand('copy'); } catch {} ta.remove();
    }
    const label = $('span', b); const prev = label?.textContent;
    if (label) label.textContent = 'Copied';
    b.classList.add('copied');
    const ico = $('svg', b);
    if (ico && !b.dataset.icon) { b.dataset.icon = '1'; const chk = svgPaths(['M5 12.5l4.5 4.5L19 7.5'], 'check-draw'); ico.after(chk); }
    toast('Copied to clipboard');
    setTimeout(() => { if (label) label.textContent = prev; b.classList.remove('copied'); }, 1400);
  });

  // ---------- tabs (install commands) ----------
  $$('.tabs').forEach((tabs) => {
    const list = $$('[role="tab"]', tabs);
    const select = (t) => {
      list.forEach((x) => {
        const on = x === t;
        x.setAttribute('aria-selected', on); x.tabIndex = on ? 0 : -1;
        $('#' + x.getAttribute('aria-controls')).hidden = !on;
      });
    };
    list.forEach((t, i) => {
      t.addEventListener('click', () => select(t));
      t.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault(); const n = list[(i + d + list.length) % list.length]; select(n); n.focus();
      });
    });
  });

  // ---------- prompt fill-in fields ----------
  const tpl = $('#prompt-text');
  const vars = $$('#vars [data-var]');
  if (tpl && vars.length) {
    const template = tpl.getAttribute('data-template');
    const copyBtn = $('#copy-prompt');
    const render = () => {
      const vals = Object.fromEntries(vars.map((i) => [i.getAttribute('data-var'), i.value]));
      const out = template.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (m, name, def) => (vals[name.trim()] || def || name).trim());
      tpl.textContent = out;           // textContent: never parsed as HTML
      copyBtn?.setAttribute('data-copy', out);
    };
    vars.forEach((i) => i.addEventListener('input', render));
    render();
  }

  // ---------- data (lazy) ----------
  let dataPromise;
  const loadData = () => (dataPromise ||= Promise.all([
    fetch(BASE + 'data/index.json').then((r) => r.json()),
    fetch(BASE + 'data/taxonomy.json').then((r) => r.json()).catch(() => ({ teams: {}, tasks: {}, industries: {} })),
  ]).then(([idx, tax]) => ({ ...idx, tax })));
  const norm = (s) => (s || '').toLowerCase();

  // ---------- query understanding: "marketing agent for social media to post things" ----------
  // Finds the team, task, industry and type a person means, then ranks by best match.
  const STOP = new Set('a an the for to of in on and or with that this my me i we want need help helps something things thing some can which best good top tool tools app apps using use way ways how do does make get find me please any'.split(' '));
  const TYPE_WORDS = [[/\b(sub-?agents?|agents?)\b/g, ['agent', 'skill', 'plugin']], [/\bskills?\b/g, ['skill']], [/\b(mcp|mcp servers?|servers?|connectors?)\b/g, ['mcp-server']], [/\bplugins?\b/g, ['plugin']], [/\b(prompts?|templates?)\b/g, ['prompt']], [/\b(cursor rules|rules files?)\b/g, ['rules']]];
  const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const phraseRe = (ph) => new RegExp(`(^|[^a-z0-9])${reEsc(ph)}(?=[^a-z0-9]|$)`, 'g');
  function parseQuery(raw, tax) {
    let q = ` ${norm(raw)} `;
    const pq = { tasks: new Set(), teams: new Set(), inds: new Set(), types: [], words: [] };
    const scan = (dict, into) => {
      const phrases = Object.entries(dict).flatMap(([k, v]) => (v.q || []).map((ph) => [k, ph])).sort((a, b) => b[1].length - a[1].length);
      for (const [k, ph] of phrases) { const re = phraseRe(ph); if (re.test(q)) { into.add(k); q = q.replace(phraseRe(ph), ' '); } }
    };
    scan(tax.tasks || {}, pq.tasks);
    scan(tax.teams || {}, pq.teams);
    scan(tax.industries || {}, pq.inds);
    for (const [re, types] of TYPE_WORDS) if (re.test(q)) { if (!pq.types.length) pq.types = types; q = q.replace(re, ' '); }
    pq.words = q.split(/[^a-z0-9.+#/-]+/).filter((w) => w.length > 1 && !STOP.has(w));
    pq.taskTeams = new Set([...pq.tasks].map((k) => k.split('/')[0]));
    pq.understood = pq.tasks.size + pq.teams.size + pq.inds.size > 0;
    return pq;
  }
  function relevance(e, pq) {
    const tk = e.k2 || [], tm = e.f || [], ix = e.x || [];
    const name = norm(e.n), hay = norm(`${e.d} ${e.r} ${(e.i || []).join(' ')}`);
    let hits = 0, r = 0;
    for (const w of pq.words) { if (name.includes(w)) { r += 3; hits++; } else if (hay.includes(w)) { r += 1; hits++; } }
    const taskHit = tk.some((t) => pq.tasks.has(t)), teamHit = tm.some((f) => pq.teams.has(f) || pq.taskTeams.has(f)), indHit = ix.some((x) => pq.inds.has(x));
    const strongHit = (e.ks || []).some((t) => pq.tasks.has(t));
    if (pq.tasks.size) { if (taskHit) r += strongHit ? 16 : 8; else if (teamHit && hits) r += 3; else return 0; }
    else if (pq.teams.size) { if (teamHit) r += 8; else if (hits < pq.words.length || !hits) return 0; }
    if (pq.inds.size) { if (indHit) r += 6; else if (!pq.tasks.size && !pq.teams.size) return 0; }
    if (!pq.understood) {
      if (pq.words.length && hits < pq.words.length) return 0;          // plain keyword search: every word must match
      if (!pq.words.length) { if (!pq.types.length || !pq.types.includes(e.t)) return 0; r = 1; } // "subagents" alone
    }
    if (pq.types.length) r += pq.types[0] === e.t ? 5 : pq.types.includes(e.t) ? 2 : 0;
    return r + (e.s ?? 0) / 40;
  }
  const TYPE_NAME = { agent: 'subagents', skill: 'skills', 'mcp-server': 'MCP servers', plugin: 'plugins', prompt: 'prompts', rules: 'rules files' };
  function describe(pq, tax) {
    const parts = [...[...pq.tasks].map((k) => `${tax.teams[k.split('/')[0]]?.label} › ${tax.tasks[k]?.label}`), ...[...pq.teams].filter((k) => !pq.taskTeams.has(k)).map((k) => tax.teams[k]?.label), ...[...pq.inds].map((k) => tax.industries[k]?.label)];
    if (!parts.length && !pq.types.length) return '';
    return `Showing ${parts.join(' + ') || 'everything'}${pq.types.length ? `, ${TYPE_NAME[pq.types[0]]} first` : ''}${pq.words.length ? `, matching "${pq.words.join(' ')}"` : ''}`;
  }
  const rank = (entries, q, tax) => { const pq = parseQuery(q, tax); return { pq, hits: entries.map((e) => [e, relevance(e, pq)]).filter(([, r]) => r > 0).sort((a, b) => b[1] - a[1]).map(([e]) => e) }; };
  const TYPE = { plugin: 'Plugin', 'mcp-server': 'MCP server', skill: 'Skill', agent: 'Subagent', prompt: 'Prompt', rules: 'Rules file' };

  // ---------- anonymous search counting + live trending searches (functions/api/*) ----------
  const logged = new Set();
  // the last query follows you to the next page, so searching again is one click (per tab only)
  const LASTQ = 'plado:lastq';
  const rememberQ = (q) => { try { if ((q || '').trim().length >= 2) sessionStorage.setItem(LASTQ, q.trim()); } catch {} };
  const lastQ = () => { try { return sessionStorage.getItem(LASTQ) || ''; } catch { return ''; } };
  const logSearch = (q) => {
    rememberQ(q);
    q = (q || '').trim().toLowerCase();
    if (q.length < 2 || logged.has(q)) return;
    logged.add(q);
    try { navigator.sendBeacon?.(BASE + 'api/search', JSON.stringify({ q })); } catch {}
  };
  let tsCache = {};
  const trendingSearches = (w = 'day') => (tsCache[w] ||= fetch(`${BASE}api/trending-searches?w=${w}`).then((r) => (r.ok ? r.json() : { items: [] })).catch(() => ({ items: [] })));

  // ---------- header / hero search ----------
  $$('[data-search]').forEach((form) => {
    const input = $('input', form);
    const box = $('.search-results', form);
    let active = -1, loadedOnce = false;
    if (form.classList.contains('search-top') && !input.value) input.value = lastQ();
    const render = async () => {
      const q = norm(input.value.trim());
      box.textContent = ''; active = -1;
      if (q.length < 2) {
        const { items = [] } = await trendingSearches('day');
        if (!items.length || document.activeElement !== input) { box.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
        box.append(el('li', { role: 'presentation' }, el('span', { class: 'muted small interp', text: 'Trending searches today' })));
        items.slice(0, 6).forEach((x, i) => box.append(el('li', { role: 'presentation' }, el('a', { href: `${BASE}browse/?q=${encodeURIComponent(x.q)}`, id: `sr-${i}`, role: 'option' }, document.createTextNode(x.q), el('span', { class: 'meta', text: `${x.n} people searched this today` })))));
        box.hidden = false; input.setAttribute('aria-expanded', 'true'); return;
      }
      if (!loadedOnce) box.append(el('li', { class: 'loading-row' }, el('span', { class: 'dots', 'aria-label': 'Loading' }, el('i'), el('i'), el('i')), el('span', { class: 'muted small', text: 'Loading the catalog…' })));
      box.hidden = false;
      const { entries, tax } = await loadData(); loadedOnce = true;
      box.textContent = '';
      const { pq, hits: all } = rank(entries, q, tax);
      const hits = all.slice(0, 8);
      const said = describe(pq, tax);
      if (said) box.append(el('li', { role: 'presentation' }, el('span', { class: 'muted small interp', text: said })));
      if (!hits.length) {
        box.append(el('li', {}, emptyTag('No matches. Try a tool name, like "postgres" or "figma".')));
      }
      hits.forEach((e, i) => {
        const a = el('a', { href: `${BASE}e/${e.id}/`, id: `sr-${i}`, role: 'option' },
          document.createTextNode(e.n),
          el('span', { class: 'meta', text: e.t === 'prompt' ? `Prompt · ▲ ${e.st} vote${e.st === 1 ? '' : 's'} · ${e.r}` : e.t === 'rules' ? `Cursor rules · ${e.r}` : `${TYPE[e.t] || e.t} · ${e.s ?? '–'} popularity score · ${e.r}` }));
        box.append(el('li', { role: 'presentation' }, a));
      });
      box.append(el('li', { role: 'presentation' }, el('a', { href: `${BASE}browse/?q=${encodeURIComponent(input.value.trim())}`, text: 'See all results →' })));
      box.hidden = false; input.setAttribute('aria-expanded', 'true');
    };
    input.addEventListener('input', render);
    input.addEventListener('focus', () => { loadData(); render(); input.select(); });
    box.addEventListener('click', (e) => { if (e.target.closest('a')) logSearch(input.value); });
    input.addEventListener('keydown', (e) => {
      const opts = $$('a', box);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
        opts.forEach((o, i) => o.setAttribute('aria-selected', i === active));
        opts[active]?.scrollIntoView({ block: 'nearest' });
        input.setAttribute('aria-activedescendant', opts[active]?.id || '');
      } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); opts[active].click(); }
      else if (e.key === 'Escape') { box.hidden = true; input.setAttribute('aria-expanded', 'false'); }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      logSearch(input.value);
      location.href = `${BASE}browse/?q=${encodeURIComponent(input.value.trim())}`;
    });
    document.addEventListener('click', (e) => { if (!form.contains(e.target)) box.hidden = true; });
  });

  // phones: the header search sits behind an icon until you ask for it
  const openBtn = $('.search-open');
  if (openBtn) openBtn.addEventListener('click', () => {
    const header = openBtn.closest('.site-header');
    const on = header.classList.toggle('searching');
    openBtn.setAttribute('aria-expanded', String(on));
    if (on) $('#q-top')?.focus();
  });
  // "/" jumps to search from anywhere, unless you're already typing
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const box = $('#q-top') || $('#q-hero') || $('#f-q');
    if (!box) return;
    e.preventDefault();
    if (box.offsetParent === null) openBtn?.click(); // hidden behind the phone icon
    box.focus();
  });

  // ---------- browse page ----------
  const browse = $('#browse');
  if (browse) {
    const form = $('#filters');
    const out = $('#results');
    const count = $('#result-count');
    const more = $('#load-more');
    const PAGE = 40;
    let shown = PAGE, current = [], logT;

    // restore state from the URL so filtered views are shareable (deep links)
    const params = new URLSearchParams(location.search);
    for (const [k, v] of params) {
      const f = form.elements[k];
      if (!f) continue;
      if (f instanceof RadioNodeList || (f.length && f[0]?.type === 'checkbox')) {
        v.split(',').forEach((x) => { const c = [...f].find((i) => i.value === x); if (c) c.checked = true; });
      } else if (f.type === 'checkbox') f.checked = v === f.value || v === '1';
      else f.value = v;
    }

    const state = () => {
      const fd = new FormData(form);
      return {
        q: norm(fd.get('q')?.trim()),
        platform: fd.getAll('platform'), type: fd.getAll('type'),
        integration: fd.get('integration') || '', job: fd.get('job') || '', use: fd.get('use') || '', ind: fd.get('ind') || '',
        min: Number(fd.get('min') || 0), license: fd.get('license') === '1', sort: fd.get('sort') || 'match',
      };
    };

    // same anatomy as the server-rendered cards, built with DOM calls only
    const NS = 'http://www.w3.org/2000/svg';
    const icon = (paths) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true'); for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); } return s; };
    const IC = {
      star: ['M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2-6.2 3.2L7 14.2 2 9.3l6.9-1z'], trend: ['m22 7-8.5 8.5-5-5L2 17', 'M16 7h6v6'],
      clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 7v5l3 2'], check: ['M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z', 'm9 12 2 2 4-4'],
      prompt: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'], rules: ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8M13 12h8M13 18h8'],
    };
    const span = (cls, ...kids) => el('span', cls ? { class: cls } : {}, ...kids);
    const card = (e) => {
      const repoLike = e.t !== 'prompt' && e.t !== 'rules';
      const av = el('span', { class: repoLike ? 'av' : 'av av-icon' });
      if (repoLike && e.o) av.append(el('img', { src: `https://avatars.githubusercontent.com/${encodeURIComponent(e.o)}?s=88`, alt: '', width: '44', height: '44', loading: 'lazy', decoding: 'async' }));
      else av.append(icon(e.t === 'rules' ? IC.rules : IC.prompt));
      const title = el('div', { class: 'card-title' }, el('h3', {}, el('a', { href: `${BASE}e/${e.id}/`, text: e.n })));
      if (e.vo) title.append(el('span', { class: 'maker', title: 'From the maker' }, icon(IC.check)));
      const sub = el('div', { class: 'card-sub' }, el('span', { class: repoLike ? 'mono' : '', text: e.r }), el('span', { class: 'type', text: e.t === 'prompt' ? (e.k ? `${e.k[0].toUpperCase() + e.k.slice(1)} prompt` : 'Prompt') : TYPE[e.t] || e.t }));
      const stats = el('div', { class: 'stats' });
      if (e.t === 'prompt') stats.append(span('', `▲ ${e.st} vote${e.st === 1 ? '' : 's'}`), span('', 'CC0'));
      else if (e.t === 'rules') stats.append(el('span', { class: 'plat', text: 'Cursor' }), span('', 'CC0'));
      else {
        stats.append(span('', icon(IC.star), fmt(e.st)));
        if (e.tw) stats.append(span('up', icon(IC.trend), `+${fmt(e.tw)} this week`));
        stats.append(span('', icon(IC.clock), ago(e.u)));
        if (e.cx) stats.append(el('span', { class: 'ctx-chip', title: 'Estimated context cost', text: e.t === 'agent' ? `≈${fmtK(e.cx)} tokens in your chat` : `≈${fmtK(e.cx)} tokens always loaded` }));
        (e.p || []).slice(0, 3).forEach((p) => stats.append(el('span', { class: 'plat', text: PLATFORM[p] || p })));
        stats.append(e.sc == null ? el('span', { class: 'badge unscanned', text: 'Not scanned' }) : el('span', { class: 'badge neutral', text: `Scanned${e.sc ? ` · ${e.sc} to know` : ''}` }));
      }
      const side = el('div', { class: 'card-side' },
        el('div', { class: 'score', title: e.t === 'prompt' ? 'Prompt score (community votes)' : 'Popularity and upkeep from public GitHub signals, not whether it works' }, document.createTextNode(e.s ?? '–'), el('small', { text: e.t === 'prompt' ? 'score' : e.s == null ? 'unranked' : 'popular' })),
        el('a', { class: 'btn copy-install', href: `${BASE}e/${e.id}/#install`, text: e.t === 'prompt' ? 'Open' : 'Install' }));
      return el('article', { class: 'card' }, av, el('div', { class: 'card-main' }, title, sub, el('p', { class: 'desc', text: e.d }), stats), side);
    };

    const draw = () => {
      out.textContent = '';
      const slice = current.slice(0, shown);
      if (!slice.length) out.append(emptyTag('Nothing matches these filters. Try removing one.'));
      slice.forEach((e) => out.append(card(e)));
      count.textContent = `${current.length.toLocaleString()} result${current.length === 1 ? '' : 's'}`;
      more.hidden = shown >= current.length;
    };

    const apply = async () => {
      const s = state();
      const { entries, tax } = await loadData();
      const ranked = s.q ? rank(entries, s.q, tax) : null;
      $('#interp').textContent = ranked ? describe(ranked.pq, tax) : '';
      clearTimeout(logT); if (s.q) logT = setTimeout(() => logSearch(s.q), 1500);
      current = (ranked ? ranked.hits : entries).filter((e) =>
        (!s.platform.length || s.platform.some((p) => e.p.includes(p))) &&
        (!s.type.length || s.type.includes(e.t)) &&
        (!s.integration || (e.i || []).includes(s.integration)) &&
        (!s.job || (e.j || []).includes(s.job)) &&
        (!s.use || (s.use.includes('/') ? (e.k2 || []).includes(s.use) : (e.f || []).includes(s.use))) &&
        (!s.ind || (e.x || []).includes(s.ind)) &&
        (e.s ?? 0) >= s.min &&
        (!s.license || !!e.l));
      const by = { match: ranked ? null : (a, b) => (b.s ?? 0) - (a.s ?? 0), score: (a, b) => (b.s ?? 0) - (a.s ?? 0), trending: (a, b) => (b.tw ?? 0) - (a.tw ?? 0) || (b.s ?? 0) - (a.s ?? 0), stars: (a, b) => b.st - a.st, light: (a, b) => (a.cx ?? 1e9) - (b.cx ?? 1e9) || (b.s ?? 0) - (a.s ?? 0), updated: (a, b) => (Date.parse(b.u) || 0) - (Date.parse(a.u) || 0), name: (a, b) => a.n.localeCompare(b.n) }[s.sort];
      if (by) current.sort(by);
      shown = PAGE; draw();
      // keep the URL in sync for sharing and back/forward
      const p = new URLSearchParams();
      if (s.q) p.set('q', s.q);
      if (s.platform.length) p.set('platform', s.platform.join(','));
      if (s.type.length) p.set('type', s.type.join(','));
      if (s.integration) p.set('integration', s.integration);
      if (s.job) p.set('job', s.job);
      if (s.use) p.set('use', s.use);
      if (s.ind) p.set('ind', s.ind);
      if (s.min) p.set('min', s.min);
      if (s.license) p.set('license', '1');
      if (s.sort !== 'match') p.set('sort', s.sort);
      history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
    };

    let t;
    form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(apply, 120); });
    form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
    more.addEventListener('click', () => { shown += PAGE; draw(); });
    $('#reset')?.addEventListener('click', () => { form.reset(); apply(); });
    apply();
  }

  const PLATFORM = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', 'gemini-cli': 'Gemini CLI', 'skills-cli': 'Skills CLI', 'any-llm': 'Any AI chat' };

  // ---------- trending: window tabs, hot/rising, type chips, search ----------
  const tools = $('#trend-tools');
  if (tools) {
    const WINS = ['day', 'week', 'quarter', 'year'];
    const st = { w: 'week', sort: 'hot', type: '', q: '' };
    const h = (location.hash || '').slice(1).split('-');
    if (WINS.includes(h[0])) st.w = h[0];
    if (h[1] === 'rising') st.sort = 'rising';
    const apply = () => {
      $$('[role="tab"][data-w]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.w === st.w)));
      $$('[data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === st.sort)));
      $$('.trend-types [data-type]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === st.type)));
      let shown = 0;
      $$('.trend-panel').forEach((p) => {
        const on = p.dataset.panel === `${st.w}-${st.sort}` && st.type !== 'prompt';
        p.hidden = !on;
        if (on) $$('article', p).forEach((a) => { const ok = (!st.type || a.dataset.t === st.type) && (!st.q || a.dataset.q.includes(st.q)); a.hidden = !ok; if (ok) shown++; });
      });
      const promptsOn = !st.type || st.type === 'prompt';
      $('#trend-prompts').hidden = !promptsOn;
      $$('.trend-ppanel').forEach((p) => {
        const on = p.dataset.ppanel === st.w;
        p.hidden = !on;
        if (on) $$('article', p).forEach((a) => { const ok = !st.q || a.dataset.q.includes(st.q); a.hidden = !ok; if (ok && promptsOn) shown++; });
      });
      $('#trend-none').hidden = shown > 0 || !st.q;
      try { history.replaceState(null, '', `#${st.w}${st.sort === 'rising' ? '-rising' : ''}`); } catch {}
    };
    $$('[role="tab"][data-w]').forEach((b) => b.addEventListener('click', () => { st.w = b.dataset.w; apply(); }));
    $$('[data-sort]').forEach((b) => b.addEventListener('click', () => { st.sort = b.dataset.sort; apply(); }));
    $$('.trend-types [data-type]').forEach((b) => b.addEventListener('click', () => { st.type = b.dataset.type; apply(); }));
    $('#trend-q').addEventListener('input', (ev) => { st.q = ev.target.value.trim().toLowerCase(); apply(); });
    apply();
  }

  // ---------- live trending searches: home chips + trending page panel ----------
  const homeChips = $('[data-trending-searches]');
  if (homeChips) trendingSearches('day').then(({ items = [] }) => {
    if (items.length < 3) return; // keep the static "Popular" chips until there's real data
    homeChips.textContent = '';
    homeChips.append(el('span', { class: 'muted small' }, el('span', { class: 'live-dot', 'aria-hidden': 'true' }), document.createTextNode(' Trending searches:')));
    items.slice(0, 8).forEach((x) => homeChips.append(el('a', { class: 'chip link', href: `${BASE}browse/?q=${encodeURIComponent(x.q)}`, title: `${x.n} people searched this today`, text: x.q })));
  });
  const live = $('#live-searches');
  if (live) {
    let w = 'day';
    const draw = async (fresh) => {
      if (fresh) tsCache = {};
      const { items = [] } = await trendingSearches(w);
      const list = $('#live-searches-list'); list.textContent = '';
      live.hidden = !items.length && w === 'day';
      if (!items.length) { list.append(el('li', { class: 'muted small', text: 'Not enough searches yet this week.' })); return; }
      items.forEach((x, i) => list.append(el('li', { class: 'row' },
        el('span', { class: 'rank mono', text: String(i + 1) }),
        el('span', {}),
        el('div', { class: 'row-main' }, el('a', { class: 'row-name', href: `${BASE}browse/?q=${encodeURIComponent(x.q)}`, text: x.q })),
        el('span', { class: 'row-right' }, el('span', { class: 'small muted', text: `${x.n} people` }), x.change != null ? el('span', { class: x.change >= 0 ? 'up small' : 'small muted', text: ` ${x.change >= 0 ? '+' : ''}${x.change}%` }) : el('span', { class: 'up small', text: ' new' })))));
    };
    $$('[data-sw]', live).forEach((b) => b.addEventListener('click', () => { w = b.dataset.sw; $$('[data-sw]', live).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); draw(); }));
    draw();
    setInterval(() => { if (!document.hidden) draw(true); }, 60000);
  }

  // ---------- type chips on use-case pages ----------
  $$('.type-filter').forEach((bar) => {
    const list = bar.nextElementSibling;
    bar.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-type]'); if (!b) return;
      $$('[data-type]', bar).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      $$('article[data-t]', list).forEach((a) => { a.hidden = !!b.dataset.type && a.dataset.t !== b.dataset.type; });
    });
  });

  // ---------- motion (all of it off under reduced motion) ----------
  // 1. odometer: numbers roll into place the first time they scroll into view
  function odometer(elm) {
    const to = Number(elm.dataset.odo), s = to.toLocaleString('en-US');
    elm.textContent = ''; elm.classList.add('odo'); elm.setAttribute('aria-label', s);
    const strips = [];
    for (const ch of s) {
      if (!/\d/.test(ch)) { elm.append(el('span', { text: ch })); continue; }
      const strip = el('span', { class: 'odo-strip' });
      for (let k = 0; k < 20; k++) strip.append(el('span', { text: String(k % 10) }));
      elm.append(el('span', { class: 'odo-col', 'aria-hidden': 'true' }, strip)); strips.push([strip, Number(ch)]);
    }
    strips.forEach(([strip, d], i) => {
      const place = strips.length - 1 - i, target = d + (place < 2 ? 10 : 0);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        strip.style.transition = `transform ${1.1 + (strips.length - place) * 0.08}s cubic-bezier(.2,.8,.2,1)`;
        strip.style.transform = `translateY(-${target * 1.25}em)`;
      }));
    });
  }
  if (!reduced && 'IntersectionObserver' in window) {
    const seen = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (!en.isIntersecting) return;
      const t = en.target; seen.unobserve(t);
      if (t.dataset.odo) odometer(t); else t.classList.add('drawn');
    }), { threshold: 0.6 });
    $$('[data-odo]').forEach((x) => seen.observe(x));
    $$('.draw-line, .spark').forEach((x) => seen.observe(x));
  } else $$('.draw-line, .spark').forEach((x) => x.classList.add('drawn'));

  // 2. the tag swings on the first page of a visit (and on hover, in CSS)
  const logo = $('.site-header .logo svg');
  if (logo && !reduced) { let first = true; try { first = !sessionStorage.getItem('plado-swung'); sessionStorage.setItem('plado-swung', '1'); } catch {} if (first) logo.classList.add('swing'); }

  // 6. fade the edges of rows that scroll sideways
  const fades = $$('.seg, .tabs [role="tablist"], .trend-types');
  const markFade = () => fades.forEach((x) => x.classList.toggle('fade-x', x.scrollWidth > x.clientWidth + 2));
  markFade(); addEventListener('resize', markFade, { passive: true });

  // 5. stacked cards: shrink a card slightly as the next one slides over it
  const cards = $$('.stack-card');
  if (cards.length && !reduced) {
    const onScroll = () => cards.forEach((c, i) => {
      const next = cards[i + 1]; if (!next) return;
      const a = c.getBoundingClientRect(), b = next.getBoundingClientRect();
      const o = Math.min(1, Math.max(0, (a.bottom - b.top) / a.height));
      c.style.transform = `scale(${1 - o * 0.06})`; c.style.opacity = String(1 - o * 0.35);
    });
    addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }

  function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); }
  function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n ?? 0); }
  function ago(iso) {
    const d = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86400000));
    return d === 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d}d ago` : d < 365 ? `${Math.round(d / 30)}mo ago` : `${Math.round(d / 365)}y ago`;
  }
})();
