#!/bin/bash
# Full check: unit tests, then against throwaway local copies (wrangler dev + local D1):
#   :8787  the browser suite (e2e.mjs), the profile sync suite (sync.mjs) and the Claude connector suite (mcp.mjs)
#   :8788  the messages hardening suite (chat.mjs), started with AI_FORCE_BAD=1 so no real AI allowance is spent
# Usage (from anywhere):  bash test/run.sh            local only
#                         bash test/run.sh remote     also against the deployed Worker (makes and deletes ZZ test people)
set -e
W="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d /tmp/lector-chat-test-XXXX)"; export LECTOR_TEST_DIR="$T"
unset CLOUDFLARE_ACCOUNT_ID
node "$W/test/unit.mjs" "$W"
mkdir -p "$T/cw" && cp -R "$W/src" "$W/migrations" "$W/package.json" "$W/wrangler.toml" "$T/cw/" && ln -s "$W/node_modules.nosync" "$T/cw/node_modules"
node "$W/test/gkeys.mjs" "$T"
(cd "$T/cw" && npx wrangler@3 d1 migrations apply lector-chat --local --persist-to "$T/state" >/dev/null)
(cd "$T/cw" && npx wrangler@3 d1 migrations apply lector-chat --local --persist-to "$T/state-bad" >/dev/null)
# SIGNUP:open on the throwaway local copy only: the suite tests account creation; the deployed Worker stays "closed".
(cd "$T/cw" && npx wrangler@3 dev --local --port 8787 --inspector-port 9231 --persist-to "$T/state" --var SIGNUP:open > "$T/dev.log" 2>&1) &
(cd "$T/cw" && npx wrangler@3 dev --local --port 8788 --inspector-port 9232 --persist-to "$T/state-bad" --var AI_FORCE_BAD:1 > "$T/dev-bad.log" 2>&1) &
trap 'pkill -f "wrangler.*dev --local --port 878[78]" 2>/dev/null; rm -rf "$T"' EXIT
for i in $(seq 1 60); do curl -s localhost:8787/ >/dev/null 2>&1 && curl -s localhost:8788/ >/dev/null 2>&1 && break; sleep 0.5; done
node "$W/test/e2e.mjs" local "$T/cw"
node "$W/test/sync.mjs" local "$T/cw"
node "$W/test/mcp.mjs" local "$T/cw"
node "$W/test/chat.mjs" "$T" "$T/cw"
# remote: each suite runs even if one before it failed (e2e remote fails its 4 sign-up checks while SIGNUP is "closed")
R=0
if [ "$1" = remote ]; then
  node "$W/test/e2e.mjs" remote "$W" || R=1
  node "$W/test/sync.mjs" remote "$W" || R=1
  node "$W/test/mcp.mjs" remote "$W" || R=1
fi
exit $R
