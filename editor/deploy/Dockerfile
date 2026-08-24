# syntax=docker/dockerfile:1.7

# Itemerness editor: one image serving the browser UI, the JSON API, and both WebSocket endpoints
# from a single origin, which is what lets a downstream server be configured with only a URL and a
# token.
#
# Build context is the repository root, because the image needs two files from outside editor/:
# the generated font-metrics artifact and the pinned Mojang source manifest. Neither contains
# Mojang assets; the manifest only holds URLs and digests the control plane verifies at fetch time.

FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /workspace
COPY editor/pnpm-workspace.yaml editor/package.json editor/pnpm-lock.yaml ./
COPY editor/packages/protocol/package.json ./packages/protocol/
COPY editor/packages/mc-assets/package.json ./packages/mc-assets/
COPY editor/packages/mc-render/package.json ./packages/mc-render/
COPY editor/apps/web/package.json ./apps/web/
COPY editor/apps/control-plane/package.json ./apps/control-plane/
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && pnpm install --frozen-lockfile

FROM deps AS build
COPY editor/ ./
RUN pnpm --filter @itemerness/web build \
    && pnpm --filter @itemerness/control-plane build

# The bundle inlines every @itemerness/* package but leaves third-party dependencies as runtime
# imports. `pnpm deploy` materialises a portable production tree from the same lockfile used by the
# build, without a second resolver or floating semver ranges in the runtime stage.
RUN pnpm --filter @itemerness/control-plane deploy --prod --legacy /runtime-deps

FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    ITEMERNESS_REPO_ROOT=/app \
    ITEMERNESS_WEB_ROOT=/app/web \
    ITEMERNESS_ASSET_CACHE=/data/vanilla-cache

# package.json carries "type": "module", without which Node would parse the ESM bundle as CommonJS.
COPY --from=build /runtime-deps/package.json ./package.json
COPY --from=build /runtime-deps/node_modules/ ./node_modules/
COPY --from=build /workspace/apps/control-plane/dist/ ./dist/
COPY --from=build /workspace/apps/web/dist/ ./web/
# Read at runtime by the metrics endpoint and the vanilla asset proxy respectively.
COPY itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm \
     ./itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm
COPY tools/font-metrics/26.1.2.sources.json ./tools/font-metrics/26.1.2.sources.json

RUN mkdir -p /data/vanilla-cache && chown -R node:node /data /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
