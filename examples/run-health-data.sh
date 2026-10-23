#!/usr/bin/env bash
# Launcher for the Withings-compatible community MCP server (stdio).
# Client id/secret (and optional WITHINGS_REDIRECT_URI / WITHINGS_TOKEN_FILE) come from a mode-600 env file that the
# server reads itself (WITHINGS_ENV_FILE), so they are never placed in an MCP client config, argv, or a log.
# Point your MCP client at this script: {"command": "/absolute/path/to/run-health-data.sh", "args": []}
set -euo pipefail
ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"   # repo root; or set an absolute path here
export WITHINGS_ENV_FILE="${WITHINGS_ENV_FILE:-$HOME/.config/personal-health-data-mcp/withings.env}"
[ -r "$WITHINGS_ENV_FILE" ] || { echo "run-health-data: env file missing or unreadable: $WITHINGS_ENV_FILE" >&2; exit 1; }
# Optional: a separate token file per install (see README, "Sharing one token file").
# export WITHINGS_TOKEN_FILE="$HOME/.config/personal-health-data-mcp/tokens.json"
cd "$ROOT"
exec node "$ROOT/server/index.mjs"
