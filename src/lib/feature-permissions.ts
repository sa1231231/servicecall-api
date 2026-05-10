// Feature × level permission system.
//
// Replaces the older flat boolean map (`{create_agents: true, ...}`) with
// a per-feature enum: each feature key (e.g. "agent_config") maps to a
// level — `none`, `read`, `write`, or `manage` — modeled on GitHub's
// repo permissions. `manage` implies `write` implies `read`.
//
// Migration: existing user docs and role-default docs may still carry
// the old shape; `migrateOldPermissionsToFeatureLevels` converts them
// on read so a deploy can be rolled out without a separate batch job.

export type Level = "none" | "read" | "write" | "manage";

export const LEVEL_RANK: Record<Level, number> = {
  none: 0,
  read: 1,
  write: 2,
  manage: 3,
};

export const ALL_LEVELS: Level[] = ["none", "read", "write", "manage"];

export interface FeatureLevelEntry {
  ui: string[];
  routes: string[];
}

export interface Feature {
  key: string;
  label: string;
  description: string;
  // Which levels are *meaningful* for this feature; renders the dropdown.
  // For features that are essentially "can do this action or not"
  // (send_comms, sms_blast, backups), only `none` and `write` are shown.
  available: Level[];
  levels: Partial<Record<Level, FeatureLevelEntry>>;
  // Set when only super_admin / root can grant this. Hidden from the
  // editor for regular admins entirely.
  superAdminOnly?: boolean;
}

