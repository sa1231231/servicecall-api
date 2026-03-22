#!/usr/bin/env bash
set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"

echo "=== GET /health ==="
curl -s "$BASE_URL/health" | jq . 2>/dev/null || curl -s "$BASE_URL/health"
echo
