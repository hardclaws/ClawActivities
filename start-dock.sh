#!/usr/bin/env bash
# Activity Dock launcher (macOS / Linux)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it from https://nodejs.org (LTS) and run this again."; exit 1
fi
exec node server.js "$@"
