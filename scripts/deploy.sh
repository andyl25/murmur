#!/bin/bash
# Ships the chat server + web app to the Lightsail box behind https://copose.ai.
#   bash scripts/deploy.sh
# The box (Ubuntu, Node 22, Caddy for HTTPS, systemd unit "murmur") was set up by its first-boot
# script; this only builds, uploads and restarts. The helper token lives in ~/.murmur/helper-token
# and in /opt/murmur/murmur.env on the box; the Mac app reads it from `defaults`.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${MURMUR_DEPLOY_HOST:-23.21.240.217}"
SSH=(ssh -i "$HOME/.ssh/murmur_lightsail" -o BatchMode=yes "ubuntu@$HOST")

npx vite build --logLevel warn
mkdir -p build/deploy/server
npx esbuild server/index.ts --bundle --platform=node --format=esm --target=node22 --log-level=warning \
  --external:vite --external:bufferutil --external:utf-8-validate \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile=build/deploy/server/index.mjs

"${SSH[@]}" "mkdir -p /tmp/murmur-upload/server /tmp/murmur-upload/dist"
rsync -az --delete -e "ssh -i $HOME/.ssh/murmur_lightsail -o BatchMode=yes" \
  build/deploy/server/ "ubuntu@$HOST:/tmp/murmur-upload/server/"
rsync -az --delete -e "ssh -i $HOME/.ssh/murmur_lightsail -o BatchMode=yes" \
  dist/ "ubuntu@$HOST:/tmp/murmur-upload/dist/"

TOKEN_FILE="$HOME/.murmur/helper-token"
if [ ! -s "$TOKEN_FILE" ]; then
  mkdir -p "$HOME/.murmur" && openssl rand -hex 24 > "$TOKEN_FILE" && chmod 600 "$TOKEN_FILE"
fi

"${SSH[@]}" "sudo bash -s" <<REMOTE
set -e
rsync -a --delete /tmp/murmur-upload/server/ /opt/murmur/server/
rsync -a --delete /tmp/murmur-upload/dist/ /opt/murmur/dist/
grep -q '^MURMUR_HELPER_TOKEN=' /opt/murmur/murmur.env || echo 'MURMUR_HELPER_TOKEN=$(cat "$TOKEN_FILE")' >> /opt/murmur/murmur.env
chown -R murmur:murmur /opt/murmur
chmod 600 /opt/murmur/murmur.env
systemctl restart murmur
sleep 1
systemctl is-active murmur
journalctl -u murmur -n 3 --no-pager -o cat
REMOTE
