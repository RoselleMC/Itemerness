#!/usr/bin/env bash
# Syncs the editor build context to an explicitly selected host and rebuilds the stack.
# `.env` is excluded from --delete on purpose: it holds generated secrets that only exist on the
# host, and a sync that removes them turns a routine redeploy into a credential loss.
set -euo pipefail
TARGET_HOST="${1:?usage: deploy.sh <ssh-host>}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
REMOTE=/opt/itemerness-editor

rsync -az --delete \
  --exclude 'node_modules/' --exclude 'dist/' --exclude 'vanilla-cache/' \
  --exclude 'test-results/' --exclude 'playwright-report/' --exclude '.vite/' \
  --exclude '*.tsbuildinfo' --exclude 'deploy/.env' \
  "$ROOT/editor/" "$TARGET_HOST:$REMOTE/editor/"

rsync -az --relative \
  "$ROOT/./itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm" \
  "$ROOT/./tools/font-metrics/26.1.2.sources.json" \
  "$ROOT/./.dockerignore" \
  "$TARGET_HOST:$REMOTE/"

ssh "$TARGET_HOST" "cd $REMOTE/editor/deploy && docker compose -p itemerness-editor up -d --build"
