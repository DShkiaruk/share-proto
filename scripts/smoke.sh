#!/usr/bin/env bash
# Post-deploy checks for a share-proto deployment. Usage:
#   scripts/smoke.sh https://<domain> <team-password> <client-password> [--room <name>]
#
# --room targets one room on a host that holds several — a Cloudflare Worker,
# typically. It also switches auth to the bearer token the login returns, which
# is the only thing that works there: the Worker issues no cookie, so without
# this the run reads as "every password is wrong". On a host with real rooms on
# it, point this at a throwaway name (`--room smoke`) rather than a live one —
# the checks clean up their comments, but the map keeps the two screens they
# teach it.
set -u
D=${1:?domain}; TEAM=${2:?team password}; CLIENT=${3:?client password}
shift 3
ROOM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --room) ROOM=${2:-}; shift ;;
    *) echo "usage: smoke.sh https://<domain> <team-pw> <client-pw> [--room <name>]" >&2; exit 2 ;;
  esac
  shift
done
D=${D%/}
Q=""; RQ=""
[ -n "$ROOM" ] && { Q="?room=$ROOM"; RQ="&room=$ROOM"; }
API="$D/api/comments$Q"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail=0
check() { if [ "$1" = "$2" ]; then echo "  ok   $3"; else echo "  FAIL $3 (got: $1, want: $2)"; fail=1; fi; }
skip() { echo "  n/a  $1"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
jq_() { python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit(0)
$1" 2>/dev/null; }
# Cookies for the editions that set them, a bearer header for the one that does
# not. Both are sent every time: a curl config file holds the header, and an
# empty one is a no-op, so every call site stays a single extra `-K`.
login() {
  curl -s -c "$TMP/$1.jar" -H 'Content-Type: application/json' \
    -d '{"password":"'"$2"'","name":"smoke-'"$1"'"}' "$D/api/login$Q" > "$TMP/$1.body"
  : > "$TMP/$1.conf"
  TOK=$(jq_ 'print(d.get("token",""))' < "$TMP/$1.body")
  [ -n "$TOK" ] && printf 'header = "Authorization: Bearer %s"\n' "$TOK" > "$TMP/$1.conf"
  cat "$TMP/$1.body"
}
# Non-JSON bodies (500 pages) print an empty value instead of a traceback.
role_of() { jq_ 'print(d.get("role",""))'; }

echo "share-proto smoke → $D"
# A comments host serves no prototype and has no gate of its own — the page it
# belongs to lives on another origin and does the gating there. Asking it for a
# login page and calling the absence a failure would make every Worker run red.
if [ -n "$ROOM" ]; then
  skip "GET / shows a login page — a comments host serves no prototype"
else
  check "$(curl -s "$D/" | grep -c 'protected prototype')" 1 "GET / without cookie shows login page"
fi
check "$(login team "$TEAM" | role_of)" designer "team password → designer"
check "$(login client "$CLIENT" | role_of)" client "client password → client"
check "$(code -H 'Content-Type: application/json' -d '{"password":"nope","name":"x"}' "$D/api/login$Q")" 401 "wrong password → 401"
check "$(code "$API")" 401 "GET /api/comments without cookie → 401"
check "$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" "$D/" | grep -c 'overlay.js')" 1 "designer sees prototype with overlay"
check "$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" "$API" | jq_ 'print(d.get("role"), isinstance(d.get("threads"), list))')" "designer True" "designer GET /api/comments"

