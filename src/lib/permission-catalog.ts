// Human-readable map of every legacy `requirePermission(...)` permission
// to the routes and UI it gates. Surfaced in the dashboard's "Permission
// Reference" panel.
//
// IMPORTANT — SCOPE: this catalog documents the **legacy** flat-permission
// model only (`PERMISSION_DEFS` in `users.ts`). The codebase has largely
// migrated to the feature/level model in `feature-permissions.ts` + the
// `requireFeature(feature, level)` middleware. New routes should be gated
// with `requireFeature(...)`, not `requirePermission(...)`, and the
// dashboard's role-management matrix is now driven by FEATURES /
// SEED_FEATURE_DEFAULTS — not by this catalog.
//
// What this catalog still gates: a few legacy `requirePermission("...")`
// call sites that haven't been migrated to the new model.
//
// What checks this against drift:
//   - `__tests__/permission-catalog.test.ts` — verifies every key in
//     `PERMISSION_DEFS` (the legacy enum in `users.ts`) appears here and
//     vice versa. It walks the static array, NOT the live router.
//   - `__tests__/feature-permission-drift.test.ts` — separate test that
//     guards the NEW model: every `requireFeature(...)` call site uses a
//     known FEATURE_KEY and a valid Level.

export interface PermissionEntry {
  key: string;
  routes: string[]; // backend HTTP routes
  ui: string[];     // dashboard UI elements / sections
  notes?: string;   // gotchas — e.g. "admin role gets this regardless of stored map"
}

export const PERMISSION_CATALOG: PermissionEntry[] = [
  {
    key: "create_agents",
    routes: [
      "GET /form (the agent creation form)",
      "POST /agents (create + deploy a new agent)",
    ],
    ui: [
      "+ Create button in the dashboard header",
      "Quick Create page (/quick-create.html)",
    ],
  },
  {
    key: "edit_agents",
    routes: [
      "PATCH /dashboard/api/agents/:slug",
      "PATCH /dashboard/api/agents/:slug/shadow",
      "PATCH /dashboard/api/agents/:slug/active",
      "PATCH /dashboard/api/agents/:slug/folder",
      "All /dashboard/api/agents/:slug/nodes/* routes (node editor)",
      "POST /dashboard/api/folders, PATCH /folders/:id, DELETE /folders/:id",
    ],
    ui: [
      "Save buttons in Agent Settings, Dispatch, Node Editor",
      "Folder toolbar (create/rename/delete)",
      "Shadow / Active toggles",
    ],
    notes: "Covers both client-doc edits AND node-editor mutations (prompts, flows, data points).",
  },
  {
    key: "clone_agents",
    routes: [
      "POST /dashboard/api/agents/:slug/clone",
    ],
    ui: [
      "Clone Agent button on the agent detail page",
    ],
  },
  {
    key: "delete_agents",
    routes: [
      "DELETE /dashboard/api/agents/:slug (soft-delete; recoverable for 30 days)",
    ],
    ui: [
      "Delete button on the agent detail page",
    ],
    notes: "Some slugs (ROOT_ONLY_DELETE_SLUGS — e.g. demo-hvac) require root regardless of this permission.",
  },
  {
    key: "send_comms",
    routes: [
      "POST /dashboard/api/agents/:slug/request-review",
      "POST /dashboard/api/agents/:slug/send-instructions",
      "POST /dashboard/api/agents/:slug/send-payment-link",
      "POST /dashboard/api/agents/:slug/send-portal-link",
      "POST /dashboard/api/blast-sms/preview",
      "POST /dashboard/api/blast-sms",
    ],
    ui: [
      "Send to Client menu (review request, instructions, payment, portal)",
      "SMS Blast settings tab",
    ],
  },
  {
    key: "manage_settings",
    routes: [
      "PATCH /dashboard/api/settings",
    ],
    ui: [
      "Settings page Save button",
      "Lead intake on/off toggle (next to + Create)",
    ],
    notes: "Settings PATCH is now field-validated server-side and writes a before/after diff to the audit log.",
  },
  {
    key: "manage_data_points",
    routes: [
      "POST /dashboard/api/data-point-defaults",
      "PATCH /dashboard/api/data-point-defaults/:key",
      "PUT /dashboard/api/data-point-defaults/reorder",
      "DELETE /dashboard/api/data-point-defaults/:key",
    ],
    ui: [
      "Data Point Defaults editor (in Settings)",
    ],
  },
  {
    key: "manage_users",
    routes: [
      "GET /dashboard/api/users",
      "POST /dashboard/api/users",
      "PATCH /dashboard/api/users/:username/permissions",
      "DELETE /dashboard/api/users/:username",
    ],
    ui: [
      "User Management section in Settings",
    ],
    notes: "Editing super_admin/admin permissions has no effect — their effective perms come from the role default, not the stored map.",
  },
  {
    key: "view_billing",
    routes: [
      "(no dedicated routes — the billing tab pulls call data from the standard endpoints)",
    ],
    ui: [
      "Billing tab on each agent",
      "Cost columns in call-log tables",
      "COGS panel in Settings",
    ],
    notes: "This is a UI-visibility-only permission — there is no server enforcement. Treat it as 'should this user see cost numbers' rather than a security boundary.",
  },
  {
    key: "manage_deleted",
    routes: [
      "GET /dashboard/api/deleted-agents",
      "POST /dashboard/api/deleted-agents/:slug/restore",
      "DELETE /dashboard/api/deleted-agents/:slug (permanent delete; releases Twilio numbers + Retell agents)",
    ],
    ui: [
      "Recently Deleted Agents section in the agent list",
    ],
    notes: "Permanent-delete on protected slugs (ROOT_ONLY_DELETE_SLUGS) requires root.",
  },
  {
    key: "manage_leads",
    routes: [
      "All /api/leads/* routes (list, view, edit, re-enrich, dismiss, promote)",
    ],
    ui: [
      "Pending Leads view (the eyeball badge next to + Create)",
    ],
    notes: "The public POST /api/leads/intake endpoint (used by the Apps Script) does NOT require this permission — it's API-key authed.",
  },
];

export const PERMISSION_CATALOG_BY_KEY: Record<string, PermissionEntry> =
  Object.fromEntries(PERMISSION_CATALOG.map((p) => [p.key, p]));
