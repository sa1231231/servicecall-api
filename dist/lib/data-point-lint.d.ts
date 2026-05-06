import { type DataPoint } from "./agent-generator/data-point-registry.js";
export interface LintError {
    code: string;
    message: string;
    variableName?: string;
}
export declare function lintDataPoint(dp: DataPoint): LintError[];
/**
 * Lint branch conditions inside a generated conversation flow against the
 * variables actually extracted upstream. Complements node-validator.ts which
 * checks structural reachability and edge destinations but not semantic
 * variable references.
 */
export declare function lintBranchVariableReferences(flow: Record<string, unknown>): LintError[];
