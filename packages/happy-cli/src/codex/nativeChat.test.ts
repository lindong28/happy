import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEnvelope } from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { encodeBase64, encrypt } from '@/api/encryption';
import type { Credentials } from '@/persistence';
import { createNativeChat, isNativePhoneInput, nativePhoneInputId, readNativeChat, readNativeChatHistory, unseenNativeHistory, writeNativeChat } from './nativeChat';
import { MessageQueue2 } from '@/utils/MessageQueue2';

const root = process.env.HAPPY_TEST_ARTIFACTS ?? join(homedir(), 'task-artifacts', 'happy-native-chat-tests');
mkdirSync(root, { recursive: true });
const directories: string[] = [];
const threadId = '01a1e235-08fa-77c3-956d-ab5a2164b490';
const credentials: Credentials = { token: 'local-fixture', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } };
function chat() {
    return createNativeChat(threadId, credentials, {
        id: 'original-chat', seq: 0, encryptionKey: new Uint8Array(32).fill(3), encryptionVariant: 'legacy',
        metadata: { path: '/project', host: 'fixture', homeDir: '/home', happyHomeDir: '/home/happy', happyLibDir: '/lib', happyToolsDir: '/tools' },
        metadataVersion: 4, agentState: null, agentStateVersion: 2,
    });
}
function home() { const path = mkdtempSync(join(root, 'state-')); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true }); });

