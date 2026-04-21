/**
 * One-time migration script: moves all client configs into MongoDB.
 *
 * Usage: npx tsx src/scripts/migrate-clients.ts
 *
 * Requires MONGODB_URL env var (set in .env or Railway).
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MONGODB_URL = process.env.MONGODB_URL;
if (!MONGODB_URL) {
  console.error("MONGODB_URL env var is required");
  process.exit(1);
}

// ── Hardcoded clients (converted from notification-clients.ts) ───────────────
// resolve_type functions → resolve_rule objects

const OWNER_PHONE = "+13017872841";
const OWNER_EMAIL = "samasra93@gmail.com";

const hardcodedClients: Record<string, Record<string, unknown>> = {
  "pro-v": {
    name: "Pro V",
    agent_ids: ["agent_874f64ef6ad0aaa6a233be461e"],
    dispatch_text_numbers: ["+19517608403", "+16193007267", OWNER_PHONE],
    dispatch_call_number: null,
    summary_agent_id: null,
    outbound_from_number: null,
    dispatch_email: ["info@provcontracting.com", OWNER_EMAIL],
    dispatch_cc: null,
    resolve_rule: {
      field: "is_emergency",
      equals: "true",
      then: "emergency",
      else: "service_request",
    },
    message_types: {
      emergency: {
        label: "EMERGENCY CALL",
        subject_template:
          "EMERGENCY: {{full_name}} — {{street_address}}, {{city}}",
        additional_text: "Caller expects contact within 10 minutes.",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "street_address", label: "Address" },
          { key: "city", label: "City" },
          { key: "problem_description", label: "Problem" },
        ],
      },
      service_request: {
        label: "New Service Request",
        subject_template:
          "Service Request: {{full_name}} — {{street_address}}, {{city}}",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "street_address", label: "Address" },
          { key: "city", label: "City" },
          { key: "problem_description", label: "Problem" },
          { key: "preferred_time", label: "Preferred Time" },
          { key: "preferred_day", label: "Preferred Day" },
        ],
      },
    },
    default_message_type: "service_request",
    phone_fallback_to_caller: true,
    shadow_mode: true,
  },
  test: {
    name: "Test Client",
    agent_ids: [],
    dispatch_text_numbers: [OWNER_PHONE],
    dispatch_call_number: null,
    summary_agent_id: null,
    outbound_from_number: null,
    dispatch_email: [OWNER_EMAIL],
    dispatch_cc: null,
    resolve_rule: {
      field: "is_emergency",
      equals: "true",
      then: "emergency",
      else: "service_request",
    },
    message_types: {
      emergency: {
        label: "EMERGENCY CALL",
        subject_template:
          "EMERGENCY: {{full_name}} — {{street_address}}, {{city}}",
        additional_text: "Caller expects contact within 10 minutes.",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "street_address", label: "Address" },
          { key: "problem_description", label: "Problem" },
        ],
      },
      service_request: {
        label: "New Service Request",
        subject_template:
          "Service Request: {{full_name}} — {{street_address}}, {{city}}",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "street_address", label: "Address" },
          { key: "city", label: "City" },
          { key: "problem_description", label: "Problem" },
          { key: "preferred_time", label: "Preferred Time" },
          { key: "preferred_day", label: "Preferred Day" },
        ],
      },
    },
    default_message_type: "service_request",
    phone_fallback_to_caller: true,
    shadow_mode: true,
  },
  "j-a": {
    name: "J&A Fleet Maintenance",
    agent_ids: ["agent_09483ca979c6987f8af2ebc00c"],
    dispatch_text_numbers: [
      "+18152073809",
      "+15748708959",
      "+18156666686",
      OWNER_PHONE,
    ],
    dispatch_call_number: "+18152073809",
    summary_agent_id: "agent_b1e4f94114485c41252b802afb",
    outbound_from_number: "+15747667823",
    dispatch_email: ["Dispatch@JAFleet.com", OWNER_EMAIL],
    dispatch_cc: null,
    // No resolve_rule — single message type, default handles it
    message_types: {
      mobile_emergency: {
        label: "EMERGENCY REPAIR CALL",
        subject_template:
          "Emergency: {{company_name}} — {{breakdown_location}}",
        fields: [
          {
            key: "is_dispatch",
            label: "Dispatch",
            show: false,
            required: { equals: "true" },
          },
          { key: "company_name", label: "Company" },
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "phone_number_extension", label: "Phone Ext" },
          { key: "truck_number", label: "Truck #" },
          { key: "driver_name", label: "Driver Name" },
          { key: "driver_phone", label: "Driver Phone" },
          { key: "driver_phone_extension", label: "Driver Phone Ext" },
          {
            key: "breakdown_location",
            label: "Breakdown Location",
            required: true,
          },
          {
            key: "problem_description",
            label: "Problem Description",
            required: true,
          },
          { key: "vehicle_type", label: "Vehicle Type" },
          { key: "vehicle_manufacturer", label: "Vehicle Make" },
          { key: "vehicle_color", label: "Vehicle Color" },
          {
            key: "is_loaded",
            label: "Is it Loaded?",
            show_when: { field: "load_weight_collected", equals: "true" },
            format: "yes_no",
          },
          {
            key: "load_weight",
            label: "Load Weight",
            show_when: { field: "load_weight_collected", equals: "true" },
          },
          { key: "whos_paying", label: "Who's Paying" },
          { key: "payment_method", label: "Payment Method" },
        ],
      },
    },
    default_message_type: "mobile_emergency",
    phone_fallback_to_caller: true,
    hide_not_mentioned: true,
    shadow_mode: false,
  },
  test_prod: {
    name: "Test Client (Prod)",
    agent_ids: [],
    dispatch_text_numbers: [OWNER_PHONE],
    dispatch_call_number: null,
    summary_agent_id: null,
    outbound_from_number: null,
    dispatch_email: [OWNER_EMAIL],
    dispatch_cc: null,
    resolve_rule: {
      field: "is_emergency",
      equals: "true",
      then: "emergency",
      else: "service_request",
    },
    message_types: {
      emergency: {
        label: "EMERGENCY CALL",
        subject_template:
          "EMERGENCY: {{full_name}} — {{street_address}}, {{city}}",
        additional_text: "Caller expects contact within 10 minutes.",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "street_address", label: "Address" },
          { key: "problem_description", label: "Problem" },
        ],
      },
      service_request: {
        label: "New Service Request",
        subject_template:
          "Service Request: {{full_name}} — {{street_address}}, {{city}}",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "street_address", label: "Address" },
          { key: "city", label: "City" },
          { key: "problem_description", label: "Problem" },
          { key: "preferred_time", label: "Preferred Time" },
          { key: "preferred_day", label: "Preferred Day" },
        ],
      },
    },
    default_message_type: "service_request",
    phone_fallback_to_caller: true,
    shadow_mode: true,
  },
};

// ── JSON-file clients ────────────────────────────────────────────────────────

const jsonPath = path.join(__dirname, "../config/notification-clients.json");
let jsonClients: Record<string, Record<string, unknown>> = {};
if (fs.existsSync(jsonPath)) {
  jsonClients = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  console.log(
    `Loaded ${Object.keys(jsonClients).length} client(s) from notification-clients.json`,
  );
}

// ── Migrate ──────────────────────────────────────────────────────────────────

async function main() {
  const client = new MongoClient(MONGODB_URL!);
  await client.connect();
  const db = client.db();
  const col = db.collection("clients");

  const allClients = { ...hardcodedClients, ...jsonClients };
  let upserted = 0;

  for (const [slug, entry] of Object.entries(allClients)) {
    await col.replaceOne(
      { _id: slug as any },
      { _id: slug, ...entry } as any,
      { upsert: true },
    );
    upserted++;
    console.log(`  [${upserted}] upserted "${slug}"`);
  }

  console.log(`\nMigration complete: ${upserted} client(s) upserted.`);
  await client.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
