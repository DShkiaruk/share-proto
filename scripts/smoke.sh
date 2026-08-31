#!/usr/bin/env bash
# Post-deploy checks for a share-proto deployment. Usage:
#   scripts/smoke.sh https://<domain> <team-password> <client-password>
set -u
D=${1:?domain}; TEAM=${2:?team password}; CLIENT=${3:?client password}
D=${D%/}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail=0
check() { if [ "$1" = "$2" ]; then echo "  ok   $3"; else echo "  FAIL $3 (got: $1, want: $2)"; fail=1; fi; }
skip() { echo "  n/a  $1"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
login() { curl -s -c "$TMP/$1.jar" -H 'Content-Type: application/json' -d '{"password":"'"$2"'","name":"smoke-'"$1"'"}' "$D/api/login"; }
# Non-JSON bodies (500 pages) print an empty value instead of a traceback.
jq_() { python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit(0)
$1" 2>/dev/null; }
role_of() { jq_ 'print(d.get("role",""))'; }

echo "share-proto smoke → $D"
check "$(curl -s "$D/" | grep -c 'protected prototype')" 1 "GET / without cookie shows login page"
check "$(login team "$TEAM" | role_of)" designer "team password → designer"
check "$(login client "$CLIENT" | role_of)" client "client password → client"
check "$(code -H 'Content-Type: application/json' -d '{"password":"nope","name":"x"}' "$D/api/login")" 401 "wrong password → 401"
check "$(code "$D/api/comments")" 401 "GET /api/comments without cookie → 401"
check "$(curl -s -b "$TMP/team.jar" "$D/" | grep -c 'overlay.js')" 1 "designer sees prototype with overlay"
check "$(curl -s -b "$TMP/team.jar" "$D/api/comments" | jq_ 'print(d.get("role"), isinstance(d.get("threads"), list))')" "designer True" "designer GET /api/comments"

# Role isolation: a designer-created thread must be invisible to the client.
check "$(curl -s -D - -o /dev/null -b "$TMP/team.jar" "$D/api/comments" | grep -ci 'cache-control: no-store')" 1 "GET /api/comments is no-store"
# X-Store-Path names which path through the derived state document a request
# took. Only the Blob edition has such a document; local mode answers from one
# file and never sets the header, so its absence is a fact about the server,
# not a failure — but if a GET carries it, a create must too.
BLOB_BACKED=$(curl -s -D - -o /dev/null -b "$TMP/team.jar" "$D/api/comments" | grep -ci '^x-store-path:')
TID=$(curl -s -D "$TMP/create.h" -b "$TMP/team.jar" -H 'Content-Type: application/json' \
  -d '{"action":"create","text":"smoke (designer)","screen":"smoke","screenLabel":"smoke","anchor":{"path":"body"}}' \
  "$D/api/comments" | jq_ 'print(d.get("thread",{}).get("id",""))')
if [ "$BLOB_BACKED" = 1 ]; then
  check "$(grep -i '^x-store-path:' "$TMP/create.h" | tr -d '\r' | awk '{print $2}')" patch "create took the fast path (no rebuild, no list)"
else
  skip "create took the fast path — this server keeps no derived document"
fi
check "$(curl -s -b "$TMP/client.jar" "$D/api/comments" | grep -c "$TID")" 0 "client does not see designer thread"
check "$(curl -s -b "$TMP/team.jar" "$D/api/comments" | grep -c "$TID")" 1 "designer sees own thread"
REPLY='{"action":"reply","threadId":"'"$TID"'","text":"x"}'
check "$(code -b "$TMP/client.jar" -H 'Content-Type: application/json' -d "$REPLY" "$D/api/comments")" 404 "client cannot reply to designer thread"
check "$(code -b "$TMP/client.jar" "$D/api/file?p=previews/$TID/x.jpg")" 404 "client cannot fetch media of a designer thread"
DELETE='{"action":"delete","threadId":"'"$TID"'"}'
check "$(code -b "$TMP/team.jar" -H 'Content-Type: application/json' -d "$DELETE" "$D/api/comments")" 200 "cleanup: delete smoke thread"
check "$(code "$D/api/file?p=previews/x/y.jpg")" 401 "GET /api/file without cookie → 401"

# What the newest overlay needs of a server. Same checks as the Worker's own
# smoke, so a reviewer cannot tell the editions apart.
SCREEN=$(curl -s -b "$TMP/team.jar" -H 'Content-Type: application/json' \
  -d '{"action":"create","text":"smoke: about the screen","screen":"smoke","screenLabel":"smoke"}' "$D/api/comments")
SCREEN_ID=$(printf '%s' "$SCREEN" | jq_ 'print(d.get("thread",{}).get("id",""))')
check "$(printf '%s' "$SCREEN" | jq_ 'print(d.get("thread",{}).get("anchor"), d.get("thread",{}).get("trail"))')" "None []" "a comment can be about a screen, with no anchor"
curl -s -o /dev/null -b "$TMP/team.jar" -H 'Content-Type: application/json' -d '{"action":"delete","threadId":"'"$SCREEN_ID"'"}' "$D/api/comments"

LEARN=$(curl -s -b "$TMP/team.jar" -H 'Content-Type: application/json' \
  -d '{"action":"create","text":"smoke: learns the way","screen":"smoke","screenLabel":"smoke","anchor":{"path":"body"}}' \
  "$D/api/comments" | jq_ 'print(d.get("thread",{}).get("id",""))')
TRAIL='{"action":"trail","threadId":"'"$LEARN"'","trail":[{"anchor":{"path":"#row","t":"button","txt":"Acme"},"txt":"Acme"}]}'
check "$(curl -s -b "$TMP/team.jar" -H 'Content-Type: application/json' -d "$TRAIL" "$D/api/comments" | jq_ 'print(len(d.get("thread",{}).get("trail",[])), d["thread"]["trail"][0]["txt"])')" "1 Acme" "a comment can be taught the way back"
RETEACH='{"action":"trail","threadId":"'"$LEARN"'","trail":[{"anchor":{"path":"#other","t":"button","txt":"Other"},"txt":"Other"}]}'
check "$(curl -s -b "$TMP/team.jar" -H 'Content-Type: application/json' -d "$RETEACH" "$D/api/comments" | jq_ 'print(d["thread"]["trail"][0]["txt"])')" "Acme" "and is not re-taught once it knows"
curl -s -o /dev/null -b "$TMP/team.jar" -H 'Content-Type: application/json' -d '{"action":"delete","threadId":"'"$LEARN"'"}' "$D/api/comments"

EDGE='{"action":"edge","from":"smoke-a","to":"smoke-b","anchor":{"path":"a#r","t":"a","txt":"Go"},"trail":[{"anchor":{"path":"button#adv","t":"button","txt":"Advanced"},"txt":"Advanced"}]}'
curl -s -o /dev/null -b "$TMP/team.jar" -H 'Content-Type: application/json' -d "$EDGE" "$D/api/comments"
check "$(curl -s -b "$TMP/team.jar" "$D/api/comments" | jq_ 'print(d.get("navTrail",{}).get("smoke-a>smoke-b",[{}])[0].get("txt"))')" "Advanced" "an edge keeps the steps that reach its control"
# An edge cannot be deleted, so keep the two test screens off everyone's map.
for L in smoke-a smoke-b; do
  curl -s -o /dev/null -b "$TMP/team.jar" -H 'Content-Type: application/json' -d '{"action":"mapmeta","hide":"'"$L"'"}' "$D/api/comments"
done
check "$(curl -s -b "$TMP/team.jar" "$D/api/comments" | jq_ 'h=d.get("mapmeta",{}).get("hidden",[]); print(int("smoke-a" in h and "smoke-b" in h))')" 1 "cleanup: the test screens are hidden from the map"

# Concurrency: parallel writers must retry, never 500 (Blob reports an in-flight
# collision differently from a stale ETag, and the difference used to leak out).
RACE_TMP=$(mktemp -d)
for i in 1 2 3 4 5 6; do
  ( curl -s -o "$RACE_TMP/$i.json" -w '%{http_code}\n' -b "$TMP/team.jar" -H 'Content-Type: application/json' \
      -d "{\"action\":\"create\",\"text\":\"smoke race $i\",\"screen\":\"smoke\",\"screenLabel\":\"smoke\",\"anchor\":{\"path\":\"body\"}}" \
      "$D/api/comments" > "$RACE_TMP/$i.code" ) &
done
wait
check "$(cat "$RACE_TMP"/*.code | sort -u | tr -d '\n')" 200 "6 concurrent comments all succeed"
check "$(curl -s -b "$TMP/team.jar" "$D/api/comments" | jq_ 'ns=[t["n"] for t in d["threads"] if t["messages"][0]["text"].startswith("smoke race ")]; print(len(ns), len(set(ns)))')" "6 6" "6 concurrent comments, 6 unique numbers"
for id in $(curl -s -b "$TMP/team.jar" "$D/api/comments" | jq_ 'print(" ".join(t["id"] for t in d["threads"] if t["messages"][0]["text"].startswith("smoke race ")))'); do
  curl -s -o /dev/null -b "$TMP/team.jar" -H 'Content-Type: application/json' -d "{\"action\":\"delete\",\"threadId\":\"$id\"}" "$D/api/comments"
done
check "$(curl -s -b "$TMP/team.jar" "$D/api/comments" | jq_ 'print(sum(1 for t in d["threads"] if t["messages"][0]["text"].startswith("smoke race ")))')" 0 "cleanup: race comments removed"
rm -rf "$RACE_TMP"

[ $fail = 0 ] && echo "ALL OK" || { echo "SMOKE FAILED"; exit 1; }
