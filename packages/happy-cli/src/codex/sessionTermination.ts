import type { EventEmitter } from 'node:events';

/** Route process termination through the session's normal, resumable cleanup. */
export function registerSessionTermination(terminate: () => void, signals: EventEmitter = process): () => void {
    let requested = false;
    const handler = () => {
        if (requested) return;
        requested = true;
        terminate();
    };
    signals.on('SIGTERM', handler);
    signals.on('SIGINT', handler);
    signals.on('SIGHUP', handler);
    return () => {
        signals.off('SIGTERM', handler);
        signals.off('SIGINT', handler);
        signals.off('SIGHUP', handler);
    };
}
