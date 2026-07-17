import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SpeechSynthesizer } from '../src/services/openrouter-speech.synthesizer.js';
import { TextToSpeechService } from '../src/services/text-to-speech.service.js';
import { getDefaultResolvedVoiceReplyConfig } from '../src/services/voice-reply.config.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('TTS service converts synthesized MP3 into a private OGG/Opus voice note', { skip: !hasFfmpeg }, async () => {
    const generated = spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
        '-t', '0.2',
        '-f', 'mp3', 'pipe:1'
    ], { encoding: null, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(generated.status, 0, generated.stderr?.toString());
    assert.ok(generated.stdout.length > 0);

    const synthesizer: SpeechSynthesizer = {
        async synthesize() {
            return generated.stdout;
        }
    };
    const logger = { log() {}, error() {} };
    const mediaDir = await mkdtemp(join(tmpdir(), 'whatsapp-tts-test-'));

    try {
        const service = new TextToSpeechService(logger, synthesizer, mediaDir);
        const artifact = await service.createVoiceNote('Hello from a test.', getDefaultResolvedVoiceReplyConfig());
        const header = (await readFile(artifact.path)).subarray(0, 4).toString('ascii');
        assert.equal(header, 'OggS');
        assert.equal((await stat(artifact.path)).mode & 0o777, 0o600);

        await artifact.cleanup();
        await assert.rejects(access(artifact.path), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    } finally {
        await rm(mediaDir, { recursive: true, force: true });
    }
});
