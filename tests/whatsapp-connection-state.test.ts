import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectionEventJournal } from '../src/services/connection-lifecycle.js';
import { SessionManager } from '../src/services/session.manager.js';
import { WhatsAppService } from '../src/services/whatsapp.service.js';

async function createHarness(prefix: string) {
    const root = await mkdtemp(join(tmpdir(), prefix));
    const manager = new SessionManager(root, join(root, 'legacy-missing'));
    await manager.ensureInitialized();
    const journal = new ConnectionEventJournal(join(root, 'connection-events.jsonl'), 1024 * 1024, 'test');
    const service = new WhatsAppService(manager, journal);
    return { root, manager, journal, service };
}

test('401 transitions to reauth-required and preserves stale credentials', async () => {
    const { root, manager, journal, service } = await createHarness('whatsapp-state-401-');

    try {
        await writeFile(join(manager.getAuthStateDir(), 'creds.json'), '{"registered":true}');
        await manager.markAuthStateAvailable();
        await manager.setStatus('connected');

        await (service as unknown as {
            handleConnectionClosed(lastDisconnect: unknown, options: unknown): Promise<void>;
        }).handleConnectionClosed({
            error: { output: { statusCode: 401 }, message: 'device was logged out' }
        }, {});

        assert.equal(manager.getStatus(), 'reauth-required');
        assert.equal(await manager.isRegistered(), true);
        const event = (await journal.readRecent(5)).at(-1);
        assert.equal(event?.type, 'connection-close');
        assert.equal(event?.classification, 'reauth-required');
        assert.equal(event?.action, 'pair-new-device');
        assert.equal(event?.statusCode, 401);
        const diagnostics = await service.getDiagnostics();
        assert.equal(diagnostics.operatorActionRequired, true);
        assert.equal(diagnostics.authStatePresent, true);
        assert.equal(diagnostics.lastDisconnect?.statusCode, 401);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('440 transitions to connection-conflict without retrying', async () => {
    const { root, manager, service } = await createHarness('whatsapp-state-440-');

    try {
        await manager.setStatus('connected');
        await (service as unknown as {
            handleConnectionClosed(lastDisconnect: unknown, options: unknown): Promise<void>;
        }).handleConnectionClosed({
            error: { output: { statusCode: 440 }, message: 'connection replaced' }
        }, {});

        assert.equal(manager.getStatus(), 'connection-conflict');
        const diagnostics = await service.getDiagnostics();
        assert.equal(diagnostics.operatorActionRequired, true);
        assert.equal(diagnostics.reconnectAttempts, 0);
        assert.equal(diagnostics.lastDisconnect?.classification, 'connection-conflict');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('pair-new-device quarantines stale credentials without restarting the process', async () => {
    const { root, manager, service } = await createHarness('whatsapp-state-pair-');

    try {
        await writeFile(join(manager.getAuthStateDir(), 'creds.json'), '{"registered":true}');
        await manager.markAuthStateAvailable();
        await manager.setStatus('reauth-required');
        let startCalled = false;
        service.start = async () => {
            startCalled = true;
        };

        const result = await service.resetAndStartPairing('test-reset');
        assert.equal(startCalled, true);
        assert.ok(result.quarantinePath);
        assert.equal(await manager.isRegistered(), false);
        assert.deepEqual(await readdir(manager.getAuthStateDir()), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('local credentials are deleted even when remote logout fails', async () => {
    const { root, manager, journal, service } = await createHarness('whatsapp-state-logout-');

    try {
        await writeFile(join(manager.getAuthStateDir(), 'creds.json'), '{"registered":true}');
        await manager.markAuthStateAvailable();
        (service as unknown as { socket: unknown }).socket = {
            ev: { removeAllListeners() {} },
            async logout() { throw new Error('remote socket already closed'); },
            end() {}
        };

        await service.logout();

        assert.equal(manager.getStatus(), 'logged-out');
        assert.equal(await manager.isRegistered(), false);
        assert.deepEqual(await readdir(manager.getAuthStateDir()), []);
        const event = (await journal.readRecent(5)).at(-1);
        assert.equal(event?.type, 'auth-state-deleted');
        assert.match(event?.error ?? '', /remote socket already closed/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
