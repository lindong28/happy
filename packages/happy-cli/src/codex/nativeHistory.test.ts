import { describe, expect, it } from 'vitest';
import { syncNativeHistory } from './nativeHistory';
import type { ThreadTurn } from './codexAppServerTypes';

const turn = (id: string): ThreadTurn => ({ id, items: [], status: 'completed' });

describe('native history boundary and lifetime', () => {
    it('waits for delivery and stops at the frozen boundary, excluding newer live turns', async () => {
        const abort = new AbortController();
        const published: string[] = [];
        const requested: (string | undefined)[] = [];
        let release!: () => void;
        const delivery = new Promise<void>(resolve => { release = resolve; });
        const running = syncNativeHistory({
            threadId: 'thread', boundaryId: 'old-2', signal: abort.signal,
            client: { listThreadTurns: async opts => {
                requested.push(opts.cursor);
                return opts.cursor ? { data: [turn('old-2'), turn('live')], nextCursor: 'newer' }
                    : { data: [turn('old-1')], nextCursor: 'second' };
            } },
            publishTurn: async value => { published.push(value.id); if (value.id === 'old-1') await delivery; },
        });
        await new Promise(resolve => setImmediate(resolve));
        expect(requested).toEqual([undefined]);
        release();
        await expect(running).resolves.toBe(2);
        expect(published).toEqual(['old-1', 'old-2']);
        expect(requested).toEqual([undefined, 'second']);
    });

    it('does not fetch an empty snapshot, even if new live turns now exist', async () => {
        let calls = 0;
        await expect(syncNativeHistory({ threadId: 't', boundaryId: null, signal: new AbortController().signal,
            client: { listThreadTurns: async () => { calls++; return { data: [turn('live')], nextCursor: null }; } },
            publishTurn: async () => { throw new Error('must not publish'); },
        })).resolves.toBe(0);
        expect(calls).toBe(0);
    });

    it.each(['read', 'publish'] as const)('does not continue after cancellation during %s', async phase => {
        const abort = new AbortController();
        let reads = 0, writes = 0;
        await expect(syncNativeHistory({ threadId: 't', boundaryId: 'last', signal: abort.signal,
            client: { listThreadTurns: async () => { reads++; if (phase === 'read') abort.abort(); return { data: [turn('old')], nextCursor: 'more' }; } },
            publishTurn: async () => { writes++; abort.abort(); },
        })).rejects.toThrow();
        expect(reads).toBe(1);
        expect(writes).toBe(phase === 'read' ? 0 : 1);
    });

    it('reports missing boundaries and stalled cursors instead of reporting completion', async () => {
        for (const nextCursor of [null, 'stalled']) {
            await expect(syncNativeHistory({ threadId: 't', boundaryId: 'missing', signal: new AbortController().signal,
                client: { listThreadTurns: async () => ({ data: [turn('old')], nextCursor }) },
                publishTurn: async () => {},
            })).rejects.toThrow(/history/);
        }
    });
});