# Role isolation: a designer-created thread must be invisible to the client.
check "$(curl -s -D - -o /dev/null -b "$TMP/team.jar" -K "$TMP/team.conf" "$API" | grep -ci 'cache-control: no-store')" 1 "GET /api/comments is no-store"
# X-Store-Path names which path through the derived state document a request
# took. Only the Blob edition has such a document; local mode answers from one
# file and never sets the header, so its absence is a fact about the server,
# not a failure — but if a GET carries it, a create must too.
BLOB_BACKED=$(curl -s -D - -o /dev/null -b "$TMP/team.jar" -K "$TMP/team.conf" "$API" | grep -ci '^x-store-path:')
TID=$(curl -s -D "$TMP/create.h" -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' \
  -d '{"action":"create","text":"smoke (designer)","screen":"smoke","screenLabel":"smoke","anchor":{"path":"body"}}' \
  "$API" | jq_ 'print(d.get("thread",{}).get("id",""))')
if [ "$BLOB_BACKED" = 1 ]; then
  check "$(grep -i '^x-store-path:' "$TMP/create.h" | tr -d '\r' | awk '{print $2}')" patch "create took the fast path (no rebuild, no list)"
else
  skip "create took the fast path — this server keeps no derived document"
fi
check "$(curl -s -b "$TMP/client.jar" -K "$TMP/client.conf" "$API" | grep -c "$TID")" 0 "client does not see designer thread"
check "$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" "$API" | grep -c "$TID")" 1 "designer sees own thread"
REPLY='{"action":"reply","threadId":"'"$TID"'","text":"x"}'
check "$(code -b "$TMP/client.jar" -K "$TMP/client.conf" -H 'Content-Type: application/json' -d "$REPLY" "$API")" 404 "client cannot reply to designer thread"
check "$(code -b "$TMP/client.jar" -K "$TMP/client.conf" "$D/api/file?p=previews/$TID/x.jpg$RQ")" 404 "client cannot fetch media of a designer thread"
DELETE='{"action":"delete","threadId":"'"$TID"'"}'
check "$(code -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d "$DELETE" "$API")" 200 "cleanup: delete smoke thread"
check "$(code "$D/api/file?p=previews/x/y.jpg$RQ")" 401 "GET /api/file without cookie → 401"

# What the newest overlay needs of a server. Same checks as the Worker's own
# smoke, so a reviewer cannot tell the editions apart.
SCREEN=$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' \
  -d '{"action":"create","text":"smoke: about the screen","screen":"smoke","screenLabel":"smoke"}' "$API")
SCREEN_ID=$(printf '%s' "$SCREEN" | jq_ 'print(d.get("thread",{}).get("id",""))')
check "$(printf '%s' "$SCREEN" | jq_ 'print(d.get("thread",{}).get("anchor"), d.get("thread",{}).get("trail"))')" "None []" "a comment can be about a screen, with no anchor"
curl -s -o /dev/null -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d '{"action":"delete","threadId":"'"$SCREEN_ID"'"}' "$API"

# The state a comment was left in: the mode, and the marks that can restore it.
THEME='{"action":"create","text":"smoke: left in the dark","screen":"smoke","screenLabel":"smoke","theme":{"mode":"dark","marks":{"html":{"cls":["dark"],"attrs":{"data-theme":"dark"}}},"junk":1}}'
THEME_R=$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d "$THEME" "$API")
THEME_ID=$(printf '%s' "$THEME_R" | jq_ 'print(d.get("thread",{}).get("id",""))')
check "$(printf '%s' "$THEME_R" | jq_ 't=d.get("thread",{}).get("theme") or {}; print(t.get("mode"), (t.get("marks") or {}).get("html",{}).get("attrs",{}).get("data-theme"))')" "dark dark" "a comment remembers the theme it was left in"
BAD_R=$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d '{"action":"create","text":"smoke: bad theme","screen":"smoke","screenLabel":"smoke","theme":{"mode":"neon"}}' "$API")
check "$(printf '%s' "$BAD_R" | jq_ 'print(d.get("thread",{}).get("theme"))')" "None" "a theme it cannot use is dropped, not stored"
# Both go: a smoke run must leave a real deployment exactly as it found it.
for id in "$THEME_ID" "$(printf '%s' "$BAD_R" | jq_ 'print(d.get("thread",{}).get("id",""))')"; do
  curl -s -o /dev/null -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d '{"action":"delete","threadId":"'"$id"'"}' "$API"
done

LEARN=$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' \
  -d '{"action":"create","text":"smoke: learns the way","screen":"smoke","screenLabel":"smoke","anchor":{"path":"body"}}' \
  "$API" | jq_ 'print(d.get("thread",{}).get("id",""))')
TRAIL='{"action":"trail","threadId":"'"$LEARN"'","trail":[{"anchor":{"path":"#row","t":"button","txt":"Acme"},"txt":"Acme"}]}'
check "$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d "$TRAIL" "$API" | jq_ 'print(len(d.get("thread",{}).get("trail",[])), d["thread"]["trail"][0]["txt"])')" "1 Acme" "a comment can be taught the way back"
RETEACH='{"action":"trail","threadId":"'"$LEARN"'","trail":[{"anchor":{"path":"#other","t":"button","txt":"Other"},"txt":"Other"}]}'
check "$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d "$RETEACH" "$API" | jq_ 'print(d["thread"]["trail"][0]["txt"])')" "Acme" "and is not re-taught once it knows"
curl -s -o /dev/null -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d '{"action":"delete","threadId":"'"$LEARN"'"}' "$API"

