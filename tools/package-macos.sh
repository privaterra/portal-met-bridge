#!/usr/bin/env bash
# Build "Portal Met Bridge.app" — a double-clickable macOS app that serves the
# page on http://localhost:8787, keeps its files in ~/Documents/portal-met-bridge
# and opens Chrome. The bundle is plain files — a launcher, the app, and
# (optionally) a Node runtime per CPU — so it needs nothing installed:
#   Contents/MacOS/portal-met-bridge   the main executable: tools/launcher.c compiled (macOS, needs cc from
#                                      the Xcode command-line tools), which runs the script below; without a
#                                      compiler the script itself is copied here (works, cannot be notarized)
#   Contents/Helpers/launcher.sh       the real launcher (bash): finds Node, starts serve.mjs, opens Chrome
#   Contents/Helpers/node/<arch>/bin/node   bundled Node runtimes (Helpers is where Apple wants nested code)
#   Contents/Resources/app/            index.html, js/, css/, vendor/, serve.mjs, docs
#
#   tools/package-macos.sh                       # app + zip, uses the Node already on the Mac
#   tools/package-macos.sh --download-node       # also bundles Node for Apple silicon and Intel
#   tools/package-macos.sh --node-arm64 node-v24.x-darwin-arm64.tar.gz --node-x64 node-v24.x-darwin-x64.tar.gz
#   tools/package-macos.sh --out dist --no-zip   # just the .app
#
# Needs only bash, curl and tar (no Node on the building machine). Runs on macOS (then
# also makes a .dmg and an .icns icon) and on Linux (zip only,
# which is what the GitHub workflow in .github/workflows/release.yml uses on the
# macOS runner anyway). See docs/PACKAGING.md for signing and notarization.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/dist"
node_arm64=""
node_x64=""
download_node=0
make_zip=1
node_major="${NODE_MAJOR:-24}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --node-arm64) node_arm64="$2"; shift 2 ;;
    --node-x64) node_x64="$2"; shift 2 ;;
    --download-node) download_node=1; shift ;;
    --node-major) node_major="$2"; shift 2 ;;
    --no-zip) make_zip=0; shift ;;
    -h|--help) sed -n 2,16p "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$here/package.json" | head -1)" # no Node needed to build the bundle
[ -n "$version" ] || { echo "could not read the version from package.json" >&2; exit 1; }
name="Portal Met Bridge"
app="$out/$name.app"
contents="$app/Contents"
echo "portal-met-bridge v$version → $app"

rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Helpers" "$contents/Resources/app"

# ---- the web app itself (no screenshots, no tests, no git)
for f in index.html serve.mjs package.json LICENSE README.md CONTRIBUTING.md start.command; do cp "$here/$f" "$contents/Resources/app/"; done
cp -R "$here/js" "$here/css" "$here/vendor" "$contents/Resources/app/"
mkdir -p "$contents/Resources/app/docs"
cp "$here/docs/NOTES.md" "$here/docs/PACKAGING.md" "$contents/Resources/app/docs/" 2>/dev/null || true

