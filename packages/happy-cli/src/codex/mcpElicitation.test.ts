import { describe, expect, it } from 'vitest';
import { askMcpElicitation } from './mcpElicitation';
import { QuestionForms } from './questionForms';

// Schema shapes emitted by ask-user-mcp/server.mjs: direct choice, then
// an optional second elicitation for a choice plus a required free-text note.
const choice = { type: 'string', title: 'Decision', description: 'Choose one', enum: ['A', 'B', 'Other'] };
const request = (details = false) => ({
    mode: 'form', serverName: 'ask-user', message: 'A: first option; B: second option',
    requestedSchema: {
        type: 'object', additionalProperties: false,
        properties: { q0_answer: choice, ...(details ? { q0_note: { type: 'string', minLength: 1 } } : {}) },
        required: details ? ['q0_answer', 'q0_note'] : [],
    },
});
const reply = (answers: unknown) => ({ id: 'form', kind: 'form', status: 'answered', answers });

describe('MCP elicitation forms', () => {
    it.each([false, true])('returns schema-shaped content for details=%s', async details => {
        const forms = new QuestionForms();
        const waiting = askMcpElicitation(forms, 'form', request(details), new AbortController().signal);
        const shown = forms.snapshot().communications.form.form.questions;
        expect(shown[0].question).toContain('A: first option');
        expect(shown[0].allowCustom).toBe(false);
        await forms.reply(reply({ q0_answer: { options: ['B'] }, ...(details ? { q0_note: { options: [], custom: 'my note' } } : {}) }));
        expect(await waiting).toEqual({ action: 'accept', content: { q0_answer: 'B', ...(details ? { q0_note: 'my note' } : {}) }, _meta: null });
    });

    it('preserves optional omission and cancellation as distinct outcomes', async () => {
        const forms = new QuestionForms();
        const optional = askMcpElicitation(forms, 'form', request(), new AbortController().signal);
        await forms.reply(reply({}));
        expect(await optional).toMatchObject({ action: 'accept', content: {} });
        const controller = new AbortController();
        const cancelled = askMcpElicitation(forms, 'next', request(true), controller.signal);
        controller.abort();
        expect(await cancelled).toEqual({ action: 'cancel', content: null, _meta: null });
        expect(forms.snapshot().communications).toEqual({});
    });

    it('accepts the iOS omission shape for unanswered optional questions', async () => {
        const forms = new QuestionForms();
        const params = request();
        params.requestedSchema.properties = { ...params.requestedSchema.properties, q1_answer: choice } as typeof params.requestedSchema.properties;
        const waiting = askMcpElicitation(forms, 'form', params, new AbortController().signal);
        await forms.reply(reply({ q0_answer: { options: ['A'] } }));
        expect(await waiting).toMatchObject({ action: 'accept', content: { q0_answer: 'A' } });
    });

    it.each(['ask-user', 'another-server'])('shows the requesting server %s and accepts nullable protocol fields', async serverName => {
        const forms = new QuestionForms();
        const waiting = askMcpElicitation(forms, 'form', {
            ...request(), serverName,
            requestedSchema: { type: 'object', $schema: null, required: null, properties: {
                q0_answer: { ...choice, default: null, title: null, description: null, enumNames: null },
                note: { type: 'string', default: null, minLength: null, maxLength: null, format: null },
            } },
        }, new AbortController().signal);
        // Attach a rejection handler before inspecting synchronous form publication.
        void waiting.catch(() => {});
        expect(forms.snapshot().communications.form?.form.questions[0].question).toContain(serverName);
        await forms.reply(reply({ q0_answer: { options: ['A'] }, note: { options: [], custom: 'note' } }));
        expect(await waiting).toMatchObject({ content: { q0_answer: 'A', note: 'note' } });
    });

    it('leaves invalid input retryable without returning an accepted response', async () => {
        const forms = new QuestionForms();
        const params = request(true);
        params.requestedSchema.properties.q0_note = { type: 'string', minLength: 4 };
        const waiting = askMcpElicitation(forms, 'form', params, new AbortController().signal);
        await expect(forms.reply(reply({ q0_answer: { options: ['A'] }, q0_note: { options: [], custom: 'x' } }))).rejects.toThrow();
        expect(forms.snapshot().communications.form).toBeDefined();
        await forms.reply(reply({ q0_answer: { options: ['A'] }, q0_note: { options: [], custom: 'valid note' } }));
        expect(await waiting).toMatchObject({ action: 'accept', content: { q0_note: 'valid note' } });
    });

    it.each([
        { mode: 'url', message: 'Authenticate', url: 'https://example.com' },
        { ...request(), requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } },
        { ...request(), requestedSchema: { type: 'object', properties: { q: { type: 'string', pattern: '^secret' } } } },
    ])('rejects unsupported forms without fabricating content', async params => {
        const forms = new QuestionForms();
        await expect(askMcpElicitation(forms, 'form', params, new AbortController().signal)).rejects.toThrow();
        expect(forms.snapshot().communications).toEqual({});
    });
});
