import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    ConnectionEventJournal,
    classifyDisconnect
} from '../src/services/connection-lifecycle.js';

test('classifies disconnect reasons into explicit recovery actions', () => {
    assert.deepEqual(classifyDisconnect(401, ''), {
        classification: 'reauth-required',
        action: 'pair-new-device',
        reason: 'logged-out'
    });
    assert.deepEqual(classifyDisconnect(440, ''), {
        classification: 'connection-conflict',
        action: 'resolve-conflict',
        reason: 'connection-replaced'
    });
    assert.deepEqual(classifyDisconnect(500, ''), {
        classification: 'reauth-required',
        action: 'pair-new-device',
        reason: 'bad-session'
    });
    assert.equal(classifyDisconnect(408, '').classification, 'transient');
    assert.equal(classifyDisconnect(515, '').action, 'reconnect');
    assert.equal(classifyDisconnect(undefined, 'Bad MAC while decrypting').reason, 'bad-mac');
    assert.equal(classifyDisconnect(undefined, 'unexpected close').classification, 'unknown');
    assert.equal(classifyDisconnect(401, '', true).classification, 'intentional');
});

test('writes sanitized structured lifecycle events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-lifecycle-'));
    const logPath = join(root, 'connection-events.jsonl');
    const journal = new ConnectionEventJournal(logPath, 1024 * 1024, 'test-version');

    try {
        await Promise.all([
            journal.record({
                type: 'connection-close',
                state: 'disconnected',
                statusCode: 401,
                classification: 'reauth-required',
                action: 'pair-new-device',
                reason: 'logged-out',
                error: 'Bearer secret-value sk-or-exampletoken123456789'
            }),
            journal.record({
                type: 'connection-start',
                state: 'connecting',
                reason: 'socket-start-requested'
            })
        ]);

        const events = await journal.readRecent(10);
        assert.equal(events.length, 2);
        assert.equal(events[0].routerVersion, 'test-version');
        assert.equal(events[0].statusCode, 401);
        assert.match(events[0].error ?? '', /\[REDACTED\]/);
        assert.doesNotMatch(events[0].error ?? '', /secret-value|exampletoken/);
        assert.equal(events[1].type, 'connection-start');

        const raw = await readFile(logPath, 'utf8');
        assert.equal(raw.trim().split('\n').length, 2);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('rotates the lifecycle journal when it reaches its size limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-lifecycle-rotate-'));
    const logPath = join(root, 'connection-events.jsonl');
    const journal = new ConnectionEventJournal(logPath, 1, 'test-version');

    try {
        await journal.record({ type: 'first', state: 'connected' });
        await journal.record({ type: 'second', state: 'disconnected' });

        const rotated = await readFile(`${logPath}.1`, 'utf8');
        const current = await readFile(logPath, 'utf8');
        assert.match(rotated, /"type":"first"/);
        assert.match(current, /"type":"second"/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
