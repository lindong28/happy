import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerSessionTermination } from './sessionTermination';

describe('Codex process termination', () => {
    it.each(['SIGTERM', 'SIGINT', 'SIGHUP'])('requests graceful shutdown on %s only once', (signal) => {
        const signals = new EventEmitter();
        const terminate = vi.fn();
        const dispose = registerSessionTermination(terminate, signals);
        signals.emit(signal);
        signals.emit(signal);
        expect(terminate).toHaveBeenCalledTimes(1);
        dispose();
    });

    it('removes its handlers without removing other signal consumers', () => {
        const signals = new EventEmitter();
        const other = vi.fn();
        signals.on('SIGTERM', other);
        const terminate = vi.fn();
        const dispose = registerSessionTermination(terminate, signals);
        dispose();
        signals.emit('SIGTERM');
        signals.emit('SIGINT');
        signals.emit('SIGHUP');
        expect(terminate).not.toHaveBeenCalled();
        expect(other).toHaveBeenCalledOnce();
    });
});
