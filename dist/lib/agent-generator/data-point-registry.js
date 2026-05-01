// ── Types ────────────────────────────────────────────────────────────────────
// ── Constants ────────────────────────────────────────────────────────────────
export const NOT_MENTIONED = "Not Mentioned";
export const CALLER_DOESNT_KNOW = "Caller Doesn't Know";
export const PHONE_COLLECTED_FLAG = "phone_number_collected";
export const PATH_TAKEN_VAR = "_path_taken";
export const INTERNAL_VARS = new Set([PHONE_COLLECTED_FLAG, PATH_TAKEN_VAR]);
// ── Helpers ─────────────────────────────────────────────────────────────────
export function defaultExtractEquation(varName) {
    return [
        { left: `{{${varName}}}`, operator: "exists" },
        { left: `{{${varName}}}`, operator: "!=", right: NOT_MENTIONED },
    ];
}
// Data points are managed via the dashboard UI and stored in the
// `data_point_defaults` MongoDB collection. New deployments should clone
// MongoDB from production. See src/lib/data-point-defaults.ts for CRUD.
