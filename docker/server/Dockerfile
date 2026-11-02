# syntax=docker/dockerfile:1.7
# NoConBrain server (Fastify API, archive listener, job runner, worker threads). Build context: repository root.
#
# Targets:
#   runtime  (default) the production image
#   bench    runtime plus the queue and search benchmark bundles, used by scripts/bench/run.sh and scripts/bench/search.sh
ARG NODE_IMAGE=node:24-trixie-slim

# Every workspace package.json, found automatically, so adding a package never means editing this file. Only
# manifests are kept; the layer below this one is cached until dependencies change.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS manifests
WORKDIR /m
COPY apps apps
COPY packages packages
RUN find . -type f ! -name package.json -delete

# JavaScript only, so this stage runs on the builder's own platform (fast, no emulation).
# tsup bundles everything except the native better-sqlite3 into dist/index.js and dist/worker.js.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install
# Manifests first so the install layer is cached until dependencies change. --ignore-scripts: pnpm would otherwise run
# `node-gyp rebuild` for better-sqlite3 (it has a binding.gyp). That needs a compiler and is pointless here, because the
# addon stays external and is installed in the `native` stage below.
COPY --from=manifests /m/ ./
RUN --mount=type=cache,id=ncb-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter "@ncb/server..."
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/server apps/server
COPY scripts/bench-queue.ts scripts/bench-queue.ts
COPY scripts/search/bench.ts scripts/search/bench.ts
RUN pnpm --filter @ncb/server build
# The queue benchmark as one file, so the bench target needs no TypeScript runtime.
RUN cd apps/server && pnpm exec esbuild ../../scripts/bench-queue.ts --bundle --platform=node --format=esm --target=node24 \
      --external:better-sqlite3 \
      --alias:@ncb/db=../../packages/db/src/index.ts --alias:@ncb/shared=../../packages/shared/src/index.ts \
      --banner:js="import { createRequire as __r } from 'module'; const require = __r(import.meta.url);" \
      --outfile=dist-bench/bench-queue.js
# The search benchmark (S-13), same approach.
RUN cd apps/server && pnpm exec esbuild ../../scripts/search/bench.ts --bundle --platform=node --format=esm --target=node24 \
      --external:better-sqlite3 \
      --alias:@ncb/db=../../packages/db/src/index.ts --alias:@ncb/shared=../../packages/shared/src/index.ts \
      --banner:js="import { createRequire as __r } from 'module'; const require = __r(import.meta.url);" \
      --outfile=dist-bench/bench-search.js

# The native addons, installed on the TARGET platform.
#  * better-sqlite3 ships prebuilt linux-x64 and linux-arm64 binaries inside the npm package: no compiler, no download.
#  * @openzim/libzim (task Z-01) has no prebuilt Node binary. Its install script downloads the prebuilt libzim for this platform from
#    download.openzim.org and compiles the N-API wrapper with node-gyp, so this stage (and only this stage) gets python3, make and g++.
#    LIBZIM_VERSION pins the libzim release the wrapper links; it is the value the wrapper's own .env carries for 4.7.0 (libzim 9.8.2, build 1).
#    glibc only: the downloaded libzim is a glibc "manylinux" build and fails to load on Alpine/musl, so Alpine is not supported.
# Versions are read from pnpm-lock.yaml so they cannot drift. The stage fails if either addon cannot load.
FROM ${NODE_IMAGE} AS native
ARG LIBZIM_VERSION=9.8.2-1
WORKDIR /opt/native
COPY pnpm-lock.yaml /tmp/pnpm-lock.yaml
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    v="$(sed -n 's/^  better-sqlite3@\([0-9][0-9.]*\):$/\1/p' /tmp/pnpm-lock.yaml | head -n1)"; \
    z="$(sed -n "s/^  '@openzim\/libzim@\([0-9][0-9.]*\)':$/\1/p" /tmp/pnpm-lock.yaml | head -n1)"; \
    test -n "$v"; test -n "$z"; echo "better-sqlite3 $v, @openzim/libzim $z (libzim $LIBZIM_VERSION) on $(uname -m)"; \
    echo '{"name":"native","private":true,"type":"commonjs"}' > package.json; \
    LIBZIM_VERSION="$LIBZIM_VERSION" npm_config_nodedir=/usr/local \
      npm install --omit=dev --no-audit --no-fund --no-package-lock "better-sqlite3@$v" "@openzim/libzim@$z"; \
    arch="$(node -p 'process.arch')"; \
    find node_modules/better-sqlite3/prebuilds -type f ! -name "linux-$arch.node" -delete; \
    rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src node_modules/better-sqlite3/binding.gyp node_modules/node-addon-api; \
    zd=node_modules/@openzim/libzim; \
    test -f "$zd/build/Release/zim_binding.node"; \
    rm -rf "$zd/download" "$zd/src" "$zd/test" "$zd/build/Release/obj.target" "$zd/build/Release/.deps" "$zd/build/native" "$zd/binding.gyp"; \
    node -e "const D=require('better-sqlite3');const d=new D(':memory:');console.log('sqlite',d.prepare('select sqlite_version() v').get().v)"; \
    node --input-type=module -e "import('@openzim/libzim').then((m)=>{if(typeof m.Archive!=='function')process.exit(1);console.log('libzim module loads, Archive present')})"

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NCB_DATA_DIR=/data \
    NCB_VOLUMES_ALLOWED_ROOTS=/volumes
# tini is PID 1 so signals reach node and zombies are reaped.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app /data /volumes/default \
 && chown -R node:node /app /data /volumes
WORKDIR /app
RUN echo '{"name":"ncb-server","private":true,"type":"module"}' > package.json
COPY --from=native --chown=node:node /opt/native/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/server/dist ./dist
USER node
EXPOSE 3001 3002
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.NCB_API_PORT||3001)+'/api/system/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

FROM runtime AS bench
COPY --from=build --chown=node:node /repo/apps/server/dist-bench/bench-queue.js ./bench/bench-queue.js
COPY --from=build --chown=node:node /repo/apps/server/dist-bench/bench-search.js ./bench/bench-search.js
# The bundled benchmark looks for ../migrations next to itself.
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
HEALTHCHECK NONE
CMD ["node", "bench/bench-queue.js"]
