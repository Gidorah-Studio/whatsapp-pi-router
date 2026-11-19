import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMediaService } from '../src/services/incoming-media.service.js';
import { createIncomingMediaTurn } from '../src/services/incoming-media-storage.js';
import { isPlainTextDocument, plainTextPreview } from '../src/services/document-text.js';

async function processDocument(document: Record<string, unknown>, content: Buffer) {
    const root = await mkdtemp(join(tmpdir(), 'document-text-'));
    const turn = await createIncomingMediaTurn('approved@g.us', root);
    const workerKinds: string[] = [];
    const service = new IncomingMediaService({} as any, { warn() {} } as any, async () => content,
        async (kind: string) => { workerKinds.push(kind); return 'pdf text'; });
    try {
        const result = await service.process({ kind: 'document', text: '', documentMessage: document }, 'Sender', turn);
        return { result, workerKinds, saved: await readFile(result.documentPath!) };
    } finally {
        await turn.cleanup();
        await rm(root, { recursive: true, force: true });
    }
}

test('plain-text documents are recognised by extension only', () => {
    for (const name of ['Orders.CSV', 'a.txt', 'b.json', 'notes.md', 'page.htm', 'config.yml', 'archive.tar.json']) {
        assert.equal(isPlainTextDocument(name), true, name);
    }
    for (const name of ['orders.xlsx', 'a.docx', 'deck.pptx', 'photo.zip', 'report.pdf', 'csv', '', 'noextension', 'trailing.']) {
        assert.equal(isPlainTextDocument(name), false, name);
    }
});

test('preview is bounded, drops a BOM and blank-line padding, and tolerates a cut multi-byte character', () => {
    assert.equal(plainTextPreview(Buffer.from('﻿Product,Qty\n\n\n\n\nWidget,12\n')), 'Product,Qty\n\nWidget,12');
    assert.equal(plainTextPreview(Buffer.from('x'.repeat(10_000))).length, 1200);
    const emoji = plainTextPreview(Buffer.from('😀'.repeat(5000)));
    assert.ok(emoji.length <= 1200);
    assert.doesNotMatch(emoji, /�/);
    assert.equal(plainTextPreview(Buffer.from('  \n ')), '');
    assert.equal(plainTextPreview(Buffer.alloc(0)), '');
});

test('a CSV adds a text preview to the prompt and is saved unchanged', async () => {
    const content = Buffer.from('Product,Qty\nWidget,12\n');
    const { result, workerKinds, saved } = await processDocument({ fileName: 'orders.csv', mimetype: 'text/csv', caption: 'this week' }, content);
    assert.match(result.text, /Document text preview:\nProduct,Qty\nWidget,12/);
    assert.match(result.text, /Description: this week/);
    assert.ok(result.text.includes(result.documentPath!));
    assert.deepEqual(saved, content);
    assert.deepEqual(workerKinds, []);
});

test('Office and other binary documents are passed as name, type and path with no extraction', async () => {
    for (const document of [
        { fileName: 'orders.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        { fileName: 'notes.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        { fileName: 'backup.zip', mimetype: 'application/zip' },
    ]) {
        const { result, workerKinds } = await processDocument(document, Buffer.from('PK\u0003\u0004 binary'));
        assert.ok(result.text.includes(document.fileName));
        assert.ok(result.text.includes(document.mimetype));
        assert.ok(result.text.includes(result.documentPath!));
        assert.doesNotMatch(result.text, /preview|extracted/i);
        assert.deepEqual(workerKinds, []);
    }
});

test('an empty text document adds no preview, and PDFs keep their own preview', async () => {
    const empty = await processDocument({ fileName: 'empty.txt' }, Buffer.from(' \n'));
    assert.doesNotMatch(empty.result.text, /preview/i);
    const pdf = await processDocument({ fileName: 'invoice.pdf', mimetype: 'application/pdf' }, Buffer.from('%PDF'));
    assert.match(pdf.result.text, /PDF text preview:\npdf text/);
    assert.deepEqual(pdf.workerKinds, ['pdf']);
});
