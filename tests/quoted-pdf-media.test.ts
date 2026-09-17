import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMediaService } from '../src/services/incoming-media.service.js';
import { createIncomingMediaTurn } from '../src/services/incoming-media-storage.js';

test('quoted PDF uses bounded document download, temporary private storage, preview extraction, and cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quoted-pdf-'));
    const calls: string[] = [];
    const service = new IncomingMediaService(
        {} as any,
        { warn() {} } as any,
        async (_message: any, kind: any) => { calls.push(`download:${kind}`); return Buffer.from('%PDF fixture'); },
        async (kind: string, path: string) => {
            calls.push(`worker:${kind}`);
            assert.match(path, /turn-/);
            return 'Extracted quoted PDF text';
        },
    );
    const turn = await createIncomingMediaTurn('approved@g.us', root);
    try {
        const result = await service.processQuotedPdf({ fileName: '../../report.pdf', mimetype: 'application/pdf' }, turn);
        assert.deepEqual(calls, ['download:document', 'worker:pdf']);
        assert(result.documentPath?.startsWith(turn.temporary));
        assert.equal(await readFile(result.documentPath!, 'utf8'), '%PDF fixture');
        assert.match(result.text, /Extracted quoted PDF text/);
        if (process.platform !== 'win32') assert.equal((await stat(result.documentPath!)).mode & 0o777, 0o600);
        const path = result.documentPath!;
        await turn.cleanup();
        await assert.rejects(stat(path));
    } finally {
        await turn.cleanup();
        await rm(root, { recursive: true, force: true });
    }
});

test('non-PDF quoted documents are rejected before download', async () => {
    let downloads = 0;
    const service = new IncomingMediaService(
        {} as any,
        { warn() {} } as any,
        async () => { downloads++; return Buffer.from('data'); },
        async () => '',
    );
    const root = await mkdtemp(join(tmpdir(), 'quoted-non-pdf-'));
    const turn = await createIncomingMediaTurn('approved@g.us', root);
    try {
        await assert.rejects(service.processQuotedPdf({ fileName: 'notes.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, turn), /not a PDF/);
        assert.equal(downloads, 0);
    } finally {
        await turn.cleanup();
        await rm(root, { recursive: true, force: true });
    }
});
