#!/usr/bin/env bash
# The shape the Cloudflare runbook recommends, in miniature: a gated page here
# on :4175, its comments on another host (:4173, room "bridge"). Everything that
# only breaks when those two are apart — the single sign-in, the bridge route,
# CORS, one way in at a time — needs this to be tested at all.
set -euo pipefail
cd "$(dirname "$0")/../.."
rm -rf tests/fixtures/site-bridge
python3 scripts/assemble.py tests/fixtures/proto.html tests/fixtures/site-bridge \
  --comments http://localhost:4173 --room bridge >/dev/null
cd tests/fixtures/site-bridge
rm -rf data
# The same passwords as the comments host: that is what lets the gate sign the
# reader in to both. A different session secret, because the sessions are.
DESIGNER_PASSWORD=team-e2e CLIENT_PASSWORD=client-e2e SESSION_SECRET=bridge-secret \
  exec node server.js --port 4175
