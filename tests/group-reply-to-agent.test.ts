import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../src/services/session.manager.js';
import { WhatsAppService } from '../src/services/whatsapp.service.js';
import { buildReplyContext, formatReplyContext } from '../src/services/reply-context.js';
import type { GroupReplyMode } from '../src/models/whatsapp.types.js';

const GROUP = '120363000000000000@g.us';
const PHONE = '15551234567@s.whatsapp.net';
const LID = '999999999999999@lid';
const MEMBER = '15550001111@s.whatsapp.net';
let nextId = 0;

function reply(overrides: Record<string, unknown> = {}, text = 'Can you explain this?') {
    return { extendedTextMessage: { text, contextInfo: {
        stanzaId: 'agent-message-id', participant: PHONE,
        quotedMessage: { conversation: 'The original answer' }, ...overrides,
    } } };
}
function envelope(message: any, key: Record<string, unknown> = {}) {
    return { messages: [{ key: {
        id: `follow-up-${++nextId}`, remoteJid: GROUP, participant: MEMBER, fromMe: false, ...key,
    }, pushName: 'Group member', message }] };
}
async function harness(mode: GroupReplyMode = 'mentions', bound = false) {
    const root = await mkdtemp(join(tmpdir(), 'router-reply-trigger-'));
    const manager = new SessionManager(root, join(root, 'missing'));
    await manager.ensureInitialized();
    await manager.addAllowedGroup(GROUP, 'Test group');
    await manager.setStatus('connected');
    manager.setGroupReplyMode(mode);
    manager.setGroupReplyKeywords(['ghost']);
    const service = new WhatsAppService(manager);
    const socket: any = {
        user: { id: '15551234567:4@s.whatsapp.net', lid: '999999999999999:8@lid' },
        async groupMetadata(jid: string) { return { id: jid, subject: 'Test group', participants: [] }; },
    };
    (service as any).socket = socket;
    if (bound) service.setGroupBinding(GROUP);
    const routed: any[] = [];
    const recorded: unknown[] = [];
    service.setMessageCallback(payload => { routed.push(payload); });
    service.setIncomingMessageRecorder(message => { recorded.push(message); });
    return {
        manager, service, socket, routed, recorded,
        receive: (payload: any) => (service as any).handleIncomingMessages(payload) as Promise<void>,
        async cleanup() { await service.drainIncoming(); await rm(root, { recursive: true, force: true }); },
    };
}

for (const mode of ['mentions', 'mentions-or-keywords'] as const) {
    for (const bound of [false, true]) {
        test(`${mode}, bound=${bound}: replies to the agent route without a mention or keyword`, async () => {
            const h = await harness(mode, bound);
            try {
                for (const participant of [PHONE, LID, '15551234567:9@s.whatsapp.net', '999999999999999:3@lid']) {
                    await h.receive(envelope(reply({ participant, remoteJid: GROUP })));
                }
                // Metadata alone still identifies a reply when its snapshot is unavailable.
                await h.receive(envelope(reply({ quotedMessage: undefined })));
                assert.equal(h.routed.length, 5);
                h.manager.setGroupReplyKeywords([]);
                await h.receive(envelope(reply()));
                assert.equal(h.routed.length, 6);
                assert.equal(h.recorded.length, 6);
            } finally { await h.cleanup(); }
        });
    }
}

test('third-party quotes stay quiet; only a current mention or configured keyword admits them', async () => {
    const h = await harness('mentions-or-keywords');
    try {
        await h.receive(envelope(reply({ participant: MEMBER })));
        await h.receive(envelope(reply({ participant: MEMBER, quotedMessage: { conversation: 'ghost' } })));
        await h.receive(envelope(reply({ participant: MEMBER, quotedMessage: reply({ mentionedJid: [PHONE] }) })));
        const displayNameOnly = envelope(reply({ participant: 'Ghost' }));
        displayNameOnly.messages[0].pushName = 'Ghost';
        await h.receive(displayNameOnly);
        assert.equal(h.routed.length, 0);
        assert.equal(h.recorded.length, 4);
        await h.receive(envelope(reply({ participant: MEMBER, mentionedJid: [PHONE] })));
        await h.receive(envelope(reply({ participant: MEMBER }, 'ghost, explain this')));
        assert.equal(h.routed.length, 2);
        h.manager.setGroupReplyMode('mentions');
        await h.receive(envelope(reply({ participant: MEMBER }, 'ghost, explain this')));
        assert.equal(h.routed.length, 2);
        h.manager.setGroupReplyMode('all');
        await h.receive(envelope(reply({ participant: MEMBER })));
        assert.equal(h.routed.length, 3);
    } finally { await h.cleanup(); }
});

test('missing, malformed, cross-chat and nested-only reply identifiers cannot trigger replies', async () => {
    const h = await harness('mentions-or-keywords');
    try {
        for (const metadata of [
            { stanzaId: undefined }, { stanzaId: '' }, { stanzaId: ' ' }, { stanzaId: 123 },
            { stanzaId: 'x'.repeat(257) }, { stanzaId: 'id\u0000' },
            { participant: undefined }, { participant: '' }, { participant: PHONE + '@evil' },
            { participant: ' ' + PHONE }, { participant: PHONE + ' ' },
            { participant: '15551234567@lid' }, { participant: '15551234567:bad@s.whatsapp.net' },
            { participant: '15551234567@s.whatsapp.net.evil' },
            { participant: '1'.repeat(256) + '@lid' },
            { remoteJid: 'other@g.us' }, { remoteJid: PHONE },
            { participant: MEMBER, quotedMessage: reply() },
        ]) await h.receive(envelope(reply(metadata)));
        await h.receive(envelope({ extendedTextMessage: { text: 'Explain', contextInfo: { quotedMessage: reply() } } }));
        assert.equal(h.routed.length, 0);
    } finally { await h.cleanup(); }
});

