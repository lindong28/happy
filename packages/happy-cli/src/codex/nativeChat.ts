/** Native mobile chat identity. Written only by the UUID lease owner (or legacy preparation). */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import axios from 'axios';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { decodeBase64, decrypt, encodeBase64 } from '@/api/encryption';
import type { Metadata, Session } from '@/api/types';
import type { Credentials } from '@/persistence';
import { readPersistedSessions } from '@/persistence';
import { logger } from '@/ui/logger';
import { emptyNativeRewind, nativeRewindIntentSchema, nativeRewindProjectionSchema } from './nativeRewind';

const uuid = z.string().uuid();
const seq = z.number().int().nonnegative();
const chatSchema = z.object({
    version: z.literal(1),
    threadId: uuid,
    server: z.string(),
    identity: z.string(),
    sessionId: z.string().min(1),
    encryptionKey: z.string().refine(value => Buffer.from(value, 'base64').length === 32),
    encryptionVariant: z.enum(['legacy', 'dataKey']),
    metadataVersion: seq,
    agentStateVersion: seq,
    inputSeq: seq,
    historySeq: seq,
    historyBoundary: z.string().nullable(),
    account: z.string().optional(),
    cwd: z.string(),
    legacyPending: z.boolean(),
    legacyHistoryPending: z.boolean(),
    rewind: nativeRewindProjectionSchema.optional(),
    rewindIntent: nativeRewindIntentSchema.optional(),
});
export type NativeChat = z.infer<typeof chatSchema>;

function identity(credentials: Credentials): string {
    const key = credentials.encryption.type === 'legacy' ? credentials.encryption.secret : credentials.encryption.publicKey;
    return createHash('sha256').update(credentials.encryption.type).update(key).digest('hex');
}

function privatePath(path: string, directory: boolean) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
        || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) {
        throw new Error('Native chat state must be a private, owned file/directory (no symlinks).');
    }
}

function chatPath(threadId: string, home: string): string {
    uuid.parse(threadId);
    const directory = join(home, 'native-chats');
    if (existsSync(directory)) privatePath(directory, true);
    return join(directory, `${threadId}.json`);
}

export function readNativeChat(threadId: string, credentials: Credentials, home = configuration.happyHomeDir): NativeChat | null {
    const path = chatPath(threadId, home);
    if (!existsSync(path)) return null;
    privatePath(path, false);
    const chat = chatSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (chat.threadId !== threadId || chat.server !== configuration.serverUrl || chat.identity !== identity(credentials)) {
        throw new Error('Native chat belongs to a different server or Happy identity; refusing to create a replacement chat.');
    }
    return chat;
}

export function writeNativeChat(chat: NativeChat, home = configuration.happyHomeDir): void {
    chatSchema.parse(chat);
    const path = chatPath(chat.threadId, home);
    const directory = join(home, 'native-chats');
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    privatePath(directory, true);
    if (existsSync(path)) privatePath(path, false);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify(chat), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, path);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

export function createNativeChat(threadId: string, credentials: Credentials, session: Session): NativeChat {
    return {
        version: 1, threadId, server: configuration.serverUrl, identity: identity(credentials),
        sessionId: session.id, encryptionKey: encodeBase64(session.encryptionKey), encryptionVariant: session.encryptionVariant,
        metadataVersion: session.metadataVersion, agentStateVersion: session.agentStateVersion,
        inputSeq: 0, historySeq: 0, historyBoundary: null,
        rewind: emptyNativeRewind(),
        account: process.env.HAPPY_CODEX_ACCOUNT_NAME, cwd: process.cwd(), legacyPending: false, legacyHistoryPending: false,
    };
}

