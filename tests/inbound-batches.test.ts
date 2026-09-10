import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { SessionManager } from '../src/services/session.manager.js';
import { WhatsAppService } from '../src/services/whatsapp.service.js';

const jid = '123@g.us';
const message = (id: string, fromMe = false) => ({
    key: { id, remoteJid: jid, participant: '456@s.whatsapp.net', fromMe },
    message: { conversation: 'hello' },
});
async function harness() {
    const root = await mkdtemp(join(tmpdir(), 'router-batches-'));
    const manager = new SessionManager(root, join(root, 'missing'));
    await manager.ensureInitialized();
    await manager.addAllowedGroup(jid, 'Test');
    await manager.setStatus('connected');
    const service = new WhatsAppService(manager);
    (service as any).socket = { user: { id: '789@s.whatsapp.net' }, async groupMetadata() { return { id: jid, subject: 'Test', participants: [] }; } };
    return { service, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('routes every eligible batch member, skips self messages, deduplicates overlapping events', async () => {
    const h = await harness();
    try {
        const routed: string[] = [];
        const recorded: string[] = [];
        h.service.setIncomingMessageRecorder(message => { recorded.push(message.id); });
        h.service.setMessageCallback(payload => { routed.push(payload.messages![0].key.id!); });
        await Promise.all([
            h.service.handleIncomingMessages({ type: 'notify', messages: [message('self', true), message('A'), message('B')] }),
            h.service.handleIncomingMessages({ type: 'notify', messages: [message('A'), message('C')] }),
        ]);
        assert.deepEqual(routed, ['A', 'B', 'C']);
        await h.service.handleIncomingMessages({ type: 'append', messages: [message('offline'), message('A')] });
        await h.service.handleIncomingMessages({ type: 'append', messages: [message('offline')] });
        assert.deepEqual(routed, ['A', 'B', 'C', 'offline']);
        assert.deepEqual(recorded, ['A', 'B', 'A', 'C', 'offline', 'A', 'offline']);
        await h.service.drainIncoming();
    } finally { await h.cleanup(); }
});

test('async callback failures are observed without blocking later admissions or rerunning failures', async () => {
    const h = await harness();
    try {
        const routed: string[] = [];
        h.service.setMessageCallback(async payload => {
            routed.push(payload.messages![0].key.id!);
            if (payload.messages![0].key.id === 'A') throw new Error('provider secret must not be logged');
        });
        await h.service.handleIncomingMessages({ messages: [message('A'), message('B')] });
        await setImmediate();
        await h.service.handleIncomingMessages({ messages: [message('A')] });
        assert.deepEqual(routed, ['A', 'B']);
    } finally { await h.cleanup(); }
});

test('a long-running callback does not block other conversations from being admitted', async () => {
    const h = await harness();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    try {
        const routed: string[] = [];
        h.service.setMessageCallback(payload => {
            const id = payload.messages![0].key.id!;
            routed.push(id);
            return id === 'A' ? blocked : undefined;
        });
        await h.service.handleIncomingMessages({ messages: [message('A'), message('B')] });
        assert.deepEqual(routed, ['A', 'B']);
    } finally { release(); await setImmediate(); await h.cleanup(); }
});
