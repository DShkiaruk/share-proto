#!/usr/bin/env bash
# Sign this machine in to Cloudflare, without making the person type anything.
#
#   bash scripts/cloudflare-login.sh              # browser opens, they press Allow
#   bash scripts/cloudflare-login.sh --device     # no reachable localhost (container, SSH)
#   bash scripts/cloudflare-login.sh --timeout 600
#
# `wrangler login` asks nothing in the terminal: it opens a browser, waits for
# the OAuth callback on localhost:8976, and exits when the person presses Allow.
# So the assistant can run it — the only human part is that one press, and
# handing someone a command to paste instead just adds a step they can mistype.
#
# Exit 0 = signed in (already, or just now). 1 = not, and why.
set -u
cd "$(dirname "$0")/.."

DEVICE=0
TIMEOUT=300
while [ $# -gt 0 ]; do
  case "$1" in
    --device) DEVICE=1 ;;
    --timeout) TIMEOUT=${2:-300}; shift ;;
    *) echo "usage: cloudflare-login.sh [--device] [--timeout <seconds>]" >&2; exit 2 ;;
  esac
  shift
done

W=worker/node_modules/.bin/wrangler
if [ ! -x "$W" ] || ! "$W" --version >/dev/null 2>&1; then
  echo "wrangler is not installed yet → cd worker && npm install" >&2
  exit 1
fi

# The whole address, not up to the first dot — an email is full of them.
account() { "$W" whoami 2>&1 | grep -io 'associated with the email [^ ]*' | sed 's/associated with the email //; s/\.$//'; }

WHO=$(account)
if [ -n "$WHO" ]; then
  echo "Already signed in to Cloudflare as $WHO"
  exit 0
fi

LOG=$(mktemp)
trap 'rm -f "$LOG"; [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null' EXIT

if [ "$DEVICE" = 1 ]; then
  # No callback server: the person opens a page and types a short code. The
  # flow for containers and SSH sessions, where localhost:8976 is ours and not
  # reachable from their browser.
  "$W" login --device >"$LOG" 2>&1 &
else
  "$W" login >"$LOG" 2>&1 &
fi
PID=$!

# The link appears within a second or two; show it in case no browser opened.
for _ in $(seq 1 20); do
  grep -qE 'https://dash\.cloudflare\.com|[A-Z0-9]{4}-[A-Z0-9]{4}' "$LOG" && break
  sleep 0.5
done
echo "Cloudflare is asking this machine for permission. In the browser window that just opened,"
echo "press Allow. If no window opened, open this and press Allow:"
echo
grep -oE 'https://dash\.cloudflare\.com[^ ]*' "$LOG" | head -1
# The device flow's short code — on its own line, never the URL (which contains
# the word "code" and would print itself twice).
grep -vE 'https?://' "$LOG" | grep -oE '\b[A-Z0-9]{4}-[A-Z0-9]{4}\b' | head -1
echo

WAITED=0
while kill -0 "$PID" 2>/dev/null && [ "$WAITED" -lt "$TIMEOUT" ]; do
  sleep 3
  WAITED=$((WAITED + 3))
  WHO=$(account)
  [ -n "$WHO" ] && break
done

WHO=$(account)
if [ -n "$WHO" ]; then
  echo "Signed in to Cloudflare as $WHO"
  exit 0
fi

kill "$PID" 2>/dev/null
echo "Not signed in after ${TIMEOUT}s — nothing was changed." >&2
if [ "$DEVICE" = 0 ]; then
  echo "If the browser opened on a different machine than this one (a container, an SSH session)," >&2
  echo "the callback cannot reach back here. Run it again with --device." >&2
else
  echo "The code may have expired; running this again issues a new one." >&2
fi
exit 1
