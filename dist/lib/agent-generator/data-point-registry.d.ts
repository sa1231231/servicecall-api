export interface FinetuneExample {
    type: "positive" | "negative";
    transcript: Array<{
        content: string;
        role: "user" | "agent";
    }>;
    destination?: string;
    id?: string;
}
export interface ExtractEquation {
    left: string;
    operator: string;
    right?: string;
}
export interface VariableDef {
    variableName: string;
    type: "string" | "enum" | "boolean";
    choices?: string[];
    description: string;
}
export interface DataPoint {
    composite?: boolean;
    label: string;
    variableName: string;
    type: "string" | "enum" | "boolean";
    choices?: string[];
    description: string;
    conversationPrompt: string;
    forwardCondition: string;
    finetuneExamples?: FinetuneExample[];
    extractSuccessEquation: ExtractEquation[];
    variables?: VariableDef[];
}
export type RawDataPoint = string | Partial<DataPoint> & {
    variableName?: string;
    composite?: boolean;
    variables?: VariableDef[];
};
export declare const NOT_MENTIONED = "Not Mentioned";
export declare const CALLER_DOESNT_KNOW = "Caller Doesn't Know";
export declare const PHONE_COLLECTED_FLAG = "phone_number_collected";
export declare const PATH_TAKEN_VAR = "_path_taken";
export declare const INTERNAL_VARS: Set<string>;
export declare function defaultExtractEquation(varName: string): ExtractEquation[];
export declare const DATA_POINT_REGISTRY: Record<string, DataPoint>;
