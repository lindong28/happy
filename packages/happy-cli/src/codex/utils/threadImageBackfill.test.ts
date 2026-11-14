import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@slopus/happy-wire';

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

vi.mock('@/configuration', () => ({
    configuration: { happyHomeDir: '/home/test/.happy' },
}));

import { buildCodexThreadBackfillEnvelopes, createCodexBackfillContext } from './threadImageBackfill';

const tempDirs: string[] = [];

async function makePngFile(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happy-codex-backfill-'));
    tempDirs.push(dir);
    const filePath = join(dir, name);
    await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    return filePath;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await rm(tempDirs.pop()!, { recursive: true, force: true });
    }
});

describe('buildCodexThreadBackfillEnvelopes', () => {
    it('does not map or upload further items when cancelled during image upload', async () => {
        const imagePath = await makePngFile('cancel.png');
        const abort = new AbortController();
        const upload = vi.fn(async () => {
            abort.abort();
            return createEnvelope('user', { t: 'text', text: 'uploaded' });
        });
        await expect(buildCodexThreadBackfillEnvelopes({
            thread: { turns: [{ id: 'old', items: [
                { type: 'userMessage', id: 'a', content: [{ type: 'localImage', path: imagePath }] },
                { type: 'userMessage', id: 'b', content: [{ type: 'localImage', path: imagePath }] },
            ] }] }, uploadLocalImage: upload, signal: abort.signal,
        })).rejects.toThrow();
        expect(upload).toHaveBeenCalledTimes(1);
    });

    it('keeps cross-turn collaboration context when history arrives in separate pages', async () => {
        const context = createCodexBackfillContext();
        const sessionSubagent = 'abcdefghijklmnopqrstuvwx';
        context.subagentTitles.set(sessionSubagent, 'Existing title');
        context.providerSubagentToSessionSubagent.set('child', sessionSubagent);
        const input = { id: 'later', status: 'completed', items: [{
            type: 'subAgentActivity', id: 'child-update', kind: 'started', agentThreadId: 'child',
        }] };
        const withContext = await buildCodexThreadBackfillEnvelopes({ thread: { turns: [input] }, context, uploadLocalImage: vi.fn() });
        const withoutContext = await buildCodexThreadBackfillEnvelopes({ thread: { turns: [input] }, uploadLocalImage: vi.fn() });
        expect(JSON.stringify(withContext)).toContain(sessionSubagent);
        expect(JSON.stringify(withoutContext)).not.toContain(sessionSubagent);
    });
    it.each(['inProgress', 'completed'] as const)('shows async answers without changing native input (%s)', async status => {
        const text = '<send_user_message_question_reply>\n' + JSON.stringify([
            { questionItemId: '["request_user_input_async","call",0]', question: 'Which device?', answer: 'Mac' },
            { questionItemId: '["request_user_input_async","call",1]', question: 'Details?', answer: 'a < b\nsecond line' },
        ]) + '\n</send_user_message_question_reply>';
        const item = { id: 'reply', type: 'userMessage' as const, content: [{ type: 'text' as const, text }] };
        const envelopes = await buildCodexThreadBackfillEnvelopes({
            thread: { turns: [{ id: 'turn', status, items: [item] }] },
            uploadLocalImage: vi.fn(),
        });
        expect(envelopes.find(envelope => envelope.role === 'user')?.ev).toEqual({
            t: 'text', text: 'Which device?\nMac\n\nDetails?\na < b\nsecond line',
        });
        expect(item.content[0].text).toBe(text);
    });

    it('inserts uploaded local image file envelopes before the matching user text', async () => {
        const imagePath = await makePngFile('input.png');
        const uploadLocalImage = vi.fn(async (_attachment, opts) => createEnvelope('user', {
            t: 'file',
            ref: 'uploaded-ref',
            name: 'codex-image-1.png',
            size: 9,
            mimeType: 'image/png',
        }, opts));

        const envelopes = await buildCodexThreadBackfillEnvelopes({
            thread: {
                turns: [{
                    id: 'turn-1',
                    startedAt: 100,
                    completedAt: 101,
                    status: 'completed',
                    items: [
                        {
                            id: 'user-1',
                            type: 'userMessage',
                            content: [
                                { type: 'text', text: 'inspect this' },
                                { type: 'localImage', path: imagePath },
                            ],
                        },
                        { id: 'agent-1', type: 'agentMessage', text: 'ok' },
                    ],
                }],
            },
            uploadLocalImage,
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'file',
            'text',
            'text',
            'turn-end',
        ]);
        expect(envelopes[1]).toMatchObject({
            role: 'user',
            id: 'user-1:image:1',
            time: 100_000,
            codexItemId: 'user-1',
            ev: { t: 'file', ref: 'uploaded-ref' },
        });
        expect(envelopes[2]).toMatchObject({
            role: 'user',
            codexItemId: 'user-1',
            ev: { t: 'text', text: 'inspect this' },
        });
        expect(uploadLocalImage).toHaveBeenCalledWith(expect.objectContaining({
            mimeType: 'image/png',
            name: 'codex-image-1.png',
        }), {
            id: 'user-1:image:1',
            time: 100_000,
            codexItemId: 'user-1',
        });

        const userMessagesInCreatedAtOrder = envelopes
            .filter((envelope) => envelope.role === 'user')
            .sort((a, b) => a.time - b.time);
        expect(userMessagesInCreatedAtOrder.map((envelope) => envelope.ev.t)).toEqual([
            'file',
            'text',
        ]);
    });

    it('backfills image-only user messages without inventing empty text', async () => {
        const imagePath = await makePngFile('only-image.png');
        const uploadLocalImage = vi.fn(async (_attachment, opts) => createEnvelope('user', {
            t: 'file',
            ref: 'uploaded-ref',
            name: 'codex-image-1.png',
            size: 9,
            mimeType: 'image/png',
        }, opts));

        const envelopes = await buildCodexThreadBackfillEnvelopes({
            thread: {
                turns: [{
                    id: 'turn-1',
                    startedAt: 100,
                    items: [{
                        id: 'user-image-only',
                        type: 'userMessage',
                        content: [{ type: 'localImage', path: imagePath }],
                    }],
                }],
            },
            uploadLocalImage,
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'file',
            'turn-end',
        ]);
    });

    it('skips missing local paths and URL images while preserving text', async () => {
        const uploadLocalImage = vi.fn();

        const envelopes = await buildCodexThreadBackfillEnvelopes({
            thread: {
                turns: [{
                    id: 'turn-1',
                    startedAt: 100,
                    items: [{
                        id: 'user-1',
                        type: 'userMessage',
                        content: [
                            { type: 'text', text: 'text survives' },
                            { type: 'localImage', path: '/path/that/does/not/exist.png' },
                            { type: 'image', url: 'https://example.test/image.png' },
                        ],
                    }],
                }],
            },
            uploadLocalImage,
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'text',
            'turn-end',
        ]);
        expect(uploadLocalImage).not.toHaveBeenCalled();
    });

    it('keeps active collab-agent turns open during image backfill replay', async () => {
        const envelopes = await buildCodexThreadBackfillEnvelopes({
            thread: {
                turns: [{
                    id: 'turn-active',
                    startedAt: 100,
                    status: 'inProgress',
                    items: [{
                        id: 'collab-active',
                        type: 'collabAgentToolCall',
                        tool: 'spawnAgent',
                        status: 'inProgress',
                        receiverThreadIds: ['provider-child-thread'],
                        prompt: 'Inspect auth flow',
                    }],
                }],
            },
            uploadLocalImage: vi.fn(),
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'tool-call-start',
            'start',
        ]);
    });
});
