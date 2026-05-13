/**
 * Parses a canonical JSON conversation flow back into a structured
 * representation, reversing the output of node-builders.ts.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ParsedNode {
  raw: Record<string, unknown>;
  id: string;
  name: string;
  type: string;
}

export interface ParsedDataPoint {
  variableName: string;
  label: string;
  collectNode: ParsedNode;
  confirmNode: ParsedNode;
  variableDefs: Array<{ name: string; type: string; description: string; choices?: string[] }>;
  conversationPrompt: string;
  forwardCondition: string;
  orphan?: boolean;
}

export interface ParsedSmsAction {
  /** Function node that invokes send_sms. */
  funcNode: ParsedNode;
  /** Mark-Sent extract_dynamic_variables node that flips the sentinel. */
  markSentNode: ParsedNode;
  /** Sentinel boolean variable name (e.g. "is_sms_sent_1"). */
  sentinelVar: string;
  /** SMS body template as embedded in the function node's static_text
   *  instruction. May contain {{var}} placeholders. */
  template: string;
  /** Optional explicit recipient override. Undefined → endpoint falls back
   *  to call.from_number. */
  to?: string;
  /** Display name for the function node (UI label). */
  displayName: string;
}

/** Path "step" in router-edge order — interleaved DPs and SMS actions. The
 *  source-order sequence the path was authored with. */
export type ParsedPathStep =
  | { kind: "dp"; dp: ParsedDataPoint }
  | { kind: "sms"; action: ParsedSmsAction };

export interface ParsedPath {
  name: string;
  transitionNode: ParsedNode;
  frontExtractNode: ParsedNode;
  routerNode: ParsedNode;
  dataChain: ParsedDataPoint[];
  /** SMS-send actions wired into this path's Variables Router. Empty when
   *  the path has no inline SMS. Parsed in router-edge source order. */
  smsActions: ParsedSmsAction[];
  /** DPs and SMS actions interleaved in router-edge order — the source
   *  sequence the path was authored with. */
  steps: ParsedPathStep[];
  endMode: "callback" | "transfer";
  preTransferNode?: ParsedNode;
  transferCallNode?: ParsedNode;
  /** The terminal Close node for this callback path (per-path or shared singleton).
   *  Undefined when endMode === "transfer". */
  closeNode?: ParsedNode;
  /** The Close prompt text for this path. Undefined when endMode === "transfer". */
  closePrompt?: string;
  /** Resolved E.164 number baked into the path's transfer_call node (when endMode === "transfer"). */
  transferDestination?: string;
}

export interface ParsedFlow {
  introNode: ParsedNode;
  faqNode: ParsedNode | null;
  closeNode: ParsedNode | null;
  closingNodes: ParsedNode[];
  globalNodes: ParsedNode[];
  paths: ParsedPath[];
  allNodes: ParsedNode[];
  startNodeId: string;
  globalPrompt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function wrap(raw: Record<string, unknown>): ParsedNode {
  return {
    raw,
    id: raw.id as string,
    name: (raw.name as string) ?? "",
    type: (raw.type as string) ?? "",
  };
}

function extractPathSuffix(name: string): string | null {
  const m = name.match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : null;
}

// ── Parser ───────────────────────────────────────────────────────────────────

export function parseConversationFlow(
  canonicalJson: Record<string, unknown>,
): ParsedFlow {
  const flow = canonicalJson.conversationFlow as Record<string, unknown>;
  if (!flow) throw new Error("Missing conversationFlow in canonical JSON");

  const rawNodes = flow.nodes as Array<Record<string, unknown>>;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    throw new Error("No nodes found in conversation flow");
  }

  const startNodeId = flow.start_node_id as string;
  const globalPrompt = (flow.global_prompt as string) ?? "";
  const nodeMap = new Map<string, ParsedNode>();
  const allNodes: ParsedNode[] = [];

  for (const raw of rawNodes) {
    const pn = wrap(raw);
    nodeMap.set(pn.id, pn);
    allNodes.push(pn);
  }

  // Find intro (start node)
  const introNode = nodeMap.get(startNodeId);
  if (!introNode) throw new Error(`Start node ${startNodeId} not found`);

