#!/usr/bin/env bash
# Serve the "someone else's deployment" page on :4174 — a plain static host with
# no share-proto server of its own, which is what embed mode is for.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 -m http.server 4174 --bind 127.0.0.1
