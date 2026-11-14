/** Native foreground launcher; the detached Happy worker owns the live session. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configuration } from '@/configuration';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { startNativeFrontendProxy } from './nativeMobileTransport';

type NativeReady = { threadId: string; workerPid: number; backendPid: number; account: string; cwd: string };

export async function validateNativeMobileDirectory(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
        throw new Error('Native mobile session directory must be private and owned by this user');
    }
    if (Buffer.byteLength(join(directory, 'f.sock')) > 100) throw new Error('HAPPY_HOME_DIR is too long for native mobile sockets');
}

export async function acquireNativeLease(threadId: string, backendPid: number, onLost: () => void): Promise<ChildProcess> {
    const entry = process.env.HAPPY_CODEX_ACCOUNT_ENTRY;
    if (!entry) throw new Error('Native mobile requires the updated codex-account launcher');
    const child = spawn(entry, ['_mobile-lease', threadId, String(backendPid)], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const lines = createInterface({ input: child.stdout! });
    // Preserve adapter diagnostics in worker.log, separate from the JSON readiness
    // protocol. Draining this stream silently loses the underlying lock error.
    child.stderr?.pipe(process.stderr, { end: false });
    try {
        await new Promise<void>((resolveReady, reject) => {
            const timer = setTimeout(() => reject(new Error('Native session lease did not become ready')), 10_000);
            child.once('error', reject);
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`Native session lease unavailable (exit ${code})`)); });
            lines.once('line', line => {
                clearTimeout(timer);
                try {
                    const reply = JSON.parse(line);
                    if (reply.ready !== true || reply.backendPid !== backendPid) throw new Error('Invalid lease response');
                    resolveReady();
                } catch (error) { reject(error); }
            });
        });
    } catch (error) {
        child.stdin?.end();
        throw error;
    } finally { lines.close(); }
    child.once('exit', onLost);
    return child;
}

export async function publishNativeMobileReady(directory: string, threadId: string, backendPid: number): Promise<() => Promise<void>> {
    const closeProxy = await startNativeFrontendProxy(join(directory, 'f.sock'), join(directory, 'b.sock'), threadId);
    const ready: NativeReady = { threadId, backendPid, workerPid: process.pid, account: process.env.HAPPY_CODEX_ACCOUNT_NAME ?? 'default', cwd: process.cwd() };
    await writeFile(join(directory, 'ready.tmp'), JSON.stringify(ready), { mode: 0o600 });
    await rename(join(directory, 'ready.tmp'), join(directory, 'ready.json'));
    return async () => { await unlink(join(directory, 'ready.json')).catch(() => undefined); await closeProxy(); };
}

async function readReady(directory: string): Promise<NativeReady | null> {
    try {
        await validateNativeMobileDirectory(directory);
        const ready = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')) as NativeReady;
        if (!Number.isSafeInteger(ready.workerPid) || !Number.isSafeInteger(ready.backendPid) || typeof ready.threadId !== 'string') return null;
        process.kill(ready.workerPid, 0);
        process.kill(ready.backendPid, 0);
        // The private live socket, not a PID alone, must also exist.
        if (!(await lstat(join(directory, 'f.sock'))).isSocket()) return null;
        return ready;
    } catch { return null; }
}

export async function launchNativeMobile(args: string[], resumeThreadId?: string): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Native mobile requires an interactive terminal');
    if (!process.env.HAPPY_CODEX_ACCOUNT_ENTRY || !process.env.HAPPY_CODEX_PATH) throw new Error('Use the updated codex-account --account NAME --mobile launcher');
    const root = join(configuration.happyHomeDir, 'native');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await validateNativeMobileDirectory(root);
    let directory: string | undefined;
    let ready: NativeReady | null = null;
    if (resumeThreadId) {
        for (const name of await readdir(root)) {
            const candidate = join(root, name);
            const value = await readReady(candidate);
            if (value?.threadId === resumeThreadId && value.account === process.env.HAPPY_CODEX_ACCOUNT_NAME && value.cwd === process.cwd()) {
                directory = candidate; ready = value; break;
            }
        }
    }
    if (!ready) {
        directory = await mkdtemp(join(root, 's-'));
        await validateNativeMobileDirectory(directory);
        const log = openSync(join(directory, 'worker.log'), 'a', 0o600);
        let worker: ChildProcess;
        try {
            worker = spawnHappyCLI(['codex', ...args.filter(arg => arg !== '--native-tui'), '--native-worker', directory], {
                detached: true, stdio: ['ignore', log, log], env: { ...process.env, HAPPY_NATIVE_MOBILE_DIR: directory },
            });
        } finally { closeSync(log); }
        let spawnError: Error | undefined;
        worker.on('error', error => { spawnError = error; });
        worker.unref();
        const deadline = Date.now() + 120_000;
        while (!(ready = await readReady(directory))) {
            if (spawnError || worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Native mobile startup failed. See ${join(directory, 'worker.log')}`);
            if (Date.now() >= deadline) {
                worker.kill('SIGTERM');
                throw new Error(`Native mobile startup timed out. See ${join(directory, 'worker.log')}`);
            }
            await new Promise(resolveWait => setTimeout(resolveWait, 100));
        }
    }
    const selectedDirectory = resolve(directory!);
    const frontend = spawn(process.env.HAPPY_CODEX_PATH, ['--remote', `unix://${join(selectedDirectory, 'f.sock')}`, 'resume', ready.threadId], {
        stdio: 'inherit', env: { ...process.env, HAPPY_NATIVE_MOBILE_DIR: selectedDirectory },
    });
    const code = await new Promise<number>((resolveExit, reject) => {
        frontend.once('error', reject);
        frontend.once('exit', (status, signal) => resolveExit(status ?? (signal ? 130 : 1)));
    });
    process.exitCode = code;
}