  // Find global nodes (have global_node_setting)
  const globalNodes = allNodes.filter(
    (n) => n.raw.global_node_setting != null,
  );

  // Find FAQ node
  const faqNode = allNodes.find((n) => n.name === "Admin/FAQ") ?? null;

  // Find Close node — either the legacy singleton "Close" or, for multi-path
  // callback agents, the first per-path "Close (pathName)". Per-path nodes
  // are also exposed individually on each ParsedPath below.
  const closeNode =
    allNodes.find((n) => n.name === "Close")
    ?? allNodes.find((n) => n.name.startsWith("Close ("))
    ?? null;

  // Find closing sequence nodes. Includes the "Close Question" node that
  // sits between Close and Closing Remarks (it asks "anything else?" and
  // routes to Closing Remarks on "no more questions"). Older agents
  // generated before that node existed simply won't have it in this list.
  const closingNodes = allNodes.filter(
    (n) =>
      n.name === "Close Question" ||
      n.name === "Closing Remarks" ||
      n.name === "Closing Statement",
  );

  // ── Identify paths ──────────────────────────────────────────────────────

  // Strategy: Find all "Extract All Variables" nodes — one per path.
  // Then trace backward to find transition node, and forward to find router.
  const extractAllNodes = allNodes.filter(
    (n) =>
      n.type === "extract_dynamic_variables" &&
      n.name.startsWith("Extract All Variables"),
  );

  // Find transition nodes: named "Transition (...)" or "Conversation"
  const transitionNodes = allNodes.filter(
    (n) =>
      n.type === "conversation" &&
      (n.name.startsWith("Transition") || n.name === "Conversation"),
  );

  // Find router nodes: named "Variables Router" or "Variables Router (...)"
  const routerNodes = allNodes.filter(
    (n) =>
      n.type === "branch" &&
      n.name.startsWith("Variables Router"),
  );

  const paths: ParsedPath[] = [];

  // Match paths: each Extract All Variables node → its transition + router
  for (const extractNode of extractAllNodes) {
    const pathSuffix = extractPathSuffix(extractNode.name);
    const pathName = pathSuffix ?? "Default";

    // Find the transition node that skip_response_edges to this extract node
    const transitionNode = transitionNodes.find((tn) => {
      const skipEdge = tn.raw.skip_response_edge as Record<string, unknown> | undefined;
      return skipEdge?.destination_node_id === extractNode.id;
    });

    // Find the router node: the else_edge of the extract node points to it
    const elseEdge = extractNode.raw.else_edge as Record<string, unknown> | undefined;
    const routerNodeId = elseEdge?.destination_node_id as string | undefined;
    const routerNode = routerNodeId ? nodeMap.get(routerNodeId) : undefined;

    if (!transitionNode || !routerNode) {
      // Try fallback: match by path suffix
      const fallbackTransition = transitionNodes.find((tn) => {
        if (pathSuffix) return extractPathSuffix(tn.name) === pathSuffix;
        return tn.name === "Conversation";
      });
      const fallbackRouter = routerNodes.find((rn) => {
        if (pathSuffix) return extractPathSuffix(rn.name) === pathSuffix;
        return rn.name === "Variables Router";
      });

      if (!fallbackTransition && !transitionNode) continue;
      if (!fallbackRouter && !routerNode) continue;

      const finalTransition = transitionNode ?? fallbackTransition!;
      const finalRouter = routerNode ?? fallbackRouter!;

      paths.push(buildParsedPath(
        pathName,
        finalTransition,
        extractNode,
        finalRouter,
        nodeMap,
      ));
      continue;
    }

    paths.push(buildParsedPath(
      pathName,
      transitionNode,
      extractNode,
      routerNode,
      nodeMap,
    ));
  }

