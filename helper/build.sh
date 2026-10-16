#!/bin/bash
# Builds helper/build/Murmur.app. Signs with your Apple Development certificate when one
# exists, so macOS keeps the Microphone / Speech / Input Monitoring grants across rebuilds
# (ad-hoc signatures change every build and macOS re-asks each time).
set -euo pipefail
cd "$(dirname "$0")"
APP=build/Murmur.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp Info.plist "$APP/Contents/Info.plist"
swiftc -O -swift-version 5 -parse-as-library -o "$APP/Contents/MacOS/Murmur" Murmur.swift
IDENTITY=$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/{print $2; exit}')
codesign --force --sign "${IDENTITY:--}" "$APP"
echo "built $APP (signed: ${IDENTITY:-ad-hoc})"

# Install where Spotlight/Launchpad find it. Quit the running copy first so the swap is clean.
pkill -f "Murmur.app/Contents/MacOS/Murmur" || true
for _ in $(seq 1 20); do pgrep -f "Murmur.app/Contents/MacOS/Murmur" >/dev/null || break; sleep 0.25; done
rm -rf /Applications/Murmur.app
ditto "$APP" /Applications/Murmur.app
echo "installed /Applications/Murmur.app"
