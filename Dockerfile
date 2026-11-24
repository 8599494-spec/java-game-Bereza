# Stage 1: Build client assets, compile shared & server JS, and prune devDependencies
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/tsconfig.json shared/tsconfig.build.json ./shared/
COPY server/package.json server/tsconfig.json server/tsconfig.build.json ./server/
COPY client/package.json client/tsconfig.json client/vite.config.ts ./client/

RUN npm ci

COPY shared/src ./shared/src
COPY server/src ./server/src
COPY client/index.html ./client/index.html
COPY client/public ./client/public
COPY client/src ./client/src

RUN npm run build && npm run build:server

# Point @game/shared exports to compiled dist/*.js for zero-overhead Node runtime
RUN node -e ' \
  const fs = require("fs"); \
  const pkg = JSON.parse(fs.readFileSync("shared/package.json", "utf8")); \
  for (const [k, v] of Object.entries(pkg.exports)) { \
    pkg.exports[k] = v.replace("./src/", "./dist/").replace(/\.ts$/, ".js"); \
  } \
  fs.writeFileSync("shared/package.json", JSON.stringify(pkg, null, 2)); \
'

RUN npm prune --omit=dev && npm cache clean --force

# Stage 2: Minimal production runtime (< 200 MB, non-root user)
FROM node:24-alpine AS runner
WORKDIR /app

ARG APP_VERSION=1.0.0
ARG GIT_SHA=unknown

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_LEVEL=info \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA}

COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/shared/package.json ./shared/package.json
COPY --from=builder --chown=node:node /app/shared/dist ./shared/dist
COPY --from=builder --chown=node:node /app/server/package.json ./server/package.json
COPY --from=builder --chown=node:node /app/server/dist ./server/dist
COPY --from=builder --chown=node:node /app/client/dist ./client/dist

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1

CMD ["node", "server/dist/index.js"]