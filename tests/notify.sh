#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_KEY=$(grep '^API_KEY=' "$SCRIPT_DIR/../.env" | cut -d'=' -f2-)
BASE_URL=$(grep '^BASE_URL=' "$SCRIPT_DIR/../.env" | cut -d'=' -f2-)
BASE_URL="${BASE_URL:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"

echo "=== POST /retell/post-hook (test client — emergency) === ($BASE_URL)"
curl -s -X POST "$BASE_URL/retell/post-hook" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "call_ended",
    "call": {
      "call_id": "test-call-001",
      "agent_id": "test-agent-001",
      "from_number": "+13017872841",
      "collected_dynamic_variables": {
        "client_id": "test",
        "is_emergency": "true",
        "full_name": "John Smith",
        "phone_number": "619-555-1234",
        "address": "1252 Main Street",
        "problem_description": "Pipe burst under kitchen sink"
      }
    }
  }' | jq . 2>/dev/null || echo "(no JSON response)"
echo

echo "=== POST /retell/post-hook (test client — service quote) === ($BASE_URL)"
curl -s -X POST "$BASE_URL/retell/post-hook" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "call_ended",
    "call": {
      "call_id": "test-call-002",
      "agent_id": "test-agent-001",
      "from_number": "+13017872841",
      "collected_dynamic_variables": {
        "client_id": "test",
        "is_emergency": "false",
        "full_name": "Jane Doe",
        "phone_number": "858-555-9876",
        "address": "742 Evergreen Terrace",
        "problem_description": "Cracked foundation near garage",
        "time_preference": "Weekday mornings"
      }
    }
  }' | jq . 2>/dev/null || echo "(no JSON response)"
echo