// Comprehensive list of features. Adding a new feature here requires
// (a) a corresponding `requireFeature(...)` gate on the relevant routes
// and (b) optionally a `data-feature` attribute in the dashboard UI.
export const FEATURES: Feature[] = [
  {
    key: "agents",
    label: "Agents",
    description: "Browse the agent list, search, and view per-agent detail pages.",
    available: ["none", "read"],
    levels: {
      read: {
        ui: ["Agent list view", "Agent detail header", "Folder navigation"],
        routes: ["GET /dashboard/api/agents", "GET /dashboard/api/agents/:slug"],
      },
    },
  },
  {
    key: "agent_config",
    label: "Agent Configuration",
    description: "Per-agent dispatch numbers, contact info, webhook URL, shadow/active toggles.",
    available: ["none", "read", "write"],
    levels: {
      read: {
        ui: ["View Settings tab", "View Dispatch tab", "View Advanced tab"],
        routes: ["GET /dashboard/api/agents/:slug (covered by Agents:read)"],
      },
      write: {
        ui: ["Save Settings button", "Save Dispatch button", "Shadow/Active toggles"],
        routes: [
          "PATCH /dashboard/api/agents/:slug",
          "PATCH /dashboard/api/agents/:slug/shadow",
          "PATCH /dashboard/api/agents/:slug/active",
        ],
      },
    },
  },
  {
    key: "agent_lifecycle",
    label: "Agent Lifecycle",
    description: "Create new agents, clone existing ones, soft-delete (recoverable for 30 days).",
    available: ["none", "write", "manage"],
    levels: {
      write: {
        ui: ["+ Create button", "Quick Create page", "Clone Agent button"],
        routes: [
          "GET /form (creation form)",
          "POST /agents (deploy)",
          "POST /dashboard/api/agents/:slug/clone",
        ],
      },
      manage: {
        ui: ["Delete Agent button on the detail page"],
        routes: ["DELETE /dashboard/api/agents/:slug"],
      },
    },
  },
  {
    key: "permanent_delete",
    label: "Recently Deleted (Recovery)",
    description: "View soft-deleted agents, restore them, or permanently remove (releases Twilio numbers + Retell agents).",
    available: ["none", "read", "write", "manage"],
    levels: {
      read: {
        ui: ["Recently Deleted Agents section"],
        routes: ["GET /dashboard/api/deleted-agents"],
      },
      write: {
        ui: ["Restore button"],
        routes: ["POST /dashboard/api/deleted-agents/:slug/restore"],
      },
      manage: {
        ui: ["Permanently Delete button"],
        routes: ["DELETE /dashboard/api/deleted-agents/:slug (root required for protected slugs)"],
      },
    },
  },
  {
    key: "node_editor",
    label: "Node Editor",
    description: "Edit conversation prompts, flow transitions, data points, and agent-level prompt fields.",
    available: ["none", "read", "write", "manage"],
    levels: {
      read: {
        ui: ["Nodes tab — read-only flow view"],
        routes: ["GET /dashboard/api/agents/:slug/nodes/:agentId"],
      },
      write: {
        ui: ["Edit prompt buttons", "Add/remove data points", "Save & Publish"],
        routes: ["POST /dashboard/api/agents/:slug/nodes/:agentId/* (mutation routes)"],
      },
      manage: {
        ui: ["Rollback button on the version history list"],
        routes: ["POST /dashboard/api/agents/:slug/nodes/:agentId/rollback"],
      },
    },
  },
  {
    key: "call_logs",
    label: "Call Logs",
    description: "View per-agent call history, transcripts, and recordings.",
    available: ["none", "read"],
    levels: {
      read: {
        ui: ["Calls tab", "Transcript modal", "Audio player"],
        routes: ["GET /dashboard/api/agents/:slug/calls"],
      },
    },
  },
  {
    key: "billing",
    label: "Billing / Costs",
    description: "View call costs, monthly COGS, and per-call rate breakdowns.",
    available: ["none", "read"],
    levels: {
      read: {
        ui: ["Cost columns in call-log tables", "Billing tab", "COGS panel in Settings"],
        routes: ["(no dedicated routes — UI gate only)"],
      },
    },
  },
  {
    key: "folders",
    label: "Folders",
    description: "Organize agents into folders (create, rename, reorder, delete).",
    available: ["none", "read", "write", "manage"],
    levels: {
      read: {
        ui: ["Folder navigation", "Folder labels in agent list"],
        routes: ["GET /dashboard/api/folders"],
      },
      write: {
        ui: ["+ New Folder", "Rename folder", "Drag-reorder folders"],
        routes: [
          "POST /dashboard/api/folders",
          "PATCH /dashboard/api/folders/:id",
          "PATCH /dashboard/api/agents/:slug/folder",
        ],
      },
      manage: {
        ui: ["Delete folder button"],
        routes: ["DELETE /dashboard/api/folders/:id"],
      },
    },
  },
  {
    key: "pending_leads",
    label: "Pending Leads",
    description: "Triage incoming leads (Apps Script intake), enrich with website data, and promote to agents.",
    available: ["none", "read", "write"],
    levels: {
      read: {
        ui: ["Pending Leads view", "Leads badge"],
        routes: ["GET /api/leads, GET /api/leads/:id"],
      },
      write: {
        ui: ["Edit lead", "Re-enrich", "Dismiss", "Promote to Agent"],
        routes: [
          "PATCH /api/leads/:id",
          "POST /api/leads/:id/re-enrich",
          "POST /api/leads/:id/dismiss",
          "POST /api/leads/:id/promote",
        ],
      },
    },
  },
  {
    key: "global_settings",
    label: "Global Settings",
    description: "Workspace-wide settings: owner contact, free trial days, cost rates, lead intake toggle.",
    available: ["none", "read", "write"],
    levels: {
      read: {
        ui: ["Settings → General tab"],
        routes: ["GET /dashboard/api/settings"],
      },
      write: {
        ui: ["Save Settings button", "Lead intake on/off toggle"],
        routes: ["PATCH /dashboard/api/settings"],
      },
    },
  },
  {
    key: "sms_templates",
    label: "SMS Templates",
    description: "Review request, payment link, portal link, and carrier setup-instruction templates.",
    available: ["none", "read", "write"],
    levels: {
      read: {
        ui: ["Settings → Templates tab"],
        routes: ["GET /dashboard/api/settings (covered by Global Settings:read)"],
      },
      write: {
        ui: ["Save Templates", "Save Setup Instructions"],
        routes: ["PATCH /dashboard/api/settings (template fields)"],
      },
    },
  },
  {
    key: "data_point_defaults",
    label: "Data Point Defaults",
    description: "Curated catalog of canonical data point keys (label, description, conversation prompt) shared across agents.",
    available: ["none", "read", "write", "manage"],
    levels: {
      read: {
        ui: ["Settings → Data Points tab — read-only"],
        routes: ["GET /dashboard/api/data-point-defaults"],
      },
      write: {
        ui: ["Add data point", "Edit data point", "Reorder"],
        routes: [
          "POST /dashboard/api/data-point-defaults",
          "PATCH /dashboard/api/data-point-defaults/:key",
          "PUT /dashboard/api/data-point-defaults/reorder",
        ],
      },
      manage: {
        ui: ["Delete data point"],
        routes: ["DELETE /dashboard/api/data-point-defaults/:key"],
      },
    },
  },
  {
    key: "send_comms",
    label: "Send to Client",
    description: "Send review requests, payment links, portal links, and setup instructions to clients via SMS.",
    available: ["none", "write"],
    levels: {
      write: {
        ui: ["Send to Client menu (review request, payment, portal, instructions)"],
        routes: [
          "POST /dashboard/api/agents/:slug/request-review",
          "POST /dashboard/api/agents/:slug/send-instructions",
          "POST /dashboard/api/agents/:slug/send-payment-link",
          "POST /dashboard/api/agents/:slug/send-portal-link",
        ],
      },
    },
  },
  {
    key: "sms_blast",
    label: "SMS Blast",
    description: "Preview and send a one-off SMS to every active client (or a subset). Two-step confirm gate enforced server-side.",
    available: ["none", "read", "write"],
    levels: {
      read: {
        ui: ["Settings → SMS Blast preview area"],
        routes: ["POST /dashboard/api/blast-sms/preview"],
      },
      write: {
        ui: ["Send Blast button (with confirm)"],
        routes: ["POST /dashboard/api/blast-sms"],
      },
    },
  },
  {
    key: "users",
    label: "User Accounts",
    description: "Create/edit/delete dashboard user accounts and manage their per-user permission overrides.",
    available: ["none", "read", "manage"],
    superAdminOnly: true,
    levels: {
      read: {
        ui: ["User Management section — read-only"],
        routes: ["GET /dashboard/api/users"],
      },
      manage: {
        ui: ["Add User form", "Edit user permissions", "Remove user button"],
        routes: [
          "POST /dashboard/api/users",
          "PATCH /dashboard/api/users/:username/permissions",
          "DELETE /dashboard/api/users/:username",
        ],
      },
    },
  },
  {
    key: "role_defaults",
    label: "Role Defaults",
    description: "Edit the default permission set for each role (Admin / Operator / Viewer). Super Admin always has all permissions.",
    available: ["none", "read", "manage"],
    superAdminOnly: true,
    levels: {
      read: {
        ui: ["Role × feature matrix in the Permission Reference panel"],
        routes: ["GET /dashboard/api/role-defaults"],
      },
      manage: {
        ui: ["Editable matrix + Save Defaults button"],
        routes: ["PATCH /dashboard/api/role-defaults/:role"],
      },
    },
  },
  {
    key: "audit_log",
    label: "Audit Log",
    description: "View the audit trail of dashboard actions (who changed what, when) under Settings → Activity Log.",
    available: ["none", "read"],
    levels: {
      read: {
        ui: ["Settings → Activity Log tab — filterable list of recent actions"],
        routes: ["GET /dashboard/api/audit-log"],
      },
    },
  },
  {
    key: "backups",
    label: "Backups",
    description: "Trigger a manual MongoDB backup to S3.",
    available: ["none", "write"],
    levels: {
      write: {
        ui: ["(no dedicated UI yet) — POST /backup"],
        routes: ["POST /backup"],
      },
    },
  },
  {
    key: "phone_numbers",
    label: "Phone Numbers",
    description: "List phone numbers managed in Twilio + Retell, see which agents they're bound to.",
    available: ["none", "read"],
    levels: {
      read: {
        ui: ["Settings → Phone Numbers panel"],
        routes: ["GET /dashboard/api/phone-numbers"],
      },
    },
  },
  {
    key: "transcript_review",
    label: "Transcript Review",
    description: "AI-generated suggestions from call transcripts (unanswered questions, misheard confirmations, etc.). Approving a suggestion publishes the change to Retell.",
    available: ["none", "read", "write", "manage"],
    levels: {
      read: {
        ui: ["Suggestions tab on agent page", "Suggestions inbox"],
        routes: [
          "GET /dashboard/api/agents/:slug/suggestions",
          "GET /dashboard/api/suggestions",
          "GET /dashboard/api/suggestions/:id",
        ],
      },
      write: {
        ui: ["Approve / Edit / Reject buttons on suggestion cards"],
        routes: [
          "POST /dashboard/api/suggestions/:id/approve",
          "POST /dashboard/api/suggestions/:id/edit",
          "POST /dashboard/api/suggestions/:id/reject",
        ],
      },
      manage: {
        ui: ["Per-agent transcript_review_enabled toggle", "Per-draft is_template toggle"],
        routes: [
          "PATCH /dashboard/api/agents/:slug (transcript_review_enabled field)",
          "PUT /form/drafts/:id (is_template field)",
        ],
      },
    },
  },
];

