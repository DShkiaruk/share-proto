#!/usr/bin/env bash
# Proof that moving a room moves the room. Boots two real servers — the
# zero-dependency edition and the Cloudflare Worker under `wrangler dev` —
# fills the first with the kinds of things a review leaves behind, runs
# scripts/move-room.mjs, and compares what arrived against what was sent.
#
#   bash scripts/move-smoke.sh
#
# The pair is the same shape as the move people actually make (a Vercel
# deployment into a Worker): different storage, same API on both ends.
set -u
cd "$(dirname "$0")/.."

SRC_PORT=4183
DST_PORT=4185
SRC="http://127.0.0.1:$SRC_PORT"
DST="http://127.0.0.1:$DST_PORT"
TEAM=move-team
CLIENT=move-client
TMP=$(mktemp -d)

cleanup() {
  [ -n "${SRC_PID:-}" ] && kill "$SRC_PID" 2>/dev/null
  if [ -n "${DST_PID:-}" ]; then
    kill "$DST_PID" 2>/dev/null
    for _ in 1 2 3 4 5; do kill -0 "$DST_PID" 2>/dev/null || break; sleep 1; done
    pkill -P "$DST_PID" 2>/dev/null
    kill -9 "$DST_PID" 2>/dev/null
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

fail=0
check() { if [ "$1" = "$2" ]; then echo "  ok   $3"; else echo "  FAIL $3 (got: $1, want: $2)"; fail=1; fi; }
jq_() { python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit(0)
$1" 2>/dev/null; }

# ---- the source: the local edition, filled by hand -------------------------
rm -rf "$TMP/site"
python3 scripts/assemble.py tests/fixtures/proto.html "$TMP/site" >/dev/null
( cd "$TMP/site" && DESIGNER_PASSWORD=$TEAM CLIENT_PASSWORD=$CLIENT SESSION_SECRET=move-secret \
    node server.js --port $SRC_PORT >"$TMP/src.log" 2>&1 ) &
SRC_PID=$!
for _ in $(seq 1 40); do curl -sf "$SRC/login.html" >/dev/null && break; sleep 0.25; done

api() { curl -s -b "$TMP/$1.jar" -H 'Content-Type: application/json' -d "$2" "$SRC/api/comments"; }
curl -s -c "$TMP/team.jar" -H 'Content-Type: application/json' -d "{\"password\":\"$TEAM\",\"name\":\"Dima\"}" "$SRC/api/login" >/dev/null
curl -s -c "$TMP/client.jar" -H 'Content-Type: application/json' -d "{\"password\":\"$CLIENT\",\"name\":\"Olena\"}" "$SRC/api/login" >/dev/null
PNG="data:image/png;base64,$(base64 < tests/fixtures/pixel.png | tr -d '\n')"

# A client's comment with a picture, a designer's reply, a status, a reaction,
# a kind, a learned transition and a screen shot — one of each thing that moves.
T1=$(api client '{"action":"create","text":"the label is cut off","screen":"home","screenLabel":"Home","anchor":{"path":"h1","t":"h1","txt":"Home"},"kind":"bug","theme":{"mode":"dark","marks":{"html":{"cls":["dark"],"attrs":{}}}}}' | jq_ 'print(d["thread"]["id"])')
api team "{\"action\":\"preview\",\"threadId\":\"$T1\",\"image\":\"$PNG\"}" >/dev/null
api team "{\"action\":\"reply\",\"threadId\":\"$T1\",\"text\":\"widened it\"}" >/dev/null
api team "{\"action\":\"status\",\"threadId\":\"$T1\",\"status\":\"progress\"}" >/dev/null
AT=$(curl -s -b "$TMP/team.jar" "$SRC/api/comments" | jq_ "print([t for t in d['threads'] if t['id']=='$T1'][0]['messages'][0]['at'])")
api client "{\"action\":\"react\",\"threadId\":\"$T1\",\"at\":$AT,\"emoji\":\"👍\",\"on\":true}" >/dev/null
api team '{"action":"create","text":"about this screen","screen":"settings","screenLabel":"Settings"}' >/dev/null
api team '{"action":"edge","from":"Home","to":"Settings","anchor":{"path":"a","t":"a","txt":"Settings"}}' >/dev/null
api team "{\"action\":\"shot\",\"label\":\"Settings\",\"image\":\"$PNG\"}" >/dev/null
api team '{"action":"mapmeta","alias":{"label":"Home","name":"Start"}}' >/dev/null

BEFORE=$(curl -s -b "$TMP/team.jar" "$SRC/api/comments")
echo "$BEFORE" > "$TMP/before.json"
SRC_THREADS=$(printf '%s' "$BEFORE" | jq_ 'print(len(d["threads"]))')
echo "source: $SRC_THREADS threads"

# ---- the target: a real Worker --------------------------------------------
if [ ! -x worker/node_modules/.bin/wrangler ]; then
  echo "  n/a  wrangler is not installed — run: (cd worker && npm install)"
  exit 0
fi
rm -rf worker/.wrangler/move-state
( cd worker && exec ./node_modules/.bin/wrangler dev --ip 127.0.0.1 --port $DST_PORT --log-level warn \
    --persist-to .wrangler/move-state \
    --var DESIGNER_PASSWORD:$TEAM --var CLIENT_PASSWORD:$CLIENT --var SESSION_SECRET:move-secret \
    >"$TMP/dst.log" 2>&1 ) &
DST_PID=$!
for _ in $(seq 1 120); do curl -sf "$DST/overlay.js" >/dev/null && break; sleep 0.5; done
curl -sf "$DST/overlay.js" >/dev/null || { echo "  FAIL the worker never came up"; tail -5 "$TMP/dst.log"; exit 1; }

# ---- the move --------------------------------------------------------------
node scripts/move-room.mjs --from "$SRC" --from-password "$TEAM" --to "$DST" --to-password "$TEAM" --to-room moved
MOVED=$?
check "$MOVED" 0 "the move reports success"

TOKEN=$(curl -s -H 'Content-Type: application/json' -d "{\"password\":\"$TEAM\",\"name\":\"Check\"}" "$DST/api/login?room=moved" | jq_ 'print(d["token"])')
[ -n "$TOKEN" ] || { echo "  FAIL could not sign in to the worker"; exit 1; }
curl -s -H "Authorization: Bearer $TOKEN" "$DST/api/comments?room=moved" > "$TMP/after.json"

py() { python3 - "$TMP/before.json" "$TMP/after.json" <<PY
import json,sys
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
$1
PY
}
check "$(py 'print(len(b["threads"]))')" "$SRC_THREADS" "every thread arrived"
check "$(py 'print(sorted(t["n"] for t in b["threads"]) == sorted(t["n"] for t in a["threads"]))')" True "the numbers people refer to are unchanged"
check "$(py 'x=[t for t in b["threads"] if t["messages"][0]["text"]=="the label is cut off"][0]; print(x["author"], x["authorRole"], x["status"], x["kind"])')" "Olena client progress bug" "author, side, status and kind came across"
check "$(py 'x=[t for t in b["threads"] if t["messages"][0]["text"]=="the label is cut off"][0]; y=[t for t in a["threads"] if t["id"]==x["id"]][0]; print(x["createdAt"]==y["createdAt"], [m["at"] for m in x["messages"]]==[m["at"] for m in y["messages"]])')" "True True" "the times are the original ones, not the move's"
check "$(py 'x=[t for t in b["threads"] if t["messages"][0]["text"]=="the label is cut off"][0]; print(x["messages"][0].get("reactions"), x["theme"]["mode"])')" "{'👍': ['Olena']} dark" "reactions and the state it was left in"
check "$(py 'print(len(b["nav"]), sorted(b["shots"]) == sorted(a["shots"]), b["mapmeta"]["aliases"].get("Home"))')" "1 True Start" "the learned map, the screens and their names"

# The pictures are not just referenced, they are there.
SHOT=$(py 'print(list(b["shots"].values())[0])')
check "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$DST/api/file?p=$SHOT&room=moved")" 200 "a picture opens on the far side"

# Running it again is a resume, not a second copy.
node scripts/move-room.mjs --from "$SRC" --from-password "$TEAM" --to "$DST" --to-password "$TEAM" --to-room moved >"$TMP/again.log" 2>&1
check "$(grep -c 'threads: 0 moved' "$TMP/again.log")" 1 "a second run adds nothing"
check "$(curl -s -H "Authorization: Bearer $TOKEN" "$DST/api/comments?room=moved" | jq_ 'print(len(d["threads"]))')" "$SRC_THREADS" "and the room is still the same size"

# The source is untouched: the old link keeps working while you check the new one.
check "$(curl -s -b "$TMP/team.jar" "$SRC/api/comments" | jq_ 'print(len(d["threads"]))')" "$SRC_THREADS" "the source is left exactly as it was"

[ "$fail" = 0 ] && echo "ALL OK" || echo "SOME CHECKS FAILED"
exit "$fail"