  // Fallback: if no Extract All Variables nodes found but router exists,
  // try to build paths from router nodes directly
  if (paths.length === 0 && routerNodes.length > 0) {
    for (const rn of routerNodes) {
      const pathSuffix = extractPathSuffix(rn.name);
      const pathName = pathSuffix ?? "Default";
      const transition = transitionNodes.find((tn) => {
        if (pathSuffix) return extractPathSuffix(tn.name) === pathSuffix;
        return true;
      });
      const extract = extractAllNodes.find((en) => {
        if (pathSuffix) return extractPathSuffix(en.name) === pathSuffix;
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

function buildParsedPath(
  pathName: string,
  transitionNode: ParsedNode,
  frontExtractNode: ParsedNode,
  routerNode: ParsedNode,
  nodeMap: Map<string, ParsedNode>,
): ParsedPath {
  // ── End mode detection ──────────────────────────────────────────────────
  // The Variables Router's else_edge points to the path's terminal node when
  // all data is collected. If that's a Pre-Transfer or Transfer Call node,
  // the path is in "transfer" mode; otherwise "callback" (points to Close).
  let endMode: "callback" | "transfer" = "callback";
  let preTransferNode: ParsedNode | undefined;
  let transferCallNode: ParsedNode | undefined;
  let transferDestination: string | undefined;
  let closeNode: ParsedNode | undefined;
  let closePrompt: string | undefined;
  const routerElseEdge = routerNode.raw.else_edge as Record<string, unknown> | undefined;
  const terminalId = routerElseEdge?.destination_node_id as string | undefined;
  const terminalNode = terminalId ? nodeMap.get(terminalId) : undefined;
  if (terminalNode) {
    if (terminalNode.type === "transfer_call") {
      endMode = "transfer";
      transferCallNode = terminalNode;
    } else if (terminalNode.name.startsWith("Pre-Transfer")) {
      endMode = "transfer";
      preTransferNode = terminalNode;
      // Follow the always_edge to the transfer_call node
      const ae = terminalNode.raw.always_edge as Record<string, unknown> | undefined;
      const tcId = ae?.destination_node_id as string | undefined;
      if (tcId) {
        const tcNode = nodeMap.get(tcId);
        if (tcNode && tcNode.type === "transfer_call") transferCallNode = tcNode;
      }
    } else if (terminalNode.name === "Close" || terminalNode.name.startsWith("Close (")) {
      // Callback path: per-path Close (name ends with "(pathName)") or the
      // legacy shared "Close" singleton.
      closeNode = terminalNode;
      const instr = terminalNode.raw.instruction as Record<string, unknown> | undefined;
      closePrompt = (instr?.text as string) ?? "";
    }
  }
  if (transferCallNode) {
    const dest = transferCallNode.raw.transfer_destination as Record<string, unknown> | undefined;
    const num = dest?.number as string | undefined;
    if (num && !num.startsWith("{{")) transferDestination = num;
  }

  // Parse the data chain from the router's edges (ordered)
  const routerEdges = routerNode.raw.edges as Array<Record<string, unknown>> | undefined;
  const dataChain: ParsedDataPoint[] = [];
  const smsActions: ParsedSmsAction[] = [];
  const steps: ParsedPathStep[] = [];

  // Track each pair's primary variable name so non-composite Confirm parsing
  // can ignore the persistent orphan vars we now inject into every Confirm
  // (orphans are suffixed onto remainingVarDefs by the builder/regenerator;
  // for composites we DON'T persist orphans — see comments in
  // node-builders.ts buildDataChain — so composite sub-var parsing stays
  // correct without per-pair filtering).
  if (Array.isArray(routerEdges)) {
    for (const edge of routerEdges) {
      const destNodeId = edge.destination_node_id as string;
      const destNode = nodeMap.get(destNodeId);
      if (!destNode) continue;

      // SMS-action edge: router branches into an McpNode calling send_sms on
      // the servicecall-mcp server. The McpNode's edges[0]/else_edge both
      // point to a Mark Sent extract node, which declares the sentinel
      // variable and loops back to the router.
      if (destNode.type === "mcp" && destNode.raw.mcp_tool_name === "send_sms") {
        const fnEdges = destNode.raw.edges as Array<Record<string, unknown>> | undefined;
        const markSentId = fnEdges?.[0]?.destination_node_id as string | undefined;
        const markSentNode = markSentId ? nodeMap.get(markSentId) : undefined;
        if (markSentNode && markSentNode.type === "extract_dynamic_variables") {
          const vars = markSentNode.raw.variables as Array<Record<string, unknown>> | undefined;
          const sentinelVar = (vars?.[0]?.name as string) ?? "";
          // Recover the template + optional `to` from the function node's
          // instruction text. The generator emits it as:
          //   `Call send_sms with: {"message":"<template>",["to":"<to>"]}`
          // so a JSON.parse on the suffix round-trips cleanly.
          const fnInstr = destNode.raw.instruction as Record<string, unknown> | undefined;
          const instrText = (fnInstr?.text as string) ?? "";
          let template = "";
          let to: string | undefined;
          const marker = "Call send_sms with: ";
          const idx = instrText.indexOf(marker);
          if (idx >= 0) {
            const jsonPart = instrText.slice(idx + marker.length).trim();
            try {
              const parsed = JSON.parse(jsonPart);
              if (parsed && typeof parsed === "object") {
                template = typeof parsed.message === "string" ? parsed.message : "";
                if (typeof parsed.to === "string") to = parsed.to;
              }
            } catch {
              // Malformed instruction — leave fields empty so the UI can
              // still surface the orphaned node for the operator to fix.
            }
          }
          // Strip the path suffix from the display name. The builder names
          // the node `${displayName}${pathSuffix}` where suffix is " (pathName)".
          const rawName = (destNode.raw.name as string) ?? "Send SMS";
          const displayName = rawName.replace(/\s*\([^)]*\)\s*$/, "");
          const action: ParsedSmsAction = {
            funcNode: destNode,
            markSentNode,
            sentinelVar,
            template,
            to,
            displayName,
          };
          smsActions.push(action);
          steps.push({ kind: "sms", action });
        }
        continue;
      }

      if (destNode.type !== "conversation") continue;
      const collectNode = destNode;

      // The collect node's first edge should point to its confirm node
      const collectEdges = collectNode.raw.edges as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(collectEdges) || collectEdges.length === 0) continue;

      const confirmNodeId = collectEdges[0].destination_node_id as string;
      const confirmNode = nodeMap.get(confirmNodeId);
      if (!confirmNode || confirmNode.type !== "extract_dynamic_variables") continue;

      // Extract the data point info
      const dp = parseDataPointFromNodes(collectNode, confirmNode);
      if (dp) {
        dataChain.push(dp);
        steps.push({ kind: "dp", dp });
      }
    }
  }

  // ── Composite taper-leak fix ─────────────────────────────────────────────
  // parseDataPointFromNodes maps the *entire* Confirm.variables list onto a
  // composite's variableDefs (it has no signal at parse time for how many of
  // them are this composite's own sub-vars vs. tapered downstream DPs). The
  // followers are the variables that the NEXT DP's Confirm also carries.
  // Subtract them here: composite_sub_vars = currentConfirmVars − nextConfirmVars.
  // Without this, callers like buildDataPointsFromChain → toVarDefs would
  // re-emit every follower under the composite, producing duplicate entries
  // in regenerated Extract nodes — surfaced as EXTRACT_VAR_DUPLICATE on save.
  for (let i = 0; i < dataChain.length - 1; i++) {
    const dp = dataChain[i];
    const isComposite = !dp.collectNode.name.startsWith("Collect ");
    if (!isComposite) continue;
    const nextConfirmVars = dataChain[i + 1].confirmNode.raw.variables as
      | Array<Record<string, unknown>>
      | undefined;
    if (!Array.isArray(nextConfirmVars) || nextConfirmVars.length === 0) continue;
    const followerNames = new Set(nextConfirmVars.map((v) => v.name as string));
    dp.variableDefs = dp.variableDefs.filter((v) => !followerNames.has(v.name));
  }

  // Detect orphan variables: present in front extract but no Collect node
  const chainVarNames = new Set<string>();
  for (const dp of dataChain) {
    chainVarNames.add(dp.variableName);
    // Also include sub-variables from composite data points
    for (const vd of dp.variableDefs) chainVarNames.add(vd.name);
  }
  const frontVars = frontExtractNode.raw.variables as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(frontVars)) {
    for (const v of frontVars) {
      const name = v.name as string;
      if (!name) continue;
      if (chainVarNames.has(name)) continue;
      // Skip known internal/sentinel variables
      if (name === "_path_taken" || name.endsWith("_collected")) continue;
      dataChain.push({
        variableName: name,
        label: (name).replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
        collectNode: frontExtractNode, // placeholder — no real collect node
        confirmNode: frontExtractNode,
        variableDefs: [{
          name,
          type: (v.type as string) || "string",
          description: (v.description as string) || "",
          ...(v.choices ? { choices: v.choices as string[] } : {}),
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
    smsActions,
    steps,
    endMode,
    preTransferNode,
    transferCallNode,
    transferDestination,
    closeNode,
    closePrompt,
  };
}

function parseDataPointFromNodes(
  collectNode: ParsedNode,
  confirmNode: ParsedNode,
): ParsedDataPoint | null {
  // Extract variable name from collect node name: "Collect Full Name" → "full_name"
  // Or from the confirm node's variables array
  const confirmVars = confirmNode.raw.variables as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(confirmVars) || confirmVars.length === 0) return null;

  // The first variable is the primary one being collected at this step
  const primaryVar = confirmVars[0];
  const variableName = primaryVar.name as string;

  // Label from collect node name
  const nameMatch = collectNode.name.match(/^Collect (.+)$/);
  const label = nameMatch ? nameMatch[1] : collectNode.name;

  // Extract conversation prompt
  const instruction = collectNode.raw.instruction as Record<string, unknown> | undefined;
  const conversationPrompt = (instruction?.text as string) ?? "";

  // Extract forward condition from the collect node's edge
  const edges = collectNode.raw.edges as Array<Record<string, unknown>> | undefined;
  let forwardCondition = "";
  if (Array.isArray(edges) && edges.length > 0) {
    const tc = edges[0].transition_condition as Record<string, unknown> | undefined;
    if (tc?.type === "prompt") {
      forwardCondition = (tc.prompt as string) ?? "";
    }
  }

  // Build variable defs for this data point only (not the tapered remainder).
  // Composite data points have collect node name == label (not "Collect {label}").
  // For composites, we need all variables that aren't from later data points.
  const isComposite = !nameMatch; // collect node name doesn't match "Collect {label}"
  let variableDefs: Array<{ name: string; type: string; description: string; choices?: string[] }>;

  if (isComposite) {
    // For composite: the confirm node's variables include this composite's
    // sub-vars plus any tapered following dps. (Persistent orphans are
    // intentionally NOT injected into composite Confirms — see the build
    // logic in node-builders.ts buildDataChain — so the parser doesn't
    // need to filter them out here.)
    variableDefs = (confirmVars as Array<Record<string, unknown>>).map((v) => ({
      name: v.name as string,
      type: (v.type as string) ?? "string",
      description: (v.description as string) ?? "",
      ...(v.choices ? { choices: v.choices as string[] } : {}),
    }));
  } else {
    // Non-composite: only the primary variable for this data point
    variableDefs = [{
      name: primaryVar.name as string,
      type: (primaryVar.type as string) ?? "string",
      description: (primaryVar.description as string) ?? "",
      ...(primaryVar.choices ? { choices: primaryVar.choices as string[] } : {}),
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
export function getPathNodeIds(path: ParsedPath): Set<string> {
  const ids = new Set<string>();
  ids.add(path.transitionNode.id);
  ids.add(path.frontExtractNode.id);
  ids.add(path.routerNode.id);
  for (const dp of path.dataChain) {
    ids.add(dp.collectNode.id);
    ids.add(dp.confirmNode.id);
  }
  for (const action of path.smsActions) {
    ids.add(action.funcNode.id);
    ids.add(action.markSentNode.id);
  }
  return ids;
}

/** Get a flat list of variable names in a path, in order */
export function getPathVariableNames(path: ParsedPath): string[] {
  return path.dataChain.map((dp) => dp.variableName);
}

/** Check if a node is a structural node (not part of any data chain) */
export function isStructuralNode(node: ParsedNode, parsedFlow: ParsedFlow): boolean {
  const chainIds = new Set<string>();
  for (const path of parsedFlow.paths) {
    for (const id of getPathNodeIds(path)) chainIds.add(id);
  }
  return !chainIds.has(node.id);
}
