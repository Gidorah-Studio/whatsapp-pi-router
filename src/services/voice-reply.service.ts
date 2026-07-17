import type { VoiceReplyMode } from './voice-reply.config.js';

export const WHATSAPP_VOICE_MARKER = '<!-- whatsapp_voice -->';

const VOICE_MARKER_PATTERN = /^[\t ]*<!--[\t ]*whatsapp_voice[\t ]*-->[\t ]*(?:\r?\n)?/gim;

export interface VoiceReplyPlan {
    text: string;
    useVoice: boolean;
    explicitRequested: boolean;
    reason: 'off' | 'explicit' | 'mirror' | 'always' | 'text';
}

export function planVoiceReply(
    rawReply: string,
    mode: VoiceReplyMode,
    incomingWasVoice: boolean
): VoiceReplyPlan {
    const explicitRequested = rawReply.match(VOICE_MARKER_PATTERN) !== null;
    const text = rawReply.replace(VOICE_MARKER_PATTERN, '').trim();

    if (!text || mode === 'off') {
        return { text, useVoice: false, explicitRequested, reason: 'off' };
    }

    if (mode === 'always') {
        return { text, useVoice: true, explicitRequested, reason: 'always' };
    }

    if ((mode === 'mirror' || mode === 'mirror-explicit') && incomingWasVoice) {
        return { text, useVoice: true, explicitRequested, reason: 'mirror' };
    }

    if ((mode === 'explicit' || mode === 'mirror-explicit') && explicitRequested) {
        return { text, useVoice: true, explicitRequested, reason: 'explicit' };
    }

    return { text, useVoice: false, explicitRequested, reason: 'text' };
}

export function buildVoiceReplyPromptLines(mode: VoiceReplyMode, incomingWasVoice: boolean): string[] {
    if (mode === 'off') return [];

    const voiceWillBeAutomatic = mode === 'always'
        || ((mode === 'mirror' || mode === 'mirror-explicit') && incomingWasVoice);
    const explicitEnabled = mode === 'explicit' || mode === 'mirror-explicit';
    const lines = [
        '',
        '[WhatsApp voice reply policy]',
        `Mode: ${mode}`,
        `Incoming message was voice: ${incomingWasVoice ? 'yes' : 'no'}`
    ];

    if (voiceWillBeAutomatic) {
        lines.push('This reply will be synthesized as a WhatsApp voice note. Keep it concise and TTS-friendly: use natural spoken prose, and avoid tables, code blocks, raw URLs, or formatting that sounds awkward aloud.');
    } else if (explicitEnabled) {
        lines.push(`To send this response as a voice note, add ${WHATSAPP_VOICE_MARKER} on its own line. Use it when the user explicitly asks for voice or a spoken reply is clearly useful. The router removes the marker before delivery.`);
    }

    if (mode === 'mirror-explicit' && incomingWasVoice) {
        lines.push(`The incoming voice message already activates voice mirroring, so ${WHATSAPP_VOICE_MARKER} is optional for this reply.`);
    }

    return lines;
}