# ---- Node runtimes (optional). nodejs.org tarballs: node-vX.Y.Z-darwin-{arm64,x64}.tar.gz
fetch_node() { # arch → path of a tarball in $out/.node
  local arch="$1" index ver file url sums
  mkdir -p "$out/.node"
  index="$(curl -fsSL https://nodejs.org/dist/index.json)"
  # newest LTS release of that major (an entry whose "lts" is a name, not false); falls back to the newest release of the major
  ver="$(printf '%s' "$index" | tr '{' '\n' | grep '"lts":"[A-Za-z]' | grep -o "\"version\":\"v$node_major\.[0-9.]*\"" | head -1 | cut -d'"' -f4)"
  [ -n "$ver" ] || ver="$(printf '%s' "$index" | tr '{' '\n' | grep -o "\"version\":\"v$node_major\.[0-9.]*\"" | head -1 | cut -d'"' -f4)"
  [ -n "$ver" ] || { echo "no Node $node_major release found in nodejs.org/dist/index.json" >&2; exit 1; }
  file="node-$ver-darwin-$arch.tar.gz"
  url="https://nodejs.org/dist/$ver/$file"
  if [ ! -f "$out/.node/$file" ]; then
    echo "downloading $url" >&2
    curl -fsSL -o "$out/.node/$file" "$url"
    sums="$(curl -fsSL "https://nodejs.org/dist/$ver/SHASUMS256.txt" | grep " $file\$")"
    (cd "$out/.node" && (command -v sha256sum >/dev/null && echo "$sums" | sha256sum -c - >/dev/null || echo "$sums" | shasum -a 256 -c - >/dev/null)) || { echo "checksum mismatch for $file" >&2; exit 1; }
  fi
  echo "$out/.node/$file"
}
unpack_node() { # tarball arch
  local tgz="$1" arch="$2" dest="$contents/Helpers/node/$arch"
  mkdir -p "$dest"
  tar -xzf "$tgz" -C "$dest" --strip-components=1 '*/bin/node' '*/LICENSE' 2>/dev/null || tar -xzf "$tgz" -C "$dest" --strip-components=1
  rm -rf "$dest/lib" "$dest/include" "$dest/share" "$dest/bin/npm" "$dest/bin/npx" "$dest/bin/corepack" "$dest/CHANGELOG.md" "$dest/README.md"
  chmod +x "$dest/bin/node"
  echo "bundled Node for $arch: $(basename "$tgz")"
}
if [ "$download_node" = 1 ]; then
  node_arm64="$(fetch_node arm64)"
  node_x64="$(fetch_node x64)"
fi
[ -n "$node_arm64" ] && unpack_node "$node_arm64" arm64
[ -n "$node_x64" ] && unpack_node "$node_x64" x64

# ---- the launcher script (Contents/Helpers/launcher.sh)
cat > "$contents/Helpers/launcher.sh" <<'LAUNCHER'
#!/bin/bash
# Portal Met Bridge launcher: serve the app on localhost and open Chrome.
# Run by Contents/MacOS/portal-met-bridge (a tiny compiled program), or directly.
# Settings (optional): ~/Library/Application Support/portal-met-bridge/config
#   PORT=8787                                  # the port
#   DATA_DIR="$HOME/Documents/portal-met-bridge"  # where the app's files go (Settings → Files and folders → server)
#   BROWSER="Google Chrome"                    # or "Microsoft Edge", or "" for the default browser
#   HOST=127.0.0.1                             # 0.0.0.0 makes it reachable from the LAN (read docs/PACKAGING.md first)
contents="$(cd "$(dirname "$0")/.." && pwd)"
app="$contents/Resources/app"
support="$HOME/Library/Application Support/portal-met-bridge"
logdir="$HOME/Library/Logs"
mkdir -p "$support" "$logdir"
PORT="${PORT:-8787}"
DATA_DIR="${DATA_DIR-$HOME/Documents/portal-met-bridge}"
BROWSER="${BROWSER-Google Chrome}"
HOST="${HOST:-127.0.0.1}"
[ -f "$support/config" ] && . "$support/config"
export PORT DATA_DIR HOST
log="$logdir/portal-met-bridge.log"
url="http://localhost:$PORT"

say() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$log"; }
dialog() { osascript -e "display dialog \"$1\" buttons {\"OK\"} default button 1 with title \"Portal Met Bridge\"" >/dev/null 2>&1 || true; }
open_browser() {
  if [ -n "$BROWSER" ] && [ -d "/Applications/$BROWSER.app" ]; then open -a "$BROWSER" "$url"
  elif [ -d "/Applications/Google Chrome.app" ]; then open -a "Google Chrome" "$url"
  elif [ -d "/Applications/Microsoft Edge.app" ]; then open -a "Microsoft Edge" "$url"
  else open "$url"; fi
}

# Already running (this app, or `node serve.mjs` from a Terminal)? Just show it.
if curl -fsS -m 1 "$url/api/files" >/dev/null 2>&1 || curl -fsS -m 1 "$url/" >/dev/null 2>&1; then
  say "already serving on $url; opening the browser"
  open_browser
  exit 0
fi

