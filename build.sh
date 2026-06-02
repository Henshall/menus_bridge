#!/bin/bash
# Menus Print Bridge — build script
#
# Packages the Electron app into distributable artifacts in dist/.
# After building, run ./deploy.sh <platform> to upload to prod & staging.
#
# Full release workflow:
#   1. Bump version:  npm version patch --no-git-tag-version
#   2. Build:         ./build.sh linux   (or mac / win / all)
#   3. Test locally:  ./dist/linux-unpacked/menus-print-bridge --no-sandbox
#   4. Deploy:        ./deploy.sh linux
#
# Usage:
#   ./build.sh mac    — build Mac DMG + install to /Applications
#   ./build.sh win    — build Windows EXE
#   ./build.sh linux  — build Linux AppImages (x64, arm64, armv7l)
#   ./build.sh all    — build all platforms

set -e

PLATFORM=${1:-mac}
DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="$DIR/dist"

echo "▶ Cleaning dist..."
rm -rf "$DIST"

build_mac() {
  echo "▶ Building Mac..."
  cd "$DIR" && CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac
  APP="$DIST/mac-arm64/Menus Print Bridge.app"
  echo "▶ Installing to /Applications..."
  rm -rf "/Applications/Menus Print Bridge.app"
  cp -R "$APP" "/Applications/Menus Print Bridge.app"
  xattr -cr "/Applications/Menus Print Bridge.app"
  echo "   ✓ Built and installed"
}

build_win() {
  echo "▶ Building Windows..."
  cd "$DIR" && npm run build:win
  echo "   ✓ Built"
}

build_linux() {
  echo "▶ Building Linux..."
  cd "$DIR" && npm run build:linux
  echo "   ✓ Built (x64, arm64, armv7l)"
}

case "$PLATFORM" in
  mac)   build_mac ;;
  win)   build_win ;;
  linux) build_linux ;;
  all)   build_mac; build_win; build_linux ;;
  *)     echo "Usage: ./build.sh [mac|win|linux|all]"; exit 1 ;;
esac

echo ""
echo "✅ Done. Run ./deploy.sh to upload to servers."
