/** Pending questions use Happy's encrypted agent state and communication RPC. */
import { EventEmitter } from 'node:events';
import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';
import { nativeQuestionAnswers, type Question, type QuestionAnswers } from './userQuestions';

type Form = { kind: 'form'; createdAt: number; form: { questions: Question[] } };
type CompletedForm = Form & { completedAt: number; status: 'answered' | 'cancelled'; answers?: QuestionAnswers };
type PendingForm = { form: Form; submit: (answers: QuestionAnswers | null) => Promise<void>; submitting: boolean };
/** A known rejection before delivery is safe for the user to retry. */
export class QuestionDeliveryError extends Error {}
export type QuestionFormState = {
    communications: Record<string, Form>;
    completedCommunications: Record<string, CompletedForm>;
};

/** Choice forms render inline on iOS only when joined to a chat tool call. */
export function bindQuestionFormDisplay(
    forms: QuestionForms,
    send: (message: SessionEnvelope) => void,
    getTurnId: () => string | null,
): void {
    const activeTurns = new Map<string, string>();
    forms.on('change', (state: QuestionFormState) => {
        for (const [id, form] of Object.entries(state.communications)) {
            if (activeTurns.has(id)) continue;
            // Async questions may arrive without an active turn. Agent messages
            // without a turn are discarded by the native iOS normalizer.
            const turn = getTurnId() ?? `codex-question:${id}`;
            send(createEnvelope('agent', {
                t: 'tool-call-start', call: id, name: 'request_user_input',
                title: 'Question', description: 'Waiting for your answer',
                args: form.form,
            }, { turn }));
            activeTurns.set(id, turn);
        }
        for (const [id, turn] of activeTurns) {
            if (!state.completedCommunications[id]) continue;
            send(createEnvelope('agent', { t: 'tool-call-end', call: id }, { turn }));
            activeTurns.delete(id);
        }
    });
}

export class QuestionForms extends EventEmitter {
    private pending = new Map<string, PendingForm>();
    private completed: Record<string, CompletedForm> = {};

    snapshot(): QuestionFormState {
        return {
            communications: Object.fromEntries([...this.pending].map(([id, pending]) => [id, pending.form])),
            completedCommunications: { ...this.completed },
        };
    }

    open(id: string, questions: Question[], submit: PendingForm['submit']): void {
        if (this.pending.has(id) || this.completed[id]) return;
        this.pending.set(id, { form: { kind: 'form', createdAt: Date.now(), form: { questions } }, submit, submitting: false });
        this.emit('change', this.snapshot());
    }

    ask(id: string, questions: Question[]): Promise<QuestionAnswers | null> {
        if (this.pending.has(id) || this.completed[id]) throw new Error('Question id already exists');
        return new Promise(resolve => this.open(id, questions, async answers => { resolve(answers); }));
    }

    async reply(value: unknown): Promise<{ ok: true }> {
        if (!value || typeof value !== 'object') throw new Error('Invalid communication reply');
        const reply = value as { id?: unknown; kind?: unknown; status?: unknown; answers?: QuestionAnswers };
        const pending = typeof reply.id === 'string' ? this.pending.get(reply.id) : undefined;
        if (!pending || typeof reply.id !== 'string') throw new Error('Question no longer pending');
        if (reply.kind !== 'form' || (reply.status !== 'answered' && reply.status !== 'cancelled')) throw new Error('Invalid communication reply');
        if (reply.status === 'cancelled') {
            this.cancel(reply.id);
            return { ok: true };
        }
        if (pending.submitting) throw new Error('Previous delivery not confirmed; inspect the session before resending');
        const answers = reply.status === 'answered' ? reply.answers : null;
        if (answers !== null) nativeQuestionAnswers(pending.form.form.questions, answers ?? {});
        pending.submitting = true;
        try {
            await pending.submit(answers ?? null);
        } catch (error) {
            if (error instanceof QuestionDeliveryError) pending.submitting = false;
            // Unknown delivery remains non-retryable until reconciled; cancellation is still allowed.
            this.emit('submissionError', reply.id);
            throw error;
        }
        if (this.pending.get(reply.id) === pending) {
            this.pending.delete(reply.id);
            this.completed[reply.id] = {
                ...pending.form, completedAt: Date.now(), status: reply.status,
                ...(answers ? { answers } : {}),
            };
            this.emit('change', this.snapshot());
        }
        return { ok: true };
    }

    cancelAll(): void {
        for (const id of this.pending.keys()) this.cancel(id);
    }

    cancel(id: string): void {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.completed[id] = { ...pending.form, completedAt: Date.now(), status: 'cancelled' };
        this.emit('cancel', id);
        if (!pending.submitting) void pending.submit(null).catch(() => this.emit('submissionError', id));
        this.emit('change', this.snapshot());
    }
}
