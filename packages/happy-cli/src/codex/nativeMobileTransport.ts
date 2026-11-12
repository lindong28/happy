/** Private Unix WebSocket transport and the single-thread native frontend boundary. */
import { createServer } from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import WebSocket, { WebSocketServer } from 'ws';

export async function connectNativeSocket(path: string, stopped: () => boolean = () => false): Promise<WebSocket> {
    if (Buffer.byteLength(path) > 100) throw new Error('Native mobile socket path is too long; use a shorter HAPPY_HOME_DIR.');
    const deadline = Date.now() + 30_000;
    while (!stopped()) {
        try {
            return await new Promise<WebSocket>((resolve, reject) => {
                const socket = new WebSocket(`ws+unix://${path}:/`, { handshakeTimeout: 1000 });
                socket.once('open', () => resolve(socket));
                socket.once('error', reject);
            });
        } catch (error) {
            if (Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    throw new Error('Codex backend exited before its socket opened');
}

export function nativeThreadRequestError(message: unknown, threadId: string): string | null {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return 'Invalid JSON-RPC message';
    const request = message as { method?: string; params?: Record<string, unknown> };
    if (request.method === undefined) return null; // Replies to approvals/questions retain the original RPC ID.
    if (typeof request.method !== 'string') return 'Invalid JSON-RPC method';
    const method = request.method;
    const params = request.params ?? {};
    const newTerminal = 'This mobile terminal stays on one session. Open a new codex-account terminal to start or resume another session.';
    if (['thread/start', 'thread/fork', 'thread/delete', 'thread/archive', 'thread/rollback', 'thread/revert'].includes(method)) return newTerminal;
    if (method === 'thread/resume' && (params.path != null || params.history != null)) return newTerminal;
    if (method === 'review/start' && params.delivery === 'detached') return newTerminal;
    if (['thread/list', 'thread/search', 'thread/searchOccurrences', 'thread/loaded/list', 'thread/read'].includes(method)) return null;
    if ((method.startsWith('thread/') || method.startsWith('turn/') || method === 'review/start') && params.threadId !== threadId) return newTerminal;
    return null;
}

export async function startNativeFrontendProxy(path: string, backend: string, threadId: string): Promise<() => Promise<void>> {
    if (Buffer.byteLength(path) > 100) throw new Error('Native mobile socket path is too long');
    const http = createServer();
    const server = new WebSocketServer({ server: http });
    const peers = new Set<WebSocket>();
    server.on('connection', frontend => {
        peers.add(frontend);
        let upstream: WebSocket | undefined;
        const buffered: string[] = [];
        let bufferedBytes = 0;
        frontend.on('error', () => frontend.close());
        frontend.on('close', () => { peers.delete(frontend); upstream?.close(); });
        frontend.on('message', data => {
            const raw = data.toString();
            let message: { id?: unknown } | null;
            try { message = JSON.parse(raw); } catch { frontend.close(1007, 'Invalid JSON'); return; }
            const error = nativeThreadRequestError(message, threadId);
            if (error) {
                if (message?.id !== undefined) frontend.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: error } }));
                return;
            }
            if (upstream?.readyState === WebSocket.OPEN) upstream.send(raw);
            else {
                bufferedBytes += Buffer.byteLength(raw);
                if (bufferedBytes > 4 * 1024 * 1024) { frontend.close(1009, 'Backend unavailable'); return; }
                buffered.push(raw);
            }
        });
        void connectNativeSocket(backend, () => frontend.readyState !== WebSocket.OPEN).then(socket => {
            upstream = socket;
            if (frontend.readyState !== WebSocket.OPEN) { socket.close(); return; }
            peers.add(socket);
            socket.on('error', () => frontend.close(1011, 'Codex backend error'));
            socket.on('close', () => { peers.delete(socket); frontend.close(1011, 'Codex backend disconnected'); });
            socket.on('message', (data, isBinary) => {
                if (frontend.readyState === WebSocket.OPEN) frontend.send(data, { binary: isBinary });
            });
            for (const raw of buffered) socket.send(raw);
            buffered.length = 0;
        }).catch(() => frontend.close(1011, 'Codex backend unavailable'));
    });
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(path, resolve); });
    await chmod(path, 0o600);
    return async () => {
        for (const peer of peers) peer.terminate();
        server.close();
        await new Promise<void>(resolve => http.close(() => resolve()));
        await unlink(path).catch(() => undefined);
    };
}
