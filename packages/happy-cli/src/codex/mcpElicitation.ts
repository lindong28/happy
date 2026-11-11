import { z } from 'zod';
import { QuestionDeliveryError, QuestionForms } from './questionForms';
import type { Question, QuestionAnswers } from './userQuestions';
import type { McpServerElicitationRequestResponse } from './codexAppServerTypes';

// The string forms used by ask-user, including its second-stage note fields.
// Reject other constraints instead of accepting an answer we cannot validate.
const fieldSchema = z.object({
    type: z.literal('string'),
    title: z.string().nullish(), description: z.string().nullish(),
    enum: z.array(z.string()).min(1).optional(),
    minLength: z.number().int().nonnegative().nullish(),
    maxLength: z.number().int().nonnegative().nullish(),
    default: z.string().nullish(),
    format: z.null().optional(), enumNames: z.null().optional(),
}).strict();
const schema = z.object({
    type: z.literal('object'), properties: z.record(z.string(), fieldSchema),
    required: z.array(z.string()).nullish(), additionalProperties: z.boolean().optional(),
    $schema: z.string().nullish(), title: z.string().nullish(), description: z.string().nullish(),
}).strict();

export type McpFormRequest = { mode?: unknown; serverName?: unknown; message?: unknown; requestedSchema?: unknown };

export async function askMcpElicitation(
    forms: QuestionForms, id: string, request: McpFormRequest, signal: AbortSignal,
): Promise<McpServerElicitationRequestResponse> {
    if (request.mode !== undefined && request.mode !== 'form') throw new Error('MCP elicitation mode is unsupported by this Happy build');
    const parsed = schema.safeParse(request.requestedSchema);
    if (!parsed.success) throw new Error('MCP elicitation schema is unsupported by this Happy build');
    const { properties } = parsed.data;
    const required = parsed.data.required ?? [];
    if (typeof request.serverName !== 'string' || !request.serverName.trim()) {
        throw new Error('MCP elicitation is missing its requesting server');
    }
    const fields = Object.entries(properties);
    if (fields.length === 0 || required.some(key => !Object.hasOwn(properties, key))) {
        throw new Error('MCP elicitation schema is unsupported by this Happy build');
    }
    const questions: Question[] = fields.map(([key, field], index) => ({
        id: key, header: field.title ?? key,
        question: [
            index === 0 ? `MCP server: ${request.serverName}` : '',
            index === 0 && typeof request.message === 'string' ? request.message : '',
            field.description ?? field.title ?? key,
            field.minLength != null ? `Minimum length: ${field.minLength}` : '',
            field.maxLength != null ? `Maximum length: ${field.maxLength}` : '',
        ].filter(Boolean).join('\n\n'),
        options: (field.enum ?? []).map(label => ({ label })),
        allowCustom: !field.enum, multiSelect: false, required: required.includes(key),
    }));
    const encode = (answers: QuestionAnswers): Record<string, string> => Object.fromEntries(fields.flatMap(([key, field]) => {
        const answer = answers[key];
        if (answer === undefined && !required.includes(key)) return [];
        if (!answer || (field.enum && answer.custom) || (!field.enum && answer.options.length > 0)) {
            throw new QuestionDeliveryError(`Invalid answer for ${field.title ?? key}`);
        }
        const value = field.enum ? answer.options[0] : answer.custom;
        if (value === undefined || value === '') {
            if (required.includes(key)) throw new QuestionDeliveryError(`An answer is required for ${field.title ?? key}`);
            return [];
        }
        const length = [...value].length;
        if ((field.enum && !field.enum.includes(value))
            || (field.minLength != null && length < field.minLength)
            || (field.maxLength != null && length > field.maxLength)) {
            throw new QuestionDeliveryError(`Answer does not match the requested constraints for ${field.title ?? key}`);
        }
        return [[key, value]];
    }));
    const cancelled: McpServerElicitationRequestResponse = { action: 'cancel', content: null, _meta: null };
    if (signal.aborted) return cancelled;
    const cancel = (): void => forms.cancel(id);
    const waiting = new Promise<McpServerElicitationRequestResponse>(resolve => {
        forms.open(id, questions, async answers => {
            resolve(answers ? { action: 'accept', content: encode(answers), _meta: null } : cancelled);
        });
    });
    signal.addEventListener('abort', cancel, { once: true });
    try { return await waiting; }
    finally { signal.removeEventListener('abort', cancel); }
}
