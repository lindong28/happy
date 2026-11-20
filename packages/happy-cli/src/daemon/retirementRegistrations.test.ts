import { expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Metadata } from '@/api/types';

it('retains a registration past the normal retry window and re-registers the live session with its new daemon', async () => {
    const home = mkdtempSync(join(tmpdir(), 'happy-late-registration-'));
    vi.stubEnv('HAPPY_HOME_DIR', home);
    vi.stubEnv('HAPPY_SERVER_URL', 'http://127.0.0.1:2345');
    vi.resetModules();
    const { startDaemonControlServer } = await import('./controlServer');
    const { notifyDaemonSessionStarted } = await import('./controlClient');
    const { recoverRegistrations } = await import('./retirementRegistrations');
    const { readPersistedSessions } = await import('@/persistence');
    const server = 'http://127.0.0.1:2345';
    const machine = 'same-machine';
    writeFileSync(join(home, 'release-accepted.json'), JSON.stringify({ machine, server }), { mode: 0o600 });
    let ready = false;
    const arrivals: string[] = [];
    const control = await startDaemonControlServer({
        getChildren: () => [], stopSession: () => false, spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        requestShutdown: () => {}, acceptingRegistrations: () => ready,
        getConnectionStatus: () => ({ machineId: machine, serverUrl: server, connected: ready, cliVersion: 'test' }),
        onHappySessionWebhook: id => { arrivals.push(id); },
    });
    writeFileSync(join(home, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: control.port }));
    try {
        const metadata = { hostPid: process.pid, machineId: machine } as Metadata;
        const encryption = { encryptionKey: Buffer.alloc(32).toString('base64'), encryptionVariant: 'legacy' as const,
            seq: 1, metadataVersion: 1, agentStateVersion: 1 };
        const result = await notifyDaemonSessionStarted('late', metadata, encryption);
        expect(result.error).toBeDefined();
        expect(arrivals).toEqual([]);
        expect(readdirSync(join(home, 'release-registrations'))).toHaveLength(1);
        recoverRegistrations();
        expect(readPersistedSessions().late.encryptionKey).toBe(encryption.encryptionKey);
        expect(readdirSync(join(home, 'release-registrations'))).toEqual([]);
        expect(arrivals).toEqual([]);
        ready = true;
        await vi.waitFor(() => expect(arrivals).toEqual(['late']), { timeout: 4000 });
    } finally {
        await control.stop();
        rmSync(home, { recursive: true, force: true });
        vi.unstubAllEnvs();
    }
}, 10000);
