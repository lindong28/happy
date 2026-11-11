import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const noop = () => {};
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
function compile(name: string) {
    return ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
}

// Execute the actual runner and client lifecycle, replacing only external I/O.
function harness(preparation: boolean, slowCleanup: boolean) {
    const events: string[] = [];
    const prepared = deferred(), releasePrepare = deferred(), started = deferred();
    const cleaning = deferred(), releaseCleanup = deferred();
    const proc = Object.assign(new EventEmitter(), {
        env: {}, stdout: { isTTY: false }, stdin: { isTTY: false }, cwd: () => '/mock', execPath: 'node',
    });
    const logger = { debug: noop, warn: noop, info: noop };
    const clientModule = { exports: {} as any, require: (name: string) => name === '@/ui/logger' ? { logger } : {},
        process: { env: {} }, setTimeout, clearTimeout, Date, Map, Set, Promise };
    vm.runInNewContext(compile('./codexAppServerClient.ts'), clientModule);
    let client: any;
    class Client extends clientModule.exports.CodexAppServerClient {
        constructor(...args: any[]) {
            super(...args);
            client = this;
            this._threadId = 'thread';
            this.sandboxCleanup = async () => {
                events.push('sandbox-cleanup');
                cleaning.resolve();
                if (slowCleanup) await releaseCleanup.promise;
            };
        }
        async connect() { events.push('connect'); this.connected = true; this.process = { stdin: { end: noop }, kill: noop }; }
        async sendTurn() { events.push('turn-start'); started.resolve(); }
        async sendTurnAndWait(...args: any[]) {
            if (preparation) { await this.sendTurn(); return { aborted: false }; }
            return super.sendTurnAndWait(...args);
        }
        async resumeThread() { events.push('resume'); }
        async interruptTurn() {}
        // Exercise the timeout outcome without waiting three wall-clock seconds.
        async waitForTurnCompletion() { return false; }
        setConfigurationHandler = noop;
        setMcpElicitationHandler = noop;
        setQuestionHandler = noop;
        setApprovalHandler = noop;
        setEventHandler = noop;
        setNotificationHandler = noop;
        setAsyncQuestionHandler = noop;
    }
    class Quiet { reset = noop; abort = noop; abortAll = noop; addMessage = noop; clear = noop; }
    class Forms extends EventEmitter { cancelAll = noop; snapshot = () => ({}); }
    class Queue {
        waitForMessagesAndGetAsString = async () => ({ message: 'hello', mode: {}, attachments: [] });
        size = () => 0;
    }
    const session = {
        sessionId: 's', rpcHandlerManager: { registerHandler: noop }, onFileEvent: noop, onUserMessage: noop,
        updateAgentState: noop, updateMetadata: noop, keepAlive: noop, sendSessionEvent: noop,
        sendSessionDeath: () => events.push('death'), flush: async () => {},
        close: async () => { events.push('close'); }, getMetadata: () => ({}),
    };
    const api = { getOrCreateMachine: async () => {}, getOrCreateSession: async () => ({ id: 's' }),
        deactivateSession: async () => { events.push('deactivate'); return true; } };
    const values: Record<string, any> = {
        ApiClient: { create: async () => api }, CodexAppServerClient: Client, CodexRequestRejected: Error,
        CodexPermissionHandler: Quiet, ReasoningProcessor: Quiet, DiffProcessor: Quiet, MessageBuffer: Quiet,
        QuestionForms: Forms, QuestionDeliveryError: Error, MessageQueue2: Queue,
        CodexRemoteModeState: class { resetAfterAbort = noop; }, logger, execSync: () => '', randomUUID: () => 'uuid',
        readSettings: async () => ({ machineId: 'm', ...(preparation ? {} : { sandboxConfig: { enabled: true } }) }),
        initialMachineMetadata: {}, hashCodexEnhancedMode: noop,
        configuration: {}, connectionState: { setBackend: noop }, createSessionMetadata: () => ({ state: {}, metadata: {} }),
        discoverCodexSkillCommands: async () => [], setupOfflineReconnection: () => ({ session }),
        notifyDaemonSessionStarted: async () => ({}), projectPath: () => '/mock', join: () => '/mock',
        registerKillSessionHandler: noop, bindQuestionFormDisplay: noop, createSerialAsyncHandler: (x: any) => x,
        startHappyServer: async () => ({ url: 'mock', stop: noop }), nativeConfigMetadata: () => ({}),
        isCodexClearText: () => false, parseCodexGoalCommand: () => null, resolveCodexExecutionPolicy: () => ({}),
        prepareCodexImageInputItems: async () => {
            prepared.resolve();
            if (preparation) await releasePrepare.promise;
            return { inputItems: [], skipped: 0 };
        }, buildCodexTurnPrompt: () => 'hello', emitReadyIfIdle: noop, encodeBase64: () => '',
    };
    const context = { exports: {} as any, require: (name: string) => name.endsWith('package.json') ? { version: 'test' }
        : new Proxy(values, { get: (target, key) => {
            if (key === '__esModule') return false;
            if (typeof key === 'string' && key in target) return target[key];
            throw new Error(`Unmocked export ${String(key)} from ${name}`);
        } }), process: proc, AbortController, setInterval: () => 1, clearInterval: noop, console };
    vm.runInNewContext(compile('./sessionTermination.ts'), context);
    values.registerSessionTermination = context.exports.registerSessionTermination;
    context.exports = {};
    vm.runInNewContext(compile('./runCodex.ts'), context);
    const running = context.exports.runCodex({ credentials: {}, nativeConfig: preparation });
    return { events, proc, prepared, releasePrepare, started, cleaning, releaseCleanup, running, client: () => client };
}

describe('Codex termination through the runner', () => {
    it('does not submit a turn when terminated during asynchronous preparation', async () => {
        const h = harness(true, false);
        await Promise.race([h.prepared.promise, h.running]);
        h.proc.emit('SIGTERM');
        h.releasePrepare.resolve();
        await h.running;
        expect(h.events).not.toContain('turn-start');
        expect(h.events).toContain('deactivate');
    });

    it.each([false, true])('finishes backend cleanup before returning (slow cleanup=%s)', async slow => {
        const h = harness(false, slow);
        await Promise.race([h.started.promise, h.running]);
        h.proc.emit('SIGTERM');
        await Promise.race([h.cleaning.promise, h.running]);
        h.releaseCleanup.resolve();
        await h.running;
        await new Promise(resolve => setImmediate(resolve));
        expect(h.client().process).toBeNull();
        expect(h.events.filter(x => x === 'connect')).toHaveLength(1);
        expect(h.events).toContain('deactivate');
    });
});
