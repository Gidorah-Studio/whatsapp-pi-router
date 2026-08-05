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