# A Node runtime: bundled for this CPU, else the one installed on the Mac.
arch="$(uname -m)"
case "$arch" in arm64) node="$contents/Helpers/node/arm64/bin/node" ;; x86_64) node="$contents/Helpers/node/x64/bin/node" ;; *) node="" ;; esac
if [ ! -x "$node" ]; then
  for c in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -n "$c" ] && [ -x "$c" ]; then node="$c"; break; fi
  done
fi
if [ ! -x "$node" ]; then
  say "no Node runtime found"
  dialog "Portal Met Bridge needs Node.js and this copy does not bundle it. Install Node from https://nodejs.org (or: brew install node) and open the app again."
  exit 1
fi

mkdir -p "$DATA_DIR" 2>/dev/null || true
say "starting: $node $app/serve.mjs on $url · files in $DATA_DIR"
( sleep 1.2; open_browser ) &
cd "$app" || exit 1
exec "$node" "$app/serve.mjs" >>"$log" 2>&1
LAUNCHER
chmod +x "$contents/Helpers/launcher.sh"

# ---- the main executable: tools/launcher.c compiled as a universal Mach-O when a compiler
# is at hand (macOS with the Xcode command-line tools), else the script itself.
main_exe="$contents/MacOS/portal-met-bridge"
if [ "$(uname -s)" = Darwin ] && command -v cc >/dev/null 2>&1 && cc -O2 -Wall -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 -o "$main_exe" "$here/tools/launcher.c" 2>/dev/null; then
  echo "main executable: compiled launcher (universal)"
elif [ "$(uname -s)" = Darwin ] && command -v cc >/dev/null 2>&1 && cc -O2 -Wall -mmacosx-version-min=12.0 -o "$main_exe" "$here/tools/launcher.c" 2>/dev/null; then
  echo "main executable: compiled launcher ($(uname -m) only)"
else
  cp "$contents/Helpers/launcher.sh" "$main_exe"
  echo "main executable: the launcher script (no C compiler here; fine unsigned, cannot be notarized)"
fi
chmod +x "$main_exe"

# ---- Info.plist
cat > "$contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>org.privaterra.portal-met-bridge</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>portal-met-bridge</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleGetInfoString</key><string>Meticulous &amp; Belka Portal conductivity data visualization &amp; analysis</string>
  <key>NSHumanReadableCopyright</key><string>MIT · github.com/privaterra/portal-met-bridge</string>
</dict>
</plist>
PLIST
echo "APPL????" > "$contents/PkgInfo"

# ---- icon (macOS only: sips + iconutil turn the PNG into an .icns)
if [ -f "$here/assets/icon-1024.png" ] && command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
  iconset="$out/.AppIcon.iconset"
  rm -rf "$iconset" && mkdir -p "$iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$here/assets/icon-1024.png" --out "$iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$here/assets/icon-1024.png" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$contents/Resources/AppIcon.icns" && rm -rf "$iconset"
  echo "icon: AppIcon.icns"
elif [ -f "$here/assets/icon-1024.png" ]; then
  cp "$here/assets/icon-1024.png" "$contents/Resources/AppIcon.png" # Finder ignores it; kept for a later iconutil run
fi

# ---- archives
if [ "$make_zip" = 1 ]; then
  zip_name="portal-met-bridge-$version-macos.zip"
  rm -f "$out/$zip_name"
  if command -v ditto >/dev/null 2>&1; then
    (cd "$out" && ditto -c -k --sequesterRsrc --keepParent "$name.app" "$zip_name")
  else
    (cd "$out" && zip -qry "$zip_name" "$name.app")
  fi
  echo "zip: $out/$zip_name ($(du -h "$out/$zip_name" | cut -f1))"
  if command -v hdiutil >/dev/null 2>&1; then
    dmg="$out/portal-met-bridge-$version-macos.dmg"
    rm -f "$dmg"
    stage="$out/.dmg"
    rm -rf "$stage" && mkdir -p "$stage"
    cp -R "$app" "$stage/"
    ln -s /Applications "$stage/Applications"
    hdiutil create -quiet -volname "$name" -srcfolder "$stage" -ov -format UDZO "$dmg"
    rm -rf "$stage"
    echo "dmg: $dmg ($(du -h "$dmg" | cut -f1))"
  fi
fi
echo "done"
