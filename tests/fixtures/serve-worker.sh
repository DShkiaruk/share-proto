#!/usr/bin/env bash
# Boot the Cloudflare Worker edition on :4173 with the e2e passwords, so the
# embed spec — the real overlay on someone else's page — runs against it
# unchanged. Storage starts empty on every run.
set -euo pipefail
cd "$(dirname "$0")/../../worker"
if [ ! -x node_modules/.bin/wrangler ]; then
  echo "wrangler is not installed — run: (cd worker && npm install)" >&2
  exit 1
fi
rm -rf .wrangler/e2e-state
exec ./node_modules/.bin/wrangler dev \
  --ip 127.0.0.1 --port 4173 --log-level warn --persist-to .wrangler/e2e-state \
  --var DESIGNER_PASSWORD:team-e2e --var CLIENT_PASSWORD:client-e2e \
  --var SESSION_SECRET:e2e-secret --var ALLOWED_ORIGINS:http://localhost:4174
