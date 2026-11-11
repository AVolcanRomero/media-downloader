#!/bin/zsh
# Builds "Media Downloader.app" into /Applications from this project's server and interface.
# Run again after changing server.js or public/ — the app carries its own copy.
set -euo pipefail
ROOT="${0:A:h:h}"
cd "${0:A:h}"
APP="/Applications/Media Downloader.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Compiling…"
swiftc -O -o "$WORK/Media Downloader" main.swift -framework Cocoa -framework WebKit

echo "Drawing icon…"
swift icon.swift "$WORK/icon.png"
ICONSET="$WORK/AppIcon.iconset"; mkdir "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$WORK/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$WORK/AppIcon.icns"

echo "Assembling bundle…"
osascript -e 'quit app "Media Downloader"' 2>/dev/null || true
sleep 1
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
cp "$WORK/Media Downloader" "$APP/Contents/MacOS/"
cp "$WORK/AppIcon.icns" "$APP/Contents/Resources/"
cp "$ROOT/server.js" "$ROOT/package.json" "$APP/Contents/Resources/app/"
cp -R "$ROOT/public" "$APP/Contents/Resources/app/"
cp Info.plist "$APP/Contents/"

codesign --force --deep --sign - "$APP" >/dev/null 2>&1
echo "Built: $APP"

# Drag-to-install disk image for other Macs.
mkdir -p "$ROOT/dist"; mkdir "$WORK/dmg"
ditto "$APP" "$WORK/dmg/Media Downloader.app"
ln -s /Applications "$WORK/dmg/Applications"
hdiutil create -volname "Media Downloader" -srcfolder "$WORK/dmg" -ov -format UDZO \
  "$ROOT/dist/Media Downloader for Mac.dmg" >/dev/null 2>&1
echo "Packed: $ROOT/dist/Media Downloader for Mac.dmg"
