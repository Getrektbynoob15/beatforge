#!/usr/bin/env bash
# Download the Mac plugin host (universal: Apple Silicon + Intel) built and tested by GitHub Actions for the current
# vsthost/ sources. It must come from a successful run of .github/workflows/vsthost.yml on this exact commit of vsthost/.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=Getrektbynoob15/beatforge
sha=$(git log -1 --format=%H -- vsthost .github/workflows/vsthost.yml)
run=$(gh run list -R $REPO -w "plugin host" --commit "$sha" --status success --limit 1 --json databaseId -q '.[0].databaseId')
[ -n "$run" ] || { echo "no successful 'plugin host' run for $sha yet (push, then wait for GitHub Actions)"; exit 1; }
rm -rf vsthost/build/mac && gh run download "$run" -R $REPO -n bfvsthost-mac -D vsthost/build/mac
chmod 755 vsthost/build/mac/bfvsthost && file vsthost/build/mac/bfvsthost