export const FEATURE_KEYS: string[] = FEATURES.map((f) => f.key);
export const FEATURE_BY_KEY: Record<string, Feature> = Object.fromEntries(
  FEATURES.map((f) => [f.key, f]),
);

/** True iff `actual` meets or exceeds `required` (higher levels imply lower). */
export function satisfies(actual: Level | undefined, required: Level): boolean {
  return LEVEL_RANK[actual ?? "none"] >= LEVEL_RANK[required];
}

/** Same as `satisfies`, but pulls from a permission map. */
export function hasFeatureLevel(
  perms: Record<string, Level> | undefined,
  feature: string,
  required: Level,
): boolean {
  return satisfies(perms?.[feature], required);
}

// ── Role defaults under the new shape ───────────────────────────────────────

export type Role = "super_admin" | "admin" | "operator" | "viewer";
export const ROLES: Role[] = ["super_admin", "admin", "operator", "viewer"];

/** Highest meaningful level for a feature (e.g. for super_admin who gets
 *  the maximum of everything, regardless of stored map). */
function maxLevel(feature: Feature): Level {
  const ranks = feature.available.map((l) => LEVEL_RANK[l]);
  const max = Math.max(...ranks);
  return (Object.entries(LEVEL_RANK).find(([, r]) => r === max)?.[0] ?? "none") as Level;
}

