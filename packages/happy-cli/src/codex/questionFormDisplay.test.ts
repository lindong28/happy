import { describe, expect, it } from 'vitest';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { QuestionForms, bindQuestionFormDisplay } from './questionForms';
import { nativeQuestionForm } from './userQuestions';

describe('question form chat display', () => {
    const questions = nativeQuestionForm([{ id: 'q', header: 'Choose', question: 'Pick a value', options: [{ label: 'A' }, { label: 'B' }] }]);

    it.each(['answered', 'cancelled'] as const)('joins a pending form to a renderable tool call and finishes it when %s', async status => {
        const forms = new QuestionForms();
        const messages: SessionEnvelope[] = [];
        let turn: string | null = 'original-turn';
        bindQuestionFormDisplay(forms, message => messages.push(message), () => turn);
        forms.open('form-one', questions, async () => {});
        const start = messages[0];
        // iOS ChatNormalizer requires an agent turn; ChatRowsPipeline joins
        // request_user_input.call to the communication's toolUseId or id.
        expect(start).toMatchObject({ role: 'agent', turn: 'original-turn', ev: {
            t: 'tool-call-start', call: 'form-one', name: 'request_user_input', args: { questions },
        } });
        turn = 'later-turn';
        await forms.reply({ id: 'form-one', kind: 'form', status, answers: { q: { options: ['A'] } } });
        expect(messages[1]).toMatchObject({ turn: 'original-turn', ev: { t: 'tool-call-end', call: 'form-one' } });
        expect(messages).toHaveLength(2);
    });

    it('renders questions outside a current turn and does not duplicate calls on other state updates', () => {
        const forms = new QuestionForms();
        const messages: SessionEnvelope[] = [];
        bindQuestionFormDisplay(forms, message => messages.push(message), () => null);
        forms.open('first', questions, async () => {});
        forms.open('second', questions, async () => {});
        expect(messages).toHaveLength(2);
        expect(messages[0].turn).toBeTruthy();
        expect(messages[1].turn).toBeTruthy();
        expect(messages[0].turn).not.toBe(messages[1].turn);
        forms.cancelAll();
        expect(messages).toHaveLength(4);
        forms.cancelAll();
        expect(messages).toHaveLength(4);
    });
});
