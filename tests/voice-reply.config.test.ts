import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    getDefaultResolvedVoiceReplyConfig,
    getVoiceReplyConfigPath,
    loadResolvedVoiceReplyConfig,
    loadVoiceReplyFileConfig,
    saveVoiceReplyFileConfig
} from '../src/services/voice-reply.config.js';

test('Gemini Flash TTS with Sulafat is the default voice configuration', () => {
    const defaults = getDefaultResolvedVoiceReplyConfig();
    assert.equal(defaults.model, 'google/gemini-3.1-flash-tts-preview');
    assert.equal(defaults.voice, 'Sulafat');
});

const ENV_NAMES = [
    'WHATSAPP_PI_ROUTER_TTS_MODE',
    'WHATSAPP_PI_ROUTER_TTS_MODEL',
    'WHATSAPP_PI_ROUTER_TTS_VOICE',
    'WHATSAPP_PI_ROUTER_TTS_SPEED'
] as const;

test('voice settings persist privately and environment values override saved values', async () => {
    const originalHome = process.env.HOME;
    const originalEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
    const home = await mkdtemp(join(tmpdir(), 'whatsapp-voice-config-test-'));

    try {
        process.env.HOME = home;
        for (const name of ENV_NAMES) delete process.env[name];

        await saveVoiceReplyFileConfig({
            mode: 'mirror-explicit',
            model: 'custom/speech-model',
            voice: 'custom-voice',
            speed: 1.1
        });
        assert.deepEqual(await loadVoiceReplyFileConfig(), {
            mode: 'mirror-explicit',
            model: 'custom/speech-model',
            voice: 'custom-voice',
            speed: 1.1
        });
        assert.equal((await stat(getVoiceReplyConfigPath())).mode & 0o777, 0o600);
        assert.match(await readFile(getVoiceReplyConfigPath(), 'utf8'), /mirror-explicit/);

        process.env.WHATSAPP_PI_ROUTER_TTS_MODE = 'explicit';
        process.env.WHATSAPP_PI_ROUTER_TTS_VOICE = 'override-voice';
        process.env.WHATSAPP_PI_ROUTER_TTS_SPEED = '1.25';
        const resolved = await loadResolvedVoiceReplyConfig();
        assert.equal(resolved.mode, 'explicit');
        assert.equal(resolved.modeSource, 'environment');
        assert.equal(resolved.modelSource, 'file');
        assert.equal(resolved.voice, 'override-voice');
        assert.equal(resolved.voiceSource, 'environment');
        assert.equal(resolved.speed, 1.25);
        assert.equal(resolved.speedSource, 'environment');
    } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        for (const name of ENV_NAMES) {
            const value = originalEnv[name];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        await rm(home, { recursive: true, force: true });
    }
});

test('invalid speed is rejected', async () => {
    await assert.rejects(
        saveVoiceReplyFileConfig({ speed: 3 }),
        /must be a number from 0.5 to 2/
    );
});
