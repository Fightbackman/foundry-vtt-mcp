#!/usr/bin/env bash
# Publish the Foundry module built from this fork's master so Foundry can install
# and update it from a manifest URL:
#
#   https://raw.githubusercontent.com/Fightbackman/foundry-vtt-mcp/foundry-release/module.json
#
# The module.json on master points its "manifest" and "download" there. This script
# builds the module, zips it the same way the release workflow does, and pushes
# module.json + foundry-vtt-mcp.zip as the only files of the orphan branch
# "foundry-release". Bump the version in all manifests (npm run version:check)
# before publishing, or Foundry will not offer the update.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

BRANCH=foundry-release
REMOTE=${REMOTE:-origin}

if [ "$(git branch --show-current)" != "master" ]; then
  echo "Run this from master." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean." >&2
  exit 1
fi
npm run version:check

npm run build:shared
npm run build:foundry

WORK=$(mktemp -d)
trap 'git worktree remove --force "$WORK/tree" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

# Zip like .github/workflows/build-complete-release.yml: the module folder without
# hidden files and node_modules.
(cd packages/foundry-module && zip -qr "$WORK/foundry-vtt-mcp.zip" . -x '.*' -x 'node_modules/*')

git worktree add --detach "$WORK/tree" >/dev/null
cd "$WORK/tree"
if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null; then
  git fetch -q "$REMOTE" "$BRANCH"
  git checkout -q -B "$BRANCH" FETCH_HEAD
else
  git checkout -q --orphan "$BRANCH"
fi
git rm -rqf . >/dev/null 2>&1 || true
cp "$ROOT/packages/foundry-module/module.json" module.json
cp "$WORK/foundry-vtt-mcp.zip" foundry-vtt-mcp.zip
git add module.json foundry-vtt-mcp.zip

VERSION=$(node -p "require('./module.json').version")
SOURCE=$(git -C "$ROOT" rev-parse --short HEAD)
if git diff --cached --quiet; then
  echo "Nothing changed; $BRANCH already holds this build."
else
  git commit -q --no-verify -m "Foundry module $VERSION (master $SOURCE)"
  git push -q "$REMOTE" "HEAD:$BRANCH"
  echo "Published $VERSION from master $SOURCE to $REMOTE/$BRANCH"
fi
git checkout -q --detach
git branch -q -D "$BRANCH" 2>/dev/null || true
