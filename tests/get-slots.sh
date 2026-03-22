#!/usr/bin/env bash
set -e

# Load API_KEY from .env
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_KEY=$(grep '^API_KEY=' "$SCRIPT_DIR/../.env" | cut -d'=' -f2)
BASE_URL="${BASE_URL:-http://localhost:3000}"

echo "=== POST /deckscience/get-slots ==="
curl -s -X POST "$BASE_URL/deckscience/get-slots" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  | jq . 2>/dev/null || curl -s -X POST "$BASE_URL/deckscience/get-slots" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json"
echo
