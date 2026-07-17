import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVoiceReplyPromptLines, planVoiceReply, WHATSAPP_VOICE_MARKER } from '../src/services/voice-reply.service.js';

const reply = `Hello there.\n${WHATSAPP_VOICE_MARKER}`;

test('off mode strips an unexpected marker and returns text', () => {
    assert.deepEqual(planVoiceReply(reply, 'off', true), {
        text: 'Hello there.',
        useVoice: false,
        explicitRequested: true,
        reason: 'off'
    });
});

test('explicit mode uses voice only when the marker is present', () => {
    assert.equal(planVoiceReply('Hello there.', 'explicit', false).useVoice, false);
    const plan = planVoiceReply(reply, 'explicit', false);
    assert.equal(plan.useVoice, true);
    assert.equal(plan.reason, 'explicit');
    assert.equal(plan.text, 'Hello there.');
});

test('mirror mode follows the incoming media type', () => {
    assert.equal(planVoiceReply('Hello there.', 'mirror', true).useVoice, true);
    assert.equal(planVoiceReply('Hello there.', 'mirror', false).useVoice, false);
});

test('mirror-explicit mode supports both activation paths', () => {
    assert.equal(planVoiceReply('Hello there.', 'mirror-explicit', true).reason, 'mirror');
    assert.equal(planVoiceReply(reply, 'mirror-explicit', false).reason, 'explicit');
    assert.equal(planVoiceReply('Hello there.', 'mirror-explicit', false).useVoice, false);
});

test('always mode sends non-empty replies as voice', () => {
    assert.equal(planVoiceReply('Hello there.', 'always', false).useVoice, true);
    assert.equal(planVoiceReply('', 'always', false).useVoice, false);
});

test('voice marker must be on its own line', () => {
    const inline = `Hello ${WHATSAPP_VOICE_MARKER}`;
    const plan = planVoiceReply(inline, 'explicit', false);
    assert.equal(plan.explicitRequested, false);
    assert.equal(plan.useVoice, false);
    assert.equal(plan.text, inline);
});

test('prompt guidance distinguishes automatic and explicit voice replies', () => {
    const automatic = buildVoiceReplyPromptLines('mirror-explicit', true).join('\n');
    assert.match(automatic, /will be synthesized/);
    assert.match(automatic, /whatsapp_voice.*optional/i);

    const explicit = buildVoiceReplyPromptLines('mirror-explicit', false).join('\n');
    assert.match(explicit, /To send this response as a voice note/);
    assert.match(explicit, /whatsapp_voice/);

    assert.deepEqual(buildVoiceReplyPromptLines('off', true), []);
});
