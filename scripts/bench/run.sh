#!/usr/bin/env bash
# Queue benchmark harness (F-14). Runs scripts/bench-queue.ts, bundled into the `bench` target of the server image,
# inside a container with a hard memory limit, once per limit and per run, and records one JSON file.
#
#   scripts/bench/run.sh [options]
#     --platform arm64|amd64   image platform (default arm64; the other one runs under emulation if it is not native)
#     --limits "512m 1g"       memory limits to test (default "512m 1g")
#     --runs N                 runs per limit (default 3)
#     --total N --hosts N      queue size and host count passed to the benchmark (defaults 50000 and 500)
#     --out DIR                where the JSON goes (default bench-results/)
#     --no-build               reuse the image nocon-brain/server:bench-<platform>
#
# Each run uses a disk-backed /tmp (an anonymous Docker volume, removed afterwards), a read-only root and no swap.
# A run that is killed for running out of memory is recorded as oom: true. The output file records host details;
# "pi" says "not a Pi" unless /proc/device-tree/model names a Raspberry Pi. See docs/benchmarks.md.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
die() { echo "error: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || die "docker is not installed"
command -v node >/dev/null 2>&1 || die "node is needed on the host to assemble the JSON (Node 24)"

PLATFORM=arm64 LIMITS="512m 1g" RUNS=3 TOTAL=50000 HOSTS=500 OUT=bench-results BUILD=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="${2:?}"; shift 2 ;;
    --limits) LIMITS="${2:?}"; shift 2 ;;
    --runs) RUNS="${2:?}"; shift 2 ;;
    --total) TOTAL="${2:?}"; shift 2 ;;
    --hosts) HOSTS="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

IMAGE="nocon-brain/server:bench-$PLATFORM"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ncb-bench.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

if [[ $BUILD -eq 1 ]]; then
  echo "==> Building $IMAGE"
  docker buildx build --platform "linux/$PLATFORM" -f docker/server/Dockerfile --target bench --load -t "$IMAGE" .
fi

node scripts/bench/host.mjs > "$WORK/host.json"

RUN_FILES=()
for limit in $LIMITS; do
  for i in $(seq 1 "$RUNS"); do
    echo "==> limit $limit, run $i of $RUNS"
    out="$WORK/run-$limit-$i.out"
    rc=0
    start="$(date +%s)"
    # Prints the benchmark JSON, then the container's peak memory (cgroup v2 memory.peak) as the last line.
    docker run --rm --platform "linux/$PLATFORM" --memory "$limit" --memory-swap "$limit" \
      --read-only --mount type=volume,target=/tmp --cap-drop ALL --security-opt no-new-privileges:true \
      --entrypoint sh "$IMAGE" -c \
      "node bench/bench-queue.js --total=$TOTAL --hosts=$HOSTS && echo PEAK=\$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo 0)" \
      > "$out" 2> "$out.err" || rc=$?
    end="$(date +%s)"
    node - "$out" "$limit" "$i" "$rc" "$((end - start))" > "$WORK/run-$limit-$i.json" <<'JS'
const fs = require("node:fs");
const [file, limit, run, rc, wall] = process.argv.slice(2);
const text = fs.readFileSync(file, "utf8");
const peak = /PEAK=(\d+)/.exec(text);
const start = text.indexOf("{");
const end = text.lastIndexOf("}");
let result = null;
try { result = JSON.parse(text.slice(start, end + 1)); } catch { /* run failed */ }
console.log(JSON.stringify({
  memoryLimit: limit, run: Number(run), exitCode: Number(rc), oom: Number(rc) === 137,
  wallSeconds: Number(wall), peakMemoryMiB: peak ? Math.round(Number(peak[1]) / 1048576) : null, result,
}));
JS
    RUN_FILES+=("$WORK/run-$limit-$i.json")
  done
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT/queue-$PLATFORM-$STAMP.json"
node scripts/bench/assemble.mjs "$WORK/host.json" "$IMAGE" "linux/$PLATFORM" "${RUN_FILES[@]}" > "$FILE"
echo "==> Wrote $FILE"
node -e '
const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log("host:", d.host.cpu, "|", d.host.arch, "|", d.host.memoryGiB, "GiB |", d.host.pi);
for (const r of d.runs) console.log(r.memoryLimit.padEnd(5), "run", r.run, r.oom ? "OOM" : "exit " + r.exitCode,
  r.result ? `${r.result.msPerCycle} ms/cycle, ${r.result.cyclesPerSecond}/s, insert ${r.result.insertMs} ms` : "no result", "peak", r.peakMemoryMiB, "MiB");
' "$FILE"
