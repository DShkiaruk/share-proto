#!/usr/bin/env bash
# Assemble the fixture with the current template and serve it with the local
# server on :4173 using known passwords. Used by Playwright's webServer.
set -euo pipefail
cd "$(dirname "$0")/../.."
rm -rf tests/fixtures/site
python3 scripts/assemble.py tests/fixtures/proto.html tests/fixtures/site >/dev/null
cd tests/fixtures/site
rm -rf data
# ALLOWED_ORIGINS lets the embed-mode fixture on :4174 talk to this host.
DESIGNER_PASSWORD=team-e2e CLIENT_PASSWORD=client-e2e SESSION_SECRET=e2e-secret \
  ALLOWED_ORIGINS=http://localhost:4174 \
  exec node server.js --port 4173
