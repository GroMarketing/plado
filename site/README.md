# Plado site (preview)

This is a static site generator with **no dependencies**: plain Node, no npm packages, and so
no supply-chain surface, which suits a trust product.

```bash
# 1. data: public sources + live GitHub signals (needs `gh` logged in)
node site/data/fetch-catalog.mjs
# 2. build: writes site/dist/
node site/build.mjs
#    with a real domain: SITE_URL=https://plado.dev node site/build.mjs  (adds canonical URLs + sitemap)
# 3. preview locally
python3 -m http.server 4321 -d site/dist
```



## Skills, prompts, rules and Originals
```bash
node site/data/fetch-skills-prompts.mjs prompts   # ~1 min
node site/data/fetch-skills-prompts.mjs rules     # ~1 min
node site/data/fetch-skills-prompts.mjs skills    # long; resumable (data/.cache-skills/)
node site/data/fetch-skills-prompts.mjs agents    # Claude Code subagents (.claude/agents/*.md)
node site/data/fetch-trending.mjs                  # after a build; daily. Paced: 550 archive calls/run
```
- **Plado Originals** live in `templates/originals/**.md`. Only `status: approved`
  publishes. `DRAFTS=1 node build.mjs` shows drafts for **local review only**. Never deploy a
  `DRAFTS=1` build.
- Prompt quality, categories and the official-maker exception are documented on the site's
  `/how-we-rank/` page.

## Trending
`data/fetch-trending.mjs` writes `data/trending.json` and a daily snapshot, `data/history/YYYY-MM-DD.json`.
GitHub stopped listing who starred a repo and when (the stargazers API returns 404), so windows come from:
1. **Our own daily snapshots** of GitHub's star counts. These are exact once they reach back far enough: tomorrow for "today", 7 days for "this week", and so on.
2. **Until then, the public GitHub event archive** through OSS Insight's free API. Its counts run lower than GitHub's, so each window ranks on one source only and the page says which.

**The snapshots have to persist.** In production, the scheduled job commits `data/history/` to the data repo. Losing it resets the exact windows.
