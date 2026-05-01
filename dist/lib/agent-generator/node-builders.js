import { NOT_MENTIONED, PHONE_COLLECTED_FLAG, PATH_TAKEN_VAR } from "./data-point-registry.js";
import { renderTemplate } from "../build-notification.js";
// Default templates for the three closing nodes. Use {{business_name}} — substituted on the way to Retell.
export const DEFAULT_CLOSE_PROMPT = `Thank the caller for all the information, and let them know our team at {{business_name}} will reach out to get them set up as soon as possible.`;
export const DEFAULT_CLOSING_REMARKS_PROMPT = `You are about to end the call. Do not ask any questions.\n\nThank them and tell them to have a wonderful day. `;
export const DEFAULT_CLOSING_STATEMENT_TEXT = `Alright, bye now!`;
// Spoken right before a per-path live transfer kicks off.
export const DEFAULT_PRE_TRANSFER_PROMPT = `Thanks for the information. Hold on a moment — connecting you to our team at {{business_name}} now.`;
// ── ID Factory ───────────────────────────────────────────────────────────────
function randomSuffix(len) {
    return Math.random()
        .toString(36)
        .slice(2, 2 + len)
        .padEnd(len, "0");
}
export function makeIdFactory(baseMs) {
    let counter = baseMs || Date.now();
    return {
        nextTs() {
            return ++counter;
        },
        nodeId() {
            return `node-${++counter}`;
        },
        edgeId() {
            return `edge-${++counter}-${randomSuffix(9)}`;
        },
        goBackId() {
            return `go-back-${++counter}`;
        },
    };
}
// ── Finetune Example Helper ──────────────────────────────────────────────────
function resolveFinetuneExamples(examples, defaultPositiveDestId, nodeMap, f) {
    return (examples || []).map((ex) => {
        const out = {
            transcript: ex.transcript,
            id: ex.id || `fe-${f.nextTs()}`,
        };
        if (ex.type === "positive") {
            const dest = ex.destination && nodeMap[ex.destination]
                ? nodeMap[ex.destination]
                : defaultPositiveDestId;
            out.destination_node_id = dest;
        }
        return out;
    });
}
// ── Pre-allocate IDs ─────────────────────────────────────────────────────────
export function generateIds(f, pathDataPoints, pathEndModes) {
    const paths = pathDataPoints.map((dps, idx) => {
        const isTransfer = pathEndModes?.[idx] === "transfer";
        return {
            transitionId: f.nodeId(),
            frontExtractId: f.nodeId(),
            routerId: f.nodeId(),
            chain: dps.map(() => ({
                convId: f.nodeId(),
                confirmId: f.nodeId(),
            })),
            ...(isTransfer
                ? { preTransferId: f.nodeId(), transferCallId: f.nodeId() }
                : {}),
        };
    });
    return {
        introId: f.nodeId(),
        endId: f.nodeId(),
        faqId: f.nodeId(),
        humanReqId: f.nodeId(),
        transferCallId: f.nodeId(),
        transferFailedId: f.nodeId(),
        irrelevantGuardrailId: f.nodeId(),
        emergencyGuardrailId: f.nodeId(),
        politeHangupId: f.nodeId(),
        guardrailEndId: f.nodeId(),
        closeId: f.nodeId(),
        closingRemarksId: f.nodeId(),
        closingStatementId: f.nodeId(),
        paths,
    };
}
// ── Layout ───────────────────────────────────────────────────────────────────
const BASE_X = -954;
const STEP_X = 550;
const PATH_Y_OFFSET = 2000;
export function layoutPositions(pathDataPoints, pathEndModes) {
    const paths = pathDataPoints.map((dps, pathIdx) => {
        const yBase = pathIdx * PATH_Y_OFFSET;
        const isTransfer = pathEndModes?.[pathIdx] === "transfer";
        return {
            transition: { x: -18, y: -400 + yBase },
            frontExtract: { x: -18, y: 0 + yBase },
            router: { x: -18, y: 450 + yBase },
            chain: dps.map((_, i) => ({
                conv: { x: BASE_X + i * STEP_X, y: 900 + yBase },
                confirm: { x: BASE_X + i * STEP_X, y: 1350 + yBase },
            })),
            ...(isTransfer
                ? {
                    preTransfer: { x: -18, y: 1800 + yBase },
                    transferCall: { x: 540, y: 1800 + yBase },
                }
                : {}),
        };
    });
    const chainLengths = pathDataPoints.map((dps) => dps.length);
    const maxChainLen = chainLengths.length > 0 ? Math.max(...chainLengths) : 0;
    const lastX = BASE_X + (maxChainLen - 1) * STEP_X + STEP_X;
    const lastPathYBase = (pathDataPoints.length - 1) * PATH_Y_OFFSET;
    return {
        intro: { x: -18, y: -906 },
        end: { x: 1494, y: -882 },
        faq: { x: -1386, y: -1770 },
        humanReq: { x: -954, y: -1770 },
        irrelevantGuardrail: { x: -1386, y: -2490 },
        emergencyGuardrail: { x: -882, y: -2778 },
        politeHangup: { x: -1026, y: -2394 },
        guardrailEnd: { x: -666, y: -2346 },
        close: { x: lastX, y: 894 + lastPathYBase },
        paths,
    };
}
// ── Node Builders ────────────────────────────────────────────────────────────
export function buildEndNode(ids, pos) {
    return {
        name: "End Call",
        id: ids.endId,
        type: "end",
        speak_during_execution: false,
        display_position: pos.end,
    };
}
export function buildTransitionNode(pathIds, pathPos, f, pathName) {
    return {
        instruction: {
            type: "prompt",
            text: `The caller stated their situation, and you're about to note down the details. You can say something like

"alright let me grab the information to get you help"

Do not ask any questions here.`,
        },
        name: pathName ? `Transition (${pathName})` : "Conversation",
        edges: [],
        id: pathIds.transitionId,
        type: "conversation",
        display_position: pathPos.transition,
        skip_response_edge: {
            destination_node_id: pathIds.frontExtractId,
            id: `skip-response-edge-${f.nextTs()}-${randomSuffix(9)}`,
            transition_condition: {
                type: "prompt",
                prompt: "Skip response",
            },
        },
    };
}
export function buildIntroNode(config, ids, pos, f, pathConfigs) {
    const isMultiPath = pathConfigs && pathConfigs.length > 1;
    const nodeMap = {
        __faq__: ids.faqId,
        __extract__: ids.paths[0].transitionId,
    };
    let edges;
    if (isMultiPath) {
        edges = pathConfigs.map((p, i) => ({
            destination_node_id: ids.paths[i].transitionId,
            id: f.edgeId(),
            transition_condition: {
                type: "prompt",
                prompt: p.transitionCondition,
            },
        }));
    }
    else {
        edges = [
            {
                destination_node_id: ids.paths[0].transitionId,
                id: f.edgeId(),
                transition_condition: {
                    type: "prompt",
                    prompt: "The caller confirms forward intent with service, including wanting to sign up, get a quote, schedule service, or get started.",
                },
            },
        ];
    }
    return {
        finetune_conversation_examples: [],
        instruction: {
            type: "prompt",
            text: `Determine the reason for the caller's call.

Welcome the caller: "Thank you for calling ${config.businessName}, this is Anthony. How may I help you?"

If the caller greets you, reciprocate the sentiment and then ask how you can help them.

Stay in this node until the caller expresses clear intent to move forward with service. This includes:
- Wanting to sign up
- Wanting to schedule service
- Wanting a quote
- Wanting to get started

Do NOT leave this node if the caller is only asking questions. Let the Admin/FAQ global node handle those and return here.`,
        },
        name: "Intro",
        edges,
        start_speaker: "agent",
        finetune_transition_examples: resolveFinetuneExamples(config.introFinetuneExamples, ids.paths[0].transitionId, nodeMap, f),
        id: ids.introId,
        type: "conversation",
        display_position: pos.intro,
    };
}
export function buildFaqNode(faqKnowledgeBase, ids, pos, f, isMultiPath) {
    // Multi-path: forward-intent goes to Intro so caller re-enters path routing
    // Single-path: forward-intent goes directly to transition (existing behavior)
    const forwardDestination = isMultiPath
        ? ids.introId
        : ids.paths[0].transitionId;
    return {
        instruction: {
            type: "prompt",
            text: `Your goal is to answer administrative and general questions briefly and accurately.

${faqKnowledgeBase}`,
        },
        name: "Admin/FAQ",
        edges: [
            {
                destination_node_id: forwardDestination,
                id: f.edgeId(),
                transition_condition: {
                    type: "prompt",
                    prompt: "You answered the caller's question.",
                },
            },
        ],
        global_node_setting: {
            go_back_conditions: [
                {
                    id: f.goBackId(),
                    transition_condition: {
                        type: "prompt",
                        prompt: "You answered the caller's question.",
                    },
                },
            ],
            condition: "Jump to this node when a customer has an admin/FAQ question regarding the business or its services.",
            positive_finetune_examples: [],
            negative_finetune_examples: [],
        },
        id: ids.faqId,
        type: "conversation",
        display_position: pos.faq,
    };
}
export function buildHumanRequestNode(ids, pos, f, mode = "callback") {
    if (mode === "live_transfer") {
        // Agent acknowledges and immediately transfers
        return {
            instruction: {
                type: "prompt",
                text: `The caller is requesting a human or live person.\n\nAcknowledge and tell them you will transfer the call.`,
            },
            name: "Human Request",
            edges: [],
            global_node_setting: {
                condition: "Jump to this node if the caller requests a live agent or a human.",
                negative_finetune_examples: [],
                positive_finetune_examples: [
                    {
                        transcript: [
                            { content: "can I talk to the supervisor?", role: "user" },
                            { content: "", role: "agent" },
                        ],
                    },
                ],
            },
            id: ids.humanReqId,
            type: "conversation",
            display_position: pos.humanReq,
            skip_response_edge: {
                destination_node_id: ids.transferCallId,
                id: `skip-response-edge-${f.nextTs()}-${randomSuffix(9)}`,
                transition_condition: {
                    type: "prompt",
                    prompt: "Skip response",
                },
            },
        };
    }
    // Default: callback mode
    return {
        instruction: {
            type: "prompt",
            text: `The caller is requesting a human or live person.

1. Acknowledge the request calmly and professionally, saying they are not available at the moment.

2. Tell them they have the option to request a call back. Ask the caller if they want a call back.

If the caller refuses and repeats the request for a human, repeat that you cannot transfer the call.`,
        },
        name: "Human Request",
        edges: [
            {
                destination_node_id: ids.politeHangupId,
                id: f.edgeId(),
                transition_condition: {
                    type: "prompt",
                    prompt: "The caller wants a call back",
                },
            },
        ],
        global_node_setting: {
            go_back_conditions: [
                {
                    id: f.goBackId(),
                    transition_condition: {
                        type: "prompt",
                        prompt: "The caller would like to continue the call and not request a callback.",
                    },
                },
            ],
            condition: "Jump to this node if the caller requests a live agent or a human.",
        },
        id: ids.humanReqId,
        type: "conversation",
        display_position: pos.humanReq,
    };
}
export function buildTransferCallNode(ids, pos, f) {
    return {
        custom_sip_headers: {},
        transfer_destination: {
            type: "predefined",
            number: "{{dispatch_number}}",
        },
        edge: {
            destination_node_id: ids.transferFailedId,
            id: f.edgeId(),
            transition_condition: {
                type: "prompt",
                prompt: "Transfer failed",
            },
        },
        name: "Transfer Call",
        ignore_e164_validation: false,
        id: ids.transferCallId,
        transfer_option: {
            cold_transfer_mode: "sip_invite",
            enable_bridge_audio_cue: true,
            type: "cold_transfer",
            agent_detection_timeout_ms: 30000,
            show_transferee_as_caller: false,
        },
        type: "transfer_call",
        speak_during_execution: false,
        display_position: { x: pos.humanReq.x + 360, y: pos.humanReq.y + 96 },
    };
}
// ── Per-path transfer (used when a path's end mode is "transfer") ────────────
export function buildPreTransferNode(pathIds, pathPos, agentConfig, pathLabel, f) {
    if (!pathIds.preTransferId || !pathIds.transferCallId || !pathPos.preTransfer) {
        throw new Error("buildPreTransferNode: pathIds/pos missing transfer slots");
    }
    const text = renderTemplate(DEFAULT_PRE_TRANSFER_PROMPT, {
        business_name: agentConfig.businessName,
    });
    return {
        instruction: { type: "prompt", text },
        always_edge: {
            destination_node_id: pathIds.transferCallId,
            id: `always-edge-${f.nextTs()}-${randomSuffix(9)}`,
            transition_condition: { type: "prompt", prompt: "Always" },
        },
        name: pathLabel ? `Pre-Transfer (${pathLabel})` : "Pre-Transfer",
        edges: [],
        id: pathIds.preTransferId,
        type: "conversation",
        display_position: pathPos.preTransfer,
    };
}
export function buildPerPathTransferCallNode(pathIds, pathPos, ids, resolvedNumber, pathLabel, f) {
    if (!pathIds.transferCallId || !pathPos.transferCall) {
        throw new Error("buildPerPathTransferCallNode: pathIds/pos missing transfer slots");
    }
    return {
        custom_sip_headers: {},
        transfer_destination: { type: "predefined", number: resolvedNumber },
        edge: {
            destination_node_id: ids.transferFailedId,
            id: f.edgeId(),
            transition_condition: { type: "prompt", prompt: "Transfer failed" },
        },
        name: pathLabel ? `Transfer Call (${pathLabel})` : "Transfer Call",
        ignore_e164_validation: false,
        id: pathIds.transferCallId,
        transfer_option: {
            cold_transfer_mode: "sip_invite",
            enable_bridge_audio_cue: true,
            type: "cold_transfer",
            agent_detection_timeout_ms: 30000,
            show_transferee_as_caller: false,
        },
        type: "transfer_call",
        speak_during_execution: false,
        display_position: pathPos.transferCall,
    };
}
export function buildTransferFailedNode(ids, pos, f) {
    return {
        instruction: {
            type: "prompt",
            text: "Let the caller know you'll have their supervisor call them back as soon as possible. Do not ask them any more questions.",
        },
        always_edge: {
            destination_node_id: ids.closingRemarksId,
            id: `always-edge-${f.nextTs()}-${randomSuffix(9)}`,
            transition_condition: { type: "prompt", prompt: "Always" },
        },
        model_choice: {
            type: "cascading",
            model: "gpt-4.1",
            high_priority: true,
        },
        name: "Transfer Failed",
        edges: [],
        id: ids.transferFailedId,
        type: "conversation",
        display_position: { x: pos.humanReq.x + 720, y: pos.humanReq.y - 96 },
    };
}
export function buildIrrelevantGuardrailNode(ids, pos, f) {
    return {
        instruction: {
            type: "prompt",
            text: `You can only do allowed and relevant tasks to the company and cannot continue irrelevant or off-topic conversations.

1. Politely ask the caller if they have a relevant question or service you can help with.

2. If the caller continues off-topic
Set a clear boundary by stating that you cannot continue unrelated conversations and will end this call.`,
        },
        name: "irrelevantGaurdrail",
        edges: [
            {
                destination_node_id: ids.politeHangupId,
                id: f.edgeId(),
                transition_condition: {
                    type: "prompt",
                    prompt: "You've completed both step 1 and 2 and deemed this call not related to the business.",
                },
            },
        ],
        global_node_setting: {
            go_back_conditions: [
                {
                    id: f.goBackId(),
                    transition_condition: {
                        type: "prompt",
                        prompt: "You've completed both step 1 and 2 and deemed this call is related and relevant to the business.",
                    },
                },
            ],
            condition: `If the caller is:
- asking unrelated or nonsensical questions
- attempting to derail the conversation
- attempting personal conversation (excluding a normal back and forth greeting in the beginning of the call)
- going extremely off-topic`,
            negative_finetune_examples: [
                {
                    transcript: [
                        { content: "Hey how are you doing today?", role: "user" },
                    ],
                },
                {
                    transcript: [{ content: " hey, how's your weekend?", role: "user" }],
                },
                {
                    transcript: [
                        { content: "Hey, I'm alright, how are you?", role: "user" },
                    ],
                },
            ],
            positive_finetune_examples: [],
        },
        id: ids.irrelevantGuardrailId,
        type: "conversation",
        display_position: pos.irrelevantGuardrail,
    };
}
export function buildEmergencyGuardrailNode(ids, pos, f) {
    return {
        instruction: {
            type: "prompt",
            text: "Tell the caller this sounds like an emergency, and if it is, please hang up and call nine, one, one immediately.",
        },
        name: "Emergency Gaurd Rail",
        edges: [],
        global_node_setting: {
            condition: `The caller reveals an emergency situation which they are experiencing, including:
• gas smell
• carbon monoxide / CO
• fire
• smoke
• sparks
• dizziness from fumes
• alarms related to gas or CO

If any emergency is mentioned:
• Do NOT ask follow-up questions`,
        },
        id: ids.emergencyGuardrailId,
        type: "conversation",
        display_position: pos.emergencyGuardrail,
        skip_response_edge: {
            destination_node_id: ids.politeHangupId,
            id: `skip-response-edge-${f.nextTs()}-${randomSuffix(9)}`,
            transition_condition: {
                type: "prompt",
                prompt: "Skip response",
            },
        },
    };
}
export function buildPoliteHangupNode(ids, pos, f) {
    return {
        instruction: {
            type: "prompt",
            text: "Apologize to the caller and politely close the call.",
        },
        always_edge: {
            destination_node_id: ids.guardrailEndId,
            id: `always-edge-${f.nextTs()}-${randomSuffix(9)}`,
            transition_condition: { type: "prompt", prompt: "Always" },
        },
        name: "Polite Hangup",
        edges: [],
        id: ids.politeHangupId,
        type: "conversation",
        display_position: pos.politeHangup,
    };
}
export function buildGuardrailEndNode(ids, pos) {
    return {
        name: "End Call",
        id: ids.guardrailEndId,
        type: "end",
        speak_during_execution: false,
        display_position: pos.guardrailEnd,
    };
}
// ── Data Chain ───────────────────────────────────────────────────────────────
function toVarDefs(rdp) {
    if (rdp.composite && rdp.variables) {
        return rdp.variables.map((v) => {
            const def = {
                name: v.variableName,
                type: v.type,
                description: v.description,
            };
            if (v.type === "enum")
                def.choices = v.choices;
            return def;
        });
    }
    const def = {
        name: rdp.variableName,
        type: rdp.type,
        description: rdp.description,
    };
    if (rdp.type === "enum")
        def.choices = rdp.choices;
    return [def];
}
export function buildDataChain(resolvedDataPoints, pathIds, pathPos, closeId, f, pathName) {
    if (resolvedDataPoints.length !== pathIds.chain.length) {
        throw new Error(`buildDataChain: data point count (${resolvedDataPoints.length}) does not match allocated chain IDs (${pathIds.chain.length})`);
    }
    const nodes = [];
    const suffix = pathName ? ` (${pathName})` : "";
    // Front-loaded Extract: capture all variables from caller's initial input
    const allVariableDefs = resolvedDataPoints.flatMap(toVarDefs);
    // In multi-path mode, add hidden _path_taken variable for post-call routing
    if (pathName) {
        allVariableDefs.push({
            name: PATH_TAKEN_VAR,
            type: "string",
            description: `Always set to "${pathName}".`,
        });
    }
    nodes.push({
        variables: allVariableDefs,
        else_edge: {
            destination_node_id: pathIds.routerId,
            id: `${pathIds.frontExtractId}-else-edge`,
            transition_condition: { type: "prompt", prompt: "Else" },
        },
        name: `Extract All Variables${suffix}`,
        edges: [],
        finetune_transition_examples: [],
        id: pathIds.frontExtractId,
        type: "extract_dynamic_variables",
        display_position: pathPos.frontExtract,
    });
    // Variables Router: check each variable, route to first missing one.
    // If a data point has _branchCondition, AND the condition into the edge.
    // Orphan data points are extract-only — skip them in the router.
    const nonOrphanDps = resolvedDataPoints.filter((dp) => !dp.orphan);
    const routerEdges = nonOrphanDps.map((dp) => {
        const i = resolvedDataPoints.indexOf(dp);
        let missingEquations;
        let missingOperator;
        if (dp.variableName === "phone_number") {
            missingEquations = [
                {
                    left: `{{phone_number}}`,
                    operator: "==",
                    right: NOT_MENTIONED,
                },
                {
                    left: `{{${PHONE_COLLECTED_FLAG}}}`,
                    operator: "!=",
                    right: "true",
                },
            ];
            missingOperator = "&&";
        }
        else if (dp.composite && dp.variables) {
            missingEquations = dp.variables.flatMap((v) => [
                { left: `{{${v.variableName}}}`, operator: "not_exist" },
                { left: `{{${v.variableName}}}`, operator: "==", right: NOT_MENTIONED },
            ]);
            missingOperator = "||";
        }
        else {
            missingEquations = [
                { left: `{{${dp.variableName}}}`, operator: "not_exist" },
                {
                    left: `{{${dp.variableName}}}`,
                    operator: "==",
                    right: NOT_MENTIONED,
                },
            ];
            missingOperator = "||";
        }
        // If this data point is inside a branch, AND all branch conditions
        if (dp._branchConditions && dp._branchConditions.length > 0) {
            const branchEqs = [];
            for (const bc of dp._branchConditions) {
                branchEqs.push({
                    left: `{{${bc.variable}}}`,
                    operator: bc.operator,
                    right: bc.value,
                });
                // Guard ELSE conditions (!=) against sentinel values so they
                // don't fire when the variable is "Not Mentioned" or "Caller Doesn't Know"
                if (bc.operator === "!=") {
                    branchEqs.push({ left: `{{${bc.variable}}}`, operator: "!=", right: NOT_MENTIONED }, { left: `{{${bc.variable}}}`, operator: "!=", right: "Caller Doesn't Know" });
                }
            }
            return {
                destination_node_id: pathIds.chain[i].convId,
                id: f.edgeId(),
                transition_condition: {
                    type: "equation",
                    equations: [
                        ...missingEquations,
                        ...branchEqs,
                    ],
                    operator: "&&",
                },
            };
        }
        return {
            destination_node_id: pathIds.chain[i].convId,
            id: f.edgeId(),
            transition_condition: {
                type: "equation",
                equations: missingEquations,
                operator: missingOperator,
            },
        };
    });
    nodes.push({
        name: `Variables Router${suffix}`,
        edges: routerEdges,
        id: pathIds.routerId,
        else_edge: {
            destination_node_id: closeId,
            id: `${pathIds.routerId}-else-edge`,
            transition_condition: { type: "prompt", prompt: "Else" },
        },
        type: "branch",
        display_position: pathPos.router,
    });
    // Per-variable: Collect (conversation) + Confirm (extract) → back to router
    // Orphan data points are extract-only — no Collect+Confirm nodes needed.
    resolvedDataPoints.forEach((dp, i) => {
        if (dp.orphan)
            return;
        const chainIds = pathIds.chain[i];
        const chainPos = pathPos.chain[i];
        // Tapered variable list: this variable + all remaining after it
        const remainingVarDefs = resolvedDataPoints.slice(i).flatMap(toVarDefs);
        // Collect node — ask for the variable
        nodes.push({
            name: dp.composite ? dp.label : `Collect ${dp.label}`,
            edges: [
                {
                    destination_node_id: chainIds.confirmId,
                    id: f.edgeId(),
                    transition_condition: {
                        type: "prompt",
                        prompt: dp.forwardCondition,
                    },
                },
            ],
            finetune_transition_examples: resolveFinetuneExamples(dp.finetuneExamples, chainIds.confirmId, {}, f),
            finetune_conversation_examples: [],
            id: chainIds.convId,
            type: "conversation",
            display_position: chainPos.conv,
            instruction: { type: "prompt", text: dp.conversationPrompt },
        });
        // For phone_number, add a collected flag to break potential confirmation loops
        if (dp.variableName === "phone_number") {
            remainingVarDefs.push({
                name: PHONE_COLLECTED_FLAG,
                type: "boolean",
                description: "Always set to true",
            });
        }
        // Confirm node — extract this + all remaining variables, then route back to router
        nodes.push({
            variables: remainingVarDefs,
            else_edge: {
                destination_node_id: pathIds.routerId,
                id: `${chainIds.confirmId}-else-edge`,
                transition_condition: { type: "prompt", prompt: "Else" },
            },
            name: `Confirm ${dp.label}`,
            edges: [],
            id: chainIds.confirmId,
            type: "extract_dynamic_variables",
            display_position: chainPos.confirm,
        });
    });
    return nodes;
}
export function buildCloseNode(agentConfig, ids, pos, f) {
    const template = agentConfig.closePrompt ?? DEFAULT_CLOSE_PROMPT;
    return {
        instruction: {
            type: "prompt",
            text: renderTemplate(template, { business_name: agentConfig.businessName }),
        },
        always_edge: {
            destination_node_id: ids.closingRemarksId,
            id: `always-edge-${f.nextTs()}-${randomSuffix(9)}`,
            transition_condition: { type: "prompt", prompt: "Always" },
        },
        name: "Close",
        edges: [],
        id: ids.closeId,
        type: "conversation",
        display_position: pos.close,
    };
}
export function buildClosingSequence(agentConfig, ids, pos, f) {
    const lastX = pos.close.x;
    const remarksTemplate = agentConfig.closingRemarksPrompt ?? DEFAULT_CLOSING_REMARKS_PROMPT;
    const statementTemplate = agentConfig.closingStatementText ?? DEFAULT_CLOSING_STATEMENT_TEXT;
    const vars = { business_name: agentConfig.businessName };
    return [
        {
            instruction: {
                type: "prompt",
                text: renderTemplate(remarksTemplate, vars),
            },
            always_edge: {
                destination_node_id: ids.closingStatementId,
                id: `always-edge-${f.nextTs()}-${randomSuffix(9)}`,
                transition_condition: { type: "prompt", prompt: "Always" },
            },
            name: "Closing Remarks",
            edges: [],
            id: ids.closingRemarksId,
            type: "conversation",
            display_position: { x: lastX, y: 1182 },
        },
        {
            instruction: {
                type: "static_text",
                text: renderTemplate(statementTemplate, vars),
            },
            name: "Closing Statement",
            edges: [],
            id: ids.closingStatementId,
            type: "conversation",
            display_position: { x: lastX, y: 1494 },
            skip_response_edge: {
                destination_node_id: ids.endId,
                id: `skip-response-edge-${f.nextTs()}-${randomSuffix(9)}`,
                transition_condition: { type: "prompt", prompt: "Skip response" },
            },
        },
    ];
}
// ── Root Agent Assembly ──────────────────────────────────────────────────────
export function buildAgentRoot(businessName, conversationFlow) {
    return {
        agent_id: "",
        channel: "voice",
        last_modification_timestamp: Date.now(),
        agent_name: businessName,
        response_engine: {
            type: "conversation-flow",
            version: 1,
        },
        webhook_url: "https://servicecall-api-production.up.railway.app/retell/post-hook",
        webhook_timeout_ms: 15500,
        language: "en-US",
        data_storage_setting: "everything",
        opt_in_signed_url: false,
        end_call_after_silence_ms: 30000,
        version: 1,
        is_published: false,
        version_title: "",
        post_call_analysis_model: "gpt-5-mini",
        pii_config: { mode: "post_call", categories: [] },
        guardrail_config: {
            output_topics: [
                "harassment",
                "self_harm",
                "sexual_exploitation",
                "violence",
                "defense_and_national_security",
                "illicit_and_harmful_activity",
                "gambling",
                "regulated_professional_advice",
                "child_safety_and_exploitation",
            ],
            input_topics: ["platform_integrity_jailbreaking"],
        },
        analysis_successful_prompt: "Evaluate whether the agent seems to have a successful call with the user, where the agent finishes the task, and the call was complete without being cutoff.",
        analysis_summary_prompt: "Write a 1-3 sentence summary of the call based on the call transcript. Should capture the important information and actions taken during the call.",
        analysis_user_sentiment_prompt: "Evaluate user's sentiment, mood and satisfaction level.",
        handbook_config: {
            echo_verification: true,
            speech_normalization: true,
            default_personality: false,
            scope_boundaries: true,
            natural_filler_words: false,
            nato_phonetic_alphabet: false,
            high_empathy: false,
            ai_disclosure: true,
            smart_matching: true,
        },
        voice_id: "cartesia-James",
        voice_model: "sonic-3",
        fallback_voice_ids: [],
        voice_temperature: 0,
        voice_speed: 1.08,
        enable_dynamic_voice_speed: false,
        volume: 2,
        voice_emotion: "calm",
        enable_backchannel: false,
        backchannel_frequency: 0.2,
        backchannel_words: ["got it"],
        reminder_trigger_ms: 10000,
        reminder_max_count: 3,
        max_call_duration_ms: 655000,
        interruption_sensitivity: 0.89,
        ambient_sound: "coffee-shop",
        ambient_sound_volume: 1.31,
        responsiveness: 1,
        normalize_for_speech: true,
        begin_message_delay_ms: 2000,
        voicemail_option: { action: { type: "hangup" } },
        allow_user_dtmf: false,
        user_dtmf_options: {},
        post_call_analysis_data: [
            {
                type: "system-presets",
                name: "call_summary",
                description: "Write a 1-3 sentence summary of the call based on the call transcript. Should capture the important information and actions taken during the call.",
            },
            {
                type: "system-presets",
                name: "call_successful",
                description: "Evaluate whether the agent seems to have a successful call with the user, where the agent finishes the task, and the call was complete without being cutoff.",
            },
            {
                type: "system-presets",
                name: "user_sentiment",
                description: "Evaluate user's sentiment, mood and satisfaction level.",
            },
        ],
        conversationFlow,
    };
}
