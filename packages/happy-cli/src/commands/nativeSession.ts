import { readCredentials } from '@/persistence';
import { discoverLegacyNativeChat, prepareLegacyNativeChat, readNativeChat, writeNativeChat } from '@/codex/nativeChat';

/** Private, versioned bridge used by codex-account before releasing a worker. */
export async function handleNativeSessionCommand(args: string[]): Promise<void> {
    if (args.length === 1 && args[0] === 'capability') { console.log('1'); return; }
    const [action, threadId, directory] = args;
    if (!threadId || !['inspect', 'prepare'].includes(action)) throw new Error('Invalid native-session bridge invocation');
    const credentials = await readCredentials();
    if (!credentials) throw new Error('Happy credentials unavailable; original worker was not stopped.');
    const chat = readNativeChat(threadId, credentials);
    if (chat) { console.log(chat.legacyPending ? 'legacy-pending' : 'current'); return; }
    if (directory && directory !== '--accept-legacy') {
        if (action === 'inspect') { console.log('legacy'); return; }
        if (args[3] !== '--accept-legacy' || args.length !== 4) throw new Error('Legacy migration requires explicit input-cancellation acceptance.');
        console.log(prepareLegacyNativeChat(threadId, directory, credentials));
        return;
    }
    const legacy = await discoverLegacyNativeChat(threadId, credentials);
    if (action === 'inspect') { console.log(legacy ? 'legacy' : 'new'); return; }
    if (directory !== '--accept-legacy' || args.length !== 3 || !legacy) throw new Error('Original legacy chat could not be prepared; retry inspect before migration.');
    writeNativeChat(legacy);
    console.log('legacy');
}
