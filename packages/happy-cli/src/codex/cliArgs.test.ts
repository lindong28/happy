import { describe, expect, it } from 'vitest';

import { extractCodexNativeConfigFlag, extractCodexResumeFlag } from './cliArgs';

describe('extractCodexNativeConfigFlag', () => {
    it('keeps the existing default and explicit overrides when native mode is absent', () => {
        expect(extractCodexNativeConfigFlag(['--model', 'test-model', '--yolo'])).toEqual({
            nativeConfig: false, args: ['--model', 'test-model', '--yolo'],
        });
    });

    it('preserves resume and daemon arguments in native mode', () => {
        const result = extractCodexNativeConfigFlag(['--native-config', '--resume=thread-123', '--started-by', 'daemon']);
        expect(result.nativeConfig).toBe(true);
        expect(extractCodexResumeFlag(result.args)).toEqual({ resumeThreadId: 'thread-123', args: ['--started-by', 'daemon'] });
    });

    it.each(['--model', '--model=test-model', '--effort', '--effort=high', '--permission-mode', '--permission-mode=yolo', '--yolo', '--no-sandbox'])(
        'rejects the conflicting override %s before authentication', flag => {
            expect(() => extractCodexNativeConfigFlag(['--native-config', flag])).toThrow('cannot be combined');
        },
    );
});

describe('extractCodexResumeFlag', () => {
    it('returns null and preserves args when resume flag is absent', () => {
        const parsed = extractCodexResumeFlag(['--started-by', 'terminal']);

        expect(parsed.resumeThreadId).toBeNull();
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('extracts an explicit resume thread ID', () => {
        const parsed = extractCodexResumeFlag(['--resume', 'thread-123', '--started-by', 'daemon']);

        expect(parsed.resumeThreadId).toBe('thread-123');
        expect(parsed.args).toEqual(['--started-by', 'daemon']);
    });

    it('supports equals syntax', () => {
        const parsed = extractCodexResumeFlag(['--resume=thread-456', '--started-by', 'terminal']);

        expect(parsed.resumeThreadId).toBe('thread-456');
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('throws when resume flag is missing a thread ID', () => {
        expect(() => extractCodexResumeFlag(['--resume'])).toThrow(
            'Codex resume requires a thread ID: happy codex --resume <thread-id>',
        );
    });
});