describe('native chat continuity', () => {
    it('retains the same identity/key and input receipt across A → B → A restarts', () => {
        const directory = home();
        const original = chat();
        for (const [index, account] of ['account-a', 'account-b', 'account-a'].entries()) {
            const current = readNativeChat(threadId, credentials, directory) ?? original;
            current.account = account;
            current.inputSeq = index * 5;
            writeNativeChat(current, directory);
            const reloaded = readNativeChat(threadId, credentials, directory)!;
            expect(reloaded.sessionId).toBe(original.sessionId);
            expect(reloaded.encryptionKey).toBe(original.encryptionKey);
            expect(reloaded.account).toBe(account);
            expect(reloaded.inputSeq).toBe(index * 5);
        }
        expect(statSync(join(directory, 'native-chats', `${threadId}.json`)).mode & 0o777).toBe(0o600);
    });

    it('fails closed for identity changes, corrupt state and symlinks', () => {
        const directory = home();
        writeNativeChat(chat(), directory);
        expect(() => readNativeChat(threadId, { ...credentials, encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } }, directory)).toThrow(/identity/);
        const path = join(directory, 'native-chats', `${threadId}.json`);
        const content = readFileSync(path);
        writeFileSync(path, '{');
        expect(() => readNativeChat(threadId, credentials, directory)).toThrow();
        rmSync(path);
        const target = join(directory, 'target');
        writeFileSync(target, content, { mode: 0o600 });
        symlinkSync(target, path);
        expect(() => readNativeChat(threadId, credentials, directory)).toThrow(/symlinks/);
        expect(() => writeNativeChat(chat(), directory)).toThrow(/symlinks/);
    });

    it('records every input in the begun batch without crossing queued modes or losing attachments', async () => {
        const directory = home();
        const state = chat();
        writeNativeChat(state, directory);
        const queue = new MessageQueue2<{ mode: string; seq: number }>(value => value.mode);
        const image = { data: new Uint8Array([1]), mimeType: 'image/png', name: 'fixture' };
        queue.push('one', { mode: 'same', seq: 4 });
        queue.push('two', { mode: 'same', seq: 6 }, [image]);
        queue.push('three', { mode: 'other', seq: 9 });
        const first = await queue.waitForMessagesAndGetAsString();
        expect(first?.message).toBe('one\ntwo');
        expect(first?.attachments).toEqual([image]);
        expect(readNativeChat(threadId, credentials, directory)?.inputSeq).toBe(0);
        state.inputSeq = Math.max(...queue.consumedModes(first!).map(mode => mode.seq));
        writeNativeChat(state, directory);
        expect(readNativeChat(threadId, credentials, directory)?.inputSeq).toBe(6);
        expect(queue.size()).toBe(1);
        const second = await queue.waitForMessagesAndGetAsString();
        state.inputSeq = Math.max(...queue.consumedModes(second!).map(mode => mode.seq));
        writeNativeChat(state, directory);
        expect(readNativeChat(threadId, credentials, directory)?.inputSeq).toBe(9);
    });

    it('distinguishes repeated phone and terminal input by client identity, not text', () => {
        const phone = { type: 'userMessage', clientId: nativePhoneInputId('original-chat') };
        expect(isNativePhoneInput(phone, 'original-chat')).toBe(true);
        expect(isNativePhoneInput(phone, 'other-chat')).toBe(false);
        expect(isNativePhoneInput({ type: 'userMessage', clientId: 'terminal-id' }, 'original-chat')).toBe(false);
        expect(isNativePhoneInput({ type: 'userMessage' }, 'original-chat')).toBe(false);
    });

    it('fills partial history without repeating legacy random-id text or completed turn markers', () => {
        const old = createEnvelope('agent', { t: 'text', text: 'answer' }, { id: 'old-random', turn: 'turn-1' });
        const oldEnd = createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { id: 'old-end', turn: 'turn-1' });
        const missing = createEnvelope('agent', { t: 'text', text: 'missing' }, { id: 'item-2', codexItemId: 'item-2', turn: 'turn-1' });
        const backfill = [
            createEnvelope('agent', old.ev, { id: 'item-1', codexItemId: 'item-1', turn: 'turn-1' }),
            missing,
            createEnvelope('agent', oldEnd.ev, { id: 'turn-1:end', turn: 'turn-1' }),
        ];
        expect(unseenNativeHistory(backfill, [old, oldEnd])).toEqual([missing]);
        expect(unseenNativeHistory(backfill, [old, oldEnd, missing])).toEqual([]);
        expect(unseenNativeHistory(backfill, [])).toEqual(backfill);
    });

    it.each([[0, false], [400, false], [400, true]])('captures a legacy boundary without traversing old pages (%i messages, reordered %s)', async (count, reordered) => {
        const previousUrl = configuration.serverUrl;
        const requested: string[] = [];
        const body = { role: 'user', content: { type: 'text', text: 'old pending input' } };
        const content = { t: 'encrypted', c: encodeBase64(encrypt(new Uint8Array(32).fill(3), 'legacy', body)) };
        const server = createServer((req, res) => {
            requested.push(req.url!);
            const latest = req.url!.startsWith('/v1/');
            const candidate = count - (reordered ? 1 : 0);
            const after = Number(new URL(req.url!, 'http://fixture').searchParams.get('after_seq') ?? 0);
            const messages = latest
                ? Array.from({ length: Math.min(candidate, 150) }, (_, i) => ({ seq: candidate - i, content }))
                : Array.from({ length: Math.min(count - after, 100) }, (_, i) => ({ seq: after + i + 1, content }));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ messages, hasMore: !latest && after + messages.length < count }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        Object.defineProperty(configuration, 'serverUrl', { value: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
        try {
            const state = chat();
            state.legacyPending = true;
            const result = await readNativeChatHistory(state, credentials);
            expect(result.seq).toBe(count);
            expect(requested).toEqual(['/v1/sessions/original-chat/messages', `/v3/sessions/original-chat/messages?after_seq=${count - (reordered ? 1 : 0)}&limit=100`]);
            expect(state.inputSeq).toBe(0);
            expect(state.legacyPending).toBe(true);
        } finally {
            Object.defineProperty(configuration, 'serverUrl', { value: previousUrl });
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    it('reads paginated encrypted history but does not consume phone input; errors retain the checkpoint', async () => {
        const previousUrl = configuration.serverUrl;
        const requested: string[] = [];
        let fail = false;
        const server = createServer((req, res) => {
            if (fail) { res.writeHead(503); res.end('{}'); return; }
            requested.push(req.url!);
            const second = req.url!.includes('after_seq=3');
            const envelope = createEnvelope('agent', { t: 'text', text: 'saved' }, { id: 'saved' });
            const body = second ? { role: 'session', content: envelope } : { role: 'user', content: { type: 'text', text: 'queued' } };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ messages: [{ seq: second ? 4 : 3, content: { t: 'encrypted', c: encodeBase64(encrypt(new Uint8Array(32).fill(3), 'legacy', body)) } }], hasMore: !second }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        Object.defineProperty(configuration, 'serverUrl', { value: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
        try {
            const state = chat();
            const directory = home();
            state.inputSeq = 1;
            writeNativeChat(state, directory);
            const before = readFileSync(join(directory, 'native-chats', `${threadId}.json`));
            const result = await readNativeChatHistory(state, credentials);
            expect(result.seq).toBe(4);
            expect(result.envelopes.map(value => value.id)).toEqual(['saved']);
            expect(requested).toHaveLength(2);
            expect(state.inputSeq).toBe(1);
            fail = true;
            await expect(readNativeChatHistory(state, credentials)).rejects.toThrow();
            expect(readFileSync(join(directory, 'native-chats', `${threadId}.json`))).toEqual(before);
        } finally {
            Object.defineProperty(configuration, 'serverUrl', { value: previousUrl });
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
});
