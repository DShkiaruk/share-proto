#!/usr/bin/env bash
# A prototype with a deleted screen, on its own server (:4176) and its own
# store: the specs here seed a navigation graph, and a graph shared with the
# other specs would route their walks through edges this one invented.
set -euo pipefail
cd "$(dirname "$0")/../.."
rm -rf tests/fixtures/site-removed
python3 scripts/assemble.py tests/fixtures/removed.html tests/fixtures/site-removed >/dev/null
cd tests/fixtures/site-removed
rm -rf data
DESIGNER_PASSWORD=team-e2e CLIENT_PASSWORD=client-e2e SESSION_SECRET=removed-secret \
  exec node server.js --port 4176
