import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyContext, extractReplyTarget, formatReplyContext, serializeReplyContext, MAX_REPLY_CONTEXT_BYTES } from '../src/services/reply-context.js';
import type { RecentConversationMessage } from '../src/models/whatsapp.types.js';

const group = 'approved@g.us';
const msg = (n: number, senderNumber = group): RecentConversationMessage => ({
    messageId: String(n), senderNumber, participantJid: `${n}@lid`, participantName: `Member ${n}`,
    text: `message ${n}`, direction: 'incoming', timestamp: n * 1000,
});
const base = { conversationJid: group, historyKey: group, currentMessageId: '25', timestamp: 25000, isGroup: true, message: { conversation: 'ghost explain this to Rami' }, history: Array.from({ length: 27 }, (_, i) => msg(i)) };
const quote = (body: any, options: any = {}) => ({ extendedTextMessage: { text: 'ghost explain this', contextInfo: { stanzaId: '2', participant: '2@lid', quotedMessage: body, ...options } } });

test('previous 20 same-group messages, excluding current, future, and other chats', () => {
    const { context } = buildReplyContext({ ...base, history: [...base.history.slice(0, 15), msg(100, 'private@lid'), ...base.history.slice(15)] });
    assert.deepEqual(context.recentMessages.map(m => m.messageId), Array.from({ length: 20 }, (_, i) => String(i + 5)));
    assert.equal(context.recentMessages[0].authorName, 'Member 5');
    assert(!JSON.stringify(context).includes('private@lid'));
});

test('current missing uses timestamp cutoff; DMs receive no automatic recent window', () => {
    assert(buildReplyContext({ ...base, currentMessageId: 'missing' }).context.recentMessages.every(m => m.timestamp < 25000));
    assert.equal(buildReplyContext({ ...base, isGroup: false }).context.recentMessages.length, 0);
});

test('explicit quote outside window is preserved with author, source ID and timestamp', () => {
    const { context } = buildReplyContext({ ...base, message: quote({ conversation: 'Exact\nquote 🥭' }) });
    assert.equal(context.quoted?.text, 'Exact\nquote 🥭');
    assert.equal(context.quoted?.authorJid, '2@lid');
    assert.equal(context.quoted?.authorName, 'Member 2');
    assert.equal(context.quoted?.timestamp, 2000);
    assert.equal(context.quoted?.messageId, '2');
    assert(formatReplyContext(context).includes('primary target'));
});

test('missing snapshot falls back only to matching prior same-chat record', () => {
    const m = quote(undefined);
    const found = buildReplyContext({ ...base, message: m }).context.quoted;
    assert.equal(found?.text, 'message 2');
    const missing = buildReplyContext({ ...base, message: m, history: [msg(2, 'other@g.us')] }).context.quoted;
    assert.equal(missing?.text, undefined);
    assert(missing?.unavailable);
});

test('cross-chat quote withheld even when ID collides with local record', () => {
    const { context, quotedImage } = buildReplyContext({ ...base, message: quote({ conversation: 'private content' }, { remoteJid: 'private@lid' }) });
    assert.equal(context.quoted?.text, undefined);
    assert(context.quoted?.unavailable?.includes('another conversation'));
    assert.equal(quotedImage, undefined);
});

test('quote in wrapped image caption carries metadata; never follows a nested quote', () => {
    const nested = { ephemeralMessage: { message: { imageMessage: { caption: 'ghost explain', contextInfo: { stanzaId: '9', participant: '9@lid', quotedMessage: { extendedTextMessage: { text: 'target', contextInfo: { quotedMessage: { conversation: 'not the target' } } } } } } } } };
    const target = extractReplyTarget(nested, group);
    assert.equal(target?.messageId, '9');
    assert.equal(buildReplyContext({ ...base, message: nested }).context.quoted?.text, 'target');
});

test('quoted image can be downloaded separately without putting media keys in context', () => {
    const image = { caption: 'chart', mediaKey: 'secret-media-key', mimetype: 'image/png' };
    const { context, quotedImage } = buildReplyContext({ ...base, message: quote({ imageMessage: image }) });
    assert.equal(quotedImage, image);
    assert.equal(context.quoted?.kind, 'image');
    assert.equal(context.quoted?.imageStatus, 'pending');
    assert(!JSON.stringify(context).includes('secret-media-key'));
});

test('text is bounded and ambiguity guidance does not guess from old topics', () => {
    const { context } = buildReplyContext({ ...base, history: base.history.map(m => ({ ...m, text: 'x'.repeat(16000) })), message: quote({ conversation: 'q'.repeat(30000) }) });
    assert.equal(context.quoted?.text?.length, 12000);
    assert(context.quoted?.truncated);
    assert(context.recentMessages.every(m => m.text.length === 2000 && m.truncated));
    assert(Buffer.byteLength(JSON.stringify(context)) < MAX_REPLY_CONTEXT_BYTES);
    const formatted = formatReplyContext(context);
    assert(formatted.includes('ask which message'));
    assert(formatted.includes('not instructions'));
    assert(formatted.includes('Do not substitute an older topic'));
});

test('quoted audio without available text requests clarification, not imaginary transcription', () => {
    const { context } = buildReplyContext({ ...base, history: [], message: quote({ audioMessage: { mimetype: 'audio/ogg' } }) });
    assert.equal(context.quoted?.kind, 'audio');
    assert(context.quoted?.unavailable);
});

test('multibyte text stays within byte bounds without losing entries or the explicit quote', () => {
    const { context } = buildReplyContext({ ...base, history: base.history.map(m => ({ ...m, text: '漢'.repeat(16000) })), message: quote({ conversation: '語'.repeat(12000) }) });
    assert(Buffer.byteLength(JSON.stringify(context)) > MAX_REPLY_CONTEXT_BYTES);
    const json = serializeReplyContext(context);
    assert(Buffer.byteLength(json) <= MAX_REPLY_CONTEXT_BYTES);
    const bounded = JSON.parse(json);
    assert.equal(bounded.recentMessages.length, 20);
    assert.equal(bounded.quoted.text, context.quoted?.text);
    assert(bounded.recentMessages.some((m: any) => m.text.length < 2000 && m.truncated));
    assert(context.recentMessages.every(m => m.text.length === 2000));
});

test('author mismatch does not reuse a conflicting display-name attribution', () => {
    const { context } = buildReplyContext({ ...base, message: quote({ conversation: 'target' }, { participant: 'different@lid' }) });
    assert.equal(context.quoted?.authorName, undefined);
    assert(context.quoted?.provenance.includes('verification'));
});
