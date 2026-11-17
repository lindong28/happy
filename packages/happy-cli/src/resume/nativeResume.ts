import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { configuration } from '@/configuration';
import { readCredentials } from '@/persistence';
import { readNativeChat } from '@/codex/nativeChat';
import { validateNativeMobileDirectory } from '@/codex/nativeMobile';
import type { ResumeLaunch } from './handleResumeCommand';

/** Prepare the actual spawned argv, so account handoff can recognize this worker too. */
export async function prepareNativeResumeLaunch(launch: ResumeLaunch, sessionId: string): Promise<ResumeLaunch> {
    if (!launch.args.includes('--native-config')) return launch;
    const threadId = launch.args[launch.args.indexOf('--resume') + 1];
    const credentials = await readCredentials();
    if (!credentials) throw new Error('Happy credentials unavailable for native resume');
    const chat = readNativeChat(threadId, credentials);
    if (!chat) return launch;
    if (chat.sessionId !== sessionId) throw new Error('Native checkpoint differs from the requested Happy chat');
    const root = join(configuration.happyHomeDir, 'native');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await validateNativeMobileDirectory(root);
    const directory = await mkdtemp(join(root, 's-'));
    await validateNativeMobileDirectory(directory);
    return {
        cwd: chat.cwd,
        args: [...launch.args, '--native-worker', directory],
        env: { ...launch.env, HAPPY_NATIVE_MOBILE_DIR: directory, HAPPY_CODEX_ACCOUNT_NAME: chat.account,
            HAPPY_CODEX_ACCOUNT_ENTRY: process.env.HAPPY_CODEX_ACCOUNT_ENTRY ?? join(homedir(), '.local/bin/codex-account') },
    };
}
