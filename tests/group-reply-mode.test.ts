import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../src/services/session.manager.js';
import {
    normalizeGroupReplyMode,
    parseRouterAllowConfig
} from '../src/services/router-allow.config.js';
import type { IncomingMessage } from '../src/models/whatsapp.types.js';
import { WhatsAppService } from '../src/services/whatsapp.service.js';

const GROUP_JID = '120363000000000000@g.us';
const AGENT_PHONE_JID = '15551234567@s.whatsapp.net';
const AGENT_LID_JID = '999999999999999@lid';

async function createHarness() {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-group-replies-'));
    const manager = new SessionManager(root, join(root, 'legacy-missing'));
    await manager.ensureInitialized();
    await manager.addAllowedGroup(GROUP_JID, 'Test Group');
    await manager.setStatus('connected');

    const service = new WhatsAppService(manager);
    (service as unknown as { socket: unknown }).socket = {
        user: {
            id: '15551234567:4@s.whatsapp.net',
            lid: '999999999999999:8@lid'
        },
        async groupMetadata(jid: string) {
            return { id: jid, subject: 'Test Group', participants: [] };
        }
    };

    let routed = 0;
    const recorded: IncomingMessage[] = [];
    service.setMessageCallback(() => {
        routed++;
    });
    service.setIncomingMessageRecorder((message) => {
        recorded.push(message);
    });

    const handleIncomingMessages = (service as unknown as {
        handleIncomingMessages(payload: unknown): Promise<void>;
    }).handleIncomingMessages.bind(service);

    return {
        root,
        manager,
        service,
        getRouted: () => routed,
        getRecorded: () => [...recorded],
        handleIncomingMessages
    };
}

function groupMessage(mentionedJid?: string, message?: Record<string, unknown>) {
    return {
        messages: [{
            key: {
                id: `message-${Math.random()}`,
                remoteJid: GROUP_JID,
                participant: '15550001111@s.whatsapp.net',
                fromMe: false
            },
            pushName: 'Group Member',
            message: message ?? {
                extendedTextMessage: {
                    text: mentionedJid ? '@agent help' : 'ordinary group conversation',
                    ...(mentionedJid
                        ? { contextInfo: { mentionedJid: [mentionedJid] } }
                        : {})
                }
            }
        }]
    };
}

test('router allow config persists a backwards-compatible group reply mode', () => {
    assert.equal(normalizeGroupReplyMode(' mentions '), 'mentions');
    assert.equal(normalizeGroupReplyMode('all'), 'all');
    assert.equal(normalizeGroupReplyMode('invalid'), undefined);
    assert.equal(parseRouterAllowConfig('{}').groupReplyMode, 'all');
    assert.equal(
        parseRouterAllowConfig('{"groupReplyMode":"mentions"}').groupReplyMode,
        'mentions'
    );
    assert.equal(
        parseRouterAllowConfig('{"groupReplyMode":"invalid"}').groupReplyMode,
        'all'
    );
});

test('all-message mode keeps routing ordinary messages from allowed groups', async () => {
    const harness = await createHarness();
    try {
        harness.manager.setGroupReplyMode('all');
        await harness.handleIncomingMessages(groupMessage());
        assert.equal(harness.getRouted(), 1);
    } finally {
        await rm(harness.root, { recursive: true, force: true });
    }
});

test('mention-only mode ignores ordinary and third-party mentions', async () => {
    const harness = await createHarness();
    try {
        harness.manager.setGroupReplyMode('mentions');
        await harness.handleIncomingMessages(groupMessage());
        await harness.handleIncomingMessages(groupMessage('15559999999@s.whatsapp.net'));
        await harness.handleIncomingMessages(groupMessage('15551234567@lid'));
        assert.equal(harness.getRouted(), 0);
        assert.equal(harness.getRecorded().length, 3);
    } finally {
        await rm(harness.root, { recursive: true, force: true });
    }
});

test('mention-only mode routes phone, LID, wrapped, and media mentions of the agent', async () => {
    const harness = await createHarness();
    try {
        harness.manager.setGroupReplyMode('mentions');

        await harness.handleIncomingMessages(groupMessage(AGENT_PHONE_JID));
        const firstRecorded = harness.getRecorded()[0];
        assert.equal(firstRecorded?.participantJid, '15550001111@s.whatsapp.net');
        assert.equal(firstRecorded?.participantName, 'Group Member');

        await harness.handleIncomingMessages(groupMessage(AGENT_LID_JID));
        await harness.handleIncomingMessages(groupMessage(undefined, {
            ephemeralMessage: {
                message: {
                    extendedTextMessage: {
                        text: '@agent wrapped help',
                        contextInfo: { mentionedJid: [AGENT_PHONE_JID] }
                    }
                }
            }
        }));
        await harness.handleIncomingMessages(groupMessage(undefined, {
            imageMessage: {
                caption: '@agent inspect this',
                contextInfo: { mentionedJid: [AGENT_LID_JID] }
            }
        }));

        assert.equal(harness.getRouted(), 4);
    } finally {
        await rm(harness.root, { recursive: true, force: true });
    }
});