/** Pick the level for `feature` matching `targetRank`; fall back to the
 *  highest available level <= targetRank. */
function levelAtOrBelow(feature: Feature, targetRank: number): Level {
  const candidates = feature.available
    .map((l) => ({ l, r: LEVEL_RANK[l] }))
    .filter((x) => x.r <= targetRank)
    .sort((a, b) => b.r - a.r);
  return (candidates[0]?.l ?? "none") as Level;
}

/** Hardcoded seed defaults for the four roles, used when no DB doc has
 *  been written for that role yet (first boot) and as the migration
 *  target shape. */
export const SEED_FEATURE_DEFAULTS: Record<Role, Record<string, Level>> = {
  super_admin: Object.fromEntries(FEATURES.map((f) => [f.key, maxLevel(f)])),
  admin: Object.fromEntries(FEATURES.map((f) => {
    if (f.superAdminOnly) return [f.key, "none"];
    return [f.key, maxLevel(f)];
  })),
  operator: Object.fromEntries(FEATURES.map((f) => {
    if (f.superAdminOnly) return [f.key, "none"];
    // Operators get write everywhere except permanent_delete, sms_blast,
    // and a few sensitive areas where they get read-only.
    const writeOnly = new Set([
      "permanent_delete", // can read+restore but not permanently delete
      "global_settings",  // can read but not edit
      "sms_templates",    // can read but not edit
      "data_point_defaults",
      "audit_log",
      "billing",
    ]);
    if (writeOnly.has(f.key)) return [f.key, levelAtOrBelow(f, LEVEL_RANK.read)];
    return [f.key, levelAtOrBelow(f, LEVEL_RANK.write)];
  })),
  viewer: Object.fromEntries(FEATURES.map((f) => {
    if (f.superAdminOnly) return [f.key, "none"];
    // Viewers see most things but write nothing.
    return [f.key, levelAtOrBelow(f, LEVEL_RANK.read)];
  })),
};

// Tighten a few specific defaults for operator that the formula above
// gets wrong:
//   - permanent_delete: write (can restore, not permanently delete)
//   - sms_blast: write is OK (the route is also confirm-gated)
SEED_FEATURE_DEFAULTS.operator.permanent_delete = "write";

// ── Migration from the old flat-boolean shape ───────────────────────────────

/** Map the legacy boolean permissions object to the new feature/level
 *  shape. Used when reading user docs or role-default docs that were
 *  written before this refactor.
 *
 *  The mapping aims to *preserve* what each user could do, not to
 *  reset them to the new defaults — losing a customization to a schema
 *  change is worse than over-granting in a couple edge cases. */
