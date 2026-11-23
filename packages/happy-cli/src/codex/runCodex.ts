import { render } from "ink";
import { codexAccountName } from './accountBridge';
import React from "react";
import { createEnvelope } from '@slopus/happy-wire';
import { ApiClient } from '@/api/api';
import { CodexAppServerClient, CodexRequestRejected } from './codexAppServerClient';
import type { ReasoningEffort, ThreadItem } from './codexAppServerTypes';
import { acquireNativeLease, publishNativeMobileReady } from './nativeMobile';
import type { ChildProcess } from 'node:child_process';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { MessageQueue2, type PendingAttachment } from '@/utils/MessageQueue2';
import { projectPath } from '@/projectPath';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { unlink } from 'node:fs/promises';
import type { Server } from 'node:http';
import { NativeReleaseGate } from './nativeReleaseGate';
import { activateStagedWorker, currentWorkerRelease, recordRelease, replaceReleasedWorker, requestReleaseMaintenance, serveRelease, type Identity, type Outcome } from './nativeRelease';

type NativeOwner = { client: CodexAppServerClient; backendPid: number; release?: string; control?: Server;
    replacement?: { next: string; identity: Identity; finish: (result: Outcome) => void } };
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import type { Session as ApiSession, UserMessage } from '@/api/types';
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { PermissionMode } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { resolveCodexExecutionPolicy, shouldAutoApproveCodexApproval } from './executionPolicy';
import {
    mapCodexMcpMessageToSessionEnvelopes,
    mapCodexProcessorMessageToSessionEnvelopes,
} from './utils/sessionProtocolMapper';
import { resumeExistingThread } from './resumeExistingThread';
import { nativeConfigMetadata } from './nativeConfigMetadata';
import { registerSessionTermination } from './sessionTermination';
import { askMcpElicitation } from './mcpElicitation';
import { emitReadyIfIdle } from './emitReadyIfIdle';
import { enqueueCodexUserText, isCodexClearText } from './codexClearCommand';
import { downloadCodexFileEventAttachment } from './utils/attachmentEvents';
import { prepareCodexImageInputItems } from './utils/imageInput';
import { createSerialAsyncHandler } from './utils/serialAsyncHandler';
import { buildCodexThreadBackfillEnvelopes, createCodexBackfillContext } from './utils/threadImageBackfill';
import { syncNativeHistory } from './nativeHistory';
import { createNativeChat, isNativePhoneInput, nativePhoneInputId, readNativeChat, readNativeChatHistory, unseenNativeHistory, writeNativeChat, type NativeChat } from './nativeChat';
import { emptyNativeRewind, NativeRewindCoordinator, NativeRewindRecoveryError } from './nativeRewind';
import {
    buildCodexTurnPrompt,
    hashCodexEnhancedMode,
    type CodexEnhancedMode,
} from './codexPrompt';
import { discoverCodexSkillCommands } from './codexSkills';
import { CodexRemoteModeState } from './remoteModeState';
import { QuestionForms, QuestionDeliveryError, bindQuestionFormDisplay } from './questionForms';
import { nativeQuestionForm, nativeQuestionAnswers, asyncQuestionForm, asyncQuestionReply, type AsyncQuestionItem } from './userQuestions';
import {
    codexGoalActionCapabilities,
    mapCodexGoalEventToAgentGoalStatus,
    parseCodexGoalActionParams,
    parseCodexGoalCommand,
    type CodexGoalCommand,
} from './codexGoalStatus';

/**
 * Extracts a human-readable error from a codex task_complete/turn_aborted event.
 * Returns null if the event represents a successful/clean completion.
 */
function describeCodexFailure(msg: any): string | null {
    const hasFailure = msg?.status === 'failed' || (msg?.error !== undefined && msg?.error !== null);
    if (!hasFailure) return null;
    const err = msg.error;
    if (typeof err === 'string' && err.length > 0) return err;
    if (err && typeof err === 'object' && typeof err.message === 'string' && err.message.length > 0) {
        return err.message;
    }
    return 'Unknown error';
}

function hasCodexSubagentReference(message: Record<string, unknown>): boolean {
    for (const key of ['subagent', 'parent_call_id', 'parentCallId', 'agent_thread_id', 'agentThreadId']) {
        const value = message[key];
        if (typeof value === 'string' && value.length > 0) {
            return true;
        }
    }
    return false;
}

const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol';
const DEFAULT_CODEX_EFFORT: ReasoningEffort = 'medium';
// Happy's default preset. Native-config sessions omit per-turn overrides instead.
const DEFAULT_CODEX_PERMISSION_MODE: PermissionMode = 'auto';

/**
 * Main entry point for the codex command with ink UI
 */
type RunCodexOptions = {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    noSandbox?: boolean;
    nativeConfig?: boolean;
    nativeMobileDirectory?: string;
    resumeThreadId?: string;
    permissionMode?: PermissionMode;
    model?: string;
    effort?: ReasoningEffort;
};

export async function runCodex(opts: RunCodexOptions): Promise<void> {
    if (!opts.nativeMobileDirectory) return runCodexSession(opts);
    if (!opts.nativeConfig || opts.noSandbox || opts.model !== undefined || opts.effort !== undefined || opts.permissionMode !== undefined) throw new Error('Native mobile requires unmodified local Codex configuration.');
    const settings = await readSettings();
    if (settings?.sandboxConfig?.enabled) throw new Error('Native configuration conflicts with the enabled Happy sandbox.');
    const client = new CodexAppServerClient(undefined, join(opts.nativeMobileDirectory, 'b.sock'));
    let lease: ChildProcess | undefined;
    let owner: NativeOwner | undefined;
    try {
        // The UUID lease protects relay identity and input as well as the backend.
        // No Happy session is connected or mutated before it is held.
        await client.connect();
        const backendPid = await client.nativeBackendPid();
        const threadId = opts.resumeThreadId ?? (await client.startThread({ cwd: process.cwd() })).threadId;
        lease = await acquireNativeLease(threadId, backendPid, () => { void client.disconnect(); });
        if (!opts.resumeThreadId) await client.materializeNativeThread();
        owner = { client, backendPid, release: await currentWorkerRelease() };
        await runCodexSession({ ...opts, resumeThreadId: threadId }, owner);
    } finally {
        await client.disconnect();
        const released = owner?.replacement && lease && lease.exitCode === null && lease.signalCode === null ? once(lease, 'exit') : undefined;
        lease?.stdin?.end();
        if (owner?.replacement && owner.release) {
            const transfer = owner.replacement;
            let result: Outcome = 'unverified';
            try {
                // The lease helper only exits after the original backend is gone.
                if (released && !await Promise.race([released.then(() => true), delay(15_000, false, { ref: false })])) {
                    // Keep the intent. The scheduled owner also checks both old PIDs before recovery.
                    return;
                }
                result = await replaceReleasedWorker(owner.release, transfer.next, opts.nativeMobileDirectory, transfer.identity);
                if (result === 'migrated' || result === 'restored') await unlink(join(opts.nativeMobileDirectory, 'rollover.json'));
            } finally { transfer.finish(result); owner.control?.close(); }
        } else { owner?.control?.close(); }
    }
}

