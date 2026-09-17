import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import registerChild from '../src/child-whatsapp-media.extension.js';

test('reply context is transient system text, never a conversational message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reply-context-'));
    const previous = process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR;
    let before: ((event: any) => Promise<any>) | undefined;
    const pi = { registerTool() {}, on(name: string, callback: any) { if (name === 'before_agent_start') before = callback; } } as unknown as ExtensionAPI;
    try {
        registerChild(pi);
        assert(before);
        process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR = root;
        const context = { version: 1, conversationJid: 'approved@g.us', recentMessages: [{ messageId: '1', text: 'BACKGROUND_ONLY_CANARY', direction: 'incoming', timestamp: 1 }], quoted: { kind: 'text', provenance: 'WhatsApp', text: 'QUOTED_ONLY_CANARY' } };
        await writeFile(join(root, 'reply-context.json'), JSON.stringify(context));
        const event = { systemPrompt: 'BASE_RULES', prompt: 'ghost explain this', messages: [{ role: 'user', content: 'ghost explain this' }] };
        const snapshot = JSON.stringify(event);
        const result = await before(event);
        assert.deepEqual(Object.keys(result), ['systemPrompt']);
        assert(result.systemPrompt.includes('BACKGROUND_ONLY_CANARY'));
        assert(result.systemPrompt.includes('QUOTED_ONLY_CANARY'));
        assert.equal(JSON.stringify(event), snapshot);
        // The standard Honcho extension saves agent_end user/assistant messages, not systemPrompt.
        assert(!JSON.stringify(event.messages).includes('CANARY'));
        delete process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR;
        assert.equal(await before(event), undefined);
    } finally {
        if (previous === undefined) delete process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR;
        else process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR = previous;
        await rm(root, { recursive: true, force: true });
    }
});

test('invalid/oversized context fails to a clarification instruction, not stale context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reply-context-invalid-'));
    const previous = process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR;
    let before: ((event: any) => Promise<any>) | undefined;
    try {
        registerChild({ registerTool() {}, on(name: string, fn: any) { if (name === 'before_agent_start') before = fn; } } as unknown as ExtensionAPI);
        assert(before);
        process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR = root;
        assert.equal(await before({ systemPrompt: 'base' }), undefined);
        for (const content of ['invalid JSON', 'x'.repeat(100000), JSON.stringify({ version: 1, recentMessages: Array(51).fill({}), conversationJid: 'group' })]) {
            await writeFile(join(root, 'reply-context.json'), content);
            const result = await before({ systemPrompt: 'base' });
            assert(result.systemPrompt.includes('Ask the user to specify the target'));
            assert(!result.systemPrompt.includes(root));
        }
    } finally {
        if (previous === undefined) delete process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR;
        else process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR = previous;
        await rm(root, { recursive: true, force: true });
    }
});
