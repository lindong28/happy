import { expect, it, vi } from 'vitest';
import { emptyNativeRewind, nativeInputRange, NativeRewindCoordinator, type NativeRewindState } from './nativeRewind';
import type { ThreadTurn } from './codexAppServerTypes';
import { nativePhoneInputId } from './nativeChat';

function fixture() {
    const state: NativeRewindState = { rewind: emptyNativeRewind(), historyBoundary: 'c' };
    let turns: ThreadTurn[] = [
        { id: 'c', items: [{ id: 'input', type: 'userMessage', clientId: nativePhoneInputId('chat', [4, 7]) }] },
        { id: 'b', items: [] }, { id: 'a', items: [] },
    ];
    const persisted: NativeRewindState[] = [];
    const deps = {
        threadId: 'thread', sessionId: 'chat', state,
        persist: () => { persisted.push(structuredClone(state)); },
        publish: vi.fn(async () => {}),
        list: vi.fn(async (cursor?: string) => {
            const index = cursor ? Number(cursor) : 0;
            return { data: turns.slice(index, index + 1), nextCursor: index + 1 < turns.length ? String(index + 1) : null };
        }),
        revert: vi.fn(async (before: string) => {
            turns = turns.slice(turns.findIndex(turn => turn.id === before) + 1);
            return { thread: { id: 'thread', turns: [] } };
        }),
        active: () => false, historySettled: async () => {},
    };
    return { state, deps, persisted, coordinator: new NativeRewindCoordinator(deps), turns: () => turns };
}

it('persists precise suffix and phone input ranges before native mutation, then waits for relay acknowledgement', async () => {
    const f = fixture();
    f.deps.revert.mockImplementationOnce(async () => {
        expect(f.persisted.at(-1)?.rewindIntent?.turnIds).toEqual(['c', 'b']);
        return { thread: { id: 'thread', turns: [] } };
    });
    f.deps.publish.mockImplementationOnce(async () => { expect(f.state.rewindIntent).toBeDefined(); });
    expect(await f.coordinator.revert({ threadId: 'thread', beforeTurnId: 'b' })).toEqual({ thread: { id: 'thread', turns: [] } });
    expect(f.state.rewind).toEqual({ ...emptyNativeRewind(), discardedTurnIds: ['c', 'b'], discardedCallIds: ['thread:input'], discardedInputRanges: [[4, 7]] });
    expect(f.state.historyBoundary).toBe('a');
    expect(f.state.rewindIntent).toBeUndefined();
});

it('rejects another thread, missing target and an active turn without mutation', async () => {
    const f = fixture();
    await expect(f.coordinator.revert({ threadId: 'other', beforeTurnId: 'b' })).rejects.toThrow();
    await expect(f.coordinator.revert({ threadId: 'thread', beforeTurnId: 'missing' })).rejects.toThrow();
    f.deps.active = () => true;
    await expect(f.coordinator.revert({ threadId: 'thread', beforeTurnId: 'b' })).rejects.toThrow();
    expect(f.deps.revert).not.toHaveBeenCalled();
    expect(f.persisted).toEqual([]);
});

it('does not change the phone after a native rejection or replay that rejection on resume', async () => {
    const f = fixture();
    f.deps.revert.mockRejectedValueOnce(new Error('legacy history unsupported'));
    await expect(f.coordinator.revert({ threadId: 'thread', beforeTurnId: 'b' })).rejects.toThrow('legacy');
    await new NativeRewindCoordinator(f.deps).recover();
    expect(f.deps.publish).not.toHaveBeenCalled();
    expect(f.state.rewind).toEqual(emptyNativeRewind());
    expect(f.deps.revert).toHaveBeenCalledTimes(1);
});

it('recovers a committed rewind after metadata failure without replaying native mutation', async () => {
    const f = fixture();
    f.deps.publish.mockRejectedValueOnce(new Error('relay disconnected'));
    await expect(f.coordinator.revert({ threadId: 'thread', beforeTurnId: 'b' })).rejects.toThrow('relay');
    expect(f.state.rewindIntent).toBeDefined();
    const resumed = new NativeRewindCoordinator(f.deps);
    const send = vi.fn(async () => 'new input');
    expect(await resumed.input(send)).toBe('new input');
    expect(f.turns().map(turn => turn.id)).toEqual(['a']);
    expect(f.state.rewindIntent).toBeUndefined();
    expect(f.deps.revert).toHaveBeenCalledTimes(1);
    expect(f.deps.publish).toHaveBeenCalledTimes(2);
});

it('reconciles a lost native response and preserves inputs queued behind rewind', async () => {
    const f = fixture();
    const apply = f.deps.revert.getMockImplementation()!;
    let release!: () => void;
    f.deps.revert.mockImplementationOnce(async before => {
        await new Promise<void>(resolve => { release = resolve; });
        await apply(before);
        throw new Error('response lost');
    });
    const rewind = f.coordinator.revert({ threadId: 'thread', beforeTurnId: 'b' });
    const rejected = expect(rewind).rejects.toThrow('response lost');
    await vi.waitFor(() => expect(release).toBeDefined());
    const send = vi.fn(async () => 'queued');
    const pending = f.coordinator.input(send);
    await expect(f.coordinator.revert({ threadId: 'thread', beforeTurnId: 'a' })).rejects.toThrow('working');
    expect(send).not.toHaveBeenCalled();
    release();
    await rejected;
    expect(await pending).toBe('queued');
    expect(f.state.rewind?.discardedTurnIds).toEqual(['c', 'b']);
    expect(f.deps.revert).toHaveBeenCalledTimes(1);
});

it('supports repeated rewind to the first turn and validates the input ID producer format', async () => {
    const f = fixture();
    await f.coordinator.revert({ threadId: 'thread', beforeTurnId: 'c' });
    await f.coordinator.revert({ threadId: 'thread', beforeTurnId: 'a' });
    expect(f.turns()).toEqual([]);
    expect(f.state.historyBoundary).toBeNull();
    expect(f.state.rewind?.discardedTurnIds).toEqual(['c', 'b', 'a']);
    expect(nativeInputRange(nativePhoneInputId('chat', [1, 5]), 'chat')).toEqual([1, 5]);
    expect(nativeInputRange(nativePhoneInputId('chat'), 'chat')).toBeNull();
    expect(nativeInputRange(nativePhoneInputId('other', [1, 5]), 'chat')).toBeNull();
    expect(nativeInputRange('happy-native:chat:5:1:id', 'chat')).toBeNull();
});
