#!/bin/zsh
# Packs the Windows installer: dist/Media Downloader for Windows.zip
# Copy the zip to a Windows PC, unzip, double-click "Install Media Downloader".
set -euo pipefail
ROOT="${0:A:h:h}"
HERE="${0:A:h}"
DIST="$ROOT/dist"
PKG="$DIST/Media Downloader for Windows"
rm -rf "$PKG" "$PKG.zip"
mkdir -p "$PKG/app"

cp "$ROOT/server.js" "$ROOT/package.json" "$PKG/app/"
cp -R "$ROOT/public" "$PKG/app/"
cp "$HERE/icon.ico" "$PKG/"

# Windows text conventions: CRLF for batch/VBScript, UTF-8 with BOM for PowerShell 5.
for f in "Install Media Downloader.cmd" "Uninstall Media Downloader.cmd" launch.vbs; do
  perl -pe 's/\r?\n/\r\n/' "$HERE/$f" > "$PKG/$f"
done
for f in install.ps1 launch.ps1; do
  { printf '\xEF\xBB\xBF'; perl -pe 's/\r?\n/\r\n/' "$HERE/$f"; } > "$PKG/$f"
done

(cd "$DIST" && rm -f "Media Downloader for Windows.zip" && zip -qr -X "Media Downloader for Windows.zip" "Media Downloader for Windows")
rm -rf "$PKG"
echo "Built: $DIST/Media Downloader for Windows.zip"
