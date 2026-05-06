import type { CreateAgentBody } from "./agent-from-config.js";
export interface TemplateDoc {
    _id: unknown;
    name: string;
    type: "template";
    formData: Record<string, unknown>;
    exportConfig?: CreateAgentBody;
    createdAt?: Date;
    updatedAt?: Date;
}
export interface FromTemplateOverrides {
    business: {
        businessName: string;
        faqKnowledgeBase: string;
    };
    client?: Partial<CreateAgentBody["client"]>;
}
export declare function slugify(input: string): string;
export declare function loadTemplate(name: string): Promise<TemplateDoc | null>;
export declare function applyOverrides(exportConfig: CreateAgentBody, overrides: FromTemplateOverrides): CreateAgentBody;
