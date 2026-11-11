/** Opt-in native settings must not be combined with Happy's override flags. */
export function extractCodexNativeConfigFlag(args: string[]): { nativeConfig: boolean; args: string[] } {
    const nativeConfig = args.includes('--native-config');
    if (nativeConfig) {
        const overrides = ['--model', '--effort', '--permission-mode', '--yolo', '--no-sandbox'];
        const conflict = args.find(arg => overrides.some(flag => arg === flag || arg.startsWith(`${flag}=`)));
        if (conflict) throw new Error(`--native-config cannot be combined with ${conflict.split('=')[0]}. Remove the override to use the local Codex configuration.`);
    }
    return { nativeConfig, args: args.filter(arg => arg !== '--native-config') };
}

export function extractCodexResumeFlag(args: string[]): { resumeThreadId: string | null; args: string[] } {
    const remainingArgs: string[] = [];
    let resumeThreadId: string | null = null;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--resume' || arg === '-r') {
            if (resumeThreadId !== null) {
                throw new Error('Codex resume flag can only be provided once.');
            }

            const nextArg = args[i + 1];
            if (!nextArg || nextArg.startsWith('-')) {
                throw new Error('Codex resume requires a thread ID: happy codex --resume <thread-id>');
            }

            resumeThreadId = nextArg;
            i++;
            continue;
        }

        if (arg.startsWith('--resume=')) {
            if (resumeThreadId !== null) {
                throw new Error('Codex resume flag can only be provided once.');
            }

            const value = arg.slice('--resume='.length).trim();
            if (!value) {
                throw new Error('Codex resume requires a thread ID: happy codex --resume <thread-id>');
            }

            resumeThreadId = value;
            continue;
        }

        remainingArgs.push(arg);
    }

    return {
        resumeThreadId,
        args: remainingArgs,
    };
}
