#!/usr/bin/env bash
# What this machine still needs before the tool can be installed, and the exact
# command for each gap. Prose in a runbook gets skipped; this does not.
#
#   bash scripts/preflight.sh              # everything both paths need
#   bash scripts/preflight.sh --vercel     # the page-on-Vercel path only
#   bash scripts/preflight.sh --worker     # the comments-on-Cloudflare path only
#
# Exit code 0 = nothing is in the way. 1 = something is, and it is named below
# with the way to fix it. Steps a person has to do in a browser (creating an
# account, logging in) are printed as instructions to hand over verbatim, not
# as commands to run for them.
set -u
cd "$(dirname "$0")/.."

WANT_VERCEL=1
WANT_WORKER=1
case "${1:-}" in
  --vercel) WANT_WORKER=0 ;;
  --worker) WANT_VERCEL=0 ;;
  '') ;;
  *) echo "usage: preflight.sh [--vercel|--worker]" >&2; exit 2 ;;
esac

blocked=0
ok()   { printf '  ok    %s\n' "$1"; }
# Not a gap — something that cannot be judged yet because an earlier gap hides it.
later() { printf '  ...   %s\n' "$1"; }
gap()  { printf '  NEED  %s\n        → %s\n' "$1" "$2"; blocked=1; }
hand() { printf '        %s\n' "$1"; }

echo "share-proto preflight"

# ---- the machine ----------------------------------------------------------
if command -v python3 >/dev/null; then
  ok "python3 $(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
else
  gap "python3 (assemble.py builds the project with it)" "macOS: xcode-select --install   ·   otherwise: https://www.python.org/downloads/"
fi

HAVE_NODE=0
if command -v node >/dev/null; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$NODE_MAJOR" -ge 18 ]; then
    ok "node $(node -v)"
    HAVE_NODE=1
  else
    gap "node 18 or newer (found $(node -v))" "macOS: brew upgrade node   ·   otherwise: https://nodejs.org (LTS installer)"
  fi
else
  gap "node (nothing here runs without it)" "macOS with Homebrew: brew install node   ·   otherwise: https://nodejs.org (LTS installer), then reopen the terminal"
fi

command -v npm >/dev/null && ok "npm $(npm -v 2>/dev/null)" ||
  gap "npm (ships with node)" "install node first — see the line above"

# ---- the page on Vercel ---------------------------------------------------
if [ "$WANT_VERCEL" = 1 ]; then
  echo "  — for the page (Vercel) —"
  if [ "$HAVE_NODE" = 0 ]; then
    later "the Vercel CLI and account — checked once node is installed"
  elif command -v vercel >/dev/null; then
    ok "vercel CLI $(vercel --version 2>/dev/null | head -1)"
    if WHO=$(vercel whoami 2>/dev/null) && [ -n "$WHO" ]; then
      ok "signed in to Vercel as $WHO"
    else
      gap "a Vercel account, signed in" "the person has to do this part themselves:"
      hand "1. https://vercel.com/signup — continuing with Google is fastest, plan Hobby, free"
      hand "2. then, in this terminal, they type:  ! vercel login"
      hand "3. re-run this preflight"
    fi
  else
    gap "vercel CLI" "npm i -g vercel"
  fi
fi

# ---- the comments on Cloudflare -------------------------------------------
if [ "$WANT_WORKER" = 1 ]; then
  echo "  — for the comments (Cloudflare Worker) —"
  WRANGLER=worker/node_modules/.bin/wrangler
  # Not "is the file there" but "does it run": the file exists before node does,
  # and an installed-but-unrunnable wrangler reads as a missing account.
  if [ "$HAVE_NODE" = 0 ]; then
    later "wrangler and the Cloudflare account — checked once node is installed"
  elif [ -x "$WRANGLER" ] && WV=$("$WRANGLER" --version 2>/dev/null | tail -1) && [ -n "$WV" ]; then
    ok "wrangler $WV"
    # `wrangler whoami` exits 0 and says plenty either way — including the word
    # "account" while logged out, which is what this used to match and call
    # ready. The address is the only thing that means there is a session.
    WHO=$($WRANGLER whoami 2>&1 | grep -io 'associated with the email [^ ]*' | sed 's/associated with the email //; s/\.$//')
    if [ -n "$WHO" ]; then
      ok "signed in to Cloudflare as $WHO"
    else
      gap "a Cloudflare account, signed in" "bash scripts/cloudflare-login.sh"
      hand "That opens the browser and waits; the only human part is pressing Allow."
      hand "If they have no account yet, they make one first — free, no card asked for:"
      hand "  https://dash.cloudflare.com/sign-up — email + password"
      hand "Add --device if this is running somewhere their browser cannot reach"
      hand "(a container, an SSH session)."
    fi
  else
    gap "wrangler (the Cloudflare CLI)" "cd worker && npm install"
  fi
fi

# ---- the repo itself ------------------------------------------------------
[ -f template/public/overlay.js ] && ok "the template is here" ||
  gap "template/ is missing — this is not a full checkout" "git clone https://github.com/DShkiaruk/share-proto"

echo
if [ "$blocked" = 0 ]; then
  echo "Nothing is in the way."
else
  echo "Fix the NEED lines above, then run this again. Do them in order."
fi
exit "$blocked"
