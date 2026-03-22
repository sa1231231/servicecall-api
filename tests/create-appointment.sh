#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source <(grep -E '^(API_KEY|BASE_URL)=' "$SCRIPT_DIR/../.env")
BASE_URL="${BASE_URL:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"

echo "=== Fetching available slots... === ($BASE_URL)"
SLOTS_RESPONSE=$(curl -s -X POST "$BASE_URL/deckscience/get-slots" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json")

# Flatten all slots into a numbered list: "1) Monday, March 23 — 9:00 AM  [iso]"
SLOT_LIST=$(echo "$SLOTS_RESPONSE" | jq -r '
  [.available_slots[] | .date as $date | .times[] | "\($date) — \(.display)|\(.iso)"]
  | to_entries[]
  | "\(.key + 1)) \(.value)"
')

if [[ -z "$SLOT_LIST" ]]; then
  echo "No available slots found."
  exit 1
fi

# Display slots (hide the ISO part)
echo ""
echo "$SLOT_LIST" | while IFS='|' read -r display iso; do
  echo "$display"
done

echo ""
read -p "Pick a slot number: " CHOICE

# Extract the ISO value for the chosen slot
SELECTED_ISO=$(echo "$SLOT_LIST" | sed -n "${CHOICE}p" | cut -d'|' -f2)
SELECTED_DISPLAY=$(echo "$SLOT_LIST" | sed -n "${CHOICE}p" | cut -d'|' -f1 | sed 's/^[0-9]*) //')

if [[ -z "$SELECTED_ISO" ]]; then
  echo "Invalid selection."
  exit 1
fi

echo ""
echo "Selected: $SELECTED_DISPLAY → $SELECTED_ISO"
echo ""

# Build a realistic Retell event_message payload
EVENT_MESSAGE=$(cat <<INNER
{
  "event": "call_ended",
  "call": {
    "call_id": "test-call-001",
    "agent_id": "test-agent-001",
    "from_number": "+13175551234",
    "retell_llm_dynamic_variables": {
      "contact_id": "cgyF4ZXTnW2VQDzRCWpA"
    },
    "collected_dynamic_variables": {
      "matched_time_slot": "${SELECTED_ISO}",
      "physical_address": "123 Test Street, Indianapolis, IN 46201",
      "contact_id": "cgyF4ZXTnW2VQDzRCWpA"
    }
  }
}
INNER
)

# Wrap in Retell's event_message envelope
BODY=$(jq -n --arg msg "$EVENT_MESSAGE" '{ event_message: $msg }')

echo "=== POST /deckscience/create-appointment ==="
curl -s -X POST "$BASE_URL/deckscience/create-appointment" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  | jq . 2>/dev/null || curl -s -X POST "$BASE_URL/deckscience/create-appointment" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY"
echo
