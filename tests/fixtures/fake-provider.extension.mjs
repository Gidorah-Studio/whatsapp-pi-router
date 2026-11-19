// Test-only model provider: answers with a JSON report of what the model was given,
// so tests can assert on history, tools, images and context without a real provider.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function partsOf(message) {
    return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
}

function toolCall(name, args) {
    return { content: [{ type: 'toolCall', id: 'call-1', name, arguments: args }], stopReason: 'toolUse' };
}

function nextStep(context, options) {
    const users = context.messages.filter(message => message.role === 'user');
    const lastParts = partsOf(users.at(-1));
    const text = lastParts.filter(part => part.type === 'text').map(part => part.text).join('');
    const toolResults = context.messages.filter(message => message.role === 'toolResult').length;
    if (text.includes('HANG')) return undefined;
    if (text.includes('FAIL')) {
        return { content: [], stopReason: 'error', errorMessage: 'provider secret sk-test-123 rejected' };
    }
    const command = /RUN_BASH<(.+?)>/s.exec(text)?.[1];
    if (command && toolResults === 0) return toolCall('bash', { command });
    const image = /SEND_IMAGE<(.+?)>/.exec(text)?.[1];
    if (image && toolResults === 0) return toolCall('send_wa_image', { path: image, caption: 'chart' });
    const report = {
        turns: users.length,
        text,
        images: lastParts.filter(part => part.type === 'image').length,
        tools: (context.tools ?? []).map(tool => tool.name).sort(),
        reasoning: options?.reasoning ?? null,
        contextInSystemPrompt: (context.systemPrompt ?? '').includes('[Temporary WhatsApp reply context'),
        contextInUserMessages: users.some(message => partsOf(message)
            .some(part => part.type === 'text' && part.text.includes('[Temporary WhatsApp reply context'))),
        toolResults,
    };
    return { content: [{ type: 'text', text: JSON.stringify(report) }], stopReason: 'stop' };
}

export default function (pi) {
    pi.registerTool({
        name: 'extra_tool',
        label: 'Extra Tool',
        description: 'Extension tool used to check tool allowlists.',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'extra' }], details: undefined }; },
    });
    pi.registerProvider('fake', {
        baseUrl: 'http://127.0.0.1:9',
        apiKey: 'unused',
        api: 'fake-api',
        models: [{
            id: 'echo', name: 'Echo', reasoning: true, input: ['text', 'image'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
        }],
        streamSimple(model, context, options) {
            const stream = createAssistantMessageEventStream();
            const step = nextStep(context, options);
            if (!step) {
                // Hold the process open like a provider that never answers.
                setInterval(() => {}, 1000);
                return stream;
            }
            const message = {
                role: 'assistant', api: model.api, provider: model.provider, model: model.id,
                usage, timestamp: Date.now(), ...step,
            };
            queueMicrotask(() => {
                stream.push({ type: 'start', partial: message });
                stream.push(message.stopReason === 'error'
                    ? { type: 'error', reason: 'error', error: message }
                    : { type: 'done', reason: message.stopReason, message });
                stream.end();
            });
            return stream;
        },
    });
}
