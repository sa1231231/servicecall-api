import type { DataPoint, FinetuneExample } from "./data-point-registry.js";
export declare const DEFAULT_CLOSE_PROMPT = "Thank the caller for all the information, and let them know our team at {{business_name}} will reach out to get them set up as soon as possible.";
export declare const DEFAULT_CLOSING_REMARKS_PROMPT = "You are about to end the call. Do not ask any questions.\n\nThank them and tell them to have a wonderful day. ";
export declare const DEFAULT_CLOSING_STATEMENT_TEXT = "Alright, bye now!";
export declare const DEFAULT_PRE_TRANSFER_PROMPT = "Thanks for the information. Hold on a moment \u2014 connecting you to our team at {{business_name}} now.";
export interface IdFactory {
    nextTs(): number;
    nodeId(): string;
    edgeId(): string;
    goBackId(): string;
}
export interface PathIds {
    transitionId: string;
    frontExtractId: string;
    routerId: string;
    chain: Array<{
        convId: string;
        confirmId: string;
    }>;
    preTransferId?: string;
    transferCallId?: string;
}
export type HumanRequestMode = "live_transfer" | "callback";
interface Ids {
    introId: string;
    endId: string;
    faqId: string;
    humanReqId: string;
    transferCallId: string;
    transferFailedId: string;
    irrelevantGuardrailId: string;
    emergencyGuardrailId: string;
    politeHangupId: string;
    guardrailEndId: string;
    closeId: string;
    closingRemarksId: string;
    closingStatementId: string;
    paths: PathIds[];
}
interface Position {
    x: number;
    y: number;
}
export interface PathPositions {
    transition: Position;
    frontExtract: Position;
    router: Position;
    chain: Array<{
        conv: Position;
        confirm: Position;
    }>;
    preTransfer?: Position;
    transferCall?: Position;
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
    close: Position;
    paths: PathPositions[];
}
export interface AgentConfig {
    businessName: string;
    faqKnowledgeBase: string;
    introFinetuneExamples: FinetuneExample[];
    humanRequestMode?: HumanRequestMode;
    closePrompt?: string;
    closingRemarksPrompt?: string;
    closingStatementText?: string;
}
export interface IntroPathConfig {
    name: string;
    transitionCondition: string;
}
export declare function makeIdFactory(baseMs?: number): IdFactory;
export declare function generateIds(f: IdFactory, pathDataPoints: DataPoint[][], pathEndModes?: Array<"callback" | "transfer">): Ids;
export declare function layoutPositions(pathDataPoints: DataPoint[][], pathEndModes?: Array<"callback" | "transfer">): Positions;
export declare function buildEndNode(ids: Ids, pos: Positions): {
    name: string;
    id: string;
    type: string;
    speak_during_execution: boolean;
    display_position: Position;
};
export declare function buildTransitionNode(pathIds: PathIds, pathPos: PathPositions, f: IdFactory, pathName?: string): {
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
export declare function buildIntroNode(config: AgentConfig, ids: Ids, pos: Positions, f: IdFactory, pathConfigs?: IntroPathConfig[]): {
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
export declare function buildFaqNode(faqKnowledgeBase: string, ids: Ids, pos: Positions, f: IdFactory, isMultiPath?: boolean): {
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
export declare function buildHumanRequestNode(ids: Ids, pos: Positions, f: IdFactory, mode?: HumanRequestMode): {
    instruction: {
        type: string;
        text: string;
    };
    name: string;
    edges: never[];
    global_node_setting: {
        condition: string;
        negative_finetune_examples: never[];
        positive_finetune_examples: {
            transcript: {
                content: string;
                role: string;
            }[];
        }[];
        go_back_conditions?: undefined;
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
} | {
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
        negative_finetune_examples?: undefined;
        positive_finetune_examples?: undefined;
    };
    id: string;
    type: string;
    display_position: Position;
    skip_response_edge?: undefined;
};
export declare function buildTransferCallNode(ids: Ids, pos: Positions, f: IdFactory): {
    custom_sip_headers: {};
    transfer_destination: {
        type: string;
        number: string;
    };
    edge: {
        destination_node_id: string;
        id: string;
        transition_condition: {
            type: string;
            prompt: string;
        };
    };
    name: string;
    ignore_e164_validation: boolean;
    id: string;
    transfer_option: {
        cold_transfer_mode: string;
        enable_bridge_audio_cue: boolean;
        type: string;
        agent_detection_timeout_ms: number;
        show_transferee_as_caller: boolean;
    };
    type: string;
    speak_during_execution: boolean;
    display_position: {
        x: number;
        y: number;
    };
};
export declare function buildPreTransferNode(pathIds: PathIds, pathPos: PathPositions, agentConfig: AgentConfig, pathLabel: string | undefined, f: IdFactory): {
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
export declare function buildPerPathTransferCallNode(pathIds: PathIds, pathPos: PathPositions, ids: Ids, resolvedNumber: string, pathLabel: string | undefined, f: IdFactory): {
    custom_sip_headers: {};
    transfer_destination: {
        type: string;
        number: string;
    };
    edge: {
        destination_node_id: string;
        id: string;
        transition_condition: {
            type: string;
            prompt: string;
        };
    };
    name: string;
    ignore_e164_validation: boolean;
    id: string;
    transfer_option: {
        cold_transfer_mode: string;
        enable_bridge_audio_cue: boolean;
        type: string;
        agent_detection_timeout_ms: number;
        show_transferee_as_caller: boolean;
    };
    type: string;
    speak_during_execution: boolean;
    display_position: Position;
};
export declare function buildTransferFailedNode(ids: Ids, pos: Positions, f: IdFactory): {
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
    model_choice: {
        type: string;
        model: string;
        high_priority: boolean;
    };
    name: string;
    edges: never[];
    id: string;
    type: string;
    display_position: {
        x: number;
        y: number;
    };
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
export declare function buildDataChain(resolvedDataPoints: DataPoint[], pathIds: PathIds, pathPos: PathPositions, closeId: string, f: IdFactory, pathName?: string): Record<string, unknown>[];
export declare function buildCloseNode(agentConfig: AgentConfig, ids: Ids, pos: Positions, f: IdFactory): {
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
export declare function buildClosingSequence(agentConfig: AgentConfig, ids: Ids, pos: Positions, f: IdFactory): ({
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
    handbook_config: {
        echo_verification: boolean;
        speech_normalization: boolean;
        default_personality: boolean;
        scope_boundaries: boolean;
        natural_filler_words: boolean;
        nato_phonetic_alphabet: boolean;
        high_empathy: boolean;
        ai_disclosure: boolean;
        smart_matching: boolean;
    };
    voice_id: string;
    voice_model: string;
    fallback_voice_ids: never[];
    voice_temperature: number;
    voice_speed: number;
    enable_dynamic_voice_speed: boolean;
    volume: number;
    voice_emotion: string;
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
    normalize_for_speech: boolean;
    begin_message_delay_ms: number;
    voicemail_option: {
        action: {
            type: string;
        };
    };
    allow_user_dtmf: boolean;
    user_dtmf_options: {};
    post_call_analysis_data: {
        type: string;
        name: string;
        description: string;
    }[];
    conversationFlow: Record<string, unknown>;
};
export {};
