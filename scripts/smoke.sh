#!/usr/bin/env bash
# Post-deploy checks for a share-proto deployment. Usage:
#   scripts/smoke.sh https://<domain> <team-password> <client-password>
set -u
D=${1:?domain}; TEAM=${2:?team password}; CLIENT=${3:?client password}
D=${D%/}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail=0
check() { if [ "$1" = "$2" ]; then echo "  ok   $3"; else echo "  FAIL $3 (got: $1, want: $2)"; fail=1; fi; }
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
TID=$(curl -s -D "$TMP/create.h" -b "$TMP/team.jar" -H 'Content-Type: application/json' \
  -d '{"action":"create","text":"smoke (designer)","screen":"smoke","screenLabel":"smoke","anchor":{"path":"body"}}' \
  "$D/api/comments" | jq_ 'print(d.get("thread",{}).get("id",""))')
check "$(grep -i '^x-store-path:' "$TMP/create.h" | tr -d '\r' | awk '{print $2}')" patch "create took the fast path (no rebuild, no list)"
check "$(curl -s -b "$TMP/client.jar" "$D/api/comments" | grep -c "$TID")" 0 "client does not see designer thread"
check "$(curl -s -b "$TMP/team.jar" "$D/api/comments" | grep -c "$TID")" 1 "designer sees own thread"
REPLY='{"action":"reply","threadId":"'"$TID"'","text":"x"}'
check "$(code -b "$TMP/client.jar" -H 'Content-Type: application/json' -d "$REPLY" "$D/api/comments")" 404 "client cannot reply to designer thread"
check "$(code -b "$TMP/client.jar" "$D/api/file?p=previews/$TID/x.jpg")" 404 "client cannot fetch media of a designer thread"
DELETE='{"action":"delete","threadId":"'"$TID"'"}'
check "$(code -b "$TMP/team.jar" -H 'Content-Type: application/json' -d "$DELETE" "$D/api/comments")" 200 "cleanup: delete smoke thread"
check "$(code "$D/api/file?p=previews/x/y.jpg")" 401 "GET /api/file without cookie → 401"

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
