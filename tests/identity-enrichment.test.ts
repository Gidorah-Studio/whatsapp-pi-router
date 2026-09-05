import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IdentityMapService, type IdentityMapEntry } from '../src/services/identity-map.service.js';

const jid = '123456789@lid';
const pn = '15550102030@s.whatsapp.net';
function enrichment(base: IdentityMapEntry, id = '999') {
    return {
        basis: { phone: base.phone || null, email: base.email || null, externalRecordId: base.externalRecordId || null },
        phone: base.phone || '15550102030', email: 'test@example.com', externalRecordId: id, updatedAt: 123,
    };
}
async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'identity-enrichment-test-'));
    const service = new IdentityMapService(root);
    await service.recordLidPnMapping(jid, pn);
    const path = join(root, 'identity-enrichment.json');
    const publish = async (value: unknown, version = 1) => {
        await writeFile(`${path}.tmp`, JSON.stringify({ version, identities: { [jid]: value } }));
        await rename(`${path}.tmp`, path);
    };
    return { root, service, path, publish };
}

test('fresh external enrichment survives subsequent router writes and process reload', async () => {
    const { root, service, path, publish } = await setup();
    try {
        assert.equal((await service.getResolvedIdentity(jid))?.externalRecordId, undefined);
        await publish(enrichment(service.get(jid)!));
        const bytes = await readFile(path);
        assert.equal((await service.getResolvedIdentity(jid))?.externalRecordId, '999');
        await service.recordLidPnMapping(jid, pn);
        await service.recordIncomingIdentity({ conversationId: jid, whatsappJid: jid, phoneJid: pn, pushName: 'New name' });
        assert.deepEqual(await readFile(path), bytes);
        assert.equal((await service.getResolvedIdentity(jid))?.externalRecordId, '999');
        assert.equal(service.get(jid)?.externalRecordId, undefined, 'merged context must never enter router memory');
        const raw = JSON.parse(await readFile(join(root, 'identity-map.json'), 'utf8'));
        assert.equal(raw.identities[jid].externalRecordId, undefined);
        assert.equal((await new IdentityMapService(root).getResolvedIdentity(jid))?.externalRecordId, '999');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('atomic enrichment updates and removal are visible on the next read, not cached', async () => {
    const { root, service, path, publish } = await setup();
    try {
        await publish(enrichment(service.get(jid)!));
        assert.equal((await service.getResolvedIdentity(jid))?.externalRecordId, '999');
        await publish(enrichment(service.get(jid)!, '1000'));
        assert.equal((await service.getResolvedIdentity(jid))?.externalRecordId, '1000');
        await rm(path);
        assert.equal((await service.getResolvedIdentity(jid))?.externalRecordId, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('enrichment cannot create a contact, change delivery routing or override base identity', async () => {
    const { root, service, publish } = await setup();
    try {
        await publish({ ...enrichment(service.get(jid)!), phone: '15559999999', whatsappJid: 'evil@lid', phoneJid: 'evil@s.whatsapp.net', source: 'manual' });
        const merged = await service.getResolvedIdentity(jid);
        assert.equal(merged?.phone, '15550102030');
        assert.equal(merged?.whatsappJid, jid);
        assert.equal(merged?.phoneJid, pn);
        assert.equal(merged?.source, 'auto');
        assert.equal(await service.getResolvedIdentity('unknown@lid'), undefined);
        assert.equal(service.findByJid('evil@s.whatsapp.net'), undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('manual relink invalidates all prior enrichment rather than mixing CRM records', async () => {
    const { root, service, publish } = await setup();
    try {
        await publish(enrichment(service.get(jid)!));
        await service.setManualMapping(jid, { externalRecordId: '42' });
        const merged = await service.getResolvedIdentity(jid);
        assert.equal(merged?.externalRecordId, '42');
        assert.equal(merged?.email, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('changed WhatsApp phone invalidates enrichment', async () => {
    const { root, service, publish } = await setup();
    try {
        await publish(enrichment(service.get(jid)!));
        await service.recordLidPnMapping(jid, '15559999999@s.whatsapp.net');
        assert.equal((await service.getResolvedIdentity(jid))?.externalRecordId, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('operator clear suppresses enrichment across incoming activity and reload until relink', async () => {
    const { root, service, publish } = await setup();
    try {
        await service.clearLinkedIdentity(jid);
        await service.recordLidPnMapping(jid, pn);
        // Even a sync with the new basis may not undo an explicit clear.
        await publish(enrichment(service.get(jid)!));
        assert.equal((await service.getResolvedIdentity(jid))?.externalRecordId, undefined);
        const reloaded = new IdentityMapService(root);
        assert.equal((await reloaded.getResolvedIdentity(jid))?.externalRecordId, undefined);
        await reloaded.setManualMapping(jid, { externalRecordId: '42' });
        await publish(enrichment(reloaded.get(jid)!, '42'));
        assert.equal((await reloaded.getResolvedIdentity(jid))?.email, 'test@example.com');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing basis, malformed fields and corrupt/unsupported stores fall back to base', async () => {
    const { root, service, path, publish } = await setup();
    try {
        await publish({ email: 'test@example.com', externalRecordId: '999' });
        assert.equal((await service.getResolvedIdentity(jid))?.externalRecordId, undefined);
        await publish({ ...enrichment(service.get(jid)!), externalRecordId: { unsafe: true } });
        assert.equal((await service.getResolvedIdentity(jid))?.externalRecordId, undefined);
        await publish(enrichment(service.get(jid)!), 2);
        assert.equal((await service.getResolvedIdentity(jid))?.externalRecordId, undefined);
        await writeFile(path, '{broken');
        assert.equal((await service.getResolvedIdentity(jid))?.externalRecordId, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
});
