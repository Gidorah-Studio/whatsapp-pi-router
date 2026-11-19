import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeAllowEntry, SessionManager } from '../src/services/session.manager.js';
import { WhatsAppService } from '../src/services/whatsapp.service.js';

const journal = { record: async () => {}, readRecent: async () => [], getPath: () => '' } as any;
const ledger = { claim: async () => true, finish: async () => {} };

async function withManager(run: (manager: SessionManager, root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'wa-allow-'));
    try {
        const manager = new SessionManager(root, root);
        await manager.ensureInitialized();
        await run(manager, root);
    } finally { await rm(root, { recursive: true, force: true }); }
}

async function routedJids(manager: SessionManager, jids: string[]): Promise<string[]> {
    await manager.setStatus('connected');
    const routed: string[] = [];
    const service = new WhatsAppService(manager, journal, ledger);
    service.setMessageCallback(async payload => { routed.push(payload.messages![0]!.key.remoteJid!); });
    for (const jid of jids) {
        await service.handleIncomingMessages({
            type: 'notify',
            messages: [{ key: { id: `id-${jid}`, remoteJid: jid, fromMe: false }, message: { conversation: 'hi' } }],
        });
    }
    return routed;
}

test('allow entries normalize to the key admission compares against', () => {
    assert.equal(normalizeAllowEntry('14155551212'), '+14155551212');
    assert.equal(normalizeAllowEntry(' +1 (415) 555-1212 '), '+14155551212');
    assert.equal(normalizeAllowEntry('14155551212@s.whatsapp.net'), '+14155551212');
    assert.equal(normalizeAllowEntry('14155551212:7@s.whatsapp.net'), '+14155551212');
    assert.equal(normalizeAllowEntry('99887766:3@lid'), '99887766@lid');
    assert.equal(normalizeAllowEntry('120363012345@g.us'), '120363012345@g.us');
    assert.equal(normalizeAllowEntry('not-a-number'), 'not-a-number');
    assert.equal(normalizeAllowEntry(''), '');
});

test('a number saved in any documented format admits that sender, once', async () => {
    await withManager(async manager => {
        await manager.addNumber('14155551212');
        await manager.addNumber('14155550000@s.whatsapp.net');
        await manager.addNumber('+14155559999');
        await manager.addNumber('+1 415 555 1212');
        assert.deepEqual(manager.getAllowList().map(c => c.number), ['+14155551212', '+14155550000', '+14155559999']);
        const routed = await routedJids(manager, [
            '14155551212@s.whatsapp.net', '14155550000@s.whatsapp.net', '14155559999@s.whatsapp.net', '14155558888@s.whatsapp.net',
        ]);
        assert.deepEqual(routed, ['14155551212@s.whatsapp.net', '14155550000@s.whatsapp.net', '14155559999@s.whatsapp.net']);
        assert.deepEqual(manager.getIgnoredNumbers().map(c => c.number), ['+14155558888']);
    });
});

test('entries saved by older versions without a plus are repaired on load and removable', async () => {
    await withManager(async (_manager, root) => {
        await writeFile(join(root, 'config.json'), JSON.stringify({
            allowList: ['14155551212', { number: '14155551212@s.whatsapp.net', name: 'Dana' }, { number: '+14155550000' }],
        }));
        const restarted = new SessionManager(root, root);
        await restarted.ensureInitialized();
        assert.deepEqual(restarted.getAllowList(), [{ number: '+14155551212', name: 'Dana' }, { number: '+14155550000', name: undefined, sendNumber: undefined }]);
        assert.equal(restarted.isAllowed('+14155551212'), true);
        await restarted.removeNumber('14155551212@s.whatsapp.net');
        assert.equal(restarted.isAllowed('+14155551212'), false);
    });
});

test('configured entries admit senders and groups without being written to config.json', async () => {
    await withManager(async (manager, root) => {
        manager.setConfiguredAllowEntries(['14155551212', '120363012345@g.us', '  ']);
        assert.equal(manager.isAllowed('+14155551212'), true);
        assert.equal(manager.isAllowedGroup('120363012345@g.us'), true);
        assert.equal(manager.getAllowedConversationCount(), 2);
        const routed = await routedJids(manager, ['14155551212@s.whatsapp.net', '120363012345@g.us']);
        assert.deepEqual(routed, ['14155551212@s.whatsapp.net', '120363012345@g.us']);
        const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
        assert.deepEqual(saved.allowList, []);
        assert.deepEqual(saved.allowedGroups, []);
    });
});

test('removing a configured entry revokes it on the next start', async () => {
    await withManager(async (manager, root) => {
        manager.setConfiguredAllowEntries(['+14155551212']);
        await manager.addNumber('+14155550000');
        await manager.saveConfig();
        const restarted = new SessionManager(root, root);
        await restarted.ensureInitialized();
        restarted.setConfiguredAllowEntries([]);
        assert.equal(restarted.isAllowed('+14155551212'), false);
        assert.equal(restarted.isAllowed('+14155550000'), true);
        assert.equal(restarted.getAllowedConversationCount(), 1);
    });
});
