import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReleaseRetirement } from './releaseRetirement';
import { startDaemonControlServer } from './controlServer';

describe('release retirement through the real HTTP control server', () => {
    it('refuses uncertain, busy, registering or unarmed handoffs, then admits one quiescent handoff', async () => {
        const profile = mkdtempSync(join(tmpdir(), 'happy-release-'));
        const release = '/managed/releases/' + '1'.repeat(64);
        const gate = new ReleaseRetirement(profile, release);
        const token = 'a'.repeat(64);
        let shutdown = 0;
        let busy = true;
        let releaseSpawn!: () => void;
        const inProgress = gate.run(async () => {
            await new Promise<void>(done => { releaseSpawn = done; });
            return { type: 'success', sessionId: 'same-chat' };
        })();
        const server = await startDaemonControlServer({
            getChildren: () => [], spawnSession: gate.run(async () => ({ type: 'success', sessionId: 'new' })),
            stopSession: () => false, requestShutdown: () => {}, onHappySessionWebhook: () => {},
            acceptingRegistrations: () => gate.acceptingRegistrations,
            prepareRetirement: t => gate.prepare(t, busy, () => { shutdown++; }),
        });
        const post = (path: string, body: object) => fetch('http://127.0.0.1:' + server.port + path, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        const prepare = async (candidate = token) => (await (await post('/prepare-release-retirement', { token: candidate })).json() as { status: string }).status;
        try {
            expect(await prepare()).toBe('deferred');
            const request = { pid: process.pid, source: release, token, machine: 'same-machine' };
            writeFileSync(join(profile, 'release-request.json'), JSON.stringify(request), { mode: 0o600 });
            busy = false;
            expect(await prepare()).toBe('deferred');
            releaseSpawn();
            expect(await inProgress).toEqual({ type: 'success', sessionId: 'same-chat' });
            expect(await prepare('b'.repeat(64))).toBe('deferred');
            busy = true;
            expect(await prepare()).toBe('deferred');
            busy = false;
            expect(await prepare()).toBe('accepted');
            expect(JSON.parse(readFileSync(join(profile, 'release-accepted.json'), 'utf8'))).toEqual(request);
            expect(await prepare()).toBe('deferred');
            expect((await post('/spawn-session', { directory: profile })).status).toBe(500);
            expect((await post('/session-started', { sessionId: 'new', metadata: {} })).status).toBe(503);
            await new Promise(done => setTimeout(done, 75));
            expect(shutdown).toBe(1);
        } finally {
            await server.stop();
            rmSync(profile, { recursive: true, force: true });
        }
    });
});
