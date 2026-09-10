import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { ConversationScheduler } from '../src/services/conversation-scheduler.js';

function deferred() {
    let resolve!: () => void;
    return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() };
}

test('slow media cannot be overtaken by later text; other chats run concurrently within limit', async () => {
    const scheduler = new ConversationScheduler(2, 10, 10);
    const audio = deferred();
    const other = deferred();
    const order: string[] = [];
    const a = scheduler.enqueue('A', async () => { order.push('audio-start'); await audio.promise; order.push('audio-end'); });
    const b = scheduler.enqueue('A', async () => { order.push('text'); });
    const c = scheduler.enqueue('B', async () => { order.push('other'); await other.promise; });
    const d = scheduler.enqueue('C', async () => { order.push('third'); });
    await setImmediate();
    assert.deepEqual(order, ['audio-start', 'other']);
    audio.resolve();
    await Promise.all([a, b, d]);
    assert.ok(order.indexOf('audio-end') < order.indexOf('text'));
    other.resolve();
    await c;
});

test('rejects per-chat and global overload and continues after a failed turn', async () => {
    const scheduler = new ConversationScheduler(1, 1, 2);
    const gate = deferred();
    const a = scheduler.enqueue('A', () => gate.promise);
    await assert.rejects(scheduler.enqueue('A', async () => {}), /busy/);
    const b = scheduler.enqueue('B', async () => { throw new Error('failed'); });
    const failure = assert.rejects(b, /failed/);
    await assert.rejects(scheduler.enqueue('C', async () => {}), /busy/);
    gate.resolve();
    await Promise.all([a, failure]);
    await scheduler.enqueue('B', async () => {});
});

test('shutdown cancels active work, rejects waiting jobs and waits for actual cleanup', async () => {
    const scheduler = new ConversationScheduler(1);
    const cleanup = deferred();
    let cancelled = false;
    let stopped = false;
    const active = scheduler.enqueue('A', signal => new Promise<void>(resolve => {
        signal.addEventListener('abort', () => { cancelled = true; void cleanup.promise.then(resolve); });
    }));
    const pending = scheduler.enqueue('A', async () => { assert.fail('queued work started after shutdown'); });
    const rejected = assert.rejects(pending, /stopped/);
    await setImmediate();
    const stop = scheduler.stop().then(() => { stopped = true; });
    await setImmediate();
    assert.equal(cancelled, true);
    assert.equal(stopped, false);
    cleanup.resolve();
    await Promise.all([active, rejected, stop]);
    await assert.rejects(scheduler.enqueue('B', async () => {}), /stopped/);
});
