import assert from 'node:assert/strict';
import test from 'node:test';
import { isStoppedError, RouterError, safeFailure, STOPPED_NOTICE } from '../src/services/router-errors.js';
import { stopTurnsThenSocket } from '../src/services/router-shutdown.js';
import { ConversationScheduler } from '../src/services/conversation-scheduler.js';

test('turns are cancelled and settled before the socket closes', async () => {
    const events: string[] = [];
    await stopTurnsThenSocket({
        stopTurns: async () => { await new Promise(resolve => setTimeout(resolve, 20)); events.push('turns'); },
        stopSocket: async () => { events.push('socket'); },
        graceMs: 1000,
    });
    assert.deepEqual(events, ['turns', 'socket']);
});

test('a hung turn cleanup cannot hold the socket open past the grace period', async () => {
    const events: string[] = [];
    let release!: () => void;
    const hung = new Promise<void>(resolve => { release = resolve; });
    const stopping = stopTurnsThenSocket({
        stopTurns: async () => { await hung; events.push('turns'); },
        stopSocket: async () => { events.push('socket'); },
        graceMs: 20,
    }).then(() => events.push('returned'));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(events, ['socket']);
    release();
    await stopping;
    assert.deepEqual(events, ['socket', 'turns', 'returned']);
});

test('a failed socket stop still waits for turns and reports the failure', async () => {
    const events: string[] = [];
    await assert.rejects(stopTurnsThenSocket({
        stopTurns: async () => { await new Promise(resolve => setTimeout(resolve, 40)); events.push('turns'); },
        stopSocket: async () => { throw new Error('socket stop failed'); },
        graceMs: 5,
    }), /socket stop failed/);
    assert.deepEqual(events, ['turns']);
});

test('a failed turn cleanup still closes the socket and is reported', async () => {
    const events: string[] = [];
    await assert.rejects(stopTurnsThenSocket({
        stopTurns: async () => { throw new Error('cleanup failed'); },
        stopSocket: async () => { events.push('socket'); },
        graceMs: 1000,
    }), /cleanup failed/);
    assert.deepEqual(events, ['socket']);
});

test('scheduler shutdown produces errors classified as stopped, for running and queued turns', async () => {
    const scheduler = new ConversationScheduler(1, 5, 5);
    const running = scheduler.enqueue('a', signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new RouterError('stopped')), { once: true });
    }));
    const queued = scheduler.enqueue('b', async () => 'never runs');
    const outcomes = Promise.allSettled([running, queued]);
    await new Promise(resolve => setImmediate(resolve));
    await scheduler.stop();
    for (const outcome of await outcomes) {
        assert.equal(outcome.status, 'rejected');
        assert.equal(isStoppedError((outcome as PromiseRejectedResult).reason), true);
    }
});

test('only shutdown cancellations are classified as stopped', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    assert.equal(isStoppedError(abort), true);
    assert.equal(isStoppedError(new RouterError('stopped')), true);
    assert.equal(isStoppedError(new RouterError('timeout')), false);
    assert.equal(isStoppedError(new RouterError('busy')), false);
    assert.equal(isStoppedError(new Error('boom')), false);
    assert.equal(isStoppedError(undefined), false);
    assert.match(STOPPED_NOTICE, /send it again/i);
    assert.doesNotMatch(safeFailure(new RouterError('timeout'), 'routed-turn').message, /restarted/);
});
