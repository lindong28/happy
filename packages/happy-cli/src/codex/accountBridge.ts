/** Optional personal account routing. Contains a local name, never credentials. */
export function codexAccountName(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(value) ||
        value === 'session-links' || value === 'session-locks') {
        throw new Error('Invalid Codex account name; refusing to use another account.');
    }
    return value;
}