test('mention-only mode resolves the agent LID when the socket exposes only its phone JID', async () => {
    const harness = await createHarness();
    try {
        harness.manager.setGroupReplyMode('mentions');
        (harness.service as unknown as { socket: unknown }).socket = {
            user: { id: '15551234567:4@s.whatsapp.net' },
            signalRepository: {
                lidMapping: {
                    async getLIDForPN(jid: string) {
                        return jid === AGENT_PHONE_JID ? AGENT_LID_JID : null;
                    },
                    async getPNForLID() {
                        return null;
                    }
                }
            },
            async groupMetadata(jid: string) {
                return { id: jid, subject: 'Test Group', participants: [] };
            }
        };

        await harness.handleIncomingMessages(groupMessage(AGENT_LID_JID));
        assert.equal(harness.getRouted(), 1);
    } finally {
        await rm(harness.root, { recursive: true, force: true });
    }
});

test('mention-or-keyword mode routes authored text, captions, wrappers and mentions', async () => {
    const h = await createHarness();
    try {
        h.manager.setGroupReplyMode('mentions-or-keywords');
        h.manager.setGroupReplyKeywords(['Emily']);
        for (const message of [
            { conversation: 'Hey EMILY!' },
            { extendedTextMessage: { text: 'Emily, help' } },
            { imageMessage: { caption: 'emily' } },
            { videoMessage: { caption: 'emily' } },
            { documentMessage: { caption: 'emily' } },
            { ephemeralMessage: { message: { conversation: 'emily' } } },
            { viewOnceMessageV2: { message: { imageMessage: { caption: 'Emily!' } } } },
            { documentWithCaptionMessage: { message: { documentMessage: { caption: 'Emily!' } } } },
        ]) await h.handleIncomingMessages(groupMessage(undefined, message));
        await h.handleIncomingMessages(groupMessage(AGENT_PHONE_JID));
        await h.handleIncomingMessages(groupMessage(AGENT_LID_JID));
        assert.equal(h.getRouted(), 10);
        assert.equal(h.getRecorded().length, 10);
        await h.service.drainIncoming();
    } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('keywords never inspect quoted text, filenames, display names, reactions or audio placeholders', async () => {
    const h = await createHarness();
    try {
        h.manager.setGroupReplyMode('mentions-or-keywords');
        h.manager.setGroupReplyKeywords(['Emily', 'audio', 'image', 'document']);
        for (const message of [
            { conversation: 'Emilyson' },
            { extendedTextMessage: { text: 'hello', contextInfo: { quotedMessage: { conversation: 'Emily' } } } },
            { documentMessage: { fileName: 'Emily.pdf' } },
            { imageMessage: {} },
            { audioMessage: {} },
            { reactionMessage: { text: 'Emily' } },
            { protocolMessage: { editedMessage: { conversation: 'Emily' } } },
        ]) {
            const payload = groupMessage(undefined, message);
            payload.messages[0].pushName = 'Emily';
            await h.handleIncomingMessages(payload);
        }
        assert.equal(h.getRouted(), 0);
        assert.equal(h.getRecorded().length, 7);
    } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('empty keywords fall back to mentions and settings updates apply to subsequent messages', async () => {
    const h = await createHarness();
    try {
        h.manager.setGroupReplyMode('mentions-or-keywords');
        await h.handleIncomingMessages(groupMessage(undefined, { conversation: 'Emily' }));
        assert.equal(h.getRouted(), 0);
        h.manager.setGroupReplyKeywords(['Emily']);
        await h.handleIncomingMessages(groupMessage(undefined, { conversation: 'Emily' }));
        assert.equal(h.getRouted(), 1);
        h.manager.setGroupReplyKeywords([]);
        await h.handleIncomingMessages(groupMessage(undefined, { conversation: 'Emily' }));
        await h.handleIncomingMessages(groupMessage(AGENT_PHONE_JID));
        assert.equal(h.getRouted(), 2);
        h.manager.setGroupReplyKeywords(['Emily']);
        h.manager.setGroupReplyMode('mentions');
        await h.handleIncomingMessages(groupMessage(undefined, { conversation: 'Emily' }));
        assert.equal(h.getRouted(), 2);
        await h.service.drainIncoming();
    } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('keywords never bypass group permissions or group binding, and direct chats are unchanged', async () => {
    const h = await createHarness();
    try {
        h.manager.setGroupReplyMode('mentions-or-keywords');
        h.manager.setGroupReplyKeywords(['Emily']);
        await h.manager.removeAllowedGroup(GROUP_JID);
        await h.handleIncomingMessages(groupMessage(undefined, { conversation: 'Emily' }));
        assert.equal(h.getRouted(), 0);
        await h.manager.addAllowedGroup(GROUP_JID, 'Test Group');
        h.service.setGroupBinding('different@g.us');
        await h.handleIncomingMessages(groupMessage(undefined, { conversation: 'Emily' }));
        assert.equal(h.getRouted(), 0);
        h.service.setGroupBinding(GROUP_JID);
        await h.handleIncomingMessages(groupMessage(undefined, { conversation: 'Emily' }));
        assert.equal(h.getRouted(), 1);
        await h.service.drainIncoming();
    } finally { await rm(h.root, { recursive: true, force: true }); }

    const direct = await createHarness();
    try {
        direct.manager.setGroupReplyMode('mentions-or-keywords');
        direct.manager.setGroupReplyKeywords(['Emily']);
        await direct.manager.addNumber('+15550001111');
        await direct.handleIncomingMessages({ messages: [{
            key: { id: 'direct-no-keyword', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
            message: { conversation: 'Hello' },
        }] });
        assert.equal(direct.getRouted(), 1);
        await direct.service.drainIncoming();
    } finally { await rm(direct.root, { recursive: true, force: true }); }
});