/** Snapshot the relay log. Never advances the input receipt except during approved legacy migration. */
export async function readNativeChatHistory(chat: NativeChat, credentials: Credentials, signal?: AbortSignal) {
    let afterSeq = chat.historySeq;
    const envelopes: SessionEnvelope[] = [];
    const deadline = Date.now() + 60_000;
    // Migration needs the cancellation boundary, not all old display history.
    // Start with v1's latest 150 messages, then confirm with seq-ordered v3:
    // createdAt order alone cannot prove that the maximum seq was included.
    let latestPage = chat.legacyPending;
    let pages = 0;
    while (true) {
        signal?.throwIfAborted();
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Native chat history snapshot exceeded 60000ms; retry the same resume command.');
        const response = await axios.get<{
            messages: { seq: number; content: { t: string; c: string } }[]; hasMore: boolean;
        }>(`${configuration.serverUrl}/${latestPage ? 'v1' : 'v3'}/sessions/${encodeURIComponent(chat.sessionId)}/messages`, {
            params: latestPage ? undefined : { after_seq: afterSeq, limit: 100 },
            headers: { Authorization: `Bearer ${credentials.token}` }, timeout: remaining, signal,
        });
        const previous = afterSeq;
        for (const message of response.data.messages) {
            afterSeq = Math.max(afterSeq, message.seq);
            if (message.content.t !== 'encrypted') throw new Error('Unexpected native chat message encoding');
            const body = decrypt(decodeBase64(chat.encryptionKey), chat.encryptionVariant, decodeBase64(message.content.c)) as { role?: string; content?: SessionEnvelope } | null;
            if (!body) throw new Error('Could not decrypt original native chat; refusing to replay input.');
            if (body.role === 'session' && body.content?.ev) envelopes.push(body.content);
        }
        pages++;
        logger.debug('[Codex native chat] History snapshot page', { latestPage, pages, messages: response.data.messages.length, seq: afterSeq });
        if (latestPage) { latestPage = false; continue; }
        if (!response.data.hasMore) return { seq: afterSeq, envelopes };
        if (afterSeq <= previous) throw new Error('Native chat history pagination did not advance');
    }
}

