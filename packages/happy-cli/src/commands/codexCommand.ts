import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { runCodex } from '@/codex/runCodex'
import { extractCodexNativeConfigFlag, extractCodexResumeFlag } from '@/codex/cliArgs'
import { extractNoSandboxFlag } from '@/utils/sandboxFlags'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'
import type { PermissionMode } from '@/api/types'
import type { ReasoningEffort } from '@/codex/codexAppServerTypes'
import { launchNativeMobile, validateNativeMobileDirectory } from '@/codex/nativeMobile'

export async function handleCodexCommand(args: string[]): Promise<void> {
  let startedBy: 'daemon' | 'terminal' | undefined = undefined
  let permissionMode: PermissionMode | undefined = undefined
  let model: string | undefined = undefined
  let effort: ReasoningEffort | undefined = undefined
  const nativeArgs = extractCodexNativeConfigFlag(args)
  const sandboxArgs = extractNoSandboxFlag(nativeArgs.args)
  const codexArgs = extractCodexResumeFlag(sandboxArgs.args)
  if (args.includes('--native-tui')) {
    await launchNativeMobile(args, codexArgs.resumeThreadId ?? undefined)
    return
  }
  const workerIndex = args.indexOf('--native-worker')
  const nativeMobileDirectory = workerIndex >= 0 ? args[workerIndex + 1] : undefined
  if (workerIndex >= 0) {
    if (!nativeMobileDirectory || nativeMobileDirectory !== process.env.HAPPY_NATIVE_MOBILE_DIR || !nativeArgs.nativeConfig) throw new Error('Invalid native mobile worker invocation')
    await validateNativeMobileDirectory(nativeMobileDirectory)
  }

  for (let i = 0; i < codexArgs.args.length; i++) {
    if (codexArgs.args[i] === '--started-by') {
      startedBy = codexArgs.args[++i] as 'daemon' | 'terminal'
    } else if (codexArgs.args[i] === '--permission-mode') {
      permissionMode = codexArgs.args[++i] as PermissionMode
    } else if (codexArgs.args[i] === '--model') {
      model = codexArgs.args[++i]
    } else if (codexArgs.args[i] === '--effort') {
      effort = codexArgs.args[++i] as ReasoningEffort
    } else if (codexArgs.args[i] === '--yolo') {
      permissionMode = 'yolo'
    }
  }

  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()

  await runCodex({
    credentials,
    startedBy,
    nativeConfig: nativeArgs.nativeConfig,
    nativeMobileDirectory,
    noSandbox: sandboxArgs.noSandbox,
    resumeThreadId: codexArgs.resumeThreadId ?? undefined,
    permissionMode,
    model,
    effort,
  })
}
