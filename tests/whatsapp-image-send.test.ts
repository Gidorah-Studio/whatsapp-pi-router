import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../src/services/session.manager.js';
import { WhatsAppService } from '../src/services/whatsapp.service.js';

test('WhatsApp service sends an image URL with its MIME type and caption', async () => {
    const sessionManager = new SessionManager('/tmp/whatsapp-image-send-test');
    (sessionManager as unknown as { status: string }).status = 'connected';
    const service = new WhatsAppService(sessionManager);
    let sentJid = '';
    let sentContent: unknown;
    const presences: string[] = [];

    (service as unknown as { socket: unknown }).socket = {
        sendMessage: async (jid: string, content: unknown) => {
            sentJid = jid;
            sentContent = content;
            return { key: { id: 'image-message-id' } };
        },
        sendPresenceUpdate: async (presence: string) => {
            presences.push(presence);
        }
    };

    const result = await service.sendImageMessage(
        '12345@lid',
        '/tmp/rendered.png',
        'image/png',
        'A client sketch'
    );

    assert.equal(result.success, true);
    assert.equal(result.messageId, 'image-message-id');
    assert.equal(sentJid, '12345@lid');
    assert.deepEqual(sentContent, {
        image: { url: '/tmp/rendered.png' },
        mimetype: 'image/png',
        caption: 'A client sketch'
    });
    assert.deepEqual(presences, ['composing', 'paused']);
});
