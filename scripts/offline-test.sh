#!/usr/bin/env bash
# Brings the stack up with NO internet access for any service, runs tests/offline/check.mjs from a container on
# the internal network, then tears everything down.
#   scripts/offline-test.sh [--keep]     --keep leaves the stack running for debugging
# Needs Docker with Compose v2.24 or later. Builds the images first (set NCB_SKIP_BUILD=1 to use images that exist).
# To test the other architecture: NCB_SKIP_BUILD=1 NCB_VERSION=latest-amd64 DOCKER_DEFAULT_PLATFORM=linux/amd64 scripts/offline-test.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-ncb-offline}"
export NCB_PROXY_SECRET="${NCB_PROXY_SECRET:-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')}"
# A throwaway .env must not leak into this run, so an empty env file is used for interpolation and nothing else.
DC=(docker compose --env-file /dev/null -f compose.yml -f compose.offline.yml)

cleanup() {
  local rc=$?
  if [[ $KEEP -eq 0 ]]; then
    "${DC[@]}" --profile offline-test down -v --remove-orphans >/dev/null 2>&1 || true
  else
    echo "Stack left running (project $COMPOSE_PROJECT_NAME). Remove it with:"
    echo "  COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME NCB_PROXY_SECRET=x docker compose --env-file /dev/null -f compose.yml -f compose.offline.yml --profile offline-test down -v"
  fi
  exit "$rc"
}
trap cleanup EXIT

if [[ "${NCB_SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> Building images (cached if unchanged)"
  "${DC[@]}" build server web
fi

echo "==> Starting stack (internal networks only)"
"${DC[@]}" up -d --wait server web

echo "==> Egress proof from the service containers"
rc_egress=0
for svc in server web; do
  if "${DC[@]}" exec -T "$svc" node -e "fetch('https://example.com',{signal:AbortSignal.timeout(6000)}).then(()=>process.exit(1),()=>process.exit(0))"; then
    echo "PASS  $svc cannot reach https://example.com"
  else
    echo "FAIL  $svc REACHED https://example.com"
    rc_egress=1
  fi
done
# An IP literal proves the block is the network, not DNS.
if "${DC[@]}" exec -T server node -e "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(6000)}).then(()=>process.exit(1),()=>process.exit(0))"; then
  echo "PASS  server cannot reach http://1.1.1.1"
else
  echo "FAIL  server REACHED http://1.1.1.1"
  rc_egress=1
fi

echo "==> Running checks from a container on the internal network"
rc_checks=0
"${DC[@]}" --profile offline-test run --rm offline-test || rc_checks=$?

if [[ $rc_egress -ne 0 || $rc_checks -ne 0 ]]; then
  echo "OFFLINE TEST: FAIL (egress=$rc_egress checks=$rc_checks)"
  "${DC[@]}" logs --tail 40 server web 2>&1 || true
  exit 1
fi
echo "OFFLINE TEST: PASS"
