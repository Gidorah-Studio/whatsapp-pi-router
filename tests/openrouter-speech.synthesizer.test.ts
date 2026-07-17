import assert from 'node:assert/strict';
import test from 'node:test';
import { getOpenRouterSpeechResponseFormat } from '../src/services/openrouter-speech.synthesizer.js';

test('Gemini TTS models request PCM while other OpenRouter TTS models request MP3', () => {
    assert.equal(getOpenRouterSpeechResponseFormat('google/gemini-3.1-flash-tts-preview'), 'pcm');
    assert.equal(getOpenRouterSpeechResponseFormat('google/gemini-2.5-flash-preview-tts'), 'pcm');
    assert.equal(getOpenRouterSpeechResponseFormat('x-ai/grok-voice-tts-1.0'), 'mp3');
});
