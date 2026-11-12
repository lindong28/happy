/** Real Unix sockets prove rejected requests do not reach the Codex-facing consumer. */
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { connectNativeSocket, nativeThreadRequestError, startNativeFrontendProxy } from './nativeMobileTransport';

it('preserves native input and approval replies, rejecting both thread-change paths before forwarding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hn-'));
    const backendPath = join(directory, 'b');
    const frontendPath = join(directory, 'f');
    const http = createServer();
    const backend = new WebSocketServer({ server: http });
    const received: unknown[] = [];
    backend.on('connection', socket => socket.on('message', data => {
        const request = JSON.parse(data.toString());
        received.push(request);
        if (request.method) socket.send(JSON.stringify({ id: request.id, result: { echoed: request.params } }));
    }));
    await new Promise<void>(resolve => http.listen(backendPath, resolve));
    const close = await startNativeFrontendProxy(frontendPath, backendPath, 'fixed');
    let frontend: WebSocket | undefined;
    try {
        frontend = await connectNativeSocket(frontendPath);
        const exchange = (request: unknown) => new Promise<{ error?: unknown; result?: unknown }>(resolve => {
            frontend!.once('message', (data, isBinary) => {
                expect(isBinary).toBe(false); // Codex's native TUI consumes JSON-RPC text frames.
                resolve(JSON.parse(data.toString()));
            });
            frontend!.send(JSON.stringify(request));
        });
        frontend.send('null');
        frontend.send('[]');
        for (const request of [
            { id: 0, method: 42 },
            { id: 1, method: 'thread/start', params: {} },
            { id: 2, method: 'thread/resume', params: { threadId: 'other' } },
            { id: 3, method: 'thread/resume', params: { threadId: 'fixed', path: '/other' } },
            { id: 4, method: 'turn/start', params: { threadId: 'other', input: [] } },
        ]) expect((await exchange(request)).error).toBeDefined();
        expect(received).toEqual([]);
        const resume = { id: 5, method: 'thread/resume', params: { threadId: 'fixed', path: null, history: null } };
        expect((await exchange(resume)).error).toBeUndefined();
        const input = { id: 6, method: 'turn/start', params: { threadId: 'fixed', input: [{ type: 'text', text: '你好' }] } };
        await exchange(input);
        const approval = { id: 91, result: { decision: 'accept' } };
        frontend.send(JSON.stringify(approval));
        await exchange({ id: 7, method: 'config/read' }); // Ordering barrier after approval reply.
        expect(received).toEqual([resume, input, approval, { id: 7, method: 'config/read' }]);
    } finally {
        frontend?.terminate();
        await close();
        for (const client of backend.clients) client.terminate();
        backend.close();
        await new Promise<void>(resolve => http.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
    }
});

it('allows same-session native configuration and rejects detached reviews', () => {
    expect(nativeThreadRequestError({ method: 'thread/settings/update', params: { threadId: 'fixed', model: 'chosen' } }, 'fixed')).toBeNull();
    expect(nativeThreadRequestError({ method: 'review/start', params: { threadId: 'fixed', delivery: 'detached' } }, 'fixed')).not.toBeNull();
});
