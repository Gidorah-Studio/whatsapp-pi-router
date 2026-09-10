import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TextToSpeechService } from '../src/services/text-to-speech.service.js';
import { getDefaultResolvedVoiceReplyConfig } from '../src/services/voice-reply.config.js';

const logger = { log() {}, error() {} };

test('shutdown propagates cancellation to speech synthesis and removes temporary artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'router-tts-cancel-'));
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    try {
        const service = new TextToSpeechService(logger, {
            synthesize(_text, options) {
                assert.equal(options.signal, controller.signal);
                return new Promise((_resolve, reject) => {
                    options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
                    started();
                });
            },
        }, root);
        const pending = service.createVoiceNote('Hello', getDefaultResolvedVoiceReplyConfig(), controller.signal);
        const rejected = assert.rejects(pending);
        await ready;
        controller.abort();
        await rejected;
        assert.deepEqual(await readdir(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed TTS converter preserves synthesis flow and artifact cleanup without external APIs', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'router-tts-converter-'));
    try {
        const binary = join(root, 'fake-ffmpeg.mjs');
        await writeFile(binary, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs'; writeFileSync(process.argv.at(-1),'OggS');\n`);
        await chmod(binary, 0o700);
        const media = join(root, 'media');
        const service = new TextToSpeechService(logger, { async synthesize() { return { audio: Buffer.from('fake-pcm'), format: 'pcm' }; } }, media);
        (service as any).ffmpegCommands = [binary];
        const artifact = await service.createVoiceNote('Hello', getDefaultResolvedVoiceReplyConfig());
        assert.equal(await readFile(artifact.path, 'utf8'), 'OggS');
        await artifact.cleanup();
        assert.deepEqual(await readdir(media), []);
    } finally { await rm(root, { recursive: true, force: true }); }
});
