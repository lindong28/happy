import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { checkedRelease, movedTerminal, pinTerminal, recordRelease, recoverIntent, replaceReleasedWorker, requestReleaseMaintenance, serveRelease } from './nativeRelease';
import { idleBackendEvidence, NativeReleaseGate } from './nativeReleaseGate';

const shape = { id: 'thread', status: { type: 'idle' } };
const evidence = (thread: unknown = shape, goal: unknown = { goal: null }, terminals: unknown = { data: [] }, loaded: unknown = { data: ['thread'] }) =>
    idleBackendEvidence('thread', thread, goal, terminals, loaded);

it('accepts confirmed idle only, including backend resources that survive a turn', () => {
    expect(evidence()).toBe(true);
    for (const status of [{ type: 'active', activeFlags: [] }, { type: 'active', activeFlags: ['waitingOnApproval'] },
        { type: 'active', activeFlags: ['waitingOnUserInput'] }, { type: 'unknown' }, { type: 'idle', activeFlags: ['unknown'] }]) {
        expect(evidence({ ...shape, status })).toBe(false);
    }
    expect(evidence({ ...shape, id: 'different' })).toBe(false);
    expect(evidence(shape, {})).toBe(false);
    expect(evidence(shape, { goal: { status: 'active' } })).toBe(false);
    expect(evidence(shape, { goal: null }, { data: ['terminal'] })).toBe(false);
    expect(evidence(shape, { goal: null }, { data: [] }, { data: ['thread', 'agent'] })).toBe(false);
});

it('preserves an attached frontend, queued work and input racing the backend reads', async () => {
    const gate = new NativeReleaseGate();
    const check = vi.fn(async () => true);
    const detach = gate.attach()!;
    expect(await gate.reserve(() => true, check)).toBe(false);
    detach();
    expect(await gate.reserve(() => false, check)).toBe(false);
    expect(check).not.toHaveBeenCalled();
    for (const race of [() => gate.changed(), () => gate.attach()!()]) {
        expect(await gate.reserve(() => true, async () => { race(); return true; })).toBe(false);
    }
    await expect(gate.reserve(() => true, async () => { throw new Error('backend unavailable'); })).rejects.toThrow();
    await expect(gate.reserve(() => true, check, () => { throw new Error('record unavailable'); })).rejects.toThrow();
    expect(gate.frozen).toBe(false);
    expect(await gate.reserve(() => true, check)).toBe(true);
    expect(gate.attach()).toBeNull();
    expect(await gate.reserve(() => true, check)).toBe(false);
});

it('wakes the owner once after an explicitly deferred session drains and detaches', async () => {
    vi.useFakeTimers();
    const gate = new NativeReleaseGate();
    try {
        const wake = vi.fn();
        let queued = true;
        const backendIdle = vi.fn(async () => true);
        gate.changed();
        await vi.advanceTimersByTimeAsync(2000);
        expect(vi.getTimerCount()).toBe(0);
        const detach = gate.attach()!;
        gate.retryWhenIdle(async () => {
            if (!await gate.inspectIdle(() => !queued, backendIdle)) return false;
            wake(); return true;
        });
        await vi.advanceTimersByTimeAsync(1500);
        expect(backendIdle).not.toHaveBeenCalled();
        detach();
        await vi.advanceTimersByTimeAsync(1500);
        expect(wake).not.toHaveBeenCalled();
        queued = false;
        gate.changed(); gate.changed();
        await vi.advanceTimersByTimeAsync(1500);
        expect(wake).toHaveBeenCalledOnce();
        gate.changed();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(wake).toHaveBeenCalledOnce();
    } finally { gate.cancelRetry(); vi.useRealTimers(); }
});

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { force: true, recursive: true }))); });

