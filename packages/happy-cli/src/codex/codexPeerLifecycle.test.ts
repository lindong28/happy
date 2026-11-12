/** Protocol fixtures exercise the real dispatcher and its outgoing JSON-RPC stream. */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CodexAppServerClient } from './codexAppServerClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';

function harness() {
    const client = new CodexAppServerClient();
    const input = new PassThrough();
    const output: string[] = [];
    input.on('data', data => output.push(data.toString()));
    const dispatcher = client as unknown as {
        process: { stdin: PassThrough };
        _threadId: string;
        _turnId: string;
        pendingTurnCompletion: { turnId: string; resolve(aborted: boolean): void } | null;
        handleServerRequest(id: number, method: string, params: unknown): Promise<void>;
        handleNotification(method: string, params: unknown): void;
    };
    dispatcher.process = { stdin: input };
    dispatcher._threadId = 'thread';
    return { client, dispatcher, output };
}

describe('Codex peer lifecycle', () => {
    it('forwards completed native user messages with identity and attachments', () => {
        const { client, dispatcher } = harness();
        const events: unknown[] = [];
        client.setEventHandler(event => events.push(event));
        const item = { type: 'userMessage', id: 'user-1', clientId: 'terminal-1', content: [
            { type: 'text', text: 'inspect this' }, { type: 'localImage', path: '/project/image.png' },
        ] };
        dispatcher.handleNotification('item/started', { threadId: 'thread', turnId: 'turn', item });
        expect(events).toEqual([]);
        dispatcher.handleNotification('item/completed', { threadId: 'thread', turnId: 'turn', item });
        expect(events).toEqual([{ type: 'native_user_message', threadId: 'thread', turnId: 'turn', item }]);
    });

    it('withdraws only the resolved approval from the actual permission state consumer', async () => {
        const { client, dispatcher, output } = harness();
        let state: AgentState = {};
        const session = {
            rpcHandlerManager: { registerHandler() {} },
            updateAgentState(update: (value: AgentState) => AgentState) { state = update(state); },
        } as unknown as ApiSessionClient;
        const permissions = new CodexPermissionHandler(session, false);
        client.setApprovalHandler(async (params, signal) => {
            return (await permissions.handleToolCall(params.callId, 'CodexBash', { command: params.command }, signal)).decision;
        });
        const one = dispatcher.handleServerRequest(17, 'item/commandExecution/requestApproval', { threadId: 'thread', itemId: 'one', command: ['pwd'] });
        const two = dispatcher.handleServerRequest(18, 'item/commandExecution/requestApproval', { threadId: 'thread', itemId: 'two', command: ['ls'] });
        expect(Object.keys(state.requests ?? {})).toHaveLength(2);
        dispatcher.handleNotification('serverRequest/resolved', { threadId: 'thread', requestId: 17 });
        await one;
        expect(Object.keys(state.requests ?? {})).toEqual(['thread:two']);
        expect(state.completedRequests?.['thread:one']).toMatchObject({ status: 'canceled' });
        expect(output).toEqual([]);
        permissions.abortAll();
        await two;
        expect(output.map(line => JSON.parse(line))).toEqual([{ jsonrpc: '2.0', id: 18, result: { decision: 'cancel' } }]);
    });

    it.each(['interrupted', 'completed'])('waits for authoritative %s after idle', status => {
        const { client, dispatcher } = harness();
        const results: boolean[] = [];
        const events: unknown[] = [];
        client.setEventHandler(event => events.push(event));
        dispatcher._turnId = 'turn';
        dispatcher.pendingTurnCompletion = { turnId: 'turn', resolve: aborted => results.push(aborted) };
        dispatcher.handleNotification('thread/status/changed', { threadId: 'thread', status: { type: 'idle' } });
        expect(results).toEqual([]);
        expect(events).toEqual([]);
        dispatcher.handleNotification('turn/completed', { threadId: 'thread', turn: { id: 'turn', status } });
        expect(results).toEqual([status === 'interrupted']);
        expect(events).toEqual([expect.objectContaining({ type: status === 'interrupted' ? 'turn_aborted' : 'task_complete', status })]);
    });

    it.each([
        ['item/commandExecution/requestApproval', {}],
        ['item/fileChange/requestApproval', {}],
        ['mcpServer/elicitation/request', { serverName: 'tool', mode: 'form', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call' } }],
    ])('withdraws peer-resolved %s and suppresses a late reply', async (method, extra) => {
        const { client, dispatcher, output } = harness();
        let signal: AbortSignal | undefined;
        let finish!: (decision: 'approved') => void;
        client.setApprovalHandler(async (_params, incomingSignal?: AbortSignal) => {
            signal = incomingSignal;
            return new Promise(resolve => { finish = resolve; });
        });
        const waiting = dispatcher.handleServerRequest(17, method, { threadId: 'thread', itemId: 'item', ...extra });
        dispatcher.handleNotification('serverRequest/resolved', { threadId: 'unrelated', requestId: 17 });
        const before = signal?.aborted;
        dispatcher.handleNotification('serverRequest/resolved', { threadId: 'thread', requestId: 17 });
        const after = signal?.aborted;
        finish('approved');
        await waiting;
        expect(before).toBe(false);
        expect(after).toBe(true);
        expect(output).toEqual([]);
    });
});
