/** Native question identities and replies must survive the mobile form round trip. */
import { describe, expect, it } from 'vitest';
import { asyncQuestionForm, nativeQuestionForm, nativeQuestionAnswers, asyncQuestionReply } from './userQuestions';

describe('Codex question forms', () => {
    const native = [{ id: 'route', header: 'Route', question: 'Which route?', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }], isOther: true, isSecret: false }];

    it('preserves native question ids, labels and custom answers', () => {
        const form = nativeQuestionForm(native);
        expect(form[0]).toMatchObject({ id: 'route', question: 'Which route?', allowCustom: true, options: native[0].options });
        expect(nativeQuestionAnswers(form, { route: { options: ['B'] } })).toEqual({ answers: { route: { answers: ['B'] } } });
        expect(nativeQuestionAnswers(form, { route: { options: [], custom: 'another route' } })).toEqual({ answers: { route: { answers: ['another route'] } } });
    });

    it('rejects missing answers and unknown choices without resolving the question', () => {
        const form = nativeQuestionForm(native);
        expect(() => nativeQuestionAnswers(form, {})).toThrow();
        expect(() => nativeQuestionAnswers(form, { route: { options: ['C'] } })).toThrow();
    });

    it('keeps free text questions answerable and refuses to expose secret input as a plain form', () => {
        expect(nativeQuestionForm([{ id: 'text', header: '', question: 'Describe it' }])[0].allowCustom).toBe(true);
        expect(() => nativeQuestionForm([{ ...native[0], isSecret: true }])).toThrow();
    });

    it('uses native async identities for each question, even with no assistant text', () => {
        const item = { id: 'call-1', type: 'agentMessage', text: '', delivery: 'async', questions: [{ title: 'First?', options: ['Yes', 'No'] }, { title: 'Details?' }] };
        const form = asyncQuestionForm(item);
        expect(form.map(q => q.id)).toEqual(['["request_user_input_async","call-1",0]', '["request_user_input_async","call-1",1]']);
        const reply = asyncQuestionReply(form, { [form[0].id]: { options: ['No'] }, [form[1].id]: { options: [], custom: 'a < b' } });
        expect(JSON.parse(reply.slice(reply.indexOf('>') + 1, reply.lastIndexOf('<')))).toEqual([
            { questionItemId: form[0].id, question: 'First?', answer: 'No' },
            { questionItemId: form[1].id, question: 'Details?', answer: 'a < b' },
        ]);
        expect(asyncQuestionForm({ ...item, delivery: null })).toEqual([]);
    });
});
