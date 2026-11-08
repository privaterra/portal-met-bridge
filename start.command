#!/bin/bash
# portal-met-bridge launcher for macOS. Double-click in Finder, or run from Terminal.
# Serves the app on http://localhost:8787 and opens it in Chrome (Web Bluetooth
# needs Chrome or Edge, and needs the page to come from localhost).
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8787}"
URL="http://localhost:$PORT"

open_browser() {
  sleep 1
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -a "Google Chrome" "$URL"
  elif [ -d "/Applications/Microsoft Edge.app" ]; then
    open -a "Microsoft Edge" "$URL"
  else
    echo "Chrome or Edge is needed for the Portal's Bluetooth connection; opening the default browser."
    open "$URL"
  fi
}

echo "portal-met-bridge → $URL   (press Ctrl-C to stop)"
if command -v node >/dev/null 2>&1; then
  open_browser &
  exec node serve.mjs
elif command -v python3 >/dev/null 2>&1; then
  open_browser &
  exec python3 -m http.server "$PORT" --bind 127.0.0.1
else
  echo "Neither node nor python3 was found. Install Node (https://nodejs.org) or the Xcode command-line tools, then run this again."
  read -r -p "Press Return to close."
  exit 1
fi
