# NoConBrain renderer (optional, compose profile `renderer`). Playwright with chromium_headless_shell on Debian 13.
# Build context: repository root. The image is large (about 1.3 GB, mostly Chromium and its libraries) and is built
# only when someone turns the profile on. It runs as an unprivileged user with Chromium's own sandbox, which needs
# the seccomp profile in docker/renderer/seccomp.json (the compose file applies it).
ARG NODE_IMAGE=node:24-trixie-slim

# The server code is two small files. esbuild bundles them; playwright-core stays external and is installed below.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /build
RUN npm install --no-audit --no-fund --no-package-lock --prefix /opt/esbuild esbuild@0.25.12
COPY apps/renderer/package.json apps/renderer/tsconfig.json ./
COPY apps/renderer/src src
RUN /opt/esbuild/node_modules/.bin/esbuild src/server.ts --bundle --platform=node --format=esm --target=node24 \
      --external:playwright-core --outfile=dist/server.js

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/tmp/home \
    PORT=8080
WORKDIR /app
COPY apps/renderer/package.json ./package.json.src
# playwright-core at the exact version in apps/renderer/package.json, then only the headless shell and the system
# libraries it needs (--with-deps runs apt-get itself). The apt lists and caches are removed in the same layer.
RUN set -eux; \
    PW="$(node -p "JSON.parse(require('fs').readFileSync('package.json.src','utf8')).dependencies['playwright-core']")"; \
    echo '{"name":"ncb-renderer","private":true,"type":"module"}' > package.json; \
    npm install --omit=dev --no-audit --no-fund --no-package-lock "playwright-core@${PW}"; \
    npx playwright-core install --with-deps --only-shell chromium; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/* /root/.npm /tmp/* package.json.src; \
    chmod -R a+rX /ms-playwright; \
    node --input-type=module -e "import {chromium} from 'playwright-core'; console.log(chromium.executablePath())"
COPY --from=build /build/dist/server.js ./dist/server.js
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
