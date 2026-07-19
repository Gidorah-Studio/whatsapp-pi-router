import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    RouterInstanceLock,
    RouterInstanceLockError
} from '../src/services/router-instance-lock.js';

test('prevents a second live router from owning the same auth state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-lock-'));
    const lockPath = join(root, 'auth.lock');
    const first = new RouterInstanceLock(lockPath);
    const second = new RouterInstanceLock(lockPath);

    try {
        await first.acquire();
        await assert.rejects(
            () => second.acquire(),
            (error: unknown) => error instanceof RouterInstanceLockError && error.owner?.pid === process.pid
        );

        await first.release();
        await second.acquire();
        assert.equal(second.isHeld(), true);
    } finally {
        await first.release();
        await second.release();
        await rm(root, { recursive: true, force: true });
    }
});

test('recovers a stale router lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-stale-lock-'));
    const lockPath = join(root, 'auth.lock');
    const lock = new RouterInstanceLock(lockPath);

    try {
        await writeFile(lockPath, JSON.stringify({
            pid: 99_999_999,
            token: 'stale-token',
            startedAt: '2020-01-01T00:00:00.000Z'
        }));
        const result = await lock.acquire();
        assert.equal(result.recoveredStaleLock, true);
        assert.equal(lock.isHeld(), true);
    } finally {
        await lock.release();
        await rm(root, { recursive: true, force: true });
    }
});
