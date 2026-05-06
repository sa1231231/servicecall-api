export interface PathScenario {
    pathName: string;
    scenarioName: string;
    description: string;
    /** First user message — should bring the agent into the target path. */
    triggerMessage: string;
    /** Map variableName → user reply. The runner sends the reply when the agent enters that variable's Collect node. */
    replies: Record<string, string>;
    /** Sent when the agent is in intro/transition nodes (not yet asking a path data point). */
    fillerReply?: string;
    /** Optional explicit assertions; if omitted, the test asserts each replied variable was extracted to a value matching the reply. */
    expectVariables?: Record<string, RegExp | string>;
    expectMessageTypeKey?: string;
    /** Safety cap on dialog length. */
    maxTurns?: number;
    /**
     * If true, run this scenario N=3 times and require ≥ majority to pass
     * expectVariables. Costs 3× the live spend; opt in only for scenarios
     * known to be LLM-extraction-flaky.
     */
    flaky?: boolean;
}
export interface AgentFixture {
    slug: string;
    agentId: string;
    scenarios: PathScenario[];
}
