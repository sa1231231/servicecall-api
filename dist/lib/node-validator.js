/**
 * Validates a conversation flow JSON structure before pushing to Retell.
 * Returns an array of errors — empty means valid.
 */
// ── Main Validator ───────────────────────────────────────────────────────────
export function validateConversationFlow(flow) {
    const errors = [];
    // Basic structure
    const nodes = flow.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) {
        errors.push({ code: "NO_NODES", message: "Conversation flow has no nodes" });
        return errors;
    }
    const startNodeId = flow.start_node_id;
    if (!startNodeId) {
        errors.push({ code: "NO_START_NODE", message: "Missing start_node_id" });
    }
    const globalPrompt = flow.global_prompt;
    if (typeof globalPrompt !== "string" || globalPrompt.trim().length === 0) {
        errors.push({ code: "NO_GLOBAL_PROMPT", message: "Missing or empty global_prompt" });
    }
    // Build node index
    const nodeIds = new Set();
    const nodeMap = new Map();
    for (const node of nodes) {
        const id = node.id;
        if (!id) {
            errors.push({
                code: "NODE_NO_ID",
                message: `Node is missing an id`,
                field: "id",
            });
            continue;
        }
        if (nodeIds.has(id)) {
            errors.push({
                code: "DUPLICATE_NODE_ID",
                message: `Duplicate node id: ${id}`,
                nodeId: id,
            });
        }
        nodeIds.add(id);
        nodeMap.set(id, node);
        // Basic node fields
        if (!node.name) {
            errors.push({
                code: "NODE_NO_NAME",
                message: `Node ${id} is missing a name`,
                nodeId: id,
                field: "name",
            });
        }
        if (!node.type) {
            errors.push({
                code: "NODE_NO_TYPE",
                message: `Node ${id} is missing a type`,
                nodeId: id,
                field: "type",
            });
        }
    }
    // Start node exists
    if (startNodeId && !nodeIds.has(startNodeId)) {
        errors.push({
            code: "START_NODE_MISSING",
            message: `start_node_id "${startNodeId}" does not reference an existing node`,
        });
    }
    // Validate each node
    for (const node of nodes) {
        const id = node.id;
        if (!id)
            continue;
        const type = node.type;
        // Validate edges
        errors.push(...validateEdges(node, nodeIds, id));
        // Type-specific checks
        switch (type) {
            case "conversation":
                errors.push(...validateConversationNode(node, id));
                break;
            case "extract_dynamic_variables":
                errors.push(...validateExtractNode(node, id));
                break;
            case "branch":
                errors.push(...validateBranchNode(node, nodeIds, id));
                break;
            case "transfer_call":
                errors.push(...validateTransferNode(node, id));
                break;
            case "end":
                // End nodes just need id, name, type — already checked
                break;
        }
    }
    // Check for orphaned nodes (not reachable from start or global)
    if (startNodeId && nodeIds.has(startNodeId)) {
        const reachable = findReachableNodes(startNodeId, nodes);
        // Global nodes are always reachable
        for (const node of nodes) {
            if (node.global_node_setting)
                reachable.add(node.id);
        }
        // Nodes reachable from global nodes
        for (const node of nodes) {
            if (node.global_node_setting && node.id) {
                for (const r of findReachableNodes(node.id, nodes)) {
                    reachable.add(r);
                }
            }
        }
        for (const node of nodes) {
            const id = node.id;
            if (id && !reachable.has(id)) {
                errors.push({
                    code: "ORPHANED_NODE",
                    message: `Node "${node.name}" (${id}) is not reachable from start or any global node`,
                    nodeId: id,
                });
            }
        }
    }
    // Check for duplicate variable names across extract nodes
    const varNames = new Map(); // varName → first nodeId
    for (const node of nodes) {
        if (node.type !== "extract_dynamic_variables")
            continue;
        // Only check "Extract All Variables" nodes (front-loaded extract)
        if (!node.name?.startsWith("Extract All Variables"))
            continue;
        const vars = node.variables;
        if (!Array.isArray(vars))
            continue;
        for (const v of vars) {
            const name = v.name;
            if (!name)
                continue;
            if (varNames.has(name)) {
                // Duplicate across different Extract All Variables nodes is OK (multi-path)
                // Only flag duplicates within the same node
            }
            varNames.set(name, node.id);
        }
    }
    return errors;
}
// ── Edge Validation ──────────────────────────────────────────────────────────
function validateEdges(node, nodeIds, nodeId) {
    const errors = [];
    // Regular edges
    const edges = node.edges;
    if (Array.isArray(edges)) {
        for (let i = 0; i < edges.length; i++) {
            const edge = edges[i];
            const dest = edge.destination_node_id;
            if (!dest) {
                errors.push({
                    code: "EDGE_NO_DEST",
                    message: `Edge ${i} on node "${node.name}" has no destination_node_id`,
                    nodeId,
                    field: `edges[${i}].destination_node_id`,
                });
            }
            else if (!nodeIds.has(dest)) {
                errors.push({
                    code: "EDGE_INVALID_DEST",
                    message: `Edge ${i} on node "${node.name}" points to non-existent node "${dest}"`,
                    nodeId,
                    field: `edges[${i}].destination_node_id`,
                });
            }
            if (!edge.transition_condition) {
                errors.push({
                    code: "EDGE_NO_CONDITION",
                    message: `Edge ${i} on node "${node.name}" has no transition_condition`,
                    nodeId,
                    field: `edges[${i}].transition_condition`,
                });
            }
        }
    }
    // skip_response_edge
    const skipEdge = node.skip_response_edge;
    if (skipEdge) {
        const dest = skipEdge.destination_node_id;
        if (dest && !nodeIds.has(dest)) {
            errors.push({
                code: "SKIP_EDGE_INVALID_DEST",
                message: `skip_response_edge on node "${node.name}" points to non-existent node "${dest}"`,
                nodeId,
                field: "skip_response_edge.destination_node_id",
            });
        }
    }
    // always_edge
    const alwaysEdge = node.always_edge;
    if (alwaysEdge) {
        const dest = alwaysEdge.destination_node_id;
        if (dest && !nodeIds.has(dest)) {
            errors.push({
                code: "ALWAYS_EDGE_INVALID_DEST",
                message: `always_edge on node "${node.name}" points to non-existent node "${dest}"`,
                nodeId,
                field: "always_edge.destination_node_id",
            });
        }
    }
    // else_edge
    const elseEdge = node.else_edge;
    if (elseEdge) {
        const dest = elseEdge.destination_node_id;
        if (dest && !nodeIds.has(dest)) {
            errors.push({
                code: "ELSE_EDGE_INVALID_DEST",
                message: `else_edge on node "${node.name}" points to non-existent node "${dest}"`,
                nodeId,
                field: "else_edge.destination_node_id",
            });
        }
    }
    return errors;
}
// ── Type-Specific Validation ─────────────────────────────────────────────────
function validateConversationNode(node, nodeId) {
    const errors = [];
    const instruction = node.instruction;
    if (!instruction) {
        errors.push({
            code: "CONV_NO_INSTRUCTION",
            message: `Conversation node "${node.name}" is missing instruction`,
            nodeId,
            field: "instruction",
        });
    }
    else {
        if (!instruction.type) {
            errors.push({
                code: "CONV_NO_INSTRUCTION_TYPE",
                message: `Conversation node "${node.name}" instruction has no type`,
                nodeId,
                field: "instruction.type",
            });
        }
        if (typeof instruction.text !== "string" || instruction.text.trim().length === 0) {
            errors.push({
                code: "CONV_EMPTY_INSTRUCTION",
                message: `Conversation node "${node.name}" has empty instruction text`,
                nodeId,
                field: "instruction.text",
            });
        }
    }
    return errors;
}
function validateExtractNode(node, nodeId) {
    const errors = [];
    const variables = node.variables;
    if (!Array.isArray(variables) || variables.length === 0) {
        errors.push({
            code: "EXTRACT_NO_VARS",
            message: `Extract node "${node.name}" has no variables`,
            nodeId,
            field: "variables",
        });
    }
    else {
        const names = new Set();
        for (let i = 0; i < variables.length; i++) {
            const v = variables[i];
            if (!v.name) {
                errors.push({
                    code: "EXTRACT_VAR_NO_NAME",
                    message: `Variable ${i} in extract node "${node.name}" has no name`,
                    nodeId,
                    field: `variables[${i}].name`,
                });
            }
            else if (names.has(v.name)) {
                errors.push({
                    code: "EXTRACT_VAR_DUPLICATE",
                    message: `Duplicate variable "${v.name}" in extract node "${node.name}"`,
                    nodeId,
                    field: `variables[${i}].name`,
                });
            }
            else {
                names.add(v.name);
            }
        }
    }
    // Extract nodes should have an else_edge
    if (!node.else_edge) {
        errors.push({
            code: "EXTRACT_NO_ELSE_EDGE",
            message: `Extract node "${node.name}" is missing else_edge`,
            nodeId,
            field: "else_edge",
        });
    }
    return errors;
}
function validateBranchNode(node, nodeIds, nodeId) {
    const errors = [];
    // Branch nodes must have edges with equation conditions
    const edges = node.edges;
    if (!Array.isArray(edges) || edges.length === 0) {
        errors.push({
            code: "BRANCH_NO_EDGES",
            message: `Branch node "${node.name}" has no edges`,
            nodeId,
            field: "edges",
        });
    }
    else {
        for (let i = 0; i < edges.length; i++) {
            const tc = edges[i].transition_condition;
            if (tc && tc.type === "equation") {
                const eqs = tc.equations;
                if (!Array.isArray(eqs) || eqs.length === 0) {
                    errors.push({
                        code: "BRANCH_EMPTY_EQUATIONS",
                        message: `Edge ${i} on branch node "${node.name}" has empty equations`,
                        nodeId,
                        field: `edges[${i}].transition_condition.equations`,
                    });
                }
            }
        }
    }
    // Branch should have else_edge
    if (!node.else_edge) {
        errors.push({
            code: "BRANCH_NO_ELSE_EDGE",
            message: `Branch node "${node.name}" is missing else_edge`,
            nodeId,
            field: "else_edge",
        });
    }
    return errors;
}
function validateTransferNode(node, nodeId) {
    const errors = [];
    const dest = node.transfer_destination;
    if (!dest || !dest.number) {
        errors.push({
            code: "TRANSFER_NO_DEST",
            message: `Transfer node "${node.name}" is missing transfer_destination.number`,
            nodeId,
            field: "transfer_destination.number",
        });
    }
    return errors;
}
// ── Graph Traversal ──────────────────────────────────────────────────────────
function findReachableNodes(startId, nodes) {
    const nodeMap = new Map();
    for (const n of nodes) {
        if (n.id)
            nodeMap.set(n.id, n);
    }
    const visited = new Set();
    const queue = [startId];
    while (queue.length > 0) {
        const id = queue.shift();
        if (visited.has(id))
            continue;
        visited.add(id);
        const node = nodeMap.get(id);
        if (!node)
            continue;
        // Collect all destination IDs from all edge types
        const edges = node.edges;
        if (Array.isArray(edges)) {
            for (const e of edges) {
                const dest = e.destination_node_id;
                if (dest && !visited.has(dest))
                    queue.push(dest);
            }
        }
        for (const edgeKey of ["skip_response_edge", "always_edge", "else_edge", "edge"]) {
            const edge = node[edgeKey];
            if (edge?.destination_node_id) {
                const dest = edge.destination_node_id;
                if (!visited.has(dest))
                    queue.push(dest);
            }
        }
    }
    return visited;
}
