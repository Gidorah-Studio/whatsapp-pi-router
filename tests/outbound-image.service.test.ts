import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    cleanupImageHandoff,
    createImageHandoffDirectory,
    IMAGE_HANDOFF_MANIFEST,
    loadImageHandoff,
    stageImageHandoff
} from '../src/services/outbound-image.service.js';

const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
);

test('stages and validates a private WhatsApp image handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-image-handoff-test-'));
    const sourcePath = join(root, 'rendered.png');
    await writeFile(sourcePath, ONE_PIXEL_PNG);
    const handoffDir = await createImageHandoffDirectory(join(root, 'media'));

    try {
        const staged = await stageImageHandoff({
            sourcePath,
            handoffDir,
            caption: '  A friendly sketch  '
        });
        assert.equal(staged.mimeType, 'image/png');
        assert.equal(staged.caption, 'A friendly sketch');
        assert.equal((await stat(staged.path)).mode & 0o777, 0o600);
        assert.equal((await stat(join(handoffDir, IMAGE_HANDOFF_MANIFEST))).mode & 0o777, 0o600);

        const loaded = await loadImageHandoff(handoffDir);
        assert.deepEqual(loaded, staged);
        assert.deepEqual(await readFile(sourcePath), ONE_PIXEL_PNG);

        await cleanupImageHandoff(handoffDir);
        await assert.rejects(access(staged.path), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
        await access(sourcePath);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('rejects non-image files and unsafe handoff filenames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-image-validation-test-'));
    const sourcePath = join(root, 'not-an-image.txt');
    const handoffDir = await createImageHandoffDirectory(join(root, 'media'));

    try {
        await writeFile(sourcePath, 'not an image');
        await assert.rejects(
            stageImageHandoff({ sourcePath, handoffDir }),
            /must be a PNG or JPEG/
        );

        await writeFile(join(handoffDir, IMAGE_HANDOFF_MANIFEST), JSON.stringify({
            version: 1,
            type: 'image',
            imageFile: '../private.png',
            mimeType: 'image/png'
        }));
        await assert.rejects(loadImageHandoff(handoffDir), /invalid WhatsApp image handoff filename/i);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
