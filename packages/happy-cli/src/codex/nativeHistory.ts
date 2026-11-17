/** Backfill a frozen pre-attachment history range without gating the live session. */
import type { CodexAppServerClient } from './codexAppServerClient';
import type { ThreadTurn } from './codexAppServerTypes';

export async function syncNativeHistory(opts: {
    client: Pick<CodexAppServerClient, 'listThreadTurns'>;
    threadId: string;
    boundaryId: string | null;
    afterTurnId?: string;
    signal: AbortSignal;
    publishTurn: (turn: ThreadTurn) => Promise<void>;
}): Promise<number> {
    if (opts.boundaryId === null) return 0;
    if (opts.afterTurnId === opts.boundaryId) return 0;
    if (opts.afterTurnId) {
        // Only read turns added since the last confirmed history delivery.
        // Freeze at boundaryId even if live input has already made a newer turn.
        const pending: ThreadTurn[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        let reachedBoundary = false;
        do {
            opts.signal.throwIfAborted();
            const page = await opts.client.listThreadTurns({ threadId: opts.threadId, cursor, sortDirection: 'desc', itemsView: 'full' });
            for (const turn of page.data) {
                if (turn.id === opts.boundaryId) reachedBoundary = true;
                if (turn.id === opts.afterTurnId) {
                    if (!reachedBoundary) throw new Error('Native history boundary changed');
                    for (const item of pending.reverse()) {
                        opts.signal.throwIfAborted();
                        await opts.publishTurn(item);
                    }
                    return pending.length;
                }
                if (reachedBoundary) pending.push(turn);
            }
            cursor = page.nextCursor ?? undefined;
            if (cursor && seen.has(cursor)) throw new Error('Codex history pagination did not advance');
            if (cursor) seen.add(cursor);
        } while (cursor);
        throw new Error('Previously delivered native history boundary is missing');
    }
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
