/** Backfill a frozen pre-attachment history range without gating the live session. */
import type { CodexAppServerClient } from './codexAppServerClient';
import type { ThreadTurn } from './codexAppServerTypes';

export async function syncNativeHistory(opts: {
    client: Pick<CodexAppServerClient, 'listThreadTurns'>;
    threadId: string;
    boundaryId: string | null;
    signal: AbortSignal;
    publishTurn: (turn: ThreadTurn) => Promise<void>;
}): Promise<number> {
    if (opts.boundaryId === null) return 0;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let turns = 0;
    do {
        opts.signal.throwIfAborted();
        const page = await opts.client.listThreadTurns({
            threadId: opts.threadId, cursor, sortDirection: 'asc', itemsView: 'full',
        });
        opts.signal.throwIfAborted();
        for (const turn of page.data) {
            await opts.publishTurn(turn);
            opts.signal.throwIfAborted();
            turns++;
            if (turn.id === opts.boundaryId) return turns;
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && seenCursors.has(cursor)) throw new Error('Codex history pagination did not advance');
        if (cursor) seenCursors.add(cursor);
    } while (cursor);
    throw new Error('Codex history ended before the captured resume boundary');
}
