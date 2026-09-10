import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicWritePrivate, ensurePrivateDirectory } from '../src/services/private-storage.js';
import { RecentsService } from '../src/services/recents.service.js';
import { SessionManager } from '../src/services/session.manager.js';
import { createIncomingMediaTurn } from '../src/services/incoming-media-storage.js';

const input = (i: number) => ({ messageId: String(i), senderNumber: '+15551234567', text: `message ${i}`, direction: 'incoming' as const, timestamp: 1_800_000_000_000 + i });

test('concurrent recents updates persist valid complete JSON and survive reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'router-recents-'));
    try {
        const manager = new SessionManager(root, join(root, 'missing'));
        const recents = new RecentsService(manager, root);
        await Promise.all(Array.from({ length: 80 }, (_, i) => recents.recordMessage(input(i))));
        const path = join(root, 'recents', 'recents.json');
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        assert.equal(parsed.messagesBySender['+15551234567'].length, 80);
        const reopened = new RecentsService(manager, root);
        await (reopened as any).loadStore();
        assert.equal((await reopened.getConversationHistory('+15551234567')).length, 80);
        await recents.recordMessage(input(0));
        assert.equal((await recents.getRecentConversations())[0].lastMessageTime, input(79).timestamp);
        if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.deepEqual(await readdir(join(root, 'recents')), ['recents.json']);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('corrupt recents are preserved rather than silently replaced with empty history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'router-corrupt-recents-'));
    try {
        await ensurePrivateDirectory(join(root, 'recents'));
        const path = join(root, 'recents', 'recents.json');
        await writeFile(path, '{broken');
        const recents = new RecentsService(new SessionManager(root, join(root, 'missing')), root);
        await assert.rejects((recents as any).loadStore(), /preserved/);
        await assert.rejects(recents.recordMessage(input(1)), /preserved/);
        assert.equal(await readFile(path, 'utf8'), '{broken');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed atomic replacement leaves existing data intact and cleans temporary files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'router-atomic-'));
    try {
        const target = join(root, 'existing-directory');
        await ensurePrivateDirectory(target);
        await writeFile(join(target, 'keep'), 'original');
        await assert.rejects(atomicWritePrivate(target, 'new'));
        assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'original');
        assert.deepEqual(await readdir(root), ['existing-directory']);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('media is private and separated per conversation; cleanup retains documents and legacy files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'router-media-private-'));
    try {
        await writeFile(join(root, 'legacy.ogg'), 'legacy');
        const a = await createIncomingMediaTurn('A', root);
        const b = await createIncomingMediaTurn('B', root);
        const document = await a.saveDocument('../../invoice.txt', Buffer.from('invoice'));
        const other = await b.saveDocument('../../invoice.txt', Buffer.from('different'));
        await writeFile(join(a.temporary, 'audio.ogg'), 'audio', { mode: 0o600 });
        assert.notEqual(document, other);
        if (process.platform !== 'win32') {
            assert.equal((await stat(document)).mode & 0o777, 0o600);
            assert.equal((await stat(a.temporary)).mode & 0o777, 0o700);
        }
        await Promise.all([a.cleanup(), b.cleanup()]);
        await assert.rejects(stat(a.temporary));
        assert.equal(await readFile(document, 'utf8'), 'invoice');
        assert.equal(await readFile(join(root, 'legacy.ogg'), 'utf8'), 'legacy');
    } finally { await rm(root, { recursive: true, force: true }); }
});
