import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { collectBoundedStream, downloadBoundedMedia } from '../src/services/bounded-media.js';
import { safeFailure, positiveInteger } from '../src/services/router-errors.js';

test('downloads accumulate once and reject excess actual bytes', async () => {
    const signal = new AbortController().signal;
    assert.equal((await collectBoundedStream(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 4, signal)).toString(), 'abcd');
    const oversized = Readable.from([Buffer.alloc(3), Buffer.alloc(3)]);
    await assert.rejects(collectBoundedStream(oversized, 4, signal), /media-limit/);
    assert.equal(oversized.destroyed, true);
});

test('abort destroys stalled streams and advertised oversized media is rejected before network access', async () => {
    const controller = new AbortController();
    const stream = new PassThrough();
    const pending = collectBoundedStream(stream, 100, controller.signal);
    const rejected = assert.rejects(pending, /timeout/);
    controller.abort();
    await rejected;
    assert.equal(stream.destroyed, true);
    await assert.rejects(downloadBoundedMedia({ fileLength: 101 * 1024 * 1024 } as any, 'image'), /media-limit/);
});

test('customer notices and diagnostics never include arbitrary error content or stacks', () => {
    const error = new Error('Bearer secret-token /private/customer/passwords.json');
    const failure = safeFailure(error, 'routed-turn');
    assert.ok(!JSON.stringify(failure).includes('secret-token'));
    assert.ok(!JSON.stringify(failure).includes('/private'));
    assert.match(failure.message, /reference/i);
    const reference = JSON.parse(failure.diagnostic).reference;
    assert.ok(failure.message.includes(reference));
    for (const value of ['NaN', '0', '-1', 'Infinity', '1.5', '999999999999999']) assert.equal(positiveInteger(value, 100), 100);
});
