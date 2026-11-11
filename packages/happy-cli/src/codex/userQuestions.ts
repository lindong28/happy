/** Adapts Codex questions to Happy's existing communication form protocol. */
export type Question = {
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    allowCustom: boolean;
    multiSelect: boolean;
    required: boolean;
};

export type QuestionAnswers = Record<string, { options: string[]; custom?: string }>;
export type NativeQuestion = {
    id: string;
    header: string;
    question: string;
    options?: Array<{ label: string; description?: string }> | null;
    isOther?: boolean;
    isSecret?: boolean;
};
export type NativeQuestionResponse = { answers: Record<string, { answers: string[] }> };
export type AsyncQuestionItem = {
    id: string;
    type: string;
    delivery?: string | null;
    questions?: Array<{ title: string; options?: string[] | null }> | null;
};

export function nativeQuestionForm(questions: NativeQuestion[]): Question[] {
    return questions.map(question => {
        if (question.isSecret) throw new Error('Secret questions require the native Codex interface');
        return {
            id: question.id, header: question.header, question: question.question,
            options: question.options ?? [], allowCustom: true, multiSelect: false, required: true,
        };
    });
}

export function nativeQuestionAnswers(questions: Question[], answers: QuestionAnswers): NativeQuestionResponse {
    return { answers: Object.fromEntries(questions.map(question => {
        const answer = answers?.[question.id];
        if (answer === undefined && !question.required) return [question.id, { answers: [] }];
        if (!answer || !Array.isArray(answer.options)
            || answer.options.some(option => !question.options.some(known => known.label === option))
            || (!question.multiSelect && answer.options.length > 1)
            || (answer.custom !== undefined && typeof answer.custom !== 'string')) {
            throw new Error('Invalid question answer');
        }
        const custom = answer.custom?.trim();
        const values = [...answer.options, ...(custom ? [custom] : [])];
        if (question.required && values.length === 0) throw new Error('An answer is required');
        return [question.id, { answers: values }];
    })) };
}

export function asyncQuestionForm(item: AsyncQuestionItem): Question[] {
    if (item.type !== 'agentMessage' || item.delivery !== 'async') return [];
    return (item.questions ?? []).map((question, index) => ({
        id: JSON.stringify(['request_user_input_async', item.id, index]),
        header: '', question: question.title,
        options: (question.options ?? []).map(label => ({ label })),
        allowCustom: true, multiSelect: false, required: true,
    }));
}

export function asyncQuestionReply(questions: Question[], answers: QuestionAnswers): string {
    const native = nativeQuestionAnswers(questions, answers);
    return `<send_user_message_question_reply>\n${JSON.stringify(questions.map(question => ({
        questionItemId: question.id, question: question.question,
        answer: native.answers[question.id].answers.join('\n'),
    })))}\n</send_user_message_question_reply>`;
}
