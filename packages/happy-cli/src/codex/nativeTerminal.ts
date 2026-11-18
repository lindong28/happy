/** Optional terminal-title integration. No app-server ownership or task mutation. */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';

export type NativeTerminal = { file: string; hook: string; cwd: string; close: () => Promise<void> };
async function privateDirectory(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('Native terminal directory must be private and owned by this user');
}
function owner(pid: number): { tty: string; start: string } {
    const options = { encoding: 'utf8' as const, timeout: 800, env: { ...process.env, LC_ALL: 'C' } };
    const tty = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], options).trim();
    const start = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], options).replace(/\n$/, '');
    return { tty: '/dev/' + tty, start };
}
export async function registerNativeTerminal(directory: string, threadId: string, ownerPid = process.pid): Promise<NativeTerminal | null> {
    const hook = process.env.HAPPY_NATIVE_TITLE_HOOK;
    if (!hook) return null;
    await privateDirectory(directory);
    const ready = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'));
    if (ready.threadId !== threadId) throw new Error('Native terminal thread identity differs from backend');
    const identity = owner(ownerPid);
    if (!(await stat(identity.tty).catch(() => null))?.isCharacterDevice() || !identity.start) throw new Error('Native foreground has no verifiable terminal');
    const dir = join(directory, 'terminal-bindings');
    await mkdir(dir, { mode: 0o700, recursive: true });
    await privateDirectory(dir);
    // A crashed foreground cannot run finally. Prune only private records whose
    // owner is definitely absent; unknown process observations remain untouched.
    for (const name of await readdir(dir)) {
        if (!name.endsWith('.json')) continue;
        const stale = join(dir, name);
        try {
            const handle = await open(stale, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            let row: any;
            try { const info = await handle.stat(); if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 16384) continue; row = JSON.parse(await handle.readFile('utf8')); }
            finally { await handle.close(); }
            if (!Number.isSafeInteger(row.owner_pid) || row.owner_pid <= 1) continue;
            try { process.kill(row.owner_pid, 0); }
            catch (error: any) {
                if (error.code === 'ESRCH') { await unlink(stale); await unlink(stale + '.revision').catch(() => undefined); }
            }
        } catch { /* A foreign or concurrently removed record is never taken over. */ }
    }
    const id = randomUUID(), file = join(dir, id + '.json');
    const row = { schema_version: 1, thread_id: threadId, owner_pid: ownerPid, owner_started_at: identity.start, tty: identity.tty, initial_revision: id,
        terminal: { term_program: process.env.TERM_PROGRAM ?? '', ghostty: !!process.env.GHOSTTY_RESOURCES_DIR,
            remote: !!(process.env.SSH_TTY || process.env.SSH_CONNECTION), tmux: process.env.TMUX ?? '', tmux_pane: process.env.TMUX_PANE ?? '' } };
    const pending = file + '.pending';
    await writeFile(file + '.revision', id, { mode: 0o600, flag: 'wx' });
    try {
        await writeFile(pending, JSON.stringify(row) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(pending, file);
    } catch (error) {
        await unlink(pending).catch(() => undefined); await unlink(file + '.revision').catch(() => undefined); throw error;
    }
    return { file, hook, cwd: typeof ready.cwd === 'string' ? ready.cwd : process.cwd(), close: async () => {
        // Removing the record invalidates live, delayed and periodic consumers.
        await unlink(file).catch((error: any) => { if (error.code !== 'ENOENT') throw error; });
        await unlink(file + '.revision').catch((error: any) => { if (error.code !== 'ENOENT') throw error; });
    } };
}
export function nativeTitleState(status: unknown): 'busy' | 'idle' | null {
    if (!status || typeof status !== 'object') return null;
    const value = status as { type?: string; activeFlags?: string[] };
    if (value.type === 'idle') return 'idle';
    if (value.type !== 'active' || !Array.isArray(value.activeFlags)) return null;
    return value.activeFlags.some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') ? 'idle' : 'busy';
}
export async function readNativeTitleState(socketPath: string, threadId: string): Promise<'busy' | 'idle' | null> {
    // One local read per attachment, no retry/resume and no lifecycle-owning client.
    return await new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 1600 });
        let settled = false;
        const finish = (error: Error | null, value: 'busy' | 'idle' | null = null) => {
            if (settled) return; settled = true; clearTimeout(timer); socket.terminate();
            if (error) reject(error); else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error('Native terminal status read timed out')), 1600);
        socket.on('error', error => finish(error));
        socket.on('close', () => { if (!settled) finish(new Error('Native terminal status connection closed')); });
        socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'happy-terminal-title', version: '1' }, capabilities: { experimentalApi: true } } })));
        socket.on('message', data => {
            try {
                const message = JSON.parse(data.toString());
                if (message.id !== 1 && message.id !== 2) return;
                if (message.error) { finish(new Error('Native terminal status request rejected')); return; }
                if (message.id === 1) {
                    socket.send(JSON.stringify({ method: 'initialized' }));
                    socket.send(JSON.stringify({ id: 2, method: 'thread/read', params: { threadId, includeTurns: false } }));
                } else if (message.result?.thread?.id === threadId) finish(null, nativeTitleState(message.result.thread.status));
                else finish(new Error('Native terminal status response has another thread identity'));
            } catch { finish(new Error('Native terminal status response is invalid')); }
        });
    });
}
export async function syncNativeTerminal(binding: NativeTerminal, directory: string, threadId: string): Promise<void> {
    const state = await readNativeTitleState(join(directory, 'f.sock'), threadId);
    if (!state) throw new Error('Native terminal status is unknown');
    await new Promise<void>((resolve, reject) => {
        const child = spawn('bash', [binding.hook, state], { env: { ...process.env, HAPPY_NATIVE_MOBILE_DIR: directory,
            HAPPY_NATIVE_TITLE_INITIAL_BINDING: binding.file }, cwd: binding.cwd, stdio: ['pipe', 'ignore', 'pipe'] });
        const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
        child.stderr?.on('data', data => process.stderr.write(data));
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('Native terminal title synchronization failed')); });
        child.stdin!.end(JSON.stringify({ session_id: threadId, hook_event_name: 'SessionStart' }));
    });
}