it.each(['upgrade', 'rollback', 'recover-without-old'])('resumes the exact identity and reads through its frontend (%s)', async scenario => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'hr-')));
    paths.push(dir);
    const ws = createRequire(import.meta.url).resolve('ws');
    const identity = { threadId: 'test-thread', sessionId: 'test-chat', cwd: dir, account: 'test-account' };
    const native = join(dir, 'native');
    const original = join(native, 's-source');
    await mkdir(original, { recursive: true, mode: 0o700 });
    const prepare = async (name: string, broken: boolean) => {
        const release = join(dir, 'releases', name.repeat(64));
        const pkg = join(release, 'node_modules/happy');
        await mkdir(join(pkg, 'dist'), { recursive: true });
        await writeFile(join(release, 'complete'), name.repeat(64));
        await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'happy', happyReleaseHandoff: 1 }));
        const source = [
            "import {createRequire} from 'node:module'; import {createServer} from 'node:http'; import {writeFileSync} from 'node:fs';",
            "const { WebSocketServer } = createRequire(import.meta.url)(" + JSON.stringify(ws) + ");",
            "const dir = process.env.HAPPY_NATIVE_MOBILE_DIR, release = process.env.HAPPY_RELEASE_ROOT;",
            "const identity = {threadId:process.argv[process.argv.indexOf('--resume')+1], sessionId:process.env.HAPPY_HANDOFF_CHAT, account:process.env.HAPPY_CODEX_ACCOUNT_NAME, cwd:process.cwd()};",
            "process.once('message', m=>{ if(m!=='activate') process.exit(9); const http=createServer(); const server=new WebSocketServer({server:http});",
            "server.on('connection', ws=> ws.on('message', raw=>{ const m=JSON.parse(raw); if(!m.id)return; const read=m.method==='thread/read';",
            "ws.send(JSON.stringify({id:m.id,result:read?{thread:{id:identity.threadId,status:{type:'idle'}}}:{}}));",
            "if(read){writeFileSync(process.cwd()+'/observed',JSON.stringify({release,...identity})); setTimeout(()=>process.exit(0),100);} }));",
            "http.listen(dir+'/f.sock',()=>writeFileSync(dir+'/ready.json',JSON.stringify({...identity,handoff:1,release,workerPid:process.pid,backendPid:process.pid}))); });",
            "setTimeout(()=>process.exit(9),5000).unref(); process.send({staged:identity});",
        ].join('\n');
        await writeFile(join(pkg, 'dist/index.mjs'), broken ? 'process.exit(2)' : source);
        return checkedRelease(join(dir, 'releases'), name.repeat(64));
    };
    const next = await prepare('b', scenario === 'rollback');
    const old = scenario === 'recover-without-old' ? join(dir, 'releases', 'a'.repeat(64)) : await prepare('a', false);
    if (scenario === 'recover-without-old') {
        recordRelease(original, { ...identity, workerPid: 2147483647, backendPid: 2147483646, release: old, handoff: 1 }, next);
        expect(await recoverIntent(original, next, ['s-source'])).toBe('migrated');
        await expect(readFile(join(original, 'rollover.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
        expect(await replaceReleasedWorker(old, next, original, identity)).toBe(scenario === 'rollback' ? 'restored' : 'migrated');
    }
    expect(JSON.parse(await readFile(join(dir, 'observed'), 'utf8'))).toEqual({ ...identity, release: scenario === 'rollback' ? old : next });
});

it('wakes the owner for the currently selected compatible release after the deferred target was superseded', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'hw-')));
    paths.push(dir);
    const target = join(dir, 'releases', 'b'.repeat(64));
    const current = join(dir, 'releases', 'c'.repeat(64));
    await mkdir(join(current, 'node_modules/happy/dist'), { recursive: true });
    await writeFile(join(current, 'node_modules/happy/dist/index.mjs'), '');
    await writeFile(join(current, 'node_modules/happy/package.json'), JSON.stringify({ name: 'happy', happyReleaseHandoff: 1 }));
    await writeFile(join(current, 'complete'), 'c'.repeat(64));
    await writeFile(join(dir, 'owner.json'), JSON.stringify({ sha256: 'c'.repeat(64) }));
    const stable = join(dir, 'trigger');
    await writeFile(stable, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(__dirname+"/requested",process.argv[2]);', { mode: 0o700 });
    vi.stubEnv('HAPPY_RELEASE_MAINTENANCE_ENTRY', stable);
    try {
        await requestReleaseMaintenance(target);
        await vi.waitFor(async () => expect(await readFile(join(dir, 'requested'), 'utf8')).toBe('--request-maintenance'), { timeout: 4_000 });
    } finally { vi.unstubAllEnvs(); }
});

it('follows the same chat if the selected terminal directory lost readiness before attach', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hm-')));
    paths.push(root);
    const source = join(root, 's-source'), target = join(root, 's-target');
    await mkdir(source, { mode: 0o700 }); await mkdir(target, { mode: 0o700 });
    const identity = { threadId: 'thread', sessionId: 'chat', account: 'fixture', cwd: root };
    const ready = { ...identity, workerPid: process.pid, backendPid: process.pid, handoff: 1, release: 'fixture' };
    await writeFile(join(target, 'ready.json'), JSON.stringify(ready));
    expect(await movedTerminal(root, source, identity)).toEqual({ directory: target, ready });
    expect(await movedTerminal(root, source, { ...identity, account: 'different' })).toBeNull();
});

it('pins a selected terminal across the title hook and TUI spawn before a frontend websocket exists', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'hp-')));
    paths.push(dir);
    const ready = { threadId: 'thread', sessionId: 'chat', account: 'fixture', cwd: dir, workerPid: process.pid,
        backendPid: process.pid, handoff: 1, release: 'fixture' };
    const gate = new NativeReleaseGate();
    const server = await serveRelease(dir, ready, gate, async () => 'deferred');
    try {
        const pin = await pinTerminal(dir, ready);
        const probe = vi.fn(async () => true);
        expect(await gate.reserve(() => true, probe)).toBe(false);
        expect(probe).not.toHaveBeenCalled();
        pin.close();
        await vi.waitFor(async () => expect(await gate.reserve(() => true, probe)).toBe(true));
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