export function migrateOldPermissionsToFeatureLevels(
  old: Record<string, boolean> | undefined | null,
  role?: Role,
): Record<string, Level> {
  // If the doc already has the new shape (string values), return it
  // unchanged. Reject empty maps so they fall through to seed defaults.
  if (
    old &&
    typeof old === "object" &&
    Object.keys(old).length > 0 &&
    Object.values(old).every((v) => typeof v === "string")
  ) {
    return old as unknown as Record<string, Level>;
  }
  // Start from the role's seed defaults (or super_admin's if no role
  // given — over-grant is safer than under-grant during migration since
  // the user still has to be able to log in and use the dashboard).
  const seed = SEED_FEATURE_DEFAULTS[role ?? "operator"];
  const out: Record<string, Level> = { ...seed };
  if (!old) return out;

  // Boolean key → (feature, level) overrides. When the boolean is true,
  // bump the listed feature(s) to at least the listed level. When false,
  // clamp to a lower level (this matters for explicit "user can't do X"
  // overrides like turning off send_comms for a viewer-ish operator).
  const grants: Array<{ key: string; ifTrue: Array<[string, Level]>; ifFalse?: Array<[string, Level]> }> = [
    { key: "create_agents", ifTrue: [["agent_lifecycle", "write"]], ifFalse: [["agent_lifecycle", "none"]] },
    { key: "edit_agents", ifTrue: [["agent_config", "write"], ["node_editor", "write"], ["folders", "write"]],
      ifFalse: [["agent_config", "read"], ["node_editor", "read"], ["folders", "read"]] },
    { key: "clone_agents", ifTrue: [["agent_lifecycle", "write"]] },
    { key: "delete_agents", ifTrue: [["agent_lifecycle", "manage"]], ifFalse: [["agent_lifecycle", "write"]] },
    { key: "send_comms", ifTrue: [["send_comms", "write"], ["sms_blast", "write"]],
      ifFalse: [["send_comms", "none"], ["sms_blast", "none"]] },
    { key: "manage_settings", ifTrue: [["global_settings", "write"], ["sms_templates", "write"]],
      ifFalse: [["global_settings", "read"], ["sms_templates", "read"]] },
    { key: "manage_data_points", ifTrue: [["data_point_defaults", "manage"]], ifFalse: [["data_point_defaults", "read"]] },
    { key: "manage_users", ifTrue: [["users", "manage"]], ifFalse: [["users", "none"]] },
    { key: "view_billing", ifTrue: [["billing", "read"]], ifFalse: [["billing", "none"]] },
    { key: "manage_deleted", ifTrue: [["permanent_delete", "manage"]], ifFalse: [["permanent_delete", "none"]] },
    { key: "manage_leads", ifTrue: [["pending_leads", "write"]], ifFalse: [["pending_leads", "none"]] },
  ];

  for (const g of grants) {
    if (!(g.key in old)) continue;
    const value = !!old[g.key];
    const tuples = value ? g.ifTrue : (g.ifFalse ?? []);
    for (const [feature, level] of tuples) {
      const f = FEATURE_BY_KEY[feature];
      if (!f) continue;
      // Only apply if the level is in the feature's available set;
      // otherwise round to the nearest available.
      const levelToSet = f.available.includes(level) ? level : levelAtOrBelow(f, LEVEL_RANK[level]);
      // Take the MAX of the existing seed and the migration grant (so
      // a "true" boolean never demotes a higher seed default).
      // For "false" overrides, take the MIN to clamp.
      const existing = out[feature] ?? "none";
      if (value) {
        if (LEVEL_RANK[levelToSet] > LEVEL_RANK[existing]) out[feature] = levelToSet;
      } else {
        if (LEVEL_RANK[levelToSet] < LEVEL_RANK[existing]) out[feature] = levelToSet;
      }
    }
  }

  // Ensure every feature has a level (default to "none" if somehow missing).
  for (const f of FEATURES) {
    if (!(f.key in out)) out[f.key] = "none";
  }
  return out;
}

/** Resolve effective feature permissions for a user. Mirrors the old
 *  resolvePermissions() logic but in the new shape:
 *  - super_admin / admin: defaults are authoritative; stored is ignored.
 *  - operator / viewer: stored map overrides per-feature levels.
 *
 *  `defaults` is the role's default map (loaded from MongoDB cache by
 *  the caller). `stored` is the per-user override map (also already in
 *  the new shape after migration). */
export function resolveFeaturePermissions(
  role: Role,
  defaults: Record<string, Level>,
  stored?: Record<string, Level>,
): Record<string, Level> {
  if (role === "super_admin" || role === "admin") {
    // Always returns the role default — stored is ignored.
    return { ...defaults };
  }
  const out = { ...defaults };
  if (stored) {
    for (const f of FEATURE_KEYS) {
      if (f in stored) out[f] = stored[f] as Level;
    }
  }
  return out;
}
