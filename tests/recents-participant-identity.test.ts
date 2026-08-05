import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    MAX_MESSAGES_PER_CONVERSATION,
    RecentsService
} from '../src/services/recents.service.js';
import { SessionManager } from '../src/services/session.manager.js';

test('group history preserves exact participant identity on each message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-recents-participant-'));
    const manager = new SessionManager(root, join(root, 'legacy-missing'));
    const recents = new RecentsService(manager);
    (recents as unknown as { persistStore(): Promise<void> }).persistStore = async () => {};

    try {
        await recents.recordMessage({
            messageId: 'group-message-1',
            senderNumber: '120363000000000000@g.us',
            senderName: 'Accounting Group',
            participantJid: '15551234567@s.whatsapp.net',
            participantName: 'Alice',
            text: 'Submitted the March expense report',
            direction: 'incoming',
            timestamp: 1_780_000_000_000
        });

        const history = await recents.getConversationHistory('120363000000000000@g.us');
        assert.deepEqual(history, [{
            messageId: 'group-message-1',
            senderNumber: '120363000000000000@g.us',
            participantJid: '15551234567@s.whatsapp.net',
            participantName: 'Alice',
            text: 'Submitted the March expense report',
            direction: 'incoming',
            timestamp: 1_780_000_000_000
        }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('recents retain the latest 200 messages per conversation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-recents-retention-'));
    const manager = new SessionManager(root, join(root, 'legacy-missing'));
    const recents = new RecentsService(manager);
    (recents as unknown as { persistStore(): Promise<void> }).persistStore = async () => {};

    try {
        for (let index = 0; index < 205; index++) {
            await recents.recordMessage({
                messageId: `group-message-${index}`,
                senderNumber: '120363000000000000@g.us',
                participantJid: '15551234567@s.whatsapp.net',
                text: `Message ${index}`,
                direction: 'incoming',
                timestamp: 1_780_000_000_000 + index
            });
        }

        const history = await recents.getConversationHistory('120363000000000000@g.us');
        assert.equal(MAX_MESSAGES_PER_CONVERSATION, 200);
        assert.equal(history.length, 200);
        assert.equal(history[0]?.messageId, 'group-message-5');
        assert.equal(history.at(-1)?.messageId, 'group-message-204');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('legacy and direct history records remain valid without participant fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-recents-direct-'));
    const manager = new SessionManager(root, join(root, 'legacy-missing'));
    const recents = new RecentsService(manager);
    (recents as unknown as { persistStore(): Promise<void> }).persistStore = async () => {};

    try {
        await recents.recordMessage({
            messageId: 'direct-message-1',
            senderNumber: '+15551234567',
            text: 'Hello',
            direction: 'incoming',
            timestamp: 1_780_000_000_000
        });

        const history = await recents.getConversationHistory('+15551234567');
        assert.equal(history.length, 1);
        assert.equal(history[0]?.participantJid, undefined);
        assert.equal(history[0]?.participantName, undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
