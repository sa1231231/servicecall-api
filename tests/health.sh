#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_KEY=$(grep '^API_KEY=' "$SCRIPT_DIR/../.env" | cut -d'=' -f2-)
BASE_URL=$(grep '^BASE_URL=' "$SCRIPT_DIR/../.env" | cut -d'=' -f2-)
BASE_URL="${BASE_URL:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"

echo "=== GET /health === ($BASE_URL)"
curl -s "$BASE_URL/health" | jq . 2>/dev/null || curl -s "$BASE_URL/health"
echo
