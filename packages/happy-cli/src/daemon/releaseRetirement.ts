import { lstatSync, readFileSync, realpathSync, linkSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

export function managedRelease(bundleRoot: string): string | undefined {
    const release = process.env.HAPPY_RELEASE_ROOT;
    if (!release || !/^[0-9a-f]{64}$/.test(basename(release))) return;
    try {
        if (realpathSync(release) === release && realpathSync(bundleRoot) === join(release, 'node_modules', 'happy')) return release;
    } catch { /* An unverified installation keeps its daemon. */ }
    return undefined;
}

/** Only a locally armed, quiescent daemon may relinquish machine ownership. */
export class ReleaseRetirement {
    private active = 0;
    private draining = false;

    constructor(private profile: string, readonly release: string | undefined) {}

    run<T extends unknown[]>(handler: (...args: T) => Promise<SpawnSessionResult>) {
        return async (...args: T): Promise<SpawnSessionResult> => {
            if (this.draining) return { type: 'error', errorMessage: 'Daemon upgrade in progress. Retry after reconnecting.' };
            this.active++;
            try { return await handler(...args); } finally { this.active--; }
        };
    }

    get acceptingRegistrations(): boolean { return !this.draining; }

    prepare(token: string, busy: boolean, stop: () => void): 'deferred' | 'accepted' {
        if (!this.release || this.draining || this.active || busy) return 'deferred';
        try {
            const file = join(this.profile, 'release-request.json');
            const info = lstatSync(file);
            if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return 'deferred';
            const request = JSON.parse(readFileSync(file, 'utf8'));
            if (request.token !== token || request.pid !== process.pid || request.source !== this.release) return 'deferred';
            // The installer can resume an accepted handoff after a crash.
            linkSync(file, join(this.profile, 'release-accepted.json'));
        } catch { return 'deferred'; }
        this.draining = true;
        setTimeout(stop, 50);
        return 'accepted';
    }
}
