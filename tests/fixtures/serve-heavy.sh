#!/usr/bin/env bash
# The heavy prototype (tests/fixtures/heavy.html) on its own server (:4177)
# and its own store: review.spec measures freezes and seeds its own comments,
# and neither should depend on, or disturb, the counts the other specs assert.
set -euo pipefail
cd "$(dirname "$0")/../.."
rm -rf tests/fixtures/site-heavy
python3 scripts/assemble.py tests/fixtures/heavy.html tests/fixtures/site-heavy >/dev/null
cd tests/fixtures/site-heavy
rm -rf data
DESIGNER_PASSWORD=team-e2e CLIENT_PASSWORD=client-e2e SESSION_SECRET=heavy-secret \
  exec node server.js --port 4177
