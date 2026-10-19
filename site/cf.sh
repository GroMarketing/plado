#!/bin/sh
# Run wrangler against Plado's own Cloudflare account, with its own login.
# Uses the browser login in site/.wrangler-home (./cf.sh login) and CLOUDFLARE_ACCOUNT_ID from site/.env.cloudflare (both gitignored).
#   ./cf.sh whoami
#   ./cf.sh d1 create plado
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$DIR/.env.cloudflare" ] || { echo "Missing $DIR/.env.cloudflare (see site/README.md, Cloudflare setup)"; exit 1; }
set -a; . "$DIR/.env.cloudflare"; set +a
WRANGLER="${WRANGLER:-npx --yes wrangler@4.112.0}"
# a separate config dir so this never reads or overwrites any other wrangler login
export WRANGLER_HOME="$DIR/.wrangler-home" XDG_CONFIG_HOME="$DIR/.wrangler-home"
cd "$DIR" && exec $WRANGLER "$@"
