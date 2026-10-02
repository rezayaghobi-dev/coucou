#!/usr/bin/env bash
# Rebuild the bundles and reinstall the .deb — the quickest way to
# try the current tree as an installed app.
set -euo pipefail

cd "$(dirname "$0")/.."

npm run pack
sudo apt install -y --reinstall ./release/Coucou-latest-amd64.deb

dpkg-query --show --showformat='${Package} ${Version}\n' coucou
