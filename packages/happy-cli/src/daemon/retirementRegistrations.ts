import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { persistSession, readPersistedSessions, type PersistedSession } from '@/persistence';
import { logger } from '@/ui/logger';

const directory = () => join(configuration.happyHomeDir, 'release-registrations');
const privateDirectory = () => {
    const info = lstatSync(directory());
    return info.isDirectory() && info.uid === process.getuid?.() && !(info.mode & 0o077);
};

export function queueRegistration(sessionId: string, record: PersistedSession): {machine: string; server: string} | undefined {
    const receipt = join(configuration.happyHomeDir, 'release-accepted.json');
    let target;
    try {
        const info = lstatSync(receipt);
        if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077) return;
        target = JSON.parse(readFileSync(receipt, 'utf8'));
        if (typeof target.machine !== 'string' || target.server !== new URL(configuration.serverUrl).toString().replace(/\/+$/, '')) return;
    } catch { return; }
    mkdirSync(directory(), { recursive: true, mode: 0o700 });
    if (!privateDirectory()) throw new Error('Cannot verify private registration queue');
    const file = join(directory(), randomUUID());
    writeFileSync(file + '.tmp', JSON.stringify({ sessionId, server: configuration.serverUrl, record }), { flag: 'wx', mode: 0o600 });
    renameSync(file + '.tmp', file + '.json');
    return {machine: target.machine, server: target.server};
}

/** Persist recovery data only. A saved PID never gives the new daemon authority
 * to adopt, stop, or signal a session. Only a live client webhook can do that. */
export function recoverRegistrations(onRecovered?: (id: string, saved: PersistedSession) => void): void {
    if (!existsSync(directory()) || !privateDirectory()) return;
    for (const name of readdirSync(directory())) {
        if (!name.endsWith('.json')) continue;
        const file = join(directory(), name);
        try {
            const info = lstatSync(file);
            if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077) continue;
            const { sessionId, server, record } = JSON.parse(readFileSync(file, 'utf8'));
            if (server !== configuration.serverUrl || typeof sessionId !== 'string' || !Number.isFinite(record?.savedAt) ||
                typeof record.encryptionKey !== 'string' || !record.metadata) continue;
            const saved = readPersistedSessions()[sessionId];
            if (!saved || saved.savedAt < record.savedAt) {
                persistSession(sessionId, record);
                const written = readPersistedSessions()[sessionId];
                if (written?.savedAt !== record.savedAt || written.encryptionKey !== record.encryptionKey) continue;
            }
            onRecovered?.(sessionId, readPersistedSessions()[sessionId]);
            unlinkSync(file);
        } catch {
            logger.debug('[DAEMON RUN] Registration recovery deferred');
        }
    }
}
