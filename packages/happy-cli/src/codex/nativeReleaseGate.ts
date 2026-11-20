/** Atomically reserve the idle worker without fencing input during inspection.
 * A connection or input arriving while awaiting the backend invalidates the observation.
 */
export class NativeReleaseGate {
    private revision = 0;
    private frontends = 0;
    private probing = false;
    frozen = false;
    private deferred?: () => Promise<boolean>;
    private timer?: NodeJS.Timeout;
    private checking = false;

    /** Only an actual maintenance request arms a retry. Recheck after input or
     * attachment changes, with a slower fallback for the relay's async flush.
     */
    retryWhenIdle(check: () => Promise<boolean>) {
        this.deferred = check;
        this.schedule(1000);
    }

    cancelRetry() {
        this.deferred = undefined;
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    private schedule(ms: number) {
        if (!this.deferred || this.frozen || this.checking) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(async () => {
            const check = this.deferred;
            if (!check) return;
            this.checking = true;
            try {
                if (!this.frontends && !this.probing && await check() && this.deferred === check) this.deferred = undefined;
            } catch { if (this.deferred === check) this.deferred = undefined; } // Fall back to the registered periodic owner.
            finally { this.checking = false; this.schedule(60_000); }
        }, ms);
        this.timer.unref();
    }

    changed() { this.revision++; this.schedule(1000); }

    attach(): (() => void) | null {
        if (this.frozen) return null;
        this.frontends++;
        this.changed();
        return () => { this.frontends--; this.changed(); };
    }

    reserve(localIdle: () => boolean, backendIdle: () => Promise<boolean>, onCommit?: () => void): Promise<boolean> {
        return this.inspectIdle(localIdle, backendIdle, () => {
            onCommit?.();
            this.frozen = true;
            this.cancelRetry();
        });
    }

    async inspectIdle(localIdle: () => boolean, backendIdle: () => Promise<boolean>, onCommit?: () => void): Promise<boolean> {
        if (this.probing || this.frozen || this.frontends || !localIdle()) return false;
        this.probing = true;
        const observed = this.revision;
        try {
            if (!await backendIdle() || this.revision !== observed || this.frontends || !localIdle()) return false;
            onCommit?.();
            return true;
        } finally { this.probing = false; }
    }
}

export function idleBackendEvidence(threadId: string, thread: any, goal: any, terminals: any, loaded: any): boolean {
    return thread?.id === threadId && thread.status?.type === 'idle'
        && (!('activeFlags' in thread.status) || (Array.isArray(thread.status.activeFlags) && thread.status.activeFlags.length === 0))
        && (goal?.goal === null || goal?.goal?.status === 'complete')
        && Array.isArray(terminals?.data) && terminals.data.length === 0 && terminals.nextCursor == null
        && Array.isArray(loaded?.data) && loaded.data.length === 1 && loaded.data[0] === threadId && loaded.nextCursor == null;
}
