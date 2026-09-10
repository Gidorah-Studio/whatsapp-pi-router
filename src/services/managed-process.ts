import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { RouterError } from './router-errors.js';

const execFileAsync = promisify(execFile);
interface ProcessRow { pid: number; parent: number; group: number; state: string }
async function processTable(): Promise<ProcessRow[]> {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,pgid=,stat='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim().split('\n').map(line => {
        const [pid, parent, group, state] = line.trim().split(/\s+/);
        return { pid: Number(pid), parent: Number(parent), group: Number(group), state };
    });
}
function descendants(rows: ProcessRow[], parent: number): number[] {
    const found = new Set([parent]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const row of rows) if (found.has(row.parent) && !found.has(row.pid)) {
            found.add(row.pid); changed = true;
        }
    }
    return [...found];
}
function signalPid(pid: number, signal: NodeJS.Signals): void {
    try { process.kill(pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
async function signalGroup(group: number, signal: NodeJS.Signals): Promise<void> {
    try { signalPid(-group, signal); }
    catch (error) {
        // macOS may return EPERM for a process group that now contains only zombies.
        if ((error as NodeJS.ErrnoException).code !== 'EPERM' ||
            (await processTable()).some(row => row.group === group && !row.state.startsWith('Z'))) throw error;
    }
}

export interface ManagedProcessOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    signal?: AbortSignal;
    timeoutMs: number;
    graceMs?: number;
    maxOutputBytes?: number;
}

/** Cancellation settles only after termination and stdio close. No early Promise.race release. */
export async function runManagedProcess(command: string, args: string[], options: ManagedProcessOptions): Promise<string> {
    options.signal?.throwIfAborted();
    const child = spawn(command, args, {
        cwd: options.cwd, env: options.env, detached: process.platform !== 'win32',
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let failure: unknown;
    let termination: Promise<void> | undefined;
    let bytes = 0;
    const output: Buffer[] = [];
    const limit = options.maxOutputBytes ?? 1024 * 1024;
    const grace = options.graceMs ?? 2000;
    const closed = new Promise<number | null>(resolve => {
        child.once('error', error => { failure ??= error; });
        child.once('close', code => resolve(code));
    });

    const terminate = async () => {
        if (!child.pid) return;
        if (process.platform === 'win32') {
            await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
            return;
        }
        // Include descendants that created their own process groups (e.g. Pi bash tools).
        const tracked = new Set(descendants(await processTable(), child.pid));
        for (const pid of [...tracked].reverse()) signalPid(pid, 'SIGTERM');
        await signalGroup(child.pid, 'SIGTERM');
        await delay(grace);
        for (const pid of descendants(await processTable(), child.pid)) tracked.add(pid);
        for (const pid of tracked) signalPid(pid, 'SIGKILL');
        await signalGroup(child.pid, 'SIGKILL');
        // Zombies cannot execute or mutate state. Keep the turn occupied for any live survivor.
        while ((await processTable()).some(row => tracked.has(row.pid) && !row.state.startsWith('Z'))) {
            await delay(50);
        }
    };
    const cancel = (reason: unknown) => {
        failure ??= reason;
        if (!termination) {
            termination = terminate();
            // If tree cleanup fails, kill the direct group as a fallback, but keep this
            // operation blocked: releasing a conversation with unknown live children is unsafe.
            termination = termination.catch(async () => {
                try { if (child.pid) signalPid(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* blocked below */ }
                console.error('[WhatsApp-Pi] Child process tree cleanup failed; turn remains blocked. Operator intervention required.');
                await new Promise<void>(() => {});
            });
        }
    };
    const onAbort = () => cancel(new RouterError('stopped'));
    const timer = setTimeout(() => cancel(new RouterError('timeout')), options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const consume = (chunk: Buffer, capture: boolean) => {
        bytes += chunk.length;
        if (bytes > limit) cancel(new RouterError('output-limit'));
        else if (capture) output.push(chunk);
    };
    child.stdout.on('data', chunk => consume(chunk, true));
    child.stderr.on('data', chunk => consume(chunk, false));
    child.stdin.on('error', () => { /* EPIPE on early child exit is handled by close. */ });
    child.stdin.end(options.input);
    try {
        const code = await closed;
        clearTimeout(timer);
        await termination;
        if (failure) throw failure;
        if (code !== 0) throw new RouterError('child-failed', code ?? undefined);
        return Buffer.concat(output).toString('utf8').trim();
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
    }
}
