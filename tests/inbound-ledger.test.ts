import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InboundLedger, inboundDedupKeys } from '../src/services/inbound-ledger.js';

const keys = (id: string) => inboundDedupKeys({ id, remoteJid: '123@s.whatsapp.net' });

test('concurrent replays are claimed once and claims survive restart, completion and failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'router-ledger-'));
    const path = join(root, 'ledger.json');
    try {
        const ledger = new InboundLedger(path);
        assert.deepEqual(await Promise.all([ledger.claim(keys('A')), ledger.claim(keys('A'))]), [true, false]);
        assert.equal(await new InboundLedger(path).claim(keys('A')), false);
        await ledger.finish(keys('A'), 'failed');
        assert.equal(await new InboundLedger(path).claim(keys('A')), false);
        if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.ok(!(await readFile(path, 'utf8')).includes('123@s.whatsapp.net'));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('deduplication recognizes device and PN/LID aliases without colliding across conversations', async () => {
    const ledger = new InboundLedger();
    await ledger.claim(inboundDedupKeys({ id: 'A', remoteJid: '123:2@s.whatsapp.net' }));
    assert.equal(await ledger.claim(inboundDedupKeys({ id: 'A', remoteJid: '123@s.whatsapp.net', remoteJidAlt: '987@lid' })), false);
    assert.equal(await ledger.claim(inboundDedupKeys({ id: 'A', remoteJid: '987@lid' })), false);
    assert.equal(await ledger.claim(inboundDedupKeys({ id: 'A', remoteJid: '456@s.whatsapp.net' })), true);
});

test('ledger preserves corrupt files and fails closed; capacity never evicts unexpired claims', async () => {
    const root = await mkdtemp(join(tmpdir(), 'router-ledger-corrupt-'));
    try {
        const path = join(root, 'ledger.json');
        await writeFile(path, '{broken');
        await assert.rejects(new InboundLedger(path).claim(keys('A')), /dispatch stopped/);
        assert.equal(await readFile(path, 'utf8'), '{broken');
        let now = 100;
        const ledger = new InboundLedger(undefined, 10, 1, () => now);
        await ledger.claim(keys('A'));
        await assert.rejects(ledger.claim(keys('B')), /capacity/);
        now = 111;
        assert.equal(await ledger.claim(keys('B')), true);
    } finally { await rm(root, { recursive: true, force: true }); }
});
