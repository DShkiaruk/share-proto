#!/usr/bin/env bash
# Contract checks for the Cloudflare Worker edition, over the wire.
#
# Boots `wrangler dev` locally (workerd, fresh storage, throwaway passwords) and
# exercises what only the transport layer can get wrong: bearer sessions, room
# partitioning, private media, CORS, and comment numbering under concurrency.
# The room's rules themselves are unit-tested in tests/unit/room.test.mjs.
#
#   scripts/worker-smoke.sh [port]
set -u
cd "$(dirname "$0")/.."
PORT=${1:-8788}
D="http://127.0.0.1:$PORT"
TEAM=worker-smoke-team
CLIENT=worker-smoke-client

TMP=$(mktemp -d)
cleanup() {
  # wrangler does not always go down on the first TERM, and `wait` on it would
  # hang the script for as long as it lingers.
  if [ -n "${WPID:-}" ]; then
    kill "$WPID" 2>/dev/null
    for _ in 1 2 3 4 5; do kill -0 "$WPID" 2>/dev/null || break; sleep 1; done
    pkill -P "$WPID" 2>/dev/null
    kill -9 "$WPID" 2>/dev/null
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

fail=0
check() { if [ "$1" = "$2" ]; then echo "  ok   $3"; else echo "  FAIL $3 (got: $1, want: $2)"; fail=1; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
jq_() { python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit(0)
$1" 2>/dev/null; }
api() { # api <token> <method-args...>
  local t=$1; shift
  curl -s -H "Authorization: Bearer $t" -H 'Content-Type: application/json' "$@"
}

if [ ! -x worker/node_modules/.bin/wrangler ]; then
  echo "wrangler is not installed — run: (cd worker && npm install)"
  exit 1
fi

echo "share-proto worker smoke → $D"
( cd worker && exec ./node_modules/.bin/wrangler dev \
    --ip 127.0.0.1 --port "$PORT" --log-level warn --persist-to "$TMP/state" \
    --var DESIGNER_PASSWORD:"$TEAM" --var CLIENT_PASSWORD:"$CLIENT" \
    --var SESSION_SECRET:worker-smoke-secret \
    --var ALLOWED_ORIGINS:http://localhost:4174 ) >"$TMP/wrangler.log" 2>&1 &
WPID=$!

for _ in $(seq 1 90); do
  [ "$(code "$D/")" = "200" ] && break
  kill -0 "$WPID" 2>/dev/null || { echo "wrangler exited early:"; tail -20 "$TMP/wrangler.log"; exit 1; }
  sleep 1
done
if [ "$(code "$D/")" != "200" ]; then
  echo "worker never came up:"; tail -20 "$TMP/wrangler.log"; exit 1
fi

# --- auth ---------------------------------------------------------------
check "$(code -H 'Content-Type: application/json' -d '{"password":"nope","name":"x"}' "$D/api/login")" 401 "wrong password → 401"
check "$(code "$D/api/comments")" 401 "GET /api/comments without a token → 401"
TEAM_T=$(curl -s -H 'Content-Type: application/json' -d '{"password":"'"$TEAM"'","name":"Dee"}' "$D/api/login" | jq_ 'print(d.get("token",""))')
CLIENT_T=$(curl -s -H 'Content-Type: application/json' -d '{"password":"'"$CLIENT"'","name":"Cliff"}' "$D/api/login" | jq_ 'print(d.get("token",""))')
check "$([ -n "$TEAM_T" ] && echo yes)" yes "team password → a bearer token"
check "$(api "$CLIENT_T" "$D/api/comments" | jq_ 'print(d.get("role"))')" client "client password → client role"

# Repeated wrong guesses are locked out per IP — the passwords are short and
# this host's URL is in a script tag on every preview page.
BRUTE_PIDS=""
for i in $(seq 1 10); do
  ( curl -s -o /dev/null -H 'Content-Type: application/json' -d '{"password":"guess-'"$i"'","name":"x"}' "$D/api/login" ) &
  BRUTE_PIDS="$BRUTE_PIDS $!"
done
wait $BRUTE_PIDS
check "$(code -H 'Content-Type: application/json' -d '{"password":"guess-11","name":"x"}' "$D/api/login")" 429 "ten wrong passwords from one address → the next is refused"
check "$(code -H 'Content-Type: application/json' -d '{"password":"'"$TEAM"'","name":"Dee"}' "$D/api/login")" 429 "and the brake does not care that the next one is right"

# --- the version handshake ---------------------------------------------
check "$(api "$TEAM_T" "$D/api/comments" | jq_ 'print(d.get("v"))')" 2 "the worker announces API v2"
check "$(api "$TEAM_T" "$D/api/comments" | jq_ 'print(d.get("name"), isinstance(d.get("shots"), dict), isinstance(d.get("mapmeta"), dict))')" "Dee True True" "GET carries identity, shots and map metadata"

# --- rooms and role isolation ------------------------------------------
NEW='{"action":"create","text":"worker smoke (designer)","screen":"s","screenLabel":"Home","anchor":{"path":"body"}}'
TID=$(api "$TEAM_T" -d "$NEW" "$D/api/comments?room=pr-7" | jq_ 'print(d.get("thread",{}).get("id",""))')
check "$([ -n "$TID" ] && echo yes)" yes "a designer can comment in a room"
check "$(api "$TEAM_T" "$D/api/comments?room=pr-7" | grep -c "$TID")" 1 "the comment is in its room"
check "$(api "$TEAM_T" "$D/api/comments" | grep -c "$TID")" 0 "and not in the default room"
check "$(api "$CLIENT_T" "$D/api/comments?room=pr-7" | grep -c "$TID")" 0 "a client does not see a designer thread"
check "$(code -X POST -H "Authorization: Bearer $CLIENT_T" -H 'Content-Type: application/json' \
  -d '{"action":"reply","threadId":"'"$TID"'","text":"x"}' "$D/api/comments?room=pr-7")" 404 "nor reply to one"

# --- private media ------------------------------------------------------
PIX=$(python3 -c "import base64;print('data:image/png;base64,'+base64.b64encode(open('tests/fixtures/pixel.png','rb').read()).decode())")
WITH_IMG=$(python3 -c "import json,sys;print(json.dumps({'action':'create','text':'worker smoke (client)','screen':'s','screenLabel':'Home','anchor':{'path':'body'},'images':[sys.argv[1]]}))" "$PIX")
CT=$(api "$CLIENT_T" -d "$WITH_IMG" "$D/api/comments?room=pr-7" | jq_ 'print(d.get("thread",{}).get("id",""))')
IMG=$(api "$CLIENT_T" "$D/api/comments?room=pr-7" | jq_ 'print(next(m["img"][0] for t in d["threads"] for m in t["messages"] if m.get("img")))')
check "$([ -n "$IMG" ] && echo yes)" yes "an attachment is stored and referenced"
check "$(code -H "Authorization: Bearer $CLIENT_T" "$D/api/file?p=$IMG&room=pr-7")" 200 "the author fetches it with the bearer header"
check "$(code "$D/api/file?p=$IMG&room=pr-7")" 401 "without a token → 401"
check "$(code "$D/api/file?p=$IMG&room=pr-7&token=$CLIENT_T")" 401 "a token in the URL is not a session"
check "$(code -H "Authorization: Bearer $CLIENT_T" "$D/api/file?p=../../secret.png&room=pr-7")" 400 "a path outside the room is refused"

# A hidden screen is hidden everywhere, not only in the map's rendering.
SHOT=$(python3 -c "import json,sys;print(json.dumps({'action':'shot','label':'Secret','image':sys.argv[1]}))" "$PIX")
SPATH=$(api "$TEAM_T" -d "$SHOT" "$D/api/comments?room=pr-7" | jq_ 'print(d.get("path",""))')
api "$TEAM_T" -d '{"action":"mapmeta","hide":"Secret"}' "$D/api/comments?room=pr-7" >/dev/null
check "$(api "$CLIENT_T" "$D/api/comments?room=pr-7" | jq_ 'print("Secret" in d.get("shots",{}), d.get("mapmeta",{}).get("hidden"))')" "False []" "a hidden screen is absent from the client's map"
check "$(code -H "Authorization: Bearer $CLIENT_T" "$D/api/file?p=$SPATH&room=pr-7")" 404 "and its picture 404s for the client"
check "$(code -H "Authorization: Bearer $TEAM_T" "$D/api/file?p=$SPATH&room=pr-7")" 200 "while the designer still sees it"

# --- CORS ---------------------------------------------------------------
check "$(curl -s -D - -o /dev/null -H 'Origin: http://localhost:4174' -H "Authorization: Bearer $TEAM_T" "$D/api/comments" | grep -ci 'access-control-allow-origin: http://localhost:4174')" 1 "an allow-listed origin gets CORS headers"
check "$(curl -s -D - -o /dev/null -H 'Origin: https://evil.example' -H "Authorization: Bearer $TEAM_T" "$D/api/comments" | grep -ci 'access-control-allow-origin')" 0 "an unknown origin gets none"
check "$(curl -s -D - -o /dev/null "$D/overlay.js" | grep -ci 'access-control-allow-origin: \*')" 1 "/overlay.js is loadable from any preview host"

# --- concurrency --------------------------------------------------------
# Six writers at once must each get their own number. (The room serializes its
# own mutations; workerd did not interleave them here even without that queue,
# so this check guards the outcome, not one particular mechanism.)
RACE_PIDS=""
for i in 1 2 3 4 5 6; do
  ( curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TEAM_T" -H 'Content-Type: application/json' \
      -d "{\"action\":\"create\",\"text\":\"race $i\",\"screen\":\"s\",\"screenLabel\":\"Home\",\"anchor\":{\"path\":\"body\"}}" \
      "$D/api/comments?room=race" > "$TMP/$i.code" ) &
  RACE_PIDS="$RACE_PIDS $!"
done
# Named PIDs, not a bare `wait`: the server itself is a background job here.
wait $RACE_PIDS
check "$(cat "$TMP"/*.code | sort -u | tr -d '\n')" 200 "6 concurrent comments all succeed"
check "$(api "$TEAM_T" "$D/api/comments?room=race" | jq_ 'ns=[t["n"] for t in d["threads"]]; print(len(ns), len(set(ns)))')" "6 6" "6 concurrent comments, 6 unique numbers"

[ $fail = 0 ] && echo "ALL OK" || { echo "WORKER SMOKE FAILED"; tail -20 "$TMP/wrangler.log"; exit 1; }
