# syntax=docker/dockerfile:1.7
# NoConBrain web (Next.js standalone). Build context: repository root.
ARG NODE_IMAGE=node:24-trixie-slim

# Every workspace package.json, found automatically, so adding a package never means editing this file. Only
# manifests are kept; the layer below this one is cached until dependencies change.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS manifests
WORKDIR /m
COPY apps apps
COPY packages packages
RUN find . -type f ! -name package.json -delete

# The build stage always runs on the builder's native platform: `next build` crashes under QEMU
# (amd64 on an Apple Silicon or arm64 builder). The standalone output is plain JavaScript apart from
# sharp's platform binaries, which are removed below because the app does not use next/image optimisation.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install
COPY --from=manifests /m/ ./
# (--ignore-scripts below: no native addon is needed to build the web app.)
RUN --mount=type=cache,id=ncb-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter "@ncb/web..."
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN mkdir -p apps/web/public && pnpm --filter @ncb/web build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    API_INTERNAL_URL=http://server:3001
WORKDIR /app
# Standalone output in a monorepo nests the server under apps/web (outputFileTracingRoot is the repo root).
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
RUN rm -rf /app/node_modules/.pnpm/@img+sharp* /app/node_modules/.pnpm/sharp@* /app/node_modules/sharp \
           /app/node_modules/.pnpm/node_modules/sharp /app/node_modules/.pnpm/node_modules/@img 2>/dev/null; \
    find /app/node_modules -xtype l -name 'sharp*' -delete; true
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
# Next writes its runtime cache here; compose mounts a tmpfs over it when the root is read-only.
RUN mkdir -p /app/apps/web/.next/cache && chown -R node:node /app/apps/web/.next
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
