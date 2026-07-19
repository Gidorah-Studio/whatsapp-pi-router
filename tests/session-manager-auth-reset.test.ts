import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../src/services/session.manager.js';

test('quarantines stale auth and immediately prepares an empty pairing directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-auth-reset-'));
    const manager = new SessionManager(root, join(root, 'legacy-missing'));

    try {
        await manager.ensureInitialized();
        await writeFile(join(manager.getAuthStateDir(), 'creds.json'), '{"registered":true}');
        await writeFile(join(manager.getAuthStateDir(), 'app-state-key.json'), 'key-material');
        await manager.markAuthStateAvailable();
        await manager.setStatus('connected');

        const quarantinePath = await manager.quarantineAuthState('operator/request');
        assert.ok(quarantinePath);
        assert.equal(manager.getStatus(), 'reauth-required');
        assert.equal(await manager.isRegistered(), false);
        assert.deepEqual(await readdir(manager.getAuthStateDir()), []);
        assert.equal(await readFile(join(quarantinePath!, 'app-state-key.json'), 'utf8'), 'key-material');

        const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
            status: string;
            hasAuthState: boolean;
        };
        assert.equal(config.status, 'reauth-required');
        assert.equal(config.hasAuthState, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a live connected session is not downgraded by an incomplete creds file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-auth-live-'));
    const manager = new SessionManager(root, join(root, 'legacy-missing'));

    try {
        await manager.ensureInitialized();
        await writeFile(join(manager.getAuthStateDir(), 'creds.json'), '{"registered":false}');
        await manager.setStatus('connected');

        assert.equal(await manager.isRegistered(), true);
        assert.equal(manager.getStatus(), 'connected');
        const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
            status: string;
            hasAuthState: boolean;
        };
        assert.equal(config.status, 'connected');
        assert.equal(config.hasAuthState, true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('an unpaired creds file is not treated as a registered WhatsApp session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-auth-unpaired-'));
    const manager = new SessionManager(root, join(root, 'legacy-missing'));

    try {
        await manager.ensureInitialized();
        await writeFile(join(manager.getAuthStateDir(), 'creds.json'), '{"registered":false}');
        assert.equal(await manager.isRegistered(), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('deleting auth always leaves a clean logged-out state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-auth-delete-'));
    const manager = new SessionManager(root, join(root, 'legacy-missing'));

    try {
        await manager.ensureInitialized();
        await writeFile(join(manager.getAuthStateDir(), 'creds.json'), '{"registered":true}');
        await manager.markAuthStateAvailable();
        await manager.deleteAuthState();

        assert.equal(manager.getStatus(), 'logged-out');
        assert.equal(await manager.isRegistered(), false);
        assert.deepEqual(await readdir(manager.getAuthStateDir()), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
