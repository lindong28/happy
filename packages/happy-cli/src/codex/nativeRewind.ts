/** Codex owns history; this checkpoint only projects its discarded turns onto Happy. */
import { z } from 'zod';
import type { ThreadTurn } from './codexAppServerTypes';

const sequence = z.number().int().nonnegative();
export const nativeRewindProjectionSchema = z.object({
    version: z.literal(1),
    legacyThroughSeq: sequence,
    legacyInputSeq: sequence,
    discardedTurnIds: z.array(z.string()),
    discardedCallIds: z.array(z.string()).default([]),
    discardedInputRanges: z.array(z.tuple([sequence, sequence])),
});
export type NativeRewindProjection = z.infer<typeof nativeRewindProjectionSchema>;
export const nativeRewindIntentSchema = z.object({
    beforeTurnId: z.string().min(1),
    turnIds: z.array(z.string()),
    callIds: z.array(z.string()).default([]),
    inputRanges: z.array(z.tuple([sequence, sequence])),
    retainedBoundary: z.string().nullable(),
});
export type NativeRewindIntent = z.infer<typeof nativeRewindIntentSchema>;
export type NativeRewindState = {
    rewind?: NativeRewindProjection;
    rewindIntent?: NativeRewindIntent;
    historyBoundary: string | null;
};

export function emptyNativeRewind(): NativeRewindProjection {
    return { version: 1, legacyThroughSeq: 0, legacyInputSeq: 0, discardedTurnIds: [], discardedCallIds: [], discardedInputRanges: [] };
}

export function nativeInputRange(clientId: unknown, sessionId: string): [number, number] | null {
    const prefix = `happy-native:${sessionId}:`;
    if (typeof clientId !== 'string' || !clientId.startsWith(prefix)) return null;
    const parts = clientId.slice(prefix.length).split(':');
    if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
    const first = Number(parts[0]), last = Number(parts[1]);
    return Number.isSafeInteger(first) && Number.isSafeInteger(last) && first > 0 && last >= first ? [first, last] : null;
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
    const result: [number, number][] = [];
    for (const [first, last] of [...ranges].sort((a, b) => a[0] - b[0])) {
        const previous = result.at(-1);
        if (previous && first <= previous[1] + 1) previous[1] = Math.max(last, previous[1]);
        else result.push([first, last]);
    }
    return result;
}

type Dependencies = {
    threadId: string;
    sessionId: string;
    state: NativeRewindState;
    persist: () => void;
    publish: (projection: NativeRewindProjection) => Promise<void>;
    list: (cursor: string | undefined, itemsView: 'full' | 'notLoaded', limit: number, timeoutMs: number) => Promise<{ data: ThreadTurn[]; nextCursor: string | null }>;
    revert: (beforeTurnId: string) => Promise<unknown>;
    active: () => boolean;
    historySettled: () => Promise<unknown>;
};

export class NativeRewindRecoveryError extends Error {
    constructor(options: ErrorOptions) {
        super('Phone history could not be synchronized. Resume this same session to retry; unsent phone inputs are preserved.', options);
    }
}

export class NativeRewindCoordinator {
    private operation: Promise<unknown> | undefined;
    private acceptingInputs = 0;
    constructor(private readonly deps: Dependencies) {}

    /** Serializes the acceptance boundary, not the duration of model generation. */
    async input<T>(send: () => Promise<T>): Promise<T> {
        if (this.operation) {
            // A rejected rewind must not discard an input that was queued behind it.
            try { await this.operation; } catch { /* reconcile the durable intent below */ }
        }
        if (this.deps.state.rewindIntent) {
            try { await this.recover(); }
            catch (cause) { throw new NativeRewindRecoveryError({ cause }); }
        }
        this.acceptingInputs++;
        try { return await send(); } finally { this.acceptingInputs--; }
    }

    private async turnsUntil(target: string, deadline: number): Promise<ThreadTurn[]> {
        const turns: ThreadTurn[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
            const page = await this.deps.list(cursor, 'notLoaded', 100, this.readTimeout(deadline));
            turns.push(...page.data);
            const index = turns.findIndex(turn => turn.id === target);
            if (index >= 0 && (index < turns.length - 1 || !page.nextCursor)) return turns.slice(0, index + 2);
            cursor = page.nextCursor ?? undefined;
            if (cursor && cursors.has(cursor)) throw new Error('Codex history returned a repeated cursor.');
            if (cursor) cursors.add(cursor);
        } while (cursor);
        return turns;
    }

    private readTimeout(deadline: number): number {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Reading Codex rewind history timed out.');
        return Math.min(30_000, remaining);
    }

