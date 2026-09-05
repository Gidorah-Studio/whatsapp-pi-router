import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../src/services/session.manager.js';

const paired = { registered: false, me: { id: '15550102030:7@s.whatsapp.net' } };

for (const status of ['stopped', 'connected', 'disconnected', 'reconnecting', 'connecting']) {
    test(`cold startup resumes paired credentials with registered=false after ${status}`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'wa-startup-'));
        try {
            const setup = new SessionManager(root);
            await setup.ensureInitialized();
            await writeFile(join(root, 'auth', 'creds.json'), JSON.stringify(paired));
            await writeFile(join(root, 'config.json'), JSON.stringify({ status, hasAuthState: false }));
            const before = await readFile(join(root, 'auth', 'creds.json'), 'utf8');
            const restarted = new SessionManager(root);
            await restarted.ensureInitialized();
            assert.equal(await restarted.isRegistered(), true);
            assert.equal(await restarted.canAutoConnect(), true);
            assert.equal(await readFile(join(root, 'auth', 'creds.json'), 'utf8'), before);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
}

for (const status of ['reauth-required', 'connection-conflict']) {
    test(`restart must not override ${status} even with paired credentials`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'wa-startup-'));
        try {
            await new SessionManager(root).ensureInitialized();
            await writeFile(join(root, 'auth', 'creds.json'), JSON.stringify(paired));
            await writeFile(join(root, 'config.json'), JSON.stringify({ status, hasAuthState: true }));
            const restarted = new SessionManager(root);
            await restarted.ensureInitialized();
            assert.equal(await restarted.isRegistered(), true);
            assert.equal(await restarted.canAutoConnect(), false);
            assert.equal(restarted.getStatus(), status);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
}

for (const [name, contents] of [
    ['missing', undefined], ['corrupt', '{broken'], ['null', 'null'],
    ['unpaired', '{"registered":false}'],
    ['empty account', '{"registered":false,"me":{"id":""}}'],
    ['invalid account', '{"registered":false,"me":{"id":"not-a-jid"}}'],
    ['wrong type', '{"registered":false,"me":{"id":123}}'],
] as const) {
    test(`stale connected config cannot authorize startup with ${name} credentials`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'wa-startup-'));
        try {
            await new SessionManager(root).ensureInitialized();
            if (contents !== undefined) await writeFile(join(root, 'auth', 'creds.json'), contents);
            await writeFile(join(root, 'config.json'), '{"status":"connected","hasAuthState":true}');
            const restarted = new SessionManager(root);
            await restarted.ensureInitialized();
            assert.equal(await restarted.isRegistered(), false);
            assert.equal(await restarted.canAutoConnect(), false);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
}
