import type { DataPoint, FinetuneExample } from "./data-point-registry.js";
export interface IdFactory {
    nextTs(): number;
    nodeId(): string;
    edgeId(): string;
    goBackId(): string;
}
interface Ids {
    introId: string;
    endId: string;
    faqId: string;
    humanReqId: string;
    irrelevantGuardrailId: string;
    emergencyGuardrailId: string;
    politeHangupId: string;
    guardrailEndId: string;
    transitionId: string;
    frontExtractId: string;
    routerId: string;
    closeId: string;
    closingRemarksId: string;
    closingStatementId: string;
    chain: Array<{
        convId: string;
        confirmId: string;
    }>;
}
interface Position {
    x: number;
    y: number;
}
interface Positions {
    intro: Position;
    end: Position;
    faq: Position;
    humanReq: Position;
    irrelevantGuardrail: Position;
    emergencyGuardrail: Position;
    politeHangup: Position;
    guardrailEnd: Position;
    transition: Position;
    frontExtract: Position;
    router: Position;
    chain: Array<{
        conv: Position;
        confirm: Position;
    }>;
    close: Position;
}
export interface AgentConfig {
    businessName: string;
    faqKnowledgeBase: string;
    introFinetuneExamples: FinetuneExample[];
}
export declare function makeIdFactory(baseMs?: number): IdFactory;
export declare function generateIds(f: IdFactory, resolvedDataPoints: DataPoint[]): Ids;
export declare function layoutPositions(resolvedDataPoints: DataPoint[]): Positions;
export declare function buildEndNode(ids: Ids, pos: Positions): {
    name: string;
    id: string;
    type: string;
    speak_during_execution: boolean;
    display_position: Position;
};
export declare function buildTransitionNode(ids: Ids, pos: Positions, f: IdFactory): {
    instruction: {
        type: string;
        text: string;
    };
    name: string;
    edges: never[];
    id: string;
    type: string;
    display_position: Position;
    skip_response_edge: {
        destination_node_id: string;
        id: string;
        transition_condition: {
            type: string;
            prompt: string;
        };
    };
};
export declare function buildIntroNode(config: AgentConfig, ids: Ids, pos: Positions, f: IdFactory): {
    finetune_conversation_examples: never[];
    instruction: {
        type: string;
        text: string;
    };
    name: string;
    edges: {
        destination_node_id: string;
        id: string;
        transition_condition: {
            type: string;
            prompt: string;
        };
    }[];
    start_speaker: string;
    finetune_transition_examples: Record<string, unknown>[];
    id: string;
    type: string;
    display_position: Position;
};
export declare function buildFaqNode(faqKnowledgeBase: string, ids: Ids, pos: Positions, f: IdFactory): {
    instruction: {
        type: string;
        text: string;
    };
    name: string;
    edges: {
        destination_node_id: string;
        id: string;
        transition_condition: {
            type: string;
            prompt: string;
        };
    }[];
    global_node_setting: {
        go_back_conditions: {
            id: string;
            transition_condition: {
                type: string;
                prompt: string;
            };
        }[];
        condition: string;
        positive_finetune_examples: never[];
        negative_finetune_examples: never[];
    };
    id: string;
    type: string;
    display_position: Position;
};
export declare function buildHumanRequestNode(ids: Ids, pos: Positions, f: IdFactory): {
    instruction: {
        type: string;
        text: string;
    };
    name: string;
    edges: {
        destination_node_id: string;
        id: string;
        transition_condition: {
            type: string;
            prompt: string;
        };
    }[];
    global_node_setting: {
        go_back_conditions: {
            id: string;
            transition_condition: {
                type: string;
                prompt: string;
            };
        }[];
        condition: string;
    };
    id: string;
    type: string;
    display_position: Position;
};
export declare function buildIrrelevantGuardrailNode(ids: Ids, pos: Positions, f: IdFactory): {
    instruction: {
        type: string;
        text: string;
    };
    name: string;
    edges: {
        destination_node_id: string;
        id: string;
        transition_condition: {
            type: string;
            prompt: string;
        };
    }[];
    global_node_setting: {
        go_back_conditions: {
            id: string;
            transition_condition: {
                type: string;
                prompt: string;
            };
        }[];
        condition: string;
        negative_finetune_examples: {
            transcript: {
                content: string;
                role: string;
            }[];
        }[];
        positive_finetune_examples: never[];
    };
    id: string;
    type: string;
    display_position: Position;
};
export declare function buildEmergencyGuardrailNode(ids: Ids, pos: Positions, f: IdFactory): {
    instruction: {
        type: string;
        text: string;
    };
    name: string;
    edges: never[];
    global_node_setting: {
        condition: string;
    };
    id: string;
    type: string;
    display_position: Position;
    skip_response_edge: {
        destination_node_id: string;
        id: string;
        transition_condition: {
            type: string;
            prompt: string;
        };
    };
};
export declare function buildPoliteHangupNode(ids: Ids, pos: Positions, f: IdFactory): {
    instruction: {
        type: string;
        text: string;
    };
    always_edge: {
        destination_node_id: string;
        id: string;
        transition_condition: {
            type: string;
            prompt: string;
        };
    };
    name: string;
    edges: never[];
    id: string;
    type: string;
    display_position: Position;
};
export declare function buildGuardrailEndNode(ids: Ids, pos: Positions): {
    name: string;
    id: string;
    type: string;
    speak_during_execution: boolean;
    display_position: Position;
};
export declare function buildDataChain(resolvedDataPoints: DataPoint[], ids: ReturnType<typeof generateIds>, pos: ReturnType<typeof layoutPositions>, f: IdFactory): Record<string, unknown>[];
export declare function buildCloseNode(businessName: string, ids: ReturnType<typeof generateIds>, pos: ReturnType<typeof layoutPositions>, f: IdFactory): {
    instruction: {
        type: string;
        text: string;
    };
    always_edge: {
        destination_node_id: string;
        id: string;
        transition_condition: {
            type: string;
            prompt: string;
        };
    };
    name: string;
    edges: never[];
    id: string;
    type: string;
    display_position: Position;
};
export declare function buildClosingSequence(ids: ReturnType<typeof generateIds>, pos: ReturnType<typeof layoutPositions>, f: IdFactory): ({
    instruction: {
        type: string;
        text: string;
    };
    always_edge: {
        destination_node_id: string;
        id: string;
        transition_condition: {
            type: string;
            prompt: string;
        };
    };
    name: string;
    edges: never[];
    id: string;
    type: string;
    display_position: {
        x: number;
        y: number;
    };
    skip_response_edge?: undefined;
} | {
    instruction: {
        type: string;
        text: string;
    };
    name: string;
    edges: never[];
    id: string;
    type: string;
    display_position: {
        x: number;
        y: number;
    };
    skip_response_edge: {
        destination_node_id: string;
        id: string;
        transition_condition: {
            type: string;
            prompt: string;
        };
    };
    always_edge?: undefined;
})[];
export declare function buildAgentRoot(businessName: string, conversationFlow: Record<string, unknown>): {
    agent_id: string;
    channel: string;
    last_modification_timestamp: number;
    agent_name: string;
    response_engine: {
        type: string;
        version: number;
    };
    webhook_url: string;
    webhook_timeout_ms: number;
    language: string;
    data_storage_setting: string;
    opt_in_signed_url: boolean;
    end_call_after_silence_ms: number;
    version: number;
    is_published: boolean;
    version_title: string;
    post_call_analysis_model: string;
    pii_config: {
        mode: string;
        categories: never[];
    };
    guardrail_config: {
        output_topics: string[];
        input_topics: string[];
    };
    analysis_successful_prompt: string;
    analysis_summary_prompt: string;
    analysis_user_sentiment_prompt: string;
    voice_id: string;
    fallback_voice_ids: string[];
    voice_temperature: number;
    voice_speed: number;
    volume: number;
    enable_backchannel: boolean;
    backchannel_frequency: number;
    backchannel_words: string[];
    reminder_trigger_ms: number;
    reminder_max_count: number;
    max_call_duration_ms: number;
    interruption_sensitivity: number;
    ambient_sound: string;
    ambient_sound_volume: number;
    responsiveness: number;
    begin_message_delay_ms: number;
    voicemail_option: {
        action: {
            type: string;
        };
    };
    allow_user_dtmf: boolean;
    user_dtmf_options: {};
    webhook_events: string[];
    conversationFlow: Record<string, unknown>;
};
export {};
