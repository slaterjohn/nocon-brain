#!/usr/bin/env bash
# Search benchmark harness (S-13), same pattern as run.sh. Runs scripts/search/bench.ts (bundled into the `bench` target of the
# server image) in a container with a hard memory limit and no swap, once per size and limit, and writes one JSON file.
#
#   scripts/bench/search.sh [options]
#     --platform arm64|amd64   image platform (default arm64)
#     --limits "512m 1g"       memory limits (default "512m 1g")
#     --sizes "50000 500000"   document counts (default "50000 500000"; above 50,000 the corpus is expanded deterministically)
#     --runs N                 runs per size and limit (default 1)
#     --out DIR                where the JSON goes (default bench-results/)
#     --no-build               reuse the image nocon-brain/server:bench-<platform>
#
# The corpus (docs/research/search-bench/data/corpus.jsonl) is a test-only artefact built by build_corpus.py from the Simple English
# Wikipedia dump; it is mounted read-only. "pi" in the output says "not a Pi" unless /proc/device-tree/model names a Raspberry Pi.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
die() { echo "error: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || die "docker is not installed"
PLATFORM=arm64 LIMITS="512m 1g" SIZES="50000 500000" RUNS=1 OUT=bench-results BUILD=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="${2:?}"; shift 2 ;;
    --limits) LIMITS="${2:?}"; shift 2 ;;
    --sizes) SIZES="${2:?}"; shift 2 ;;
    --runs) RUNS="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -f docs/research/search-bench/data/corpus.jsonl ]] || die "corpus missing: see docs/research/search-bench/build_corpus.py"
IMAGE="nocon-brain/server:bench-$PLATFORM"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ncb-sbench.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"
if [[ $BUILD -eq 1 ]]; then
  echo "==> Building $IMAGE"
  docker buildx build --platform "linux/$PLATFORM" -f docker/server/Dockerfile --target bench --load -t "$IMAGE" .
fi
node scripts/bench/host.mjs > "$WORK/host.json"
RUN_FILES=()
for size in $SIZES; do
  for limit in $LIMITS; do
    for i in $(seq 1 "$RUNS"); do
      echo "==> $size docs, limit $limit, run $i of $RUNS"
      out="$WORK/run-$size-$limit-$i.out"
      rc=0
      start="$(date +%s)"
      docker run --rm --platform "linux/$PLATFORM" --memory "$limit" --memory-swap "$limit" \
        --read-only --mount type=volume,target=/tmp --cap-drop ALL --security-opt no-new-privileges:true \
        -v "$PWD/docs/research/search-bench/data/corpus.jsonl:/corpus.jsonl:ro" -v "$PWD/docs/research/search-bench/queries.json:/queries.json:ro" \
        --entrypoint sh "$IMAGE" -c \
        "NCB_SEARCH_TRACE=1 node bench/bench-search.js --docs=$size --dir=/tmp/idx --corpus=/corpus.jsonl --queries=/queries.json && echo PEAK=\$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo 0)" \
        > "$out" 2> "$out.err" || rc=$?
      end="$(date +%s)"
      if [[ $rc -ne 0 ]]; then echo "    exit $rc; last stderr lines:"; tail -n 6 "$out.err" | sed 's/^/    /'; fi
      node - "$out" "$size" "$limit" "$i" "$rc" "$((end - start))" > "$WORK/run-$size-$limit-$i.json" <<'JS'
const fs = require("node:fs");
const [file, size, limit, run, rc, wall] = process.argv.slice(2);
const text = fs.readFileSync(file, "utf8");
const peak = /PEAK=(\d+)/.exec(text);
let result = null;
try { result = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { /* run failed */ }
console.log(JSON.stringify({ docs: Number(size), memoryLimit: limit, run: Number(run), exitCode: Number(rc), oom: Number(rc) === 137, wallSeconds: Number(wall), peakMemoryMiB: peak ? Math.round(Number(peak[1]) / 1048576) : null, result }));
JS
      RUN_FILES+=("$WORK/run-$size-$limit-$i.json")
    done
  done
done
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT/search-$PLATFORM-$STAMP.json"
BENCH_NAME=search node scripts/bench/assemble.mjs "$WORK/host.json" "$IMAGE" "linux/$PLATFORM" "${RUN_FILES[@]}" > "$FILE"
echo "==> Wrote $FILE"
