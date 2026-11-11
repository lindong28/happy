import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockAuthAndSetupMachineIfNeeded: vi.fn(),
  mockRunCodex: vi.fn(),
  mockExtractNoSandboxFlag: vi.fn(),
  mockEnsureDaemonRunning: vi.fn(),
}))

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: mocks.mockAuthAndSetupMachineIfNeeded,
}))

vi.mock('@/codex/runCodex', () => ({
  runCodex: mocks.mockRunCodex,
}))

vi.mock('@/utils/sandboxFlags', () => ({
  extractNoSandboxFlag: mocks.mockExtractNoSandboxFlag,
}))

vi.mock('@/daemon/ensureDaemonRunning', () => ({
  ensureDaemonRunning: mocks.mockEnsureDaemonRunning,
}))

import { handleCodexCommand } from './codexCommand'

describe('handleCodexCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockAuthAndSetupMachineIfNeeded.mockResolvedValue({
      credentials: { token: 'token' },
    })
    mocks.mockExtractNoSandboxFlag.mockImplementation((args: string[]) => ({
      noSandbox: false,
      args,
    }))
    mocks.mockEnsureDaemonRunning.mockResolvedValue(undefined)
    mocks.mockRunCodex.mockResolvedValue(undefined)
  })

  it('ensures the daemon is running before starting a codex session', async () => {
    await handleCodexCommand(['--started-by', 'terminal'])

    expect(mocks.mockEnsureDaemonRunning).toHaveBeenCalledTimes(1)
    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: 'terminal',
      noSandbox: false,
      nativeConfig: false,
      resumeThreadId: undefined,
      permissionMode: undefined,
      model: undefined,
      effort: undefined,
    })
    expect(
      mocks.mockEnsureDaemonRunning.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.mockRunCodex.mock.invocationCallOrder[0])
  })

  it('passes parsed no-sandbox and resume flags through to runCodex', async () => {
    mocks.mockExtractNoSandboxFlag.mockReturnValue({
      noSandbox: true,
      args: ['--resume', 'thread-123', '--started-by', 'daemon'],
    })
    await handleCodexCommand(['--no-sandbox', '--resume', 'thread-123', '--started-by', 'daemon'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: 'daemon',
      noSandbox: true,
      nativeConfig: false,
      resumeThreadId: 'thread-123',
      permissionMode: undefined,
      model: undefined,
      effort: undefined,
    })
  })

  it('passes permission-mode through to runCodex', async () => {
    await handleCodexCommand(['--permission-mode', 'yolo'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: undefined,
      noSandbox: false,
      nativeConfig: false,
      resumeThreadId: undefined,
      permissionMode: 'yolo',
      model: undefined,
      effort: undefined,
    })
  })

  it('maps --yolo to codex yolo permission mode', async () => {
    await handleCodexCommand(['--yolo'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: undefined,
      noSandbox: false,
      nativeConfig: false,
      resumeThreadId: undefined,
      permissionMode: 'yolo',
      model: undefined,
      effort: undefined,
    })
  })

  it('passes model and effort through to runCodex', async () => {
    await handleCodexCommand(['--model', 'gpt-5.4', '--effort', 'xhigh'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: undefined,
      noSandbox: false,
      nativeConfig: false,
      resumeThreadId: undefined,
      permissionMode: undefined,
      model: 'gpt-5.4',
      effort: 'xhigh',
    })
  })

  it('passes native mode through without model or permission overrides', async () => {
    await handleCodexCommand(['--native-config'])
    expect(mocks.mockRunCodex).toHaveBeenCalledWith(expect.objectContaining({
      nativeConfig: true, model: undefined, effort: undefined, permissionMode: undefined,
    }))
  })

  it('rejects native mode conflicts before authenticating or starting the daemon', async () => {
    await expect(handleCodexCommand(['--native-config', '--yolo'])).rejects.toThrow('cannot be combined')
    expect(mocks.mockAuthAndSetupMachineIfNeeded).not.toHaveBeenCalled()
    expect(mocks.mockEnsureDaemonRunning).not.toHaveBeenCalled()
    expect(mocks.mockRunCodex).not.toHaveBeenCalled()
  })
})