async function runCodexSession(opts: RunCodexOptions, native?: NativeOwner): Promise<void> {
    if (opts.nativeConfig && (opts.noSandbox || opts.model !== undefined || opts.effort !== undefined || opts.permissionMode !== undefined)) {
        throw new Error('Native configuration cannot be combined with Happy model, effort, permission or sandbox overrides.');
    }
    // Early check: ensure Codex CLI is installed before proceeding
    try {
        execSync('codex --version', { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    } catch {
        console.error('\n\x1b[1m\x1b[33mCodex CLI is not installed\x1b[0m\n');
        console.error('Please install Codex CLI using one of these methods:\n');
        console.error('\x1b[1mOption 1 - npm (recommended):\x1b[0m');
        console.error('  \x1b[36mnpm install -g @openai/codex\x1b[0m\n');
        console.error('\x1b[1mOption 2 - Homebrew (macOS):\x1b[0m');
        console.error('  \x1b[36mbrew install --cask codex\x1b[0m\n');
        console.error('Alternatively, use Claude Code:');
        console.error('  \x1b[36mhappy claude\x1b[0m\n');
        process.exit(1);
    }

    type EnhancedMode = CodexEnhancedMode;

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    if (opts.nativeConfig && settings?.sandboxConfig?.enabled) {
        throw new Error('Native configuration conflicts with the enabled Happy sandbox. Use the normal happy codex command to retain that sandbox.');
    }
    let machineId = settings?.machineId;
    const sandboxConfig = opts.noSandbox || opts.nativeConfig ? undefined : settings?.sandboxConfig;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    const initialPermissionMode = opts.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE;
    // Lineage from the daemon's spawn RPC (set by app-side fork / duplicate).
    const forkedFromSessionId = process.env.HAPPY_FORKED_FROM_SESSION_ID;
    const forkedFromMessageId = process.env.HAPPY_FORKED_FROM_MESSAGE_ID;
    const isSideChat = process.env.HAPPY_SIDE_CHAT === '1';

    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy,
        sandbox: sandboxConfig,
        dangerouslySkipPermissions: initialPermissionMode === 'yolo' || initialPermissionMode === 'bypassPermissions',
        ...(forkedFromSessionId ? { parentSessionId: forkedFromSessionId } : {}),
        ...(forkedFromMessageId ? { forkedFromMessageId } : {}),
        ...(isSideChat ? { isSideChat: true } : {}),
    });

    if (opts.nativeConfig) Object.assign(metadata, nativeConfigMetadata());
    const accountName = codexAccountName(process.env.HAPPY_CODEX_ACCOUNT_NAME);
    if (accountName !== undefined) metadata.codexAccountName = accountName;

    const skillCommands = await discoverCodexSkillCommands();
    if (skillCommands.length > 0) {
        metadata.skills = skillCommands;
        metadata.slashCommands = Array.from(new Set([...(metadata.slashCommands ?? []), ...skillCommands]));
    }

    let nativeChat: NativeChat | null = native && opts.resumeThreadId ? readNativeChat(opts.resumeThreadId, opts.credentials) : null;
    if (process.env.HAPPY_HANDOFF_CHAT && (!nativeChat || nativeChat.sessionId !== process.env.HAPPY_HANDOFF_CHAT
        || !accountName || nativeChat.account !== accountName || nativeChat.legacyPending || nativeChat.legacyHistoryPending)) {
        throw new Error('Release handoff checkpoint identity changed.');
    }
    if (native && !nativeChat && process.env.HAPPY_RECONNECT_SESSION_ID) throw new Error('This legacy chat must first be migrated with codex-account --mobile before automatic resume.');
    if (nativeChat && nativeChat.cwd !== process.cwd()) throw new Error('Native chat working directory changed; refusing to move the original chat.');
    let nativeHistorySnapshot: Awaited<ReturnType<typeof readNativeChatHistory>> | undefined;
    if (nativeChat?.legacyPending) {
        // The old backend lease is released before this snapshot. Old inputs
        // cannot race across the migration boundary and execute twice.
        nativeHistorySnapshot = await readNativeChatHistory(nativeChat, opts.credentials);
        nativeChat.inputSeq = nativeHistorySnapshot.seq;
        nativeChat.legacyPending = false;
        writeNativeChat(nativeChat);
    }
    if (nativeChat && process.env.HAPPY_RECONNECT_SESSION_ID && process.env.HAPPY_RECONNECT_SESSION_ID !== nativeChat.sessionId) {
        throw new Error('Daemon reconnect identity differs from the native chat checkpoint.');
    }
    // Check for session reconnection env vars (set by daemon for resume-in-place)
    const reconnectSessionId = nativeChat?.sessionId ?? process.env.HAPPY_RECONNECT_SESSION_ID;
    const reconnectKeyBase64 = nativeChat?.encryptionKey ?? process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
    const reconnectVariant = nativeChat?.encryptionVariant ?? process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;
    const reconnectSeq = process.env.HAPPY_RECONNECT_SEQ;
    const reconnectMetadataVersion = process.env.HAPPY_RECONNECT_METADATA_VERSION;
    const reconnectAgentStateVersion = process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;

    let response: ApiSession | null;
    if (reconnectSessionId && reconnectKeyBase64 && reconnectVariant) {
        logger.debug(`[START] Reconnecting to existing session ${reconnectSessionId}`);
        response = {
            id: reconnectSessionId,
            seq: parseInt(reconnectSeq || '0', 10),
            encryptionKey: decodeBase64(reconnectKeyBase64),
            encryptionVariant: reconnectVariant,
            metadata,
            metadataVersion: nativeChat?.metadataVersion ?? parseInt(reconnectMetadataVersion || '0', 10),
            agentState: state,
            agentStateVersion: nativeChat?.agentStateVersion ?? parseInt(reconnectAgentStateVersion || '0', 10),
        };
    } else {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    }

    if (native) {
        if (!response) throw new Error('Happy is unavailable; retry the same resume command. No replacement chat was started.');
        nativeChat ??= createNativeChat(opts.resumeThreadId!, opts.credentials, response);
        nativeChat.account = accountName;
        writeNativeChat(nativeChat);
        metadata.codexThreadId = opts.resumeThreadId;
    }

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later at line ~385 after client setup)
    let permissionHandler: CodexPermissionHandler;
    let client!: CodexAppServerClient;
    let reasoningProcessor!: ReasoningProcessor;
    let abortInProgress: Promise<void> | null = null;
    const releaseGate = new NativeReleaseGate();
    let waitingForPhone = false;
    let historyBusy = false;
    let rpcInFlight = 0;
    const guardSession = (value: ApiSessionClient) => {
        if (!native?.release) return;
        value.rpcHandlerManager.enterRequest = () => {
            if (releaseGate.frozen || process.env.HAPPY_HANDOFF_CHAT) throw new Error('Session upgrade in progress; retry shortly.');
            releaseGate.changed(); rpcInFlight++;
            return () => { rpcInFlight--; releaseGate.changed(); };
        };
    }
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            guardSession(newSession);
            session = newSession;
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
        }
    });
    guardSession(initialSession);
    session = initialSession;
    if (nativeChat) session.resumeNativeInput(nativeChat.inputSeq);

    // On reconnect, un-archive the session and skip replaying old messages.
    if (reconnectSessionId) {
        session.suppressNextArchiveSignal();
        if (!nativeChat) session.skipExistingMessages();
        session.updateMetadata((meta) => ({
            ...meta,
            ...(nativeChat ? metadata : {}),
            lifecycleState: 'running',
            archivedBy: undefined,
        }));
    }

    // Always report to daemon if it exists (skip if offline)
    if (response) {
        try {
            logger.debug(`[START] Reporting session ${response.id} to daemon`);
            const result = await notifyDaemonSessionStarted(response.id, metadata, {
                encryptionKey: encodeBase64(response.encryptionKey),
                encryptionVariant: response.encryptionVariant,
                seq: response.seq,
                metadataVersion: response.metadataVersion,
                agentStateVersion: response.agentStateVersion,
            });
            if (result.error) {
                logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
            } else {
                logger.debug(`[START] Reported session ${response.id} to daemon`);
            }
        } catch (error) {
            logger.debug('[START] Failed to report to daemon (may not be running):', error);
        }
    }

    const messageQueue = new MessageQueue2<EnhancedMode>(hashCodexEnhancedMode);
    const questionForms = new QuestionForms();
    const queuedQuestionReplies = new Map<string, { threadId: string; formId: string; resolve: () => void; reject: (error: Error) => void }>();
    questionForms.on('cancel', (formId: string) => {
        for (const [id, reply] of queuedQuestionReplies) {
            if (reply.formId !== formId) continue;
            queuedQuestionReplies.delete(id);
            reply.reject(new QuestionDeliveryError('Question cancelled before submission'));
        }
    });
    const cancelQuestions = (): void => {
        questionForms.cancelAll();
        for (const reply of queuedQuestionReplies.values()) reply.reject(new QuestionDeliveryError('Question cancelled'));
        queuedQuestionReplies.clear();
    };
    questionForms.on('change', () => session.updateAgentState(current => ({ ...current, ...questionForms.snapshot() })));
    questionForms.on('submissionError', () => session.sendSessionEvent({
        type: 'message', message: 'Question reply could not be confirmed. Check the running Codex session before sending it again.',
    }));
    session.rpcHandlerManager.registerHandler('communication', value => questionForms.reply(value));

    session.onFileEvent((fileEvent) => {
        releaseGate.changed();
        if (releaseGate.frozen) return; // Replayed by the successor from the durable phone input receipt.
        const ev = fileEvent.content.data.ev;
        logger.debug('[Codex] File event received', {
            size: ev.size,
            hasMimeType: Boolean(ev.mimeType),
        });
        session.trackAttachmentDownload(downloadCodexFileEventAttachment(session, fileEvent));
    });

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    const remoteModeState = new CodexRemoteModeState({
        permissionMode: initialPermissionMode,
        model: opts.nativeConfig ? undefined : opts.model ?? DEFAULT_CODEX_MODEL,
        effort: opts.nativeConfig ? undefined : opts.effort ?? DEFAULT_CODEX_EFFORT,
    });
    let currentAppendSystemPrompt: string | undefined = undefined;

    const resetCurrentModeDefaults = () => {
        // Reset permission mode and prompts to what the session was launched
        // with. Note this is NOT
        // a safety guarantee by itself — for plain `happy codex` the launch
        // mode IS yolo; the post-abort grace window is protected by the
        // approval handler only trusting explicitly-picked modes.
        // Model and effort deliberately remain sticky. Current apps also
        // reassert all three visible values on the next message.
        remoteModeState.resetAfterAbort();
        currentAppendSystemPrompt = undefined;
        logger.debug('[Codex] Reset current mode defaults after abort');
    };

    const handleUserMessage = createSerialAsyncHandler<UserMessage>(async (message) => {
        if (opts.nativeMobileDirectory && isCodexClearText(message.content.text)) {
            session.sendSessionEvent({ type: 'message', message: 'This terminal and phone stay on one Codex session. Open a new codex-account terminal to start another session.' });
            return;
        }
        if (isCodexClearText(message.content.text)) cancelQuestions();
        const attachmentsForThisMessage = await session.drainAttachmentsForUserMessage();

        const modeResolution = remoteModeState.resolve(opts.nativeConfig ? undefined : message.meta);
        if (opts.nativeConfig && message.meta && ['model', 'effort', 'permissionMode'].some(key => Object.prototype.hasOwnProperty.call(message.meta, key))) {
            session.sendSessionEvent({ type: 'message', message: 'Experimental native configuration: this session uses the local Codex settings. The mobile model, effort and permission selectors do not change its settings.' });
        }
        if (modeResolution.permission.kind === 'updated') {
            logger.debug(`[Codex] Permission mode updated from user message to: ${modeResolution.permissionMode}`);
        } else if (modeResolution.permission.kind === 'ignored') {
            logger.debug(`[Codex] Ignoring invalid permission mode from user message: ${String(modeResolution.permission.incoming)}`);
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${modeResolution.permissionMode}`);
        }
        if (modeResolution.modelResolution.kind === 'updated') {
            logger.debug(`[Codex] Model updated from user message: ${modeResolution.model || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${modeResolution.model || 'default'}`);
        }
        if (modeResolution.effortResolution.kind === 'updated') {
            logger.debug(modeResolution.effort
                ? `[Codex] Effort updated from user message: ${modeResolution.effort}`
                : '[Codex] Effort reset to default');
        } else if (modeResolution.effortResolution.kind === 'ignored') {
            logger.debug(`[Codex] Ignoring invalid effort from user message: ${String(modeResolution.effortResolution.incoming)}`);
        } else {
            logger.debug(`[Codex] User message received with no effort override, using current: ${modeResolution.effort ?? 'default'}`);
        }

        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (!opts.nativeConfig && message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined;
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[Codex] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[Codex] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        const enhancedMode: EnhancedMode = {
            receivedSeq: session.userMessageSeq(message),
            permissionMode: modeResolution.permissionMode,
            model: modeResolution.model,
            appendSystemPrompt: messageAppendSystemPrompt,
            effort: modeResolution.effort,
        };
        const enqueueResult = enqueueCodexUserText({
            text: message.content.text,
            mode: enhancedMode,
            queue: messageQueue,
            attachments: attachmentsForThisMessage,
        });
        if (enqueueResult === 'clear') {
            logger.debug('[Codex] /clear command pushed to isolated queue');
        }
    }, (error) => {
        logger.warn('[Codex] Failed to handle user message', {
            errorName: error instanceof Error ? error.name : typeof error,
        });
    });
    session.onUserMessage(message => {
        releaseGate.changed();
        if (!releaseGate.frozen) handleUserMessage(message);
    });
    let thinking = false;
    let currentTurnId: string | null = null;
    const sendTurnFailure = (message: Record<string, unknown>, failure: string) => {
        const turn = typeof message.turn_id === 'string' ? message.turn_id : currentTurnId;
        if (turn) session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'service', text: `Codex error: ${failure}` }, { turn }));
        else session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
    };
    bindQuestionFormDisplay(questionForms, message => session.sendSessionProtocolMessage(message), () => currentTurnId);
    let codexStartedSubagents = new Set<string>();
    let codexActiveSubagents = new Set<string>();
    let codexProviderSubagentToSessionSubagent = new Map<string, string>();
    let codexSubagentTitles = new Map<string, string>();
    let codexCollabReceiverThreadIdsByCall = new Map<string, string[]>();
    let codexCollabToolByCall = new Map<string, string>();
    let activeTurnPermissionMode: PermissionMode | undefined = undefined;
    session.keepAlive(thinking, 'remote');
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendSessionNotification({
                kind: 'done',
                metadata: session.getMetadata(),
                data: {
                    sessionId: session.sessionId,
                    type: 'ready',
                    provider: 'codex',
                }
            });
        } catch (pushError) {
            logger.debug('[Codex] Failed to send ready push', pushError);
        }
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    // AbortController is used ONLY to wake messageQueue.waitForMessages when idle.
    // Turn cancellation uses client.interruptTurn() — no AbortController hack needed.
    let abortController = new AbortController();
    let shouldExit = false;
    const nativeHistoryAbort = new AbortController();
    let nativeHistoryTask: Promise<void> | undefined;
    let terminationPromise: Promise<void> | null = null;

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort(restartBackend = true) {
        if (abortInProgress) {
            await abortInProgress;
            return;
        }

        logger.debug('[Codex] Abort requested - stopping current task');
        abortInProgress = (async () => {
            try {
                // Resolve any pending permission requests as 'abort' first.
                if (permissionHandler) {
                    permissionHandler.abortAll();
                }
                cancelQuestions();

                // Request interruption, then force-restart Codex app-server if
                // it doesn't settle quickly (long-running shell commands).
                if (client) {
                    const abortResult = await client.abortTurnWithFallback({
                        gracePeriodMs: 3000,
                        forceRestartOnTimeout: restartBackend,
                    });
                    if (abortResult.forcedRestart) {
                        logger.warn('[Codex] Forced app-server restart after interrupt timeout');
                        session.sendSessionEvent({
                            type: 'message',
                            message: abortResult.resumedThread
                                ? 'Force-stopped active task after interrupt timeout. Codex backend was restarted and the previous thread was resumed.'
                                : 'Force-stopped active task after interrupt timeout. Codex backend was restarted, but the previous thread could not be resumed.',
                        });
                    }
                }

                if (reasoningProcessor) {
                    reasoningProcessor.abort();
                }
                logger.debug('[Codex] Abort completed - session remains active');
            } catch (error) {
                logger.debug('[Codex] Error during abort:', error);
            } finally {
                resetCurrentModeDefaults();
                // Wake up message queue wait if idle
                abortController.abort();
                abortController = new AbortController();
            }
        })();

        await abortInProgress;
        abortInProgress = null;
    }

    // Unlike Stop, process termination must never start a replacement backend.
    // Await an already-running Stop before the final disconnect as well.
    function terminateSession(): Promise<void> {
        shouldExit = true;
        nativeHistoryAbort.abort();
        terminationPromise ??= (async () => {
            await handleAbort(false);
            await client?.disconnect();
        })().catch(error => logger.debug('[codex]: Error during termination', error));
        return terminationPromise;
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async () => {
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        try {
            // Update lifecycle state to archived before closing
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));
                
                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Force close Codex transport (best-effort) so we don't leave stray processes
            try {
                await client.disconnect();
            } catch (e) {
                logger.debug('[Codex] Error disconnecting Codex during termination', e);
            }

            // Stop Happy MCP server
            happyServer?.stop();

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', error);
            process.exit(1);
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', () => handleAbort());

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = !opts.nativeMobileDirectory && process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onSubmit: (text: string) => {
                session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text }));
                handleUserMessage({ role: 'user', content: { type: 'text', text } });
            },
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                await terminateSession();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    client = native?.client ?? new CodexAppServerClient(sandboxConfig, opts.nativeMobileDirectory ? join(opts.nativeMobileDirectory, 'b.sock') : undefined);
    let nativeLease: ChildProcess | undefined;
    let closeNativeFrontend: (() => Promise<void>) | undefined;
    const mobileUserMessageIds = new Set<string>();
    const nativeUserItems = new Set<string>();
    const forwardNativeUser = createSerialAsyncHandler<{ item: ThreadItem; turnId: string }>(async ({ item, turnId }) => {
        const envelopes = await buildCodexThreadBackfillEnvelopes({
            thread: { turns: [{ id: turnId, items: [item], status: 'inProgress' }] },
            uploadLocalImage: (attachment, imageOpts) => session.uploadLocalImageAttachmentEnvelope(attachment, imageOpts),
        });
        for (const envelope of envelopes) {
            if (envelope.role === 'user') session.sendSessionProtocolMessage(envelope);
        }
    }, error => logger.warn('[Codex] Could not forward native input', { errorName: error instanceof Error ? error.name : typeof error }));

    permissionHandler = new CodexPermissionHandler(session, !opts.nativeConfig);
    // Drop any permission requests left in agent state from a previous CLI
    // process that died while a tool prompt was open — see the matching
    // call in claudeRemoteLauncher for the full rationale.
    permissionHandler.reset('Previous CLI process exited before responding');
    reasoningProcessor = new ReasoningProcessor((message) => {
        const mapped = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        currentTurnId = mapped.currentTurnId;
        for (const envelope of mapped.envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const diffProcessor = new DiffProcessor((message) => {
        const mapped = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        currentTurnId = mapped.currentTurnId;
        for (const envelope of mapped.envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const updateCodexGoalState = (message: Record<string, unknown>) => {
        const capabilities = codexGoalActionCapabilities(client.supportsGoalActions());
        const goalStatus = mapCodexGoalEventToAgentGoalStatus(
            message,
            client.threadId,
            capabilities ? { capabilities } : undefined,
        );
        if (!goalStatus) {
            return;
        }
        session.updateAgentState((currentState) => ({
            ...currentState,
            agentGoalStatus: goalStatus,
        }));
    };
    const handleCodexGoalCommand = async (
        command: CodexGoalCommand,
        threadId: string,
    ): Promise<boolean> => {
        try {
            if (command.type === 'clear') {
                const result = await client.clearGoal({ threadId });
                if (result.cleared !== false) {
                    updateCodexGoalState({
                        type: 'thread_goal_cleared',
                        threadId,
                    });
                }
                messageBuffer.addMessage('Goal cleared', 'status');
                return true;
            }

            const result = await client.setGoal({
                threadId,
                objective: command.objective,
            });
            updateCodexGoalState({
                type: 'thread_goal_updated',
                threadId,
                goal: result.goal,
            });
            messageBuffer.addMessage('Goal updated', 'status');
            return true;
        } catch (error) {
            logger.debug('[Codex] Goal command API failed; falling back to normal turn:', error);
            return false;
        }
    };
    session.rpcHandlerManager.registerHandler('goal-action', async (params: Record<string, unknown>) => {
        const command = parseCodexGoalActionParams(params);
        if (!command) {
            throw new Error('Unsupported Codex goal action');
        }

        const threadId = client.threadId;
        if (!threadId) {
            throw new Error('No active Codex thread');
        }

        const handled = await handleCodexGoalCommand(command, threadId);
        if (!handled) {
            throw new Error('Codex goal actions are not supported by this runtime');
        }

        return { ok: true };
    });

    if (opts.nativeConfig) {
        client.setConfigurationHandler(config => {
            session.updateMetadata(meta => ({ ...meta, ...nativeConfigMetadata(config) }));
        });
    }

    client.setMcpElicitationHandler((request, signal) =>
        askMcpElicitation(questionForms, `codex-mcp-question:${randomUUID()}`, request, signal));

    // Native questions and MCP forms collect answers; tool approvals stay separate.
    client.setQuestionHandler(async (request, signal) => {
        const form = nativeQuestionForm(request.questions);
        const id = `codex-question:${randomUUID()}`;
        const cancel = (): void => questionForms.cancel(id);
        const waiting = questionForms.ask(id, form);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        try {
            const answers = await waiting;
            return answers ? nativeQuestionAnswers(form, answers) : { answers: {} };
        } finally {
            signal.removeEventListener('abort', cancel);
        }
    });

    client.setApprovalHandler(async (params, signal) => {
        const toolName = params.type === 'exec'
            ? 'CodexBash'
            : params.type === 'patch'
                ? 'CodexPatch'
                : (params.toolName ?? 'McpTool');
        const input = params.type === 'exec'
            ? { command: params.command, cwd: params.cwd }
            : params.type === 'patch'
                ? { changes: params.fileChanges }
                : (params.input ?? {});
        const activePermissionMode = activeTurnPermissionMode ?? remoteModeState.currentPermissionMode;
        // Check the latest session mode too: a turn pinned under an untrusted
        // policy keeps prompting after the user flips to yolo mid-turn
        // otherwise. Only when the mode was EXPLICITLY picked by the user —
        // the abort-reset restores the launch default (yolo for plain codex),
        // and a straggler approval from the dying turn (the ~3s abort grace
        // window, when the pinned turn mode is still set) must not be waved
        // through by that reset value.
        const latestPermissionMode = remoteModeState.currentPermissionModeExplicitlySet
            ? remoteModeState.currentPermissionMode
            : undefined;

        if (!opts.nativeConfig && (shouldAutoApproveCodexApproval(activePermissionMode, client.sandboxEnabled)
            || (latestPermissionMode !== undefined && shouldAutoApproveCodexApproval(latestPermissionMode, client.sandboxEnabled)))) {
            logger.debug(`[Codex] Auto-approving ${params.type} approval in ${activePermissionMode} mode (latest: ${latestPermissionMode ?? 'n/a'})`);
            return 'approved';
        }

        try {
            const result = await permissionHandler.handleToolCall(params.callId, toolName, input, signal);
            logger.debug('[Codex] Permission result:', result.decision);
            return result.decision;
        } catch (error) {
            logger.debug('[Codex] Error handling permission:', error);
            return 'denied';
        }
    });

    // Event handler: same EventMsg types as the legacy MCP server — no changes needed
    client.setEventHandler((msg) => {
        releaseGate.changed();
        if (msg.type === 'thread_name_updated') {
            const name = msg.name;
            if (opts.nativeMobileDirectory && msg.threadId === client.threadId && typeof name === 'string') {
                session.updateMetadata(current => ({
                    ...current,
                    summary: { text: name, updatedAt: Date.now() },
                }));
            }
            return;
        }
        if (msg.type === 'backend_disconnected') {
            cancelQuestions();
            if (opts.nativeMobileDirectory && !shouldExit) void terminateSession();
            return;
        }
        if (msg.type === 'native_user_message') {
            if (!opts.nativeMobileDirectory || msg.threadId !== client.threadId) return;
            const item = msg.item as ThreadItem & { clientId?: string };
            if (nativeUserItems.has(item.id)) return;
            nativeUserItems.add(item.id);
            if (item.clientId && mobileUserMessageIds.delete(item.clientId)) return;
            if (typeof msg.turnId === 'string') forwardNativeUser({ item, turnId: msg.turnId });
            return;
        }
        if (msg.type === 'user_questions') {
            const item = msg.item as AsyncQuestionItem;
            const form = asyncQuestionForm(item);
            if (form.length > 0) {
                const threadId = msg.threadId;
                const formId = `codex-async:${JSON.stringify([threadId, item.id])}`;
                questionForms.open(formId, form, async answers => {
                    if (!answers) return;
                    if (typeof threadId !== 'string' || threadId !== client.threadId) throw new QuestionDeliveryError('Question belongs to another Codex thread');
                    const text = asyncQuestionReply(form, answers);
                    if (client.turnId) {
                        try { await client.steerTurn(text); }
                        catch (error) {
                            if (error instanceof CodexRequestRejected && [-32600, -32602].includes(error.code)) throw new QuestionDeliveryError(error.message);
                            throw error;
                        }
                    } else {
                        await new Promise<void>((resolve, reject) => {
                            const questionReplyId = randomUUID();
                            queuedQuestionReplies.set(questionReplyId, { threadId, formId, resolve, reject });
                            messageQueue.pushIsolated(text, {
                                permissionMode: remoteModeState.currentPermissionMode,
                                model: remoteModeState.currentModel, effort: remoteModeState.currentEffort,
                                questionReplyId,
                            });
                        });
                    }
                });
            }
            return;
        }
        logger.debug(`[Codex] Event: ${JSON.stringify(msg)}`);
        const isSubagentScopedEvent = hasCodexSubagentReference(msg as Record<string, unknown>);

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage((msg as any).message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning' && !isSubagentScopedEvent) {
            messageBuffer.addMessage(`[Thinking] ${(msg as any).text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${(msg as any).command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = (msg as any).output || (msg as any).error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            // Ready is emitted from the main loop's idle check so pushes only fire once
            // after the queue is actually drained.
            const failure = describeCodexFailure(msg);
            if (failure) {
                messageBuffer.addMessage(`Task failed: ${failure}`, 'status');
                sendTurnFailure(msg, failure);
            } else {
                messageBuffer.addMessage('Task completed', 'status');
            }
        } else if (msg.type === 'turn_aborted') {
            const failure = describeCodexFailure(msg);
            if (failure) {
                messageBuffer.addMessage(`Turn aborted: ${failure}`, 'status');
                sendTurnFailure(msg, failure);
            } else {
                messageBuffer.addMessage('Turn aborted', 'status');
            }
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break' && !isSubagentScopedEvent) {
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta' && !isSubagentScopedEvent) {
            reasoningProcessor.processDelta((msg as any).delta);
        }
        if (msg.type === 'agent_reasoning' && !isSubagentScopedEvent) {
            reasoningProcessor.complete((msg as any).text);
        }
        if (msg.type === 'patch_apply_begin') {
            const { changes } = msg as any;
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        }
        if (msg.type === 'patch_apply_end') {
            const { stdout, stderr, success } = msg as any;
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
        }
        if (msg.type === 'turn_diff') {
            if ((msg as any).unified_diff) {
                diffProcessor.processDiff((msg as any).unified_diff);
            }
        }
        if (msg.type === 'thread_goal_updated' || msg.type === 'thread_goal_cleared') {
            updateCodexGoalState(msg);
        }

        // Convert events into the unified session-protocol envelope stream.
        // Reasoning deltas are handled by ReasoningProcessor to avoid duplicate text output.
        // Subagent-scoped reasoning bypasses the processor, so only forward the
        // FINAL agent_reasoning for subagents — the mapper renders deltas and
        // the final text identically, and forwarding both would emit one
        // thinking bubble per fragment plus a duplicate full-text bubble.
        const isReasoningEvent = msg.type === 'agent_reasoning_delta'
            || msg.type === 'agent_reasoning'
            || msg.type === 'agent_reasoning_section_break';
        const isForwardableSubagentReasoning = isSubagentScopedEvent && msg.type === 'agent_reasoning';
        if (msg.type !== 'turn_diff' && (!isReasoningEvent || isForwardableSubagentReasoning)) {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(msg, {
                currentTurnId,
                startedSubagents: codexStartedSubagents,
                activeSubagents: codexActiveSubagents,
                providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
                subagentTitles: codexSubagentTitles,
                collabReceiverThreadIdsByCall: codexCollabReceiverThreadIdsByCall,
                collabToolByCall: codexCollabToolByCall,
            });
            currentTurnId = mapped.currentTurnId;
            codexStartedSubagents = mapped.startedSubagents;
            codexActiveSubagents = mapped.activeSubagents;
            codexProviderSubagentToSessionSubagent = mapped.providerSubagentToSessionSubagent;
            codexSubagentTitles = mapped.subagentTitles;
            codexCollabReceiverThreadIdsByCall = mapped.collabReceiverThreadIdsByCall;
            codexCollabToolByCall = mapped.collabToolByCall;
            for (const envelope of mapped.envelopes) {
                if (nativeChat && msg.type === 'agent_message' && typeof msg.item_id === 'string' && envelope.ev.t === 'text') {
                    session.sendSessionProtocolMessage({ ...envelope, id: msg.item_id, codexItemId: msg.item_id });
                } else {
                    session.sendSessionProtocolMessage(envelope);
                }
            }
        }
    });

    // Start Happy MCP server (HTTP) and prepare STDIO bridge config for Codex
    const happyServer = opts.nativeConfig ? undefined : await startHappyServer(session);
    // Launch the bridge via `node <path>` (rather than relying on the .mjs shebang)
    // so it works on Windows, where Windows can't execute shebang scripts directly.
    // codex would otherwise fail to start the MCP server, the change_title tool would
    // not be visible to the model, and the model would improvise with shell echoes.
    const bridgeEntrypoint = join(projectPath(), 'bin', 'happy-mcp.mjs');
    const mcpServers = happyServer ? {
        happy: {
            command: process.execPath,
            args: ['--no-warnings', '--no-deprecation', bridgeEntrypoint, '--url', happyServer.url]
        }
    } : undefined;
    if (opts.nativeConfig) {
        session.sendSessionEvent({ type: 'message', message: 'Local Codex settings are active. Happy does not override the model, reasoning effort, permissions, hooks or MCP configuration. The compatible personal iPhone app shows these settings read-only; change them in Codex on the computer.' });
    }
    let first = true;
    let appendSystemPromptInjected = false;
    const removeTerminationHandlers = registerSessionTermination(() => {
        logger.debug('[codex]: Termination signal received; leaving session resumable');
        void terminateSession();
    });

    try {
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');

        let backendPid: number | undefined = native?.backendPid;
        if (opts.nativeMobileDirectory && !native) {
            backendPid = await client.nativeBackendPid();
            if (opts.resumeThreadId) nativeLease = await acquireNativeLease(opts.resumeThreadId, backendPid, () => { if (!shouldExit) void terminateSession(); });
        }

        if (opts.resumeThreadId) {
            await resumeExistingThread({
                client,
                session,
                messageBuffer,
                threadId: opts.resumeThreadId,
                cwd: process.cwd(),
                mcpServers,
                // Side chats start empty — keep the resume notice out of the UI.
                announce: !isSideChat,
            });
            first = false;
            appendSystemPromptInjected = true;
        }

        if (opts.nativeMobileDirectory) {
            let historyBoundary: string | null = null;
            let historyBoundaryError: unknown;
            if (!opts.resumeThreadId) {
                const started = await client.startThread({ cwd: process.cwd(), mcpServers });
                nativeLease = await acquireNativeLease(started.threadId, backendPid!, () => { if (!shouldExit) void terminateSession(); });
                await client.materializeNativeThread();
                session.updateMetadata(current => ({ ...current, codexThreadId: started.threadId }));
            } else {
                try {
                    // Freeze before the TUI can attach or queued phone input can
                    // start a new turn. Live turns must never be replayed as history.
                    const page = await client.listThreadTurns({ threadId: opts.resumeThreadId, sortDirection: 'desc', itemsView: 'notLoaded' });
                    historyBoundary = page.data[0]?.id ?? null;
                } catch (error) {
                    historyBoundaryError = error;
                }
            }
            if (nativeChat?.legacyHistoryPending && !historyBoundaryError) {
                // The owner permits a fresh mobile history baseline on migration.
                // Codex history stays untouched; only the display backfill boundary changes.
                nativeChat.historyBoundary = historyBoundary;
                nativeChat.historySeq = nativeHistorySnapshot?.seq ?? nativeChat.inputSeq;
                nativeChat.legacyHistoryPending = false;
                writeNativeChat(nativeChat);
            }
            if (!nativeChat) throw new Error('Native chat checkpoint is missing.');
            const chat = nativeChat;
            if (!chat.rewind) {
                if (historyBoundaryError) throw historyBoundaryError;
                const snapshot = nativeHistorySnapshot ?? await readNativeChatHistory(chat, opts.credentials, nativeHistoryAbort.signal);
                // Only the approved old mobile projection is reset. Unconsumed
                // phone input remains visible and its receipt never moves backwards.
                chat.rewind = { ...emptyNativeRewind(), legacyThroughSeq: snapshot.seq, legacyInputSeq: chat.inputSeq };
                chat.historyBoundary = historyBoundary;
                chat.historySeq = snapshot.seq;
                writeNativeChat(chat);
            }
            const rewind = new NativeRewindCoordinator({
                threadId: client.threadId!, sessionId: chat.sessionId, state: chat,
                persist: () => writeNativeChat(chat),
                publish: projection => session.updateMetadataConfirmed(current => ({ ...current, codexRewind: projection })),
                list: (cursor, itemsView, limit, timeoutMs) => client.listThreadTurns({ threadId: client.threadId!, cursor, sortDirection: 'desc', itemsView, limit }, timeoutMs),
                revert: beforeTurnId => client.nativeFrontendRequest('thread/revert', { threadId: client.threadId!, beforeTurnId }),
                active: () => client.turnId !== null,
                historySettled: () => nativeHistoryTask ?? Promise.resolve(),
            });
            await rewind.recover();
            await session.updateMetadataConfirmed(current => ({ ...current, codexRewind: chat.rewind }));
            client.nativeInputGate = send => rewind.input(send);
            nativeHistoryAbort.signal.throwIfAborted();
            first = false;
            const identity = { threadId: client.threadId!, sessionId: chat.sessionId, account: accountName!, cwd: process.cwd() };
            await activateStagedWorker(identity);
            const release = native?.release;
            if (native && release && accountName) {
                const localIdle = () => !shouldExit && waitingForPhone && !thinking && !abortInProgress && !historyBusy && !rpcInFlight
                    && !queuedQuestionReplies.size && !Object.keys(questionForms.snapshot().communications).length
                    && !messageQueue.size() && !handleUserMessage.busy() && !forwardNativeUser.busy() && !chat.rewindIntent
                    && client.nativeLocallyIdle() && session.nativeReleaseIdle?.() === true;
                const directory = opts.nativeMobileDirectory;
                const current = { ...identity, workerPid: process.pid, backendPid: backendPid!, release, handoff: 1 };
                native.control = await serveRelease(directory, current, releaseGate, async next => {
                    const backendIdle = () => client.nativeReleaseIdle(identity.threadId);
                    if (!await releaseGate.reserve(localIdle, backendIdle, () => recordRelease(directory, current, next))) {
                        if (!releaseGate.frozen && process.env.HAPPY_RELEASE_MAINTENANCE_ENTRY) {
                            releaseGate.retryWhenIdle(async () => {
                                if (!await releaseGate.inspectIdle(localIdle, backendIdle)) return false;
                                await requestReleaseMaintenance(next);
                                return true;
                            });
                        }
                        return 'deferred';
                    }
                    return new Promise<Outcome>(finish => {
                        native.replacement = { next, identity, finish };
                        shouldExit = true;
                        abortController.abort();
                    });
                });
            }
            closeNativeFrontend = await publishNativeMobileReady(opts.nativeMobileDirectory, client.threadId!, backendPid!, async (method, params) => {
                if (method !== 'thread/revert') return client.nativeFrontendRequest(method, params);
                // Record the selected native identifiers before any history read can time out.
                // The user's prompt and RPC payload stay out of the diagnostic.
                if (typeof params.beforeTurnId === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(params.beforeTurnId)) {
                    logger.debug('[Codex native] Terminal selected rewind boundary', { threadId: client.threadId, beforeTurnId: params.beforeTurnId });
                }
                const result = await rewind.revert(params);
                cancelQuestions();
                reasoningProcessor.abort();
                diffProcessor.reset();
                currentTurnId = null;
                return result;
            }, async () => {
                if (!chat.rewindIntent) return;
                try {
                    await rewind.recover();
                    logger.debug('[Codex native] Pending rewind reconciled on terminal resume', { threadId: client.threadId });
                } catch (error) {
                    // A concurrent rewind can reject after proving it did not
                    // change history, which also clears the saved intent.
                    if (!chat.rewindIntent) return;
                    logger.warn('[Codex native] Pending rewind could not synchronize on terminal resume', { threadId: client.threadId, error });
                    throw error;
                }
            }, release && accountName ? { gate: releaseGate, sessionId: chat.sessionId, release } : undefined);
            logger.debug('[Codex native] Live session ready', { threadId: client.threadId });
            if (opts.resumeThreadId) {
                const threadId = opts.resumeThreadId;
                historyBusy = true;
                nativeHistoryTask = (async () => {
                    const startedAt = Date.now();
                    let publishedTurns = 0;
                    try {
                        if (historyBoundaryError) throw historyBoundaryError;
                        if (historyBoundary === null || nativeChat?.historyBoundary === historyBoundary) return;
                        const snapshot = nativeHistorySnapshot ?? (nativeChat ? await readNativeChatHistory(nativeChat, opts.credentials, nativeHistoryAbort.signal) : undefined);
                        session.sendSessionEvent({ type: 'message', message: 'Codex is ready. Earlier messages are syncing to this chat; you can continue working.' });
                        const context = createCodexBackfillContext();
                        const turns = await syncNativeHistory({
                            client, threadId, boundaryId: historyBoundary, afterTurnId: nativeChat?.historyBoundary ?? undefined, signal: nativeHistoryAbort.signal,
                            publishTurn: async turn => {
                                for (const item of turn.items ?? []) if (item.type === 'userMessage') nativeUserItems.add(item.id);
                                const envelopes = await buildCodexThreadBackfillEnvelopes({
                                    thread: { turns: [{ ...turn, items: turn.items?.filter(item => !nativeChat || !isNativePhoneInput(item, nativeChat.sessionId)) }] }, context, signal: nativeHistoryAbort.signal,
                                    uploadLocalImage: (attachment, imageOpts) => session.uploadLocalImageAttachmentEnvelope(attachment, imageOpts, nativeHistoryAbort.signal),
                                });
                                await session.sendSessionProtocolHistory(snapshot ? unseenNativeHistory(envelopes, snapshot.envelopes) : envelopes, nativeHistoryAbort.signal);
                                publishedTurns++;
                                logger.debug('[Codex native history] Delivered turn', { threadId, publishedTurns, elapsedMs: Date.now() - startedAt });
                            },
                        });
                        nativeHistoryAbort.signal.throwIfAborted();
                        if (nativeChat && snapshot) {
                            nativeChat.historyBoundary = historyBoundary;
                            nativeChat.historySeq = snapshot.seq;
                            writeNativeChat(nativeChat);
                        }
                        session.sendSessionEvent({ type: 'message', message: 'Earlier Codex messages have finished syncing to this chat.' });
                        logger.debug('[Codex native history] Complete', { threadId, turns, elapsedMs: Date.now() - startedAt });
                    } catch (error) {
                        if (nativeHistoryAbort.signal.aborted) return;
                        logger.debug('[Codex native history] Incomplete', { threadId, publishedTurns, elapsedMs: Date.now() - startedAt, error });
                        session.sendSessionEvent({ type: 'message', message: 'Earlier messages did not finish syncing. Codex can still continue with its original context. Keep working; restart this mobile session later to retry history sync. Details are in the computer’s Happy log.' });
                    }
                })().finally(() => { historyBusy = false; releaseGate.changed(); });
            }
        }

        const forkCodexThreadId = process.env.HAPPY_FORK_CODEX_THREAD_ID;
        if (!reconnectSessionId && forkCodexThreadId) {
            // Side chats inherit the forked thread's context inside the model
            // (thread/fork copies it), but we deliberately do NOT replay the
            // pre-fork history into the UI: a side chat starts empty from the
            // moment it was opened, so the user only sees the aside they began.
            if (!isSideChat) {
                try {
                    const { thread } = await client.readThread({
                        threadId: forkCodexThreadId,
                        includeTurns: true,
                    });
                    const envelopes = await buildCodexThreadBackfillEnvelopes({
                        thread,
                        uploadLocalImage: (attachment, imageOpts) => (
                            session.uploadLocalImageAttachmentEnvelope(attachment, imageOpts)
                        ),
                    });
                    for (const envelope of envelopes) {
                        session.sendSessionProtocolMessage(envelope);
                    }
                    logger.debug(`[CODEX FORK BACKFILL] Replayed ${envelopes.length} historical envelopes from thread ${forkCodexThreadId}`);
                } catch (error) {
                    logger.debug(`[CODEX FORK BACKFILL] Failed to read thread ${forkCodexThreadId}:`, error);
                }
            }
            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                codexThreadId: forkCodexThreadId,
            }));
        }

        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string; attachments?: PendingAttachment[] } | null = null;

        while (!shouldExit) {
            logActiveHandles('loop-top');
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string; attachments?: PendingAttachment[] } | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                waitingForPhone = true;
                releaseGate.changed();
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                waitingForPhone = false;
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            const questionReplyId = message.mode.questionReplyId;
            const questionReply = questionReplyId ? queuedQuestionReplies.get(questionReplyId) : undefined;
            if (questionReplyId && (!questionReply || questionReply.threadId !== client.threadId)) {
                questionReply?.reject(new QuestionDeliveryError('Question thread changed before submission'));
                queuedQuestionReplies.delete(questionReplyId);
                continue;
            }

            if (isCodexClearText(message.message)) {
                cancelQuestions();
                logger.debug('[Codex] Handling /clear command - resetting Codex thread state');
                client.clearThreadState();
                currentTurnId = null;
                codexStartedSubagents = new Set<string>();
                codexActiveSubagents = new Set<string>();
                codexProviderSubagentToSessionSubagent = new Map<string, string>();
                codexSubagentTitles = new Map<string, string>();
                codexCollabReceiverThreadIdsByCall = new Map<string, string[]>();
                codexCollabToolByCall = new Map<string, string>();
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                appendSystemPromptInjected = false;
                thinking = false;
                session.keepAlive(thinking, 'remote');
                messageBuffer.addMessage('Context was reset', 'status');
                session.sendSessionEvent({ type: 'message', message: 'Context was reset' });
                session.updateMetadata((currentMetadata) => {
                    const nextMetadata = { ...currentMetadata };
                    delete nextMetadata.codexThreadId;
                    return nextMetadata;
                });
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                continue;
            }

            // Display user messages in the UI
            if (message.message.trim().length > 0) {
                messageBuffer.addMessage(message.message, 'user');
            }

            try {
                // Map permission mode to approval policy and sandbox.
                // With app-server, these are per-turn — no restart needed on mode change.
                const sandboxManagedByHappy = client.sandboxEnabled;
                const executionPolicy = opts.nativeConfig ? { approvalPolicy: undefined, sandbox: undefined } : resolveCodexExecutionPolicy(
                    message.mode.permissionMode,
                    sandboxManagedByHappy,
                );
                activeTurnPermissionMode = message.mode.permissionMode;

                // Start thread on first turn (thread persists across mode changes)
                let activeThreadId = client.threadId;
                if (!client.hasActiveThread() || !activeThreadId) {
                    const startedThread = await client.startThread({
                        model: message.mode.model,
                        cwd: process.cwd(),
                        approvalPolicy: executionPolicy.approvalPolicy,
                        sandbox: executionPolicy.sandbox,
                        mcpServers,
                    });
                    activeThreadId = startedThread.threadId;
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        codexThreadId: startedThread.threadId,
                    }));
                }

                const goalCommand = parseCodexGoalCommand(message.message);
                if (goalCommand && await handleCodexGoalCommand(goalCommand, activeThreadId)) {
                    continue;
                }

                const includeAppendSystemPrompt = Boolean(
                    message.mode.appendSystemPrompt && !appendSystemPromptInjected,
                );
                const imageInputs = await prepareCodexImageInputItems(message.attachments, {
                    sessionId: session.sessionId,
                });
                if ((message.attachments?.length ?? 0) > 0) {
                    logger.debug('[Codex] Prepared image inputs for turn', {
                        inputCount: imageInputs.inputItems.length,
                        skippedCount: imageInputs.skipped,
                    });
                }
                const hasUserText = message.message.trim().length > 0;
                if ((message.attachments?.length ?? 0) > 0 && imageInputs.inputItems.length === 0 && !hasUserText) {
                    session.sendSessionEvent({
                        type: 'message',
                        message: 'No supported images were available to send to Codex.',
                    });
                    continue;
                }
                const turnPrompt = buildCodexTurnPrompt({
                    message: message.message,
                    mode: message.mode,
                    includeAppendSystemPrompt,
                    includeTitleInstruction: first && !opts.nativeConfig,
                });

                // A signal may have arrived while thread/image preparation awaited I/O.
                if (shouldExit) break;
                const consumedInputSeq = nativeChat ? Math.max(nativeChat.inputSeq, ...messageQueue.consumedModes(message!).map(mode => mode.receivedSeq ?? 0)) : 0;
                const clientUserMessageId = nativeChat ? nativePhoneInputId(nativeChat.sessionId,
                    consumedInputSeq > nativeChat.inputSeq ? [nativeChat.inputSeq + 1, consumedInputSeq] : undefined)
                    : opts.nativeMobileDirectory ? randomUUID() : undefined;
                if (clientUserMessageId) mobileUserMessageIds.add(clientUserMessageId);
                const result = await client.sendTurnAndWait(turnPrompt, {
                    clientUserMessageId,
                    beforeSend: () => {
                        if (shouldExit) throw new Error('Session stopped before input submission');
                        if (nativeChat) {
                            nativeChat.inputSeq = Math.max(nativeChat.inputSeq, consumedInputSeq);
                            writeNativeChat(nativeChat);
                        }
                    },
                    model: message.mode.model,
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                    effort: message.mode.effort,
                    extraInputItems: imageInputs.inputItems,
                    onAccepted: () => {
                        questionReply?.resolve();
                        if (questionReplyId) queuedQuestionReplies.delete(questionReplyId);
                    },
                });
                first = false;
                if (includeAppendSystemPrompt) {
                    appendSystemPromptInjected = true;
                }

                if (result.aborted) {
                    // Turn was aborted (user abort or permission cancel).
                    // UI handling already done by the event handler (turn_aborted).
                    logger.debug('[Codex] Turn aborted');
                }
            } catch (error) {
                if (error instanceof NativeRewindRecoveryError) {
                    logger.warn('[Codex native] Rewind reconciliation failed; input receipt remains unchanged', error);
                    session.sendSessionEvent({ type: 'message', message: error.message });
                    await terminateSession();
                    break;
                }
                if (questionReply) {
                    questionReply.reject(error instanceof CodexRequestRejected && [-32600, -32602].includes(error.code)
                        ? new QuestionDeliveryError(error.message)
                        : error instanceof Error ? error : new Error('Question delivery failed'));
                    if (questionReplyId) queuedQuestionReplies.delete(questionReplyId);
                }
                // Only actual errors reach here (process crash, connection failure, etc.)
                logger.warn('Error in codex session:', error);
                messageBuffer.addMessage('Process exited unexpectedly', 'status');
                session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                activeTurnPermissionMode = undefined;
                thinking = false;
                session.keepAlive(thinking, 'remote');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } finally {
        // Clean up resources when main loop exits
        releaseGate.cancelRetry();
        shouldExit = true;
        nativeHistoryAbort.abort();
        clearInterval(keepAliveInterval);
        cancelQuestions();
        await closeNativeFrontend?.();
        await terminationPromise;
        if (nativeHistoryTask) {
            // Reject an in-flight history RPC before waiting for its owner task.
            await client.disconnect();
            await nativeHistoryTask;
        }
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');

        // Cancel offline reconnection if still running
        if (reconnectionHandle) {
            logger.debug('[codex]: Cancelling offline reconnection');
            reconnectionHandle.cancel();
        }

        try {
            logger.debug('[codex]: sendSessionDeath');
            session.sendSessionDeath();
            // Match Claude's graceful shutdown: confirm inactive over HTTP
            // before closing the socket, without archiving session metadata.
            const deactivated = await api.deactivateSession(session.sessionId);
            logger.debug(`[codex]: Session deactivation confirmed=${deactivated}`);
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch (e) {
            logger.debug('[codex]: Error while closing session', e);
        }
        logger.debug('[codex]: client.disconnect begin');
        await client.disconnect();
        nativeLease?.stdin?.end();
        logger.debug('[codex]: client.disconnect done');
        // Stop Happy MCP server
        logger.debug('[codex]: happyServer.stop');
        happyServer?.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        // Clear periodic keep-alive to avoid keeping event loop alive
        logger.debug('[codex]: clearInterval(keepAlive)');
        clearInterval(keepAliveInterval);
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
        removeTerminationHandlers();
    }
}
