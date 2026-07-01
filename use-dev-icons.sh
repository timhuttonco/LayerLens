#!/usr/bin/env bash
# Toggle between production and dev icons.
# Run from the extension root directory.

set -e
cd "$(dirname "$0")"

if [ -f icons/icon16-prod.png ]; then
  # Backup exists → currently in dev mode, restore prod
  for s in 16 48 128; do
    cp icons/icon${s}-prod.png icons/icon${s}.png
    rm icons/icon${s}-prod.png
  done
  echo "✅ Switched to PRODUCTION icons — reload the extension."
else
  # No backup → currently in prod mode, switch to dev
  for s in 16 48 128; do
    cp icons/icon${s}.png icons/icon${s}-prod.png
    cp icons/icon${s}-dev.png icons/icon${s}.png
  done
  echo "🟠 Switched to DEV icons — reload the extension."
fi
