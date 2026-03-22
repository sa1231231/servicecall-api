#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source <(grep -E '^(API_KEY|BASE_URL)=' "$SCRIPT_DIR/../.env")
BASE_URL="${BASE_URL:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"

echo "=== POST /deckscience/get-slots === ($BASE_URL)"
curl -s -X POST "$BASE_URL/deckscience/get-slots" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  | jq . 2>/dev/null || curl -s -X POST "$BASE_URL/deckscience/get-slots" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json"
echo
