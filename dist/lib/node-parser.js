/**
 * Parses a canonical JSON conversation flow back into a structured
 * representation, reversing the output of node-builders.ts.
 */
// ── Helpers ──────────────────────────────────────────────────────────────────
function wrap(raw) {
    return {
        raw,
        id: raw.id,
        name: raw.name ?? "",
        type: raw.type ?? "",
    };
}
function extractPathSuffix(name) {
    const m = name.match(/\(([^)]+)\)\s*$/);
    return m ? m[1] : null;
}
// ── Parser ───────────────────────────────────────────────────────────────────
export function parseConversationFlow(canonicalJson) {
    const flow = canonicalJson.conversationFlow;
    if (!flow)
        throw new Error("Missing conversationFlow in canonical JSON");
    const rawNodes = flow.nodes;
    if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
        throw new Error("No nodes found in conversation flow");
    }
    const startNodeId = flow.start_node_id;
    const globalPrompt = flow.global_prompt ?? "";
    const nodeMap = new Map();
    const allNodes = [];
    for (const raw of rawNodes) {
        const pn = wrap(raw);
        nodeMap.set(pn.id, pn);
        allNodes.push(pn);
    }
    // Find intro (start node)
    const introNode = nodeMap.get(startNodeId);
    if (!introNode)
        throw new Error(`Start node ${startNodeId} not found`);
    // Find global nodes (have global_node_setting)
    const globalNodes = allNodes.filter((n) => n.raw.global_node_setting != null);
    // Find FAQ node
    const faqNode = allNodes.find((n) => n.name === "Admin/FAQ") ?? null;
    // Find Close node
    const closeNode = allNodes.find((n) => n.name === "Close") ?? null;
    // Find closing sequence nodes
    const closingNodes = allNodes.filter((n) => n.name === "Closing Remarks" ||
        n.name === "Closing Statement");
    // ── Identify paths ──────────────────────────────────────────────────────
    // Strategy: Find all "Extract All Variables" nodes — one per path.
    // Then trace backward to find transition node, and forward to find router.
    const extractAllNodes = allNodes.filter((n) => n.type === "extract_dynamic_variables" &&
        n.name.startsWith("Extract All Variables"));
    // Find transition nodes: named "Transition (...)" or "Conversation"
    const transitionNodes = allNodes.filter((n) => n.type === "conversation" &&
        (n.name.startsWith("Transition") || n.name === "Conversation"));
    // Find router nodes: named "Variables Router" or "Variables Router (...)"
    const routerNodes = allNodes.filter((n) => n.type === "branch" &&
        n.name.startsWith("Variables Router"));
    const paths = [];
    // Match paths: each Extract All Variables node → its transition + router
    for (const extractNode of extractAllNodes) {
        const pathSuffix = extractPathSuffix(extractNode.name);
        const pathName = pathSuffix ?? "Default";
        // Find the transition node that skip_response_edges to this extract node
        const transitionNode = transitionNodes.find((tn) => {
            const skipEdge = tn.raw.skip_response_edge;
            return skipEdge?.destination_node_id === extractNode.id;
        });
        // Find the router node: the else_edge of the extract node points to it
        const elseEdge = extractNode.raw.else_edge;
        const routerNodeId = elseEdge?.destination_node_id;
        const routerNode = routerNodeId ? nodeMap.get(routerNodeId) : undefined;
        if (!transitionNode || !routerNode) {
            // Try fallback: match by path suffix
            const fallbackTransition = transitionNodes.find((tn) => {
                if (pathSuffix)
                    return extractPathSuffix(tn.name) === pathSuffix;
                return tn.name === "Conversation";
            });
            const fallbackRouter = routerNodes.find((rn) => {
                if (pathSuffix)
                    return extractPathSuffix(rn.name) === pathSuffix;
                return rn.name === "Variables Router";
            });
            if (!fallbackTransition && !transitionNode)
                continue;
            if (!fallbackRouter && !routerNode)
                continue;
            const finalTransition = transitionNode ?? fallbackTransition;
            const finalRouter = routerNode ?? fallbackRouter;
            paths.push(buildParsedPath(pathName, finalTransition, extractNode, finalRouter, nodeMap));
            continue;
        }
        paths.push(buildParsedPath(pathName, transitionNode, extractNode, routerNode, nodeMap));
    }
    // Fallback: if no Extract All Variables nodes found but router exists,
    // try to build paths from router nodes directly
    if (paths.length === 0 && routerNodes.length > 0) {
        for (const rn of routerNodes) {
            const pathSuffix = extractPathSuffix(rn.name);
            const pathName = pathSuffix ?? "Default";
            const transition = transitionNodes.find((tn) => {
                if (pathSuffix)
                    return extractPathSuffix(tn.name) === pathSuffix;
                return true;
            });
            const extract = extractAllNodes.find((en) => {
                if (pathSuffix)
                    return extractPathSuffix(en.name) === pathSuffix;
                return true;
            });
            if (transition && extract) {
                paths.push(buildParsedPath(pathName, transition, extract, rn, nodeMap));
            }
        }
    }
    return {
        introNode,
        faqNode,
        closeNode,
        closingNodes,
        globalNodes,
        paths,
        allNodes,
        startNodeId,
        globalPrompt,
    };
}
// ── Build ParsedPath ─────────────────────────────────────────────────────────
function buildParsedPath(pathName, transitionNode, frontExtractNode, routerNode, nodeMap) {
    // ── End mode detection ──────────────────────────────────────────────────
    // The Variables Router's else_edge points to the path's terminal node when
    // all data is collected. If that's a Pre-Transfer or Transfer Call node,
    // the path is in "transfer" mode; otherwise "callback" (points to Close).
    let endMode = "callback";
    let preTransferNode;
    let transferCallNode;
    let transferDestination;
    const routerElseEdge = routerNode.raw.else_edge;
    const terminalId = routerElseEdge?.destination_node_id;
    const terminalNode = terminalId ? nodeMap.get(terminalId) : undefined;
    if (terminalNode) {
        if (terminalNode.type === "transfer_call") {
            endMode = "transfer";
            transferCallNode = terminalNode;
        }
        else if (terminalNode.name.startsWith("Pre-Transfer")) {
            endMode = "transfer";
            preTransferNode = terminalNode;
            // Follow the always_edge to the transfer_call node
            const ae = terminalNode.raw.always_edge;
            const tcId = ae?.destination_node_id;
            if (tcId) {
                const tcNode = nodeMap.get(tcId);
                if (tcNode && tcNode.type === "transfer_call")
                    transferCallNode = tcNode;
            }
        }
    }
    if (transferCallNode) {
        const dest = transferCallNode.raw.transfer_destination;
        const num = dest?.number;
        if (num && !num.startsWith("{{"))
            transferDestination = num;
    }
    // Parse the data chain from the router's edges (ordered)
    const routerEdges = routerNode.raw.edges;
    const dataChain = [];
    if (Array.isArray(routerEdges)) {
        for (const edge of routerEdges) {
            const collectNodeId = edge.destination_node_id;
            const collectNode = nodeMap.get(collectNodeId);
            if (!collectNode)
                continue;
            if (collectNode.type !== "conversation")
                continue;
            // The collect node's first edge should point to its confirm node
            const collectEdges = collectNode.raw.edges;
            if (!Array.isArray(collectEdges) || collectEdges.length === 0)
                continue;
            const confirmNodeId = collectEdges[0].destination_node_id;
            const confirmNode = nodeMap.get(confirmNodeId);
            if (!confirmNode || confirmNode.type !== "extract_dynamic_variables")
                continue;
            // Extract the data point info
            const dp = parseDataPointFromNodes(collectNode, confirmNode);
            if (dp)
                dataChain.push(dp);
        }
    }
    // Detect orphan variables: present in front extract but no Collect node
    const chainVarNames = new Set();
    for (const dp of dataChain) {
        chainVarNames.add(dp.variableName);
        // Also include sub-variables from composite data points
        for (const vd of dp.variableDefs)
            chainVarNames.add(vd.name);
    }
    const frontVars = frontExtractNode.raw.variables;
    if (Array.isArray(frontVars)) {
        for (const v of frontVars) {
            const name = v.name;
            if (!name)
                continue;
            if (chainVarNames.has(name))
                continue;
            // Skip known internal/sentinel variables
            if (name === "_path_taken" || name.endsWith("_collected"))
                continue;
            dataChain.push({
                variableName: name,
                label: (name).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
                collectNode: frontExtractNode, // placeholder — no real collect node
                confirmNode: frontExtractNode,
                variableDefs: [{
                        name,
                        type: v.type || "string",
                        description: v.description || "",
                        ...(v.choices ? { choices: v.choices } : {}),
                    }],
                conversationPrompt: "",
                forwardCondition: "",
                orphan: true,
            });
        }
    }
    return {
        name: pathName,
        transitionNode,
        frontExtractNode,
        routerNode,
        dataChain,
        endMode,
        preTransferNode,
        transferCallNode,
        transferDestination,
    };
}
function parseDataPointFromNodes(collectNode, confirmNode) {
    // Extract variable name from collect node name: "Collect Full Name" → "full_name"
    // Or from the confirm node's variables array
    const confirmVars = confirmNode.raw.variables;
    if (!Array.isArray(confirmVars) || confirmVars.length === 0)
        return null;
    // The first variable is the primary one being collected at this step
    const primaryVar = confirmVars[0];
    const variableName = primaryVar.name;
    // Label from collect node name
    const nameMatch = collectNode.name.match(/^Collect (.+)$/);
    const label = nameMatch ? nameMatch[1] : collectNode.name;
    // Extract conversation prompt
    const instruction = collectNode.raw.instruction;
    const conversationPrompt = instruction?.text ?? "";
    // Extract forward condition from the collect node's edge
    const edges = collectNode.raw.edges;
    let forwardCondition = "";
    if (Array.isArray(edges) && edges.length > 0) {
        const tc = edges[0].transition_condition;
        if (tc?.type === "prompt") {
            forwardCondition = tc.prompt ?? "";
        }
    }
    // Build variable defs for this data point only (not the tapered remainder).
    // Composite data points have collect node name == label (not "Collect {label}").
    // For composites, we need all variables that aren't from later data points.
    const isComposite = !nameMatch; // collect node name doesn't match "Collect {label}"
    let variableDefs;
    if (isComposite) {
        // For composite: the confirm node's variables include this composite's vars
        // plus remaining tapered vars. We take variables until we hit one that
        // doesn't share the composite's pattern. Heuristic: use the front-extract
        // node to find all vars, or just include all vars that aren't the primary
        // variable of a subsequent "Confirm {X}" node.
        // Simplest: take all vars from the confirm node — the regenerator's toVarDefs
        // handles composites via the DataPoint.variables field.
        variableDefs = confirmVars.map((v) => ({
            name: v.name,
            type: v.type ?? "string",
            description: v.description ?? "",
            ...(v.choices ? { choices: v.choices } : {}),
        }));
    }
    else {
        // Non-composite: only the primary variable for this data point
        variableDefs = [{
                name: primaryVar.name,
                type: primaryVar.type ?? "string",
                description: primaryVar.description ?? "",
                ...(primaryVar.choices ? { choices: primaryVar.choices } : {}),
            }];
    }
    return {
        variableName,
        label,
        collectNode,
        confirmNode,
        variableDefs,
        conversationPrompt,
        forwardCondition,
    };
}
// ── Utilities ────────────────────────────────────────────────────────────────
/** Get a set of all node IDs belonging to a specific path's data chain */
export function getPathNodeIds(path) {
    const ids = new Set();
    ids.add(path.transitionNode.id);
    ids.add(path.frontExtractNode.id);
    ids.add(path.routerNode.id);
    for (const dp of path.dataChain) {
        ids.add(dp.collectNode.id);
        ids.add(dp.confirmNode.id);
    }
    return ids;
}
/** Get a flat list of variable names in a path, in order */
export function getPathVariableNames(path) {
    return path.dataChain.map((dp) => dp.variableName);
}
/** Check if a node is a structural node (not part of any data chain) */
export function isStructuralNode(node, parsedFlow) {
    const chainIds = new Set();
    for (const path of parsedFlow.paths) {
        for (const id of getPathNodeIds(path))
            chainIds.add(id);
    }
    return !chainIds.has(node.id);
}
