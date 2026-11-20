import { spawn } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { closeSync, openSync, linkSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { validateNativeMobileDirectory } from './nativeMobileTransport';
import { readNativeTitleState } from './nativeTerminal';
import type { NativeReleaseGate } from './nativeReleaseGate';

const releaseName = /^[a-f0-9]{64}$/;
const entry = (release: string) => join(release, 'node_modules/happy/dist/index.mjs');
export type Identity = { threadId: string; sessionId: string; account: string; cwd: string };
export type Ready = Identity & { workerPid: number; backendPid: number; handoff: number; release: string };
export type Outcome = 'migrated' | 'restored' | 'deferred' | 'unverified' | 'failed';
const outcomes = new Set<Outcome>(['migrated', 'restored', 'deferred', 'unverified', 'failed']);

export async function checkedRelease(root: string, target: string): Promise<string> {
    if (!releaseName.test(target) || basename(root) !== 'releases') throw new Error('Unknown release location');
    const release = join(root, target);
    if (await realpath(entry(release)) !== entry(release)
        || (await lstat(join(release, 'complete'))).isSymbolicLink()
        || (await readFile(join(release, 'complete'), 'utf8')).trim() !== target) throw new Error('Incomplete release');
    const pkg = JSON.parse(await readFile(join(release, 'node_modules/happy/package.json'), 'utf8'));
    if (pkg.name !== 'happy' || pkg.happyReleaseHandoff !== 1) throw new Error('Worker handoff not supported');
    return release;
}

export async function currentWorkerRelease(): Promise<string | undefined> {
    const root = process.env.HAPPY_RELEASE_ROOT;
    if (!root || join(root, 'node_modules/happy') !== projectPath()) return undefined;
    return checkedRelease(dirname(root), basename(root));
}

type Intent = Identity & { version: 1; from: string; to: string; workerPid: number; backendPid: number };

export function recordRelease(directory: string, current: Ready, target: string): void {
    const marker: Intent = { version: 1, from: basename(current.release), to: basename(target), workerPid: current.workerPid,
        backendPid: current.backendPid, threadId: current.threadId, sessionId: current.sessionId, cwd: current.cwd, account: current.account };
    const name = join(directory, 'rollover.json');
    const temp = join(directory, 'rollover.tmp-' + process.pid);
    writeFileSync(temp, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    try { linkSync(temp, name); } finally { unlinkSync(temp); }
}

function live(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Unknown process identity');
    try { process.kill(pid, 0); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; throw e; }
}

export async function recoverIntent(directory: string, current: string, names: string[]): Promise<Outcome | null> {
    const marker = join(directory, 'rollover.json');
    let intent: Intent;
    try {
        const st = await lstat(marker);
        if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error('Unknown handoff owner');
        intent = JSON.parse(await readFile(marker, 'utf8'));
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    if (intent.version !== 1 || !releaseName.test(intent.to) || !releaseName.test(intent.from)
        || typeof intent.cwd !== 'string' || !intent.cwd.startsWith('/') || !intent.account || !intent.sessionId || !intent.threadId) return 'unverified';
    if (live(intent.workerPid) || live(intent.backendPid)) return 'deferred';
    for (const name of names) {
        const peerDir = join(dirname(directory), name);
        let peer: Ready;
        try { peer = await readWorker(peerDir); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
        if (peer.threadId !== intent.threadId || !live(peer.workerPid)) continue;
        if (!sameIdentity(peer, intent) || !live(peer.backendPid) || ![current, join(dirname(current), intent.from)].includes(peer.release)
            || !await readNativeTitleState(join(peerDir, 'f.sock'), peer.threadId)) return 'deferred';
        await unlink(marker);
        return peer.release === current ? 'migrated' : 'restored';
    }
    const old = join(dirname(current), intent.from);
    // Same per-account adapter as the interactive launcher. It validates the
    // pinned login before starting Codex; credentials never enter this record.
    const result = await replaceReleasedWorker(old, current, directory, intent);
    if (result === 'migrated' || result === 'restored') await unlink(marker);
    return result;
}

/** This hint asks the registered owner for a fresh serialized decision. */
export async function requestReleaseMaintenance(target: string): Promise<void> {
    const stable = process.env.HAPPY_RELEASE_MAINTENANCE_ENTRY;
    if (!stable || !isAbsolute(stable)) return;
    const owner = JSON.parse(await readFile(join(dirname(dirname(target)), 'owner.json'), 'utf8'));
    await checkedRelease(dirname(target), owner.sha256);
    const child = spawn(stable, ['--request-maintenance'], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
    });
}

function sameIdentity(a: Identity, b: Identity) {
    return a.threadId === b.threadId && a.sessionId === b.sessionId && a.account === b.account && a.cwd === b.cwd;
}

function matchingReady(a: Ready, b: Ready) {
    return sameIdentity(a, b) && a.workerPid === b.workerPid && a.backendPid === b.backendPid && a.release === b.release;
}

async function readWorker(directory: string): Promise<Ready> {
    await validateNativeMobileDirectory(directory);
    return JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'));
}

/** The private control socket belongs to the old worker and outlives its session.
 * The request stays open until the replacement is checked through its public frontend.
 */
export async function serveRelease(directory: string, current: Ready, gate: NativeReleaseGate, admit: (target: string) => Promise<Outcome>): Promise<Server> {
    const server = createServer(async (req, res) => {
        try {
            if (!['/attach', '/rollover'].includes(req.url ?? '') || req.method !== 'POST') throw new Error('Invalid request');
            let body = '';
            for await (const chunk of req) {
                body += chunk;
                if (body.length > 8192) throw new Error('Request too large');
            }
            const { expected, target } = JSON.parse(body);
            if (req.url === '/attach') {
                const detach = matchingReady(current, expected) ? gate.attach() : null;
                if (!detach) { res.writeHead(409); res.end(); return; }
                res.once('close', detach);
                res.writeHead(200, { 'X-Happy-Terminal-Pin': '1' });
                res.flushHeaders();
                return;
            }
            if (!matchingReady(current, expected) || basename(current.release) === target) throw new Error('Owner changed');
            const next = await checkedRelease(dirname(current.release), target);
            const owner = JSON.parse(await readFile(join(dirname(dirname(next)), 'owner.json'), 'utf8'));
            if (owner.sha256 !== target) throw new Error('Selected release changed');
            res.end(await admit(next));
        } catch { res.writeHead(409); res.end('unverified'); }
    });
    server.requestTimeout = 10_000;
    const socket = join(directory, 'm.sock');
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    await chmod(socket, 0o600);
    return server;
}

/** Follow an already committed handoff even when the adapter selected its old
 * directory just before ready.json disappeared. A durable chat identity is
 * required and only its own outstanding intent permits waiting.
 */
export async function movedTerminal(root: string, origin: string, identity: Identity): Promise<{ directory: string; ready: Ready } | null> {
    const deadline = Date.now() + 220_000;
    while (true) {
        for (const name of await readdir(root)) {
            const directory = join(root, name);
            if (directory === origin) continue;
            let ready: Ready;
            try { ready = await readWorker(directory); } catch { continue; }
            if (ready.handoff === 1 && sameIdentity(ready, identity) && live(ready.workerPid) && live(ready.backendPid)) return { directory, ready };
        }
        try {
            await validateNativeMobileDirectory(origin);
            const intent = JSON.parse(await readFile(join(origin, 'rollover.json'), 'utf8'));
            if (intent.version !== 1 || !sameIdentity(intent, identity)) return null;
        } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
        if (Date.now() >= deadline) return null;
        await delay(200);
    }
}

/** Hold the selection across terminal registration, title hooks and TUI spawn.
 * If maintenance won first, follow only a successor with the original full identity.
 */
export async function pinTerminal(directory: string, expected: Ready): Promise<{ directory: string; close: () => void }> {
    const original = directory;
    const deadline = Date.now() + 220_000;
    while (true) {
        try {
            const close = await new Promise<() => void>((resolve, reject) => {
                const req = request({ socketPath: join(directory, 'm.sock'), path: '/attach', method: 'POST' }, res => {
                    if (res.statusCode !== 200 || res.headers['x-happy-terminal-pin'] !== '1') { res.resume(); reject(new Error('Session handoff in progress')); return; }
                    req.setTimeout(0);
                    res.on('error', () => {});
                    resolve(() => req.destroy());
                });
                req.on('error', reject);
                req.setTimeout(2000, () => req.destroy(new Error('Session reservation timed out')));
                req.end(JSON.stringify({ expected }));
            });
            return { directory, close };
        } catch (error) {
            if (Date.now() >= deadline) throw error;
            let transferring = false;
            try { transferring = (await lstat(join(original, 'rollover.json'))).isFile(); }
            catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
            let found = false;
            for (const name of await readdir(dirname(original))) {
                const candidate = join(dirname(original), name);
                if (candidate === directory) continue;
                let peer: Ready;
                try { peer = await readWorker(candidate); } catch { continue; }
                if (!sameIdentity(expected, peer) || peer.handoff !== 1 || !live(peer.workerPid)) continue;
                directory = candidate; expected = peer; found = true; break;
            }
            if (!found && !transferring) throw error;
            await delay(200);
        }
    }
}

function askOwner(directory: string, expected: Ready, target: string): Promise<Outcome> {
    return new Promise(resolve => {
        const req = request({ socketPath: join(directory, 'm.sock'), path: '/rollover', method: 'POST' }, res => {
            let reply = '';
            res.on('data', data => { reply += data; });
            res.on('end', () => resolve(outcomes.has(reply as Outcome) ? reply as Outcome : 'unverified'));
            res.on('error', () => resolve('unverified'));
        });
        req.setTimeout(235_000, () => req.destroy());
        req.on('error', () => resolve('unverified'));
        req.end(JSON.stringify({ expected, target }));
    });
}

export async function rolloverWorkers(): Promise<void> {
    const current = await currentWorkerRelease();
    if (!current) throw new Error('Run maintenance through the installed Happy Personal entry');
    const root = join(configuration.happyHomeDir, 'native');
    const counts = { current: 0, legacy: 0, deferred: 0, migrated: 0, restored: 0, failed: 0, unverified: 0 };
    let names: string[] = [];
    try { await validateNativeMobileDirectory(root); names = await readdir(root); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    for (const name of names) {
        const directory = join(root, name);
        try {
            await validateNativeMobileDirectory(directory);
            const recovery = await recoverIntent(directory, current, names);
            if (recovery) { counts[recovery]++; continue; }
            let expected: Ready;
            try { expected = await readWorker(directory); }
            catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
            if (expected.handoff !== 1) { counts.legacy++; continue; }
            if (expected.release === current) { counts.current++; continue; }
            if (dirname(expected.release) !== dirname(current)) { counts.deferred++; continue; }
            counts[await askOwner(directory, expected, basename(current))]++;
        } catch (e) {
            counts.unverified++;
        }
    }
    console.log(JSON.stringify(counts));
    if (counts.failed || counts.unverified || counts.restored) process.exitCode = 1;
}

/** The child asks its spawning worker, over the inherited IPC channel, before
 * publishing the frontend or dispatching the first queued phone turn.
 */
export async function activateStagedWorker(identity: Identity): Promise<void> {
    if (!process.env.HAPPY_HANDOFF_CHAT) return;
    if (!process.send || !process.connected || process.env.HAPPY_HANDOFF_CHAT !== identity.sessionId) throw new Error('Missing handoff owner');
    await new Promise<void>((resolve, reject) => {
        const finish = (ok: boolean) => {
            clearTimeout(timer); process.off('message', message); process.off('disconnect', disconnected);
            if (ok) resolve(); else reject(new Error('Worker activation cancelled'));
        };
        const message = (m: unknown) => finish(m === 'activate');
        const disconnected = () => finish(false);
        const timer = setTimeout(disconnected, 90_000);
        process.once('message', message); process.once('disconnect', disconnected);
        process.send!({ staged: identity });
    });
    delete process.env.HAPPY_HANDOFF_CHAT;
}

async function startWorker(release: string, directory: string, identity: Identity): Promise<'ready' | 'stopped' | 'unverified'> {
    const next = await mkdtemp(join(dirname(directory), 's-'));
    const log = openSync(join(next, 'worker.log'), 'a', 0o600);
    let child;
    try {
        child = spawn(process.execPath, ['--no-warnings', entry(release), 'codex', '--native-config', '--resume', identity.threadId, '--native-worker', next], {
            detached: true, stdio: ['ignore', log, log, 'ipc'], cwd: identity.cwd,
            env: { ...process.env, HAPPY_RELEASE_ROOT: release, HAPPY_NATIVE_MOBILE_DIR: next, HAPPY_HANDOFF_CHAT: identity.sessionId,
                HAPPY_CODEX_ACCOUNT_NAME: identity.account, HAPPY_CODEX_ACCOUNT_ENTRY: process.env.HAPPY_CODEX_ACCOUNT_ENTRY ?? join(homedir(), '.local/bin/codex-account') },
        });
    } finally { closeSync(log); }
    let stopped = false;
    let activated = false;
    child.once('error', () => { if (!child.pid) stopped = true; });
    child.once('exit', () => { stopped = true; });
    child.once('message', (msg: any) => {
        if (msg?.staged && sameIdentity(msg.staged, identity) && child.connected) {
            activated = true;
            child.send('activate', () => {});
        }
    });
    const deadline = Date.now() + 90_000;
    try {
        while (!stopped && Date.now() < deadline) {
            if (activated) {
                try {
                    const ready = await readWorker(next);
                    if (sameIdentity(ready, identity) && ready.workerPid === child.pid && ready.release === release
                        && await readNativeTitleState(join(next, 'f.sock'), identity.threadId)) return 'ready';
                } catch { /* Startup hasn't published its frontend yet. */ }
            }
            await delay(200);
        }
        if (!stopped && !activated) {
            // It has never been authorized to start a user turn. Stop further
            // activation first, then wait for actual exit before trying recovery.
            child.removeAllListeners('message');
            child.kill('SIGTERM');
            const stopDeadline = Date.now() + 5000;
            while (!stopped && Date.now() < stopDeadline) await delay(100);
        }
        return stopped ? 'stopped' : 'unverified';
    } finally { if (child.connected) child.disconnect(); child.unref(); }
}

export async function replaceReleasedWorker(old: string, next: string, directory: string, identity: Identity): Promise<Outcome> {
    const result = await startWorker(next, directory, identity).catch(() => 'stopped' as const);
    if (result === 'ready') return 'migrated';
    if (result !== 'stopped') return 'unverified';
    try { await checkedRelease(dirname(old), basename(old)); }
    catch { return 'failed'; }
    const restored = await startWorker(old, directory, identity);
    return restored === 'ready' ? 'restored' : restored === 'stopped' ? 'failed' : 'unverified';
}
