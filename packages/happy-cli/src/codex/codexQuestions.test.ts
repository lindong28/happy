/** Exercises the actual dispatch methods without a provider or relay account. */
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from './codexAppServerClient';
import { buildCodexTurnPrompt, hashCodexEnhancedMode } from './codexPrompt';

describe('Codex question dispatch', () => {
    it('routes MCP data forms to questions and leaves explicit tool approval separate', async () => {
        const client = new CodexAppServerClient();
        const approval = vi.fn(async () => 'approved' as const);
        const elicitation = vi.fn(async () => ({ action: 'accept' as const, content: { q: 'B' }, _meta: null }));
        client.setApprovalHandler(approval);
        client.setMcpElicitationHandler(elicitation);
        const internal = client as any;
        const respond = vi.spyOn(internal, 'respond');
        const base = { threadId: 'thread', serverName: 'ask-user', mode: 'form', message: 'Choose', requestedSchema: { type: 'object', properties: { q: { type: 'string', enum: ['A', 'B'] } } } };
        await internal.handleServerRequest(21, 'mcpServer/elicitation/request', base);
        expect(approval).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(21, { action: 'accept', content: { q: 'B' }, _meta: null });
        await internal.handleServerRequest(22, 'mcpServer/elicitation/request', { ...base, _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: { type: 'object', properties: {} } });
        expect(approval).toHaveBeenCalledTimes(1);
        expect(elicitation).toHaveBeenCalledTimes(1);
        expect(respond).toHaveBeenCalledWith(22, { action: 'accept', content: {}, _meta: null });
    });
    it('does not append Happy instructions or batch unrelated input into a native answer', () => {
        const message = '<send_user_message_question_reply>[]</send_user_message_question_reply>';
        const mode = { permissionMode: 'auto' as const, questionReplyId: 'reply-1', appendSystemPrompt: 'Options' };
        expect(buildCodexTurnPrompt({ message, mode, includeAppendSystemPrompt: true, includeTitleInstruction: true })).toBe(message);
        expect(hashCodexEnhancedMode(mode)).not.toBe(hashCodexEnhancedMode({ ...mode, questionReplyId: undefined }));
    });
    it.each([true, false])('dispatches native user input with isBlocking=%s', async isBlocking => {
        const client = new CodexAppServerClient();
        const received: unknown[] = [];
        client.setQuestionHandler(async request => {
            received.push(request);
            return { answers: { q: { answers: ['B'] } } };
        });
        const params = { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking, questions: [{ id: 'q', header: '', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] };
        const dispatcher = client as unknown as { handleServerRequest(id: number, method: string, params: unknown): Promise<void> };
        await dispatcher.handleServerRequest(7, 'item/tool/requestUserInput', params);
        expect(received).toEqual([{ ...params, requestId: 7 }]);
    });

    it.each(['', 'Please choose'])('forwards async questions with text=%j', text => {
        const client = new CodexAppServerClient();
        const events: unknown[] = [];
        client.setEventHandler(event => events.push(event));
        const item = { type: 'agentMessage', id: 'call', text, delivery: 'async', questions: [{ title: 'Choose', options: ['A', 'B'] }] };
        const dispatcher = client as unknown as { handleNotification(method: string, params: unknown): void };
        dispatcher.handleNotification('item/completed', { threadId: 'thread', turnId: 'turn', item });
        expect(events).toContainEqual({ type: 'user_questions', threadId: 'thread', item });
    });

    it('withdraws an outstanding question when Codex resolves its native request', async () => {
        const client = new CodexAppServerClient();
        let questionSignal: AbortSignal | undefined;
        client.setQuestionHandler(async (_request, signal) => {
            questionSignal = signal;
            await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
            return { answers: {} };
        });
        const dispatcher = client as unknown as {
            handleServerRequest(id: number, method: string, params: unknown): Promise<void>;
            handleNotification(method: string, params: unknown): void;
        };
        const waiting = dispatcher.handleServerRequest(7, 'item/tool/requestUserInput', { threadId: 'thread', questions: [] });
        dispatcher.handleNotification('serverRequest/resolved', { threadId: 'thread', requestId: 7 });
        expect(questionSignal?.aborted).toBe(true);
        await waiting;
    });
});
