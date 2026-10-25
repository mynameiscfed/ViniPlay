#!/usr/bin/env bash
# Boots the ViniPlay image and checks that it serves the app.
# Usage: test/container-smoke.sh <image>   (or: npm run test:container -- <image>)
set -euo pipefail

IMAGE="${1:?usage: $0 <image>}"
NAME="viniplay-smoke-$$"
PORT="${SMOKE_PORT:-18998}"
BASE="http://127.0.0.1:${PORT}"

cleanup() {
    if [ "${ok:-0}" != 1 ]; then
        echo "---- container logs ----"
        docker logs "$NAME" 2>&1 | tail -n 100 || true
    fi
    docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$NAME" -p "${PORT}:8998" \
    -e SESSION_SECRET=ci-smoke-test-secret \
    "$IMAGE" >/dev/null

echo "Waiting for ViniPlay on ${BASE} ..."
for _ in $(seq 1 60); do
    if curl -fsS "${BASE}/api/auth/needs-setup" >/dev/null 2>&1; then break; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
        echo "Container exited early"; exit 1
    fi
    sleep 1
done

echo "Check: setup endpoint reports a fresh install"
body=$(curl -fsS "${BASE}/api/auth/needs-setup")
[[ "$body" == *'"needsSetup":true'* ]] || { echo "Unexpected response: $body"; exit 1; }

echo "Check: web UI is served"
body=$(curl -fsS "${BASE}/")
[[ "$body" == *'<title>VINI PLAY</title>'* ]] || { echo "Index page missing ViniPlay title"; exit 1; }

echo "Check: unauthenticated API calls are rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/config")
[ "$code" = 401 ] || [ "$code" = 403 ] || { echo "Expected 401/403 from /api/config, got $code"; exit 1; }

echo "Check: ffmpeg and ffprobe are installed"
docker exec "$NAME" ffmpeg -hide_banner -version >/dev/null
docker exec "$NAME" ffprobe -hide_banner -version >/dev/null

ok=1
echo "Container smoke test passed"
