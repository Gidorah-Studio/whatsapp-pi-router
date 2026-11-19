import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMediaService } from '../src/services/incoming-media.service.js';
import { createIncomingMediaTurn } from '../src/services/incoming-media-storage.js';
import { extractedTextPath, isExtractableDocument } from '../src/services/document-text.js';
import { runMediaWorker } from '../src/services/media-worker.js';
import { RouterError } from '../src/services/router-errors.js';

type Worker = (kind: string, path: string, signal?: AbortSignal, outputPath?: string) => Promise<string>;

async function processDocument(document: Record<string, unknown>, worker: Worker, signal?: AbortSignal) {
    const root = await mkdtemp(join(tmpdir(), 'document-text-'));
    const turn = await createIncomingMediaTurn('approved@g.us', root);
    const service = new IncomingMediaService({} as any, { warn() {} } as any, async () => Buffer.from('file bytes'), worker as any);
    try {
        return await service.process({ kind: 'document', text: '', documentMessage: document }, 'Sender', turn, signal);
    } finally {
        await turn.cleanup();
        await rm(root, { recursive: true, force: true });
    }
}

test('extractable documents are recognised by extension only', () => {
    for (const name of ['Orders.XLSX', 'a.docx', 'b.csv', 'c.txt', 'deck.pptx', 'old.xls', 'x.ods', 'archive.tar.json']) {
        assert.equal(isExtractableDocument(name), true, name);
    }
    for (const name of ['photo.zip', 'setup.exe', 'report.pdf', 'xlsx', 'csv', '', 'noextension', 'trailing.']) {
        assert.equal(isExtractableDocument(name), false, name);
    }
});

test('a spreadsheet gets a text preview and the path of its full extracted text', async () => {
    const calls: Array<{ kind: string; path: string; outputPath?: string }> = [];
    const result = await processDocument(
        { fileName: 'orders.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', caption: 'this week' },
        async (kind, path, _signal, outputPath) => { calls.push({ kind, path, outputPath }); return 'Product Qty\nWidget 12'; },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.kind, 'document');
    assert.equal(calls[0]!.path, result.documentPath);
    assert.equal(calls[0]!.outputPath, extractedTextPath(result.documentPath!));
    assert.match(result.text, /Document text preview:\nProduct Qty\nWidget 12/);
    assert.ok(result.text.includes(extractedTextPath(result.documentPath!)));
    assert.match(result.text, /Description: this week/);
});

test('extraction failure or empty text falls back to the saved file without failing the turn', async () => {
    for (const worker of [async () => { throw new RouterError('child-failed', 1); }, async () => '   ']) {
        const result = await processDocument({ fileName: 'notes.docx' }, worker);
        assert.match(result.text, /Document text was not extracted automatically/);
        assert.ok(result.documentPath);
        assert.ok(!result.text.includes('.extracted.txt'));
    }
});

test('unsupported formats are saved without starting a worker, and PDFs keep their own preview', async () => {
    const kinds: string[] = [];
    const worker: Worker = async kind => { kinds.push(kind); return 'text'; };
    const archive = await processDocument({ fileName: 'backup.zip', mimetype: 'application/zip' }, worker);
    assert.doesNotMatch(archive.text, /preview|extracted/i);
    const pdf = await processDocument({ fileName: 'invoice.pdf', mimetype: 'application/pdf' }, worker);
    assert.match(pdf.text, /PDF text preview:/);
    assert.deepEqual(kinds, ['pdf']);
});

test('shutdown during extraction cancels the turn instead of reporting a fallback', async () => {
    const controller = new AbortController();
    await assert.rejects(processDocument({ fileName: 'big.xlsx' }, async () => {
        controller.abort();
        throw new RouterError('stopped');
    }, controller.signal));
});

test('worker extracts a real CSV to a private file and returns a bounded preview', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-worker-'));
    try {
        const source = join(root, 'orders.csv');
        const output = extractedTextPath(source);
        const rows = Array.from({ length: 400 }, (_, i) => `Widget ${i},${i},4.50`).join('\n');
        await writeFile(source, `Product,Qty,Price\n\n\n\n\n${rows}\n`);
        const preview = await runMediaWorker('document', source, undefined, output);
        const full = await readFile(output, 'utf8');
        assert.ok(preview.startsWith('Product,Qty,Price\n\nWidget 0,0,4.50'));
        assert.equal(preview.length, 1200);
        assert.ok(full.endsWith('Widget 399,399,4.50'));
        assert.equal((await stat(output)).mode & 0o777, 0o600);
        await assert.rejects(runMediaWorker('document', source, undefined, output));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker reports failure for a missing file and writes nothing for an empty one', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-worker-'));
    try {
        await assert.rejects(runMediaWorker('document', join(root, 'missing.txt'), undefined, join(root, 'missing.out')));
        await writeFile(join(root, 'empty.txt'), '  \n');
        assert.equal(await runMediaWorker('document', join(root, 'empty.txt'), undefined, join(root, 'empty.out')), '');
        await assert.rejects(stat(join(root, 'empty.out')));
        await assert.rejects(runMediaWorker('document', join(root, 'empty.txt')));
    } finally { await rm(root, { recursive: true, force: true }); }
});
