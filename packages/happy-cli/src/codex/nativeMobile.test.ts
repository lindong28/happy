import { spawn as realSpawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ program: '' }));
vi.mock('node:child_process', async importOriginal => {
    const original = await importOriginal<typeof import('node:child_process')>();
    return {
        ...original,
        spawn: (_entry: string, _args: string[], options: Parameters<typeof realSpawn>[2]) =>
            original.spawn(process.execPath, ['-e', fixture.program], options),
    };
});

import { acquireNativeLease } from './nativeMobile';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

it('preserves the lease subprocess diagnostic in the worker stderr on failure', async () => {
    vi.stubEnv('HAPPY_CODEX_ACCOUNT_ENTRY', 'fixture');
    const output: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
        output.push(String(chunk));
        return true;
    });
    fixture.program = 'process.stderr.write("session lock is held\\n", () => process.exit(2))';
    await expect(acquireNativeLease('fixture-thread', 123, () => {})).rejects.toThrow('exit 2');
    expect(output.join('')).toContain('session lock is held');
});

it('keeps diagnostics separate from the readiness protocol and releases the child on EOF', async () => {
    vi.stubEnv('HAPPY_CODEX_ACCOUNT_ENTRY', 'fixture');
    const output: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
        output.push(String(chunk));
        return true;
    });
    fixture.program = 'process.stderr.write("lease diagnostic\\n"); console.log(JSON.stringify({ready:true,backendPid:123})); process.stdin.resume(); process.stdin.on("end", () => process.exit(0))';
    const lost = vi.fn();
    const child = await acquireNativeLease('fixture-thread', 123, lost);
    const closed = once(child, 'close');
    child.stdin!.end();
    await closed;
    expect(output.join('')).toContain('lease diagnostic');
    expect(lost).toHaveBeenCalledOnce();
});
