import assert from 'node:assert/strict';
import test from 'node:test';
import { GroupReplyKeywordMatcher, normalizeGroupReplyKeywords, parseGroupReplyKeywordsInput } from '../src/services/group-reply-keywords.js';
import { parseRouterAllowConfig } from '../src/services/router-allow.config.js';

test('matches whole words case-insensitively, not word fragments', () => {
    const matcher = new GroupReplyKeywordMatcher(['Emily']);
    for (const text of ['Emily', 'Hey EMILY!', '(emily)', "Emily's reply", 'emily, help']) assert.equal(matcher.matches(text), true, text);
    for (const text of ['Emilyson', 'xEmily', 'emily2', 'hey_emily', 'Emily\u0301', 'hello']) assert.equal(matcher.matches(text), false, text);
});

test('normalizes Unicode and whitespace, handles phrases, and treats regex punctuation literally', () => {
    const matcher = new GroupReplyKeywordMatcher(['Émilie', 'sales team', 'C++', 'a.b']);
    for (const text of ['Hey E\u0301MILIE!', 'sales\n  TEAM, help', 'C++!', 'a.b']) assert.equal(matcher.matches(text), true, text);
    for (const text of ['ab', 'axb', 'sales teammate', 'XC++', 'C++x']) assert.equal(matcher.matches(text), false, text);
    assert.equal(new GroupReplyKeywordMatcher(['إميلي']).matches('مرحبا إميلي!'), true);
    assert.equal(new GroupReplyKeywordMatcher(['emily']).matches('ＥＭＩＬＹ!'), true);
});

test('normalizes and bounds configuration without enabling empty or invalid keywords', () => {
    assert.deepEqual(normalizeGroupReplyKeywords([' Emily ', 'emily', '', null, '*', ' sales   team ', 'x'.repeat(81)]), ['emily', 'sales team']);
    assert.deepEqual(normalizeGroupReplyKeywords('emily'), []);
    assert.equal(normalizeGroupReplyKeywords(Array.from({ length: 40 }, (_, n) => `word${n}`)).length, 32);
    assert.equal(new GroupReplyKeywordMatcher([]).matches('anything'), false);
    assert.equal(new GroupReplyKeywordMatcher(['']).matches(''), false);
    assert.equal(new GroupReplyKeywordMatcher(['emily']).matches('emily ' + 'x'.repeat(65536)), false);
});

test('editor validates instead of silently dropping invalid entries, and blank clears', () => {
    assert.deepEqual(parseGroupReplyKeywordsInput(' Emily\r\nemily\n sales team '), ['emily', 'sales team']);
    assert.deepEqual(parseGroupReplyKeywordsInput(' \n'), []);
    assert.throws(() => parseGroupReplyKeywordsInput('x'.repeat(81)), /80/);
    assert.throws(() => parseGroupReplyKeywordsInput('*'), /letter or number/);
    assert.throws(() => parseGroupReplyKeywordsInput(Array.from({ length: 33 }, (_, n) => `word${n}`).join('\n')), /32/);
});

test('new config mode is opt-in; legacy modes and malformed keyword lists stay safe', () => {
    for (const raw of ['{}', '["15551234567"]']) {
        const config = parseRouterAllowConfig(raw);
        assert.equal(config.groupReplyMode, 'all');
        assert.deepEqual(config.groupReplyKeywords, []);
    }
    const config = parseRouterAllowConfig('{"groupReplyMode":" MENTIONS-OR-KEYWORDS ","groupReplyKeywords":["Emily","HELP"]}');
    assert.equal(config.groupReplyMode, 'mentions-or-keywords');
    assert.deepEqual(config.groupReplyKeywords, ['emily', 'help']);
    const malformed = parseRouterAllowConfig('{"groupReplyMode":"mentions-or-keywords","groupReplyKeywords":"emily"}');
    assert.equal(malformed.groupReplyMode, 'mentions-or-keywords');
    assert.deepEqual(malformed.groupReplyKeywords, []);
    assert.equal(parseRouterAllowConfig('{"groupReplyMode":"mentions","groupReplyKeywords":["Emily"]}').groupReplyMode, 'mentions');
});