    private async prepareIntent(beforeTurnId: string): Promise<NativeRewindIntent> {
        const deadline = Date.now() + 60_000;
        const turns = await this.turnsUntil(beforeTurnId, deadline);
        const index = turns.findIndex(turn => turn.id === beforeTurnId);
        if (index < 0) throw new Error('The selected Codex turn is no longer in this session.');
        const turnIds = turns.slice(0, index + 1).map(turn => turn.id);
        const intent: NativeRewindIntent = {
            beforeTurnId, turnIds, retainedBoundary: turns[index + 1]?.id ?? null, callIds: [], inputRanges: [],
        };
        let offset = 0, pageSize = 8;
        let cursor: string | undefined;
        while (offset < turnIds.length) {
            const limit = Math.min(pageSize, turnIds.length - offset);
            let page;
            try {
                page = await this.deps.list(cursor, 'full', limit, this.readTimeout(deadline));
            } catch (error) {
                if (limit === 1 || Date.now() >= deadline) throw error;
                // Retry only the read, at the same cursor, without the large payload.
                pageSize = 1;
                continue;
            }
            if (!page.data.length || page.data.length > limit) throw new Error('Invalid Codex history page.');
            for (const turn of page.data) {
                if (turn.id !== turnIds[offset++]) throw new Error('Codex history changed while preparing rewind.');
                for (const item of turn.items) {
                    intent.callIds.push(`${this.deps.threadId}:${item.id}`);
                    const range = nativeInputRange((item as { clientId?: unknown }).clientId, this.deps.sessionId);
                    if (range) intent.inputRanges.push(range);
                }
            }
            cursor = page.nextCursor ?? undefined;
            if (!cursor && offset < turnIds.length) throw new Error('Codex history ended before the selected turn.');
        }
        return intent;
    }

    private async commit(intent: NativeRewindIntent): Promise<void> {
        const state = this.deps.state;
        const previous = state.rewind ?? emptyNativeRewind();
        state.rewind = {
            ...previous,
            discardedTurnIds: [...new Set([...previous.discardedTurnIds, ...intent.turnIds])],
            discardedCallIds: [...new Set([...previous.discardedCallIds, ...intent.callIds])],
            discardedInputRanges: mergeRanges([...previous.discardedInputRanges, ...intent.inputRanges]),
        };
        state.historyBoundary = intent.retainedBoundary;
        this.deps.persist(); // Keep intent until the relay has acknowledged the projection.
        await this.publishPending();
    }

    private async publishPending(): Promise<void> {
        const state = this.deps.state;
        await this.deps.publish(state.rewind!);
        delete state.rewindIntent;
        this.deps.persist();
    }

    async recover(): Promise<void> {
        if (this.operation) { await this.operation; return; }
        const work = async () => {
            const intent = this.deps.state.rewindIntent;
            if (!intent) return;
            // commit() persists the projection and boundary together before waiting
            // for the relay. This covers checkpoints written by older workers too.
            const state = this.deps.state;
            if (state.historyBoundary === intent.retainedBoundary && state.rewind?.discardedTurnIds.includes(intent.beforeTurnId)) {
                await this.publishPending();
                return;
            }
            const turns = await this.turnsUntil(intent.beforeTurnId, Date.now() + 60_000);
            if (turns.some(turn => turn.id === intent.beforeTurnId)) {
                // Native mutation did not happen. Do not replay it on restart.
                delete this.deps.state.rewindIntent;
                this.deps.persist();
            } else {
                await this.commit(intent);
            }
        };
        this.operation = work();
        try { await this.operation; } finally { this.operation = undefined; }
    }

    async revert(params: Record<string, unknown>): Promise<unknown> {
        if (params.threadId !== this.deps.threadId || typeof params.beforeTurnId !== 'string' || !params.beforeTurnId) {
            throw new Error('Rewind requires a turn in this terminal’s Codex session.');
        }
        if (this.operation || this.acceptingInputs || this.deps.active()) {
            throw new Error('Codex is still working or processing another rewind. Interrupt the current turn and try again.');
        }
        await this.recover();
        // recover yields; reserve the operation before any further asynchronous work.
        if (this.operation || this.acceptingInputs || this.deps.active()) throw new Error('Codex is busy; try rewind again when the turn has stopped.');
        const beforeTurnId = params.beforeTurnId;
        const work = async () => {
            await this.deps.historySettled();
            let intent: NativeRewindIntent;
            try {
                intent = await this.prepareIntent(beforeTurnId);
            } catch (cause) {
                const reason = cause instanceof Error ? cause.message : 'History unavailable';
                throw new Error(`Could not prepare rewind to turn ${beforeTurnId}; rewind was not applied. ${reason} Reopen the history picker and select the same prompt to retry.`, { cause });
            }
            this.deps.state.rewindIntent = intent;
            this.deps.persist();
            let result: unknown;
            try { result = await this.deps.revert(beforeTurnId); }
            catch (error) {
                const remaining = await this.turnsUntil(beforeTurnId, Date.now() + 60_000);
                if (remaining.some(turn => turn.id === beforeTurnId)) {
                    delete this.deps.state.rewindIntent;
                    this.deps.persist();
                } else {
                    await this.commit(intent);
                }
                throw error; // Unknown RPC result is never converted into a fabricated native response.
            }
            await this.commit(intent);
            return result;
        };
        this.operation = work();
        try { return await this.operation; } finally { this.operation = undefined; }
    }
}
