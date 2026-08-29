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
role_of() { python3 -c 'import json,sys; print(json.load(sys.stdin).get("role"))'; }

echo "share-proto smoke → $D"
check "$(curl -s "$D/" | grep -c 'protected prototype')" 1 "GET / without cookie shows login page"
check "$(login team "$TEAM" | role_of)" designer "team password → designer"
check "$(login client "$CLIENT" | role_of)" client "client password → client"
check "$(code -H 'Content-Type: application/json' -d '{"password":"nope","name":"x"}' "$D/api/login")" 401 "wrong password → 401"
check "$(code "$D/api/comments")" 401 "GET /api/comments without cookie → 401"
check "$(curl -s -b "$TMP/team.jar" "$D/" | grep -c 'overlay.js')" 1 "designer sees prototype with overlay"
check "$(curl -s -b "$TMP/team.jar" "$D/api/comments" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["role"], isinstance(d["threads"], list))')" "designer True" "designer GET /api/comments"

# Role isolation: a designer-created thread must be invisible to the client.
TID=$(curl -s -b "$TMP/team.jar" -H 'Content-Type: application/json' \
  -d '{"action":"create","text":"smoke (designer)","screen":"smoke","screenLabel":"smoke","anchor":{"path":"body"}}' \
  "$D/api/comments" | python3 -c 'import json,sys; print(json.load(sys.stdin)["thread"]["id"])')
check "$(curl -s -b "$TMP/client.jar" "$D/api/comments" | grep -c "$TID")" 0 "client does not see designer thread"
check "$(curl -s -b "$TMP/team.jar" "$D/api/comments" | grep -c "$TID")" 1 "designer sees own thread"
REPLY='{"action":"reply","threadId":"'"$TID"'","text":"x"}'
check "$(code -b "$TMP/client.jar" -H 'Content-Type: application/json' -d "$REPLY" "$D/api/comments")" 404 "client cannot reply to designer thread"
DELETE='{"action":"delete","threadId":"'"$TID"'"}'
check "$(code -b "$TMP/team.jar" -H 'Content-Type: application/json' -d "$DELETE" "$D/api/comments")" 200 "cleanup: delete smoke thread"
check "$(code "$D/api/file?p=previews/x/y.jpg")" 401 "GET /api/file without cookie → 401"

[ $fail = 0 ] && echo "ALL OK" || { echo "SMOKE FAILED"; exit 1; }
