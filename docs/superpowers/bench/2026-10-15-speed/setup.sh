#!/usr/bin/env bash
# Build the pages bench.mjs and webkit.mjs measure: each page twice, with the
# overlay from before the speed work (8f1b8e3, v2.6) and with this checkout's.
#   bash setup.sh [report.html] [app.html] [app-assets-dir]
# heavy.html comes from tests/fixtures. The other two are real client pages and
# are not in the repo; app-assets-dir is the app's own static files (its theme
# CSS/JS), copied in without replacing anything the template brings.
# A page that already carries an overlay tag has it taken out first.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
OLD=8f1b8e3

rm -rf "$HERE/old-src"
git -C "$REPO" worktree add --detach "$HERE/old-src" "$OLD" >/dev/null
trap 'git -C "$REPO" worktree remove --force "$HERE/old-src"' EXIT

mkdir -p "$HERE/src"
strip() { sed '/<script src="\/overlay.js"/d' "$1" > "$2"; }
strip "$REPO/tests/fixtures/heavy.html" "$HERE/src/heavy.html"
if [ -n "${1:-}" ]; then strip "$1" "$HERE/src/report.html"; fi
if [ -n "${2:-}" ]; then strip "$2" "$HERE/src/app.html"; fi

for p in heavy report app; do
  [ -f "$HERE/src/$p.html" ] || continue
  rm -rf "$HERE/site-old-$p" "$HERE/site-new-$p"
  python3 "$HERE/old-src/scripts/assemble.py" "$HERE/src/$p.html" "$HERE/site-old-$p" >/dev/null
  python3 "$REPO/scripts/assemble.py" "$HERE/src/$p.html" "$HERE/site-new-$p" >/dev/null
  if [ "$p" = app ] && [ -n "${3:-}" ]; then
    for v in old new; do cp -n "$3"/* "$HERE/site-$v-$p/public/" 2>/dev/null || true; done
  fi
  echo "built $p (old, new)"
done