test('wrapped and media replies route, but reactions and protocol messages do not', async () => {
    const h = await harness();
    try {
        const contextInfo = reply().extendedTextMessage.contextInfo;
        for (const field of ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage']) {
            await h.receive(envelope({ [field]: { contextInfo } }));
        }
        for (const field of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage']) {
            await h.receive(envelope({ [field]: { message: reply() } }));
        }
        assert.equal(h.routed.length, 10);
        await h.receive(envelope({ reactionMessage: { text: '👍', key: { id: 'agent-message-id', fromMe: true }, contextInfo } }));
        await h.receive(envelope({ protocolMessage: { editedMessage: reply(), contextInfo } }));
        assert.equal(h.routed.length, 10);
    } finally { await h.cleanup(); }
});

test('reply matching resolves PN/LID aliases in both directions and fails closed on mapping errors', async () => {
    const h = await harness();
    try {
        h.socket.user = { id: '15551234567:4@s.whatsapp.net' };
        h.socket.signalRepository = { lidMapping: {
            async getLIDForPN(jid: string) { return jid === PHONE ? LID : null; },
            async getPNForLID(jid: string) { return jid === LID ? PHONE : null; },
        } };
        await h.receive(envelope(reply({ participant: LID })));
        h.socket.user = { lid: '999999999999999:8@lid' };
        await h.receive(envelope(reply({ participant: PHONE })));
        assert.equal(h.routed.length, 2);
        h.socket.user = { id: PHONE };
        h.socket.signalRepository.lidMapping.getLIDForPN = async () => { throw new Error('mapping unavailable'); };
        await h.receive(envelope(reply({ participant: LID })));
        assert.equal(h.routed.length, 2);
        await h.receive(envelope(reply({ participant: PHONE })));
        assert.equal(h.routed.length, 3);
    } finally { await h.cleanup(); }
});

test('a cached operator from another account never establishes reply authorship', async () => {
    const h = await harness();
    try {
        await h.manager.setOperatorJid(MEMBER);
        await h.receive(envelope(reply({ participant: MEMBER })));
        assert.equal(h.routed.length, 0);
        h.socket.user = undefined;
        await h.manager.setOperatorJid(PHONE);
        await h.receive(envelope(reply()));
        assert.equal(h.routed.length, 0);
    } finally { await h.cleanup(); }
});

test('replies cannot bypass group permissions, binding, self-message exclusion or deduplication; DMs are unchanged', async () => {
    const h = await harness();
    try {
        await h.manager.removeAllowedGroup(GROUP);
        await h.receive(envelope(reply()));
        h.service.setGroupBinding(GROUP);
        await h.receive(envelope(reply()));
        assert.equal(h.routed.length, 0);
        await h.manager.addAllowedGroup(GROUP, 'Test group');
        h.service.setGroupBinding('other@g.us');
        await h.receive(envelope(reply()));
        assert.equal(h.routed.length, 0);
        h.service.setGroupBinding(GROUP);
        await h.receive(envelope(reply(), { fromMe: true }));
        assert.equal(h.routed.length, 0);
        const message = envelope(reply());
        await h.receive(message);
        await h.receive(message);
        assert.equal(h.routed.length, 1);
    } finally { await h.cleanup(); }
    const direct = await harness();
    try {
        await direct.manager.addNumber('+15550001111');
        await direct.receive(envelope(reply({ participant: MEMBER }), { remoteJid: MEMBER }));
        assert.equal(direct.routed.length, 1);
    } finally { await direct.cleanup(); }
});

test('admitted reply preserves the explicit quote as primary context, including quoted images and missing-snapshot fallback', async () => {
    const h = await harness('mentions-or-keywords');
    try {
        const image = { caption: 'The original chart', mimetype: 'image/png', mediaKey: 'not-context-text' };
        for (const quotedMessage of [{ conversation: 'The original answer' }, { imageMessage: image }, undefined]) {
            const payload = envelope(reply({ quotedMessage }));
            await h.receive(payload);
            const routed = h.routed.at(-1);
            assert.equal(routed.messages[0], payload.messages[0]);
            const current = routed.messages[0];
            const { context, quotedImage } = buildReplyContext({
                conversationJid: GROUP, historyKey: GROUP, currentMessageId: current.key.id,
                timestamp: 3000, isGroup: true, message: current.message,
                history: [
                    { senderNumber: GROUP, messageId: 'agent-message-id', direction: 'outgoing', text: 'Stored original answer', timestamp: 1000 },
                    { senderNumber: GROUP, messageId: 'later-topic', direction: 'incoming', text: 'Unrelated recent topic', timestamp: 2000 },
                ],
            });
            assert.equal(context.quoted?.messageId, 'agent-message-id');
            assert.equal(context.quoted?.authorJid, PHONE);
            assert.equal(context.quoted?.text, quotedMessage?.imageMessage ? image.caption : quotedMessage?.conversation ?? 'Stored original answer');
            assert.equal(quotedImage, quotedMessage?.imageMessage ? image : undefined);
            assert.match(formatReplyContext(context), /explicit quote below is its primary target/);
            assert.equal(current.message.extendedTextMessage.text, 'Can you explain this?');
        }
        assert.equal(h.routed.length, 3);
    } finally { await h.cleanup(); }
});
