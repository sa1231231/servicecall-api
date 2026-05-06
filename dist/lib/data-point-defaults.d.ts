import { type DataPoint, type VariableDef } from "./agent-generator/data-point-registry.js";
export declare const CATEGORY_ORDER: string[];
export declare const CATEGORY_LABELS: Record<string, string>;
export interface StoredDataPoint extends DataPoint {
    category?: string;
    sortOrder?: number;
}
/** Load all data point defaults as a lookup map. */
export declare function getDataPointDefaults(): Promise<Record<string, DataPoint>>;
/** Load all data point defaults with category info for the form. */
export declare function getDataPointDefaultsWithCategory(): Promise<Record<string, StoredDataPoint>>;
/** Get a single data point default. */
export declare function getDataPointDefault(key: string): Promise<(StoredDataPoint & {
    _id: string;
}) | null>;
/** Update a single data point default. */
export declare function updateDataPointDefault(key: string, updates: Partial<StoredDataPoint>): Promise<StoredDataPoint | null>;
/** Create a new custom data point default. */
export declare function createDataPointDefault(key: string, data: {
    label: string;
    category?: string;
    type?: "string" | "enum" | "boolean";
    choices?: string[];
    description?: string;
    conversationPrompt?: string;
    forwardCondition?: string;
    composite?: boolean;
    variables?: VariableDef[];
}): Promise<StoredDataPoint>;
/** Delete a data point default. */
export declare function deleteDataPointDefault(key: string): Promise<boolean>;
/** Bulk reorder data points — updates category and sortOrder for each item. */
export declare function reorderDataPointDefaults(items: Array<{
    key: string;
    category: string;
    sortOrder: number;
}>): Promise<void>;