# A room can be moved in: verbatim, designer-only, and idempotent.
IMP='{"action":"import","threads":[{"id":"55555555-5555-4555-8555-555555555555","createdAt":1000,"authorRole":"client","author":"Olena","screen":"smoke","screenLabel":"smoke","n":9001,"messages":[{"author":"Olena","role":"client","text":"smoke: moved in","at":1000}]}]}'
check "$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d "$IMP" "$API" | jq_ 'print(d.get("imported"))')" "1" "a room can be moved in"
check "$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" "$API" | jq_ 't=[x for x in d["threads"] if x["id"]=="55555555-5555-4555-8555-555555555555"]; print(t[0]["author"], t[0]["n"], t[0]["createdAt"]) if t else print("missing")')" "Olena 9001 1000" "with its author, number and time"
check "$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d "$IMP" "$API" | jq_ 'print(d.get("skipped"))')" "1" "and a second run adds nothing"
check "$(curl -s -b "$TMP/client.jar" -K "$TMP/client.conf" -H 'Content-Type: application/json' -d "$IMP" "$API" | jq_ 'print(d.get("error"))')" "Not allowed" "a client cannot move a room in"
curl -s -o /dev/null -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d '{"action":"delete","threadId":"55555555-5555-4555-8555-555555555555"}' "$API"

EDGE='{"action":"edge","from":"smoke-a","to":"smoke-b","anchor":{"path":"a#r","t":"a","txt":"Go"},"trail":[{"anchor":{"path":"button#adv","t":"button","txt":"Advanced"},"txt":"Advanced"}]}'
curl -s -o /dev/null -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d "$EDGE" "$API"
check "$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" "$API" | jq_ 'print(d.get("navTrail",{}).get("smoke-a>smoke-b",[{}])[0].get("txt"))')" "Advanced" "an edge keeps the steps that reach its control"
# An edge cannot be deleted, so keep the two test screens off everyone's map.
for L in smoke-a smoke-b; do
  curl -s -o /dev/null -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d '{"action":"mapmeta","hide":"'"$L"'"}' "$API"
done
check "$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" "$API" | jq_ 'h=d.get("mapmeta",{}).get("hidden",[]); print(int("smoke-a" in h and "smoke-b" in h))')" 1 "cleanup: the test screens are hidden from the map"

# Concurrency: parallel writers must retry, never 500 (Blob reports an in-flight
# collision differently from a stale ETag, and the difference used to leak out).
RACE_TMP=$(mktemp -d)
for i in 1 2 3 4 5 6; do
  ( curl -s -o "$RACE_TMP/$i.json" -w '%{http_code}\n' -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' \
      -d "{\"action\":\"create\",\"text\":\"smoke race $i\",\"screen\":\"smoke\",\"screenLabel\":\"smoke\",\"anchor\":{\"path\":\"body\"}}" \
      "$API" > "$RACE_TMP/$i.code" ) &
done
wait
check "$(cat "$RACE_TMP"/*.code | sort -u | tr -d '\n')" 200 "6 concurrent comments all succeed"
check "$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" "$API" | jq_ 'ns=[t["n"] for t in d["threads"] if t["messages"][0]["text"].startswith("smoke race ")]; print(len(ns), len(set(ns)))')" "6 6" "6 concurrent comments, 6 unique numbers"
for id in $(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" "$API" | jq_ 'print(" ".join(t["id"] for t in d["threads"] if t["messages"][0]["text"].startswith("smoke race ")))'); do
  curl -s -o /dev/null -b "$TMP/team.jar" -K "$TMP/team.conf" -H 'Content-Type: application/json' -d "{\"action\":\"delete\",\"threadId\":\"$id\"}" "$API"
done
check "$(curl -s -b "$TMP/team.jar" -K "$TMP/team.conf" "$API" | jq_ 'print(sum(1 for t in d["threads"] if t["messages"][0]["text"].startswith("smoke race ")))')" 0 "cleanup: race comments removed"
rm -rf "$RACE_TMP"

[ $fail = 0 ] && echo "ALL OK" || { echo "SMOKE FAILED"; exit 1; }
