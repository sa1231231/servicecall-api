#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source <(grep -E '^(API_KEY|BASE_URL)=' "$SCRIPT_DIR/../.env")
BASE_URL="${BASE_URL:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"

# Build a realistic Retell event_message payload
EVENT_MESSAGE=$(cat <<'INNER'
{
  "event": "call_ended",
  "call": {
    "call_id": "test-call-002",
    "agent_id": "test-agent-001",
    "from_number": "+13175559876",
    "retell_llm_dynamic_variables": {},
    "collected_dynamic_variables": {
      "company_name": "Test Trucking Co",
      "full_name": "John Smith",
      "phone_number": "+13175551234",
      "truck_number": "TR-4521",
      "driver_name": "Mike Johnson",
      "driver_phone": "+13175554321",
      "breakdown_location": "I-65 Southbound, Mile Marker 112, near Lebanon IN",
      "problem_description": "Flat tire on rear passenger side, truck is pulled over on shoulder",
      "whos_paying": "Company account"
    }
  }
}
INNER
)

# Wrap in Retell's event_message envelope
BODY=$(jq -n --arg msg "$EVENT_MESSAGE" '{ event_message: $msg }')

echo "=== POST /email-notification === ($BASE_URL)"
echo "WARNING: This will send a real email to sam@servicecallsaver.com"
echo ""
read -p "Continue? (y/N) " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

curl -s -X POST "$BASE_URL/email-notification" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  | jq . 2>/dev/null || curl -s -X POST "$BASE_URL/email-notification" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY"
echo
