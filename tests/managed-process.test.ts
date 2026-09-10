import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { runManagedProcess } from '../src/services/managed-process.js';
import { ConversationScheduler } from '../src/services/conversation-scheduler.js';

async function waitForFile(path: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        try { if ((await readFile(path)).length) return; } catch { /* wait for child */ }
        await delay(20);
    }
    throw new Error('Child did not become ready');
}

test('captures bounded stdout and passes input over stdin; spawn failures settle', async () => {
    const text = await runManagedProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hello', timeoutMs: 5000 });
    assert.equal(text, 'hello');
    await assert.rejects(runManagedProcess('/nonexistent-router-review-binary', [], { timeoutMs: 1000 }));
    await assert.rejects(runManagedProcess(process.execPath, ['-e', 'console.error("secret");process.exit(1)'], { timeoutMs: 5000 }), error => {
        assert.ok(!String(error).includes('secret'));
        return true;
    });
});

test('timeout escalates past ignored SIGTERM and next conversation turn starts only after exit', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'router-process-'));
    try {
        const pidFile = join(root, 'pid');
        const scheduler = new ConversationScheduler(1);
        const first = scheduler.enqueue('A', signal => runManagedProcess(process.execPath, ['-e', `
            require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
            process.on('SIGTERM', () => {}); setInterval(() => {}, 50);
        `], { timeoutMs: 500, graceMs: 50, signal }));
        const failed = assert.rejects(first, /timeout/);
        const next = scheduler.enqueue('A', async () => {
            const pid = Number(await readFile(pidFile, 'utf8'));
            assert.throws(() => process.kill(pid, 0), /ESRCH/);
        });
        await Promise.all([failed, next]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancellation kills detached tool descendants before settling', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'router-process-tree-'));
    const heartbeat = join(root, 'heartbeat');
    const controller = new AbortController();
    const grandchild = `process.on('SIGTERM',()=>{});setInterval(()=>require('fs').appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`;
    const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'});process.on('SIGTERM',()=>{});setInterval(()=>{},50);`;
    const run = runManagedProcess(process.execPath, ['-e', script], { timeoutMs: 10000, graceMs: 50, signal: controller.signal });
    const rejected = assert.rejects(run, /stopped/);
    try {
        await waitForFile(heartbeat);
        controller.abort();
        await rejected;
        const before = await readFile(heartbeat, 'utf8');
        await delay(100);
        assert.equal(await readFile(heartbeat, 'utf8'), before);
    } finally { controller.abort(); await rejected; await rm(root, { recursive: true, force: true }); }
});

test('output overflow stops the child rather than accumulating unbounded stdout/stderr', { skip: process.platform === 'win32' }, async () => {
    await assert.rejects(runManagedProcess(process.execPath, ['-e', `setInterval(()=>process.stderr.write('x'.repeat(10000)),1)`], {
        timeoutMs: 5000, graceMs: 10, maxOutputBytes: 1000,
    }), /output-limit/);
});
