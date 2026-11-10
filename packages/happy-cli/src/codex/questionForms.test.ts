/** The form lifecycle is independent of the relay connection. */
import { describe, expect, it } from 'vitest';
import { QuestionForms, QuestionDeliveryError } from './questionForms';
import { nativeQuestionForm } from './userQuestions';

describe('QuestionForms', () => {
    const questions = nativeQuestionForm([{ id: 'q', header: '', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }]);

    it('holds a native request until a valid reply, then rejects duplicate submission', async () => {
        const forms = new QuestionForms();
        const waiting = forms.ask('native-1', questions);
        expect(forms.snapshot().communications['native-1'].form.questions).toEqual(questions);
        await expect(forms.reply({ id: 'native-1', kind: 'form', status: 'answered', answers: {} })).rejects.toThrow();
        expect(forms.snapshot().communications['native-1']).toBeDefined();
        await forms.reply({ id: 'native-1', kind: 'form', status: 'answered', answers: { q: { options: ['A'] } } });
        expect(await waiting).toEqual({ q: { options: ['A'] } });
        expect(forms.snapshot().communications['native-1']).toBeUndefined();
        expect(forms.snapshot().completedCommunications['native-1'].status).toBe('answered');
        await expect(forms.reply({ id: 'native-1', kind: 'form', status: 'answered', answers: { q: { options: ['B'] } } })).rejects.toThrow();
    });

    it('cancels only the requested form, and withdraws pending forms on backend loss', async () => {
        const forms = new QuestionForms();
        const first = forms.ask('one', questions);
        const second = forms.ask('two', questions);
        await forms.reply({ id: 'one', kind: 'form', status: 'cancelled' });
        expect(await first).toBeNull();
        expect(forms.snapshot().communications.two).toBeDefined();
        forms.cancelAll();
        expect(await second).toBeNull();
        expect(forms.snapshot().communications).toEqual({});
    });

    it('allows retry after explicit rejection but does not replay an uncertain delivery', async () => {
        const forms = new QuestionForms();
        let attempts = 0;
        forms.open('rejected', questions, async () => {
            if (++attempts === 1) throw new QuestionDeliveryError('Rejected before acceptance');
        });
        const reply = { id: 'rejected', kind: 'form', status: 'answered', answers: { q: { options: ['A'] } } };
        await expect(forms.reply(reply)).rejects.toThrow();
        await forms.reply(reply);
        expect(attempts).toBe(2);
        forms.open('uncertain', questions, async () => { throw new Error('Lost acknowledgement'); });
        await expect(forms.reply({ ...reply, id: 'uncertain' })).rejects.toThrow();
        await expect(forms.reply({ ...reply, id: 'uncertain' })).rejects.toThrow('not confirmed');
        await forms.reply({ id: 'uncertain', kind: 'form', status: 'cancelled' });
        expect(forms.snapshot().communications.uncertain).toBeUndefined();
    });

    it('notifies the queue when an individual pending submission is cancelled', async () => {
        const forms = new QuestionForms();
        let rejectSubmission: (error: Error) => void = () => { throw new Error('Not queued'); };
        forms.open('queued', questions, async () => new Promise<void>((_resolve, reject) => { rejectSubmission = reject; }));
        const submission = forms.reply({ id: 'queued', kind: 'form', status: 'answered', answers: { q: { options: ['A'] } } });
        forms.on('cancel', (id: string) => {
            expect(id).toBe('queued');
            rejectSubmission(new QuestionDeliveryError('Cancelled'));
        });
        await forms.reply({ id: 'queued', kind: 'form', status: 'cancelled' });
        await expect(submission).rejects.toThrow('Cancelled');
        expect(forms.snapshot().completedCommunications.queued.status).toBe('cancelled');
    });
});
