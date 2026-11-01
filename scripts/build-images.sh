#!/usr/bin/env bash
# Builds the server and web images for linux/arm64 and linux/amd64.
#
#   scripts/build-images.sh                      build each platform separately into the local image store
#                                                (tags nocon-brain/<svc>:<version>-arm64 and -amd64)
#   scripts/build-images.sh --platform arm64     one platform only
#   scripts/build-images.sh --oci DIR            multi-platform OCI archives in DIR (cannot be --load-ed)
#   scripts/build-images.sh --push REGISTRY      multi-platform build pushed to REGISTRY/nocon-brain/<svc>:<version>
#
# Options: --no-cache, --version TAG (default: $NCB_VERSION or "latest"), --services "server web".
# The non-native platform of the server image runs only the small `native` stage under emulation (QEMU). The web
# build stage and the server bundle always run on the build platform, so no `next build` runs under QEMU.
# A summary with build times and image sizes is printed at the end (and written to $NCB_BUILD_SUMMARY if set).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
die() { echo "error: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker buildx version >/dev/null 2>&1 || die "docker buildx is not available"

VERSION="${NCB_VERSION:-latest}"
SERVICES="server web"
PLATFORMS="arm64 amd64"
MODE="local" TARGET="" NOCACHE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --push) MODE=push; TARGET="${2:?--push needs a registry}"; shift 2 ;;
    --oci) MODE=oci; TARGET="${2:?--oci needs a directory}"; shift 2 ;;
    --platform) PLATFORMS="${2:?}"; shift 2 ;;
    --version) VERSION="${2:?}"; shift 2 ;;
    --services) SERVICES="${2:?}"; shift 2 ;;
    --no-cache) NOCACHE="--no-cache"; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

SUMMARY=()

build() { # service platform-list tag-suffix output-args...
  local svc="$1" plats="$2" suffix="$3"; shift 3
  local start end
  start="$(date +%s)"
  # shellcheck disable=SC2086
  docker buildx build --platform "$plats" -f "docker/$svc/Dockerfile" $NOCACHE "$@" .
  end="$(date +%s)"
  local size="n/a"
  if [[ "$MODE" == "local" ]]; then
    local bytes
    bytes="$(docker image inspect "nocon-brain/$svc:$VERSION-$suffix" --format '{{.Size}}' 2>/dev/null || echo 0)"
    size="$((bytes / 1000000)) MB"
  fi
  SUMMARY+=("$(printf '%-8s %-14s %6ss  %s' "$svc" "${suffix:-multi}" "$((end - start))" "$size")")
}

case "$MODE" in
  local)
    for p in $PLATFORMS; do
      for svc in $SERVICES; do
        echo "==> $svc linux/$p"
        extra=()
        [[ "$svc" == "server" ]] && extra=(--target runtime)
        build "$svc" "linux/$p" "$p" --load ${extra[@]+"${extra[@]}"} -t "nocon-brain/$svc:$VERSION-$p"
      done
    done ;;
  oci)
    mkdir -p "$TARGET"
    for svc in $SERVICES; do
      echo "==> $svc linux/arm64,linux/amd64 -> $TARGET/$svc.oci.tar"
      extra=()
      [[ "$svc" == "server" ]] && extra=(--target runtime)
      build "$svc" "linux/arm64,linux/amd64" "" ${extra[@]+"${extra[@]}"} -o "type=oci,dest=$TARGET/$svc.oci.tar" -t "nocon-brain/$svc:$VERSION"
    done ;;
  push)
    for svc in $SERVICES; do
      echo "==> $svc linux/arm64,linux/amd64 -> $TARGET"
      extra=()
      [[ "$svc" == "server" ]] && extra=(--target runtime)
      build "$svc" "linux/arm64,linux/amd64" "" ${extra[@]+"${extra[@]}"} --push -t "$TARGET/nocon-brain/$svc:$VERSION"
    done ;;
esac

echo
echo "Build summary (service, platform, build time, image size as reported by docker image inspect):"
printf '  %s\n' "${SUMMARY[@]}"
if [[ -n "${NCB_BUILD_SUMMARY:-}" ]]; then printf '%s\n' "${SUMMARY[@]}" > "$NCB_BUILD_SUMMARY"; fi
