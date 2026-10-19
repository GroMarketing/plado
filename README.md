# Plado

The code behind [plado.pages.dev](https://plado.pages.dev): a directory of AI coding add-ons
(MCP servers, plugins, skills, subagents, prompts and rules) for Claude Code, Codex, Cursor,
Gemini CLI and Grok, ranked by evidence and checked by an offline scanner.

- `site/`: a dependency-free static generator (plain Node) plus Cloudflare Pages Functions.
- `site/data/`: fetchers for the public sources, and `history/`, the daily snapshots that the
  trending windows are computed from.
- `pipeline/scan/`: scans every listed add-on at its pinned commit or package version with
  Cisco's skill-scanner (offline, no model). Pages show facts with file and line, never a
  "safe" verdict.
- `pipeline/usage/`: counts installs in real public projects (GitHub code search).
- `templates/`: Plado Originals. Only `status: approved` is published.

## How it updates
A Cloudflare cron (`cron/`) triggers `.github/workflows/refresh.yml` once a day. The job
fetches, rescans only what changed (cached per version), rebuilds, deploys and commits the
day's snapshot. It refuses to deploy a catalog that shrank by more than 20%.

## Run locally
```bash
node site/data/fetch-catalog.mjs          # needs `gh` logged in
node site/build.mjs
python3 -m http.server 4321 -d site/dist
```

## Setup (once)
- **GitHub secrets:** `PLADO_GH_PAT` (fine-grained, public repositories read-only, used for API
  rate limits only), `CLOUDFLARE_API_TOKEN` (Pages edit, D1 edit, Account Analytics read) and
  `CLOUDFLARE_ACCOUNT_ID`. The job stops at once if any is missing.
- **Cron Worker** (`cron/`): `wrangler deploy`, then `wrangler secret put GH_PAT` (fine-grained,
  this repo only, Actions read and write).
- **D1:** apply `site/migrations/*.sql` to the `plado` database before the first deploy that
  needs them.
- **Sponsors:** Pages secret `STRIPE_WEBHOOK_SECRET` and Pages variable `SPONSOR_LINK_ID`. The
  Stripe webhook points at `/api/stripe-webhook` with the `checkout.session.*` and
  `customer.subscription.*` events.
