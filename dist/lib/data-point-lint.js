// CI/test-only utility: validates DataPoint registry definitions.
// Run via `npm run test:lint`. Not used by production routes.
import { CALLER_DOESNT_KNOW, NOT_MENTIONED, } from "./agent-generator/data-point-registry.js";
const VAR_REF_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
export function lintDataPoint(dp) {
    const errors = [];
    const v = dp.variableName;
    const push = (code, message) => errors.push({ code, message, variableName: v });
    if (!v || !v.trim()) {
        errors.push({ code: "NO_VARIABLE_NAME", message: "Data point has no variableName" });
        return errors;
    }
    if (!dp.label?.trim())
        push("NO_LABEL", `"${v}" has empty label`);
    if (dp.composite) {
        if (!Array.isArray(dp.variables) || dp.variables.length === 0) {
            push("COMPOSITE_NO_VARIABLES", `"${v}" is composite but has no nested variables`);
        }
        else {
            const names = new Set();
            dp.variables.forEach((sub, i) => errors.push(...lintCompositeVariable(v, sub, i, names)));
        }
        if (dp.extractSuccessEquation && dp.extractSuccessEquation.length > 0) {
            push("COMPOSITE_HAS_EXTRACT_EQUATION", `"${v}" is composite — extractSuccessEquation must be empty`);
        }
    }
    else {
        if (!dp.description?.trim())
            push("NO_DESCRIPTION", `"${v}" has empty description`);
        else if (!mentionsSentinel(dp.description))
            push("DESCRIPTION_MISSING_SENTINEL", `"${v}" description should reference "${NOT_MENTIONED}" so the LLM has a default sink`);
        errors.push(...lintExtractEquation(v, dp.extractSuccessEquation));
    }
    if (!dp.orphan && !dp.conversationPrompt?.trim())
        push("NO_CONVERSATION_PROMPT", `"${v}" has no conversationPrompt`);
    if (!dp.forwardCondition?.trim())
        push("NO_FORWARD_CONDITION", `"${v}" has no forwardCondition`);
    if (dp.type === "enum")
        errors.push(...lintEnumChoices(v, dp.choices));
    if (Array.isArray(dp.finetuneExamples))
        dp.finetuneExamples.forEach((ex, i) => errors.push(...lintFinetuneExample(v, ex, i)));
    return errors;
}
function lintCompositeVariable(parent, sub, i, names) {
    const errors = [];
    const key = `${parent}.variables[${i}]`;
    const ctx = sub.variableName || key;
    if (!sub.variableName) {
        errors.push({
            code: "COMPOSITE_VAR_NO_NAME",
            message: `${parent}: composite variable at index ${i} has no variableName`,
            variableName: parent,
        });
    }
    else if (names.has(sub.variableName)) {
        errors.push({
            code: "COMPOSITE_VAR_DUPLICATE",
            message: `${parent}: duplicate composite variable "${sub.variableName}"`,
            variableName: parent,
        });
    }
    else {
        names.add(sub.variableName);
    }
    if (!sub.description?.trim()) {
        errors.push({
            code: "COMPOSITE_VAR_NO_DESCRIPTION",
            message: `${parent}: composite variable "${ctx}" has no description`,
            variableName: parent,
        });
    }
    if (sub.type === "enum") {
        for (const e of lintEnumChoices(`${parent}.${ctx}`, sub.choices)) {
            errors.push({ ...e, variableName: parent });
        }
    }
    return errors;
}
function lintEnumChoices(name, choices) {
    if (!Array.isArray(choices) || choices.length === 0) {
        return [
            {
                code: "ENUM_NO_CHOICES",
                message: `"${name}" is enum but has no choices`,
                variableName: name,
            },
        ];
    }
    const errors = [];
    if (!choices.includes(NOT_MENTIONED)) {
        errors.push({
            code: "ENUM_MISSING_NOT_MENTIONED",
            message: `"${name}" enum choices must include "${NOT_MENTIONED}" so the LLM has a fallback`,
            variableName: name,
        });
    }
    const seen = new Set();
    for (const c of choices) {
        if (seen.has(c)) {
            errors.push({
                code: "ENUM_DUPLICATE_CHOICE",
                message: `"${name}" has duplicate choice "${c}"`,
                variableName: name,
            });
        }
        seen.add(c);
    }
    return errors;
}
function lintExtractEquation(v, eqs) {
    if (!Array.isArray(eqs) || eqs.length === 0) {
        return [
            {
                code: "NO_EXTRACT_EQUATION",
                message: `"${v}" has empty extractSuccessEquation — agent will never advance`,
                variableName: v,
            },
        ];
    }
    const refsSelf = eqs.some((e) => {
        const m = String(e.left ?? "").match(/^\s*\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}\s*$/);
        return m?.[1] === v;
    });
    if (!refsSelf) {
        return [
            {
                code: "EXTRACT_EQUATION_DOES_NOT_REFERENCE_SELF",
                message: `"${v}" extractSuccessEquation never references {{${v}}}`,
                variableName: v,
            },
        ];
    }
    return [];
}
function lintFinetuneExample(v, ex, i) {
    const errors = [];
    if (!Array.isArray(ex.transcript) || ex.transcript.length === 0) {
        errors.push({
            code: "FINETUNE_EMPTY_TRANSCRIPT",
            message: `"${v}" finetuneExample[${i}] has empty transcript`,
            variableName: v,
        });
    }
    if (ex.type !== "positive" && ex.type !== "negative") {
        errors.push({
            code: "FINETUNE_INVALID_TYPE",
            message: `"${v}" finetuneExample[${i}] type must be "positive" or "negative"`,
            variableName: v,
        });
    }
    return errors;
}
function mentionsSentinel(text) {
    return text.includes(NOT_MENTIONED) || text.includes(CALLER_DOESNT_KNOW);
}
/**
 * Lint branch conditions inside a generated conversation flow against the
 * variables actually extracted upstream. Complements node-validator.ts which
 * checks structural reachability and edge destinations but not semantic
 * variable references.
 */
export function lintBranchVariableReferences(flow) {
    const nodes = flow.nodes ?? [];
    const extractedVars = new Set();
    for (const node of nodes) {
        if (node.type !== "extract_dynamic_variables")
            continue;
        const vars = node.variables ?? [];
        for (const v of vars) {
            const name = v.name;
            if (name)
                extractedVars.add(name);
        }
    }
    const errors = [];
    for (const node of nodes) {
        if (node.type !== "branch")
            continue;
        const edges = node.edges ?? [];
        for (let i = 0; i < edges.length; i++) {
            const tc = edges[i].transition_condition;
            if (!tc || tc.type !== "equation")
                continue;
            const eqs = tc.equations ?? [];
            for (const eq of eqs) {
                const left = String(eq.left ?? "");
                for (const match of left.matchAll(VAR_REF_RE)) {
                    const refName = match[1];
                    if (!extractedVars.has(refName)) {
                        errors.push({
                            code: "BRANCH_REFERENCES_UNKNOWN_VARIABLE",
                            message: `Branch "${node.name}" edge ${i} references {{${refName}}} but no upstream extract node defines it`,
                            variableName: refName,
                        });
                    }
                }
            }
        }
    }
    return errors;
}