/** Old workers used random envelope/local IDs. Match their actual turn/event content as well. */
export function nativeHistoryKey(envelope: SessionEnvelope): string {
    const event = envelope.ev;
    // Generated attachment refs/timestamps differ across uploads; item identity is stable.
    const value = envelope.codexItemId ? ['item', envelope.codexItemId, event.t]
        : event.t === 'turn-start' || event.t === 'turn-end' ? [envelope.turn, event.t]
        : [envelope.turn, envelope.subagent, envelope.role, event];
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function unseenNativeHistory(envelopes: SessionEnvelope[], existing: SessionEnvelope[]): SessionEnvelope[] {
    const ids = new Set(existing.map(envelope => envelope.id));
    const keys = new Set(existing.map(nativeHistoryKey));
    // Legacy live agent text had neither stable ID nor codexItemId.
    const legacyText = new Map<string, number>();
    for (const envelope of existing) {
        if (!envelope.codexItemId && envelope.ev.t === 'text') {
            const key = JSON.stringify([envelope.turn, envelope.role, envelope.ev]);
            legacyText.set(key, (legacyText.get(key) ?? 0) + 1);
        }
    }
    return envelopes.filter(envelope => {
        if (ids.has(envelope.id) || keys.has(nativeHistoryKey(envelope))) return false;
        if (envelope.ev.t === 'text') {
            const key = JSON.stringify([envelope.turn, envelope.role, envelope.ev]);
            const count = legacyText.get(key) ?? 0;
            if (count > 0) { legacyText.set(key, count - 1); return false; }
        }
        return true;
    });
}

/** Called before stopping a verified old worker. Does not consume input or contact Codex. */
export function prepareLegacyNativeChat(threadId: string, directory: string, credentials: Credentials): 'current' | 'legacy' {
    if (readNativeChat(threadId, credentials)) return 'current';
    privatePath(directory, true);
    const readyPath = join(directory, 'ready.json');
    privatePath(readyPath, false);
    const ready = z.object({ threadId: uuid, workerPid: z.number().int().positive(), cwd: z.string() }).parse(JSON.parse(readFileSync(readyPath, 'utf8')));
    if (ready.threadId !== threadId) throw new Error('Legacy worker thread does not match the requested session.');
    const matches = Object.entries(readPersistedSessions()).filter(([, session]) => (
        session.metadata.hostPid === ready.workerPid && resolve(session.metadata.path) === resolve(ready.cwd)
        && session.metadata.codexNativeConfig === true
    ));
    if (matches.length !== 1) throw new Error('Cannot uniquely recover the original Happy chat key; old worker was not stopped.');
    const [sessionId, saved] = matches[0];
    writeNativeChat({
        version: 1, threadId, server: configuration.serverUrl, identity: identity(credentials), sessionId,
        encryptionKey: saved.encryptionKey, encryptionVariant: saved.encryptionVariant,
        metadataVersion: saved.metadataVersion, agentStateVersion: saved.agentStateVersion,
        inputSeq: 0, historySeq: 0, historyBoundary: null,
        account: saved.metadata.codexAccountName, cwd: ready.cwd, legacyPending: true, legacyHistoryPending: true,
    });
    return 'legacy';
}

/** Recover an inactive pre-checkpoint chat using locally retained keys and relay metadata. */
export async function discoverLegacyNativeChat(threadId: string, credentials: Credentials): Promise<NativeChat | null> {
    uuid.parse(threadId);
    const candidates = Object.entries(readPersistedSessions()).filter(([, saved]) => saved.metadata.codexNativeConfig === true);
    if (!candidates.length) return null;
    const keys = new Map(candidates);
    const matches: NativeChat[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const deadline = Date.now() + 30_000;
    do {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Original chat lookup exceeded 30000ms; no replacement chat was started.');
        const response = await axios.get<{ sessions: { id: string; metadata: string; metadataVersion: number; agentStateVersion: number }[]; nextCursor: string | null; hasNext: boolean }>(`${configuration.serverUrl}/v2/sessions`, {
            params: { limit: 200, cursor }, headers: { Authorization: `Bearer ${credentials.token}` }, timeout: remaining,
        });
        for (const raw of response.data.sessions) {
            const saved = keys.get(raw.id);
            if (!saved) continue;
            const metadata = decrypt(decodeBase64(saved.encryptionKey), saved.encryptionVariant, decodeBase64(raw.metadata)) as Metadata | null;
            if (!metadata) throw new Error('Cannot decrypt saved native chat metadata; original chat lookup is incomplete.');
            if (metadata.codexThreadId !== threadId || metadata.machineId !== saved.metadata.machineId) continue;
            const chat = createNativeChat(threadId, credentials, {
                id: raw.id, seq: 0, metadata, metadataVersion: raw.metadataVersion,
                agentState: null, agentStateVersion: raw.agentStateVersion,
                encryptionKey: decodeBase64(saved.encryptionKey), encryptionVariant: saved.encryptionVariant,
            });
            chat.cwd = metadata.path;
            chat.account = metadata.codexAccountName;
            chat.legacyPending = true;
            chat.legacyHistoryPending = true;
            matches.push(chat);
        }
        cursor = response.data.hasNext ? response.data.nextCursor ?? undefined : undefined;
        if (response.data.hasNext && (!cursor || cursors.has(cursor))) throw new Error('Original chat lookup pagination did not advance');
        if (cursor) cursors.add(cursor);
    } while (cursor);
    // Legacy mobile history may restart. Prefer the most recent matching card;
    // never change the underlying Codex thread or any other saved card.
    return matches[0] ?? null;
}

/** Client identity is recorded by Codex on userMessage items, including thread history. */
/** Versioned by shape: session:firstRelaySeq:lastRelaySeq:uuid; old UUID-only IDs remain recognizable. */
export function nativePhoneInputId(sessionId: string, range?: [number, number]): string {
    return `happy-native:${sessionId}:${range ? `${range[0]}:${range[1]}:` : ''}${randomUUID()}`;
}
export function isNativePhoneInput(item: { type: string; clientId?: string | null }, sessionId: string): boolean {
    return item.type === 'userMessage' && typeof item.clientId === 'string' && item.clientId.startsWith(`happy-native:${sessionId}:`);
}
