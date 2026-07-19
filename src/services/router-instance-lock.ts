import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

interface LockOwner {
    pid: number;
    token: string;
    startedAt: string;
}

export class RouterInstanceLockError extends Error {
    constructor(
        message: string,
        readonly owner?: LockOwner
    ) {
        super(message);
        this.name = 'RouterInstanceLockError';
    }
}

export class RouterInstanceLock {
    private readonly token = randomUUID();
    private held = false;

    constructor(private readonly lockPath: string) {}

    getPath(): string {
        return this.lockPath;
    }

    isHeld(): boolean {
        return this.held;
    }

    async acquire(): Promise<{ recoveredStaleLock: boolean }> {
        if (this.held) {
            return { recoveredStaleLock: false };
        }

        await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
        let recoveredStaleLock = false;

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const handle = await open(this.lockPath, 'wx', 0o600);
                try {
                    const owner: LockOwner = {
                        pid: process.pid,
                        token: this.token,
                        startedAt: new Date().toISOString()
                    };
                    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
                } finally {
                    await handle.close();
                }
                this.held = true;
                return { recoveredStaleLock };
            } catch (error) {
                if (!isAlreadyExistsError(error)) {
                    throw error;
                }

                const owner = await this.readOwner();
                if (owner && isProcessAlive(owner.pid)) {
                    throw new RouterInstanceLockError(
                        `WhatsApp router is already running in process ${owner.pid}. Lock: ${this.lockPath}`,
                        owner
                    );
                }

                await rm(this.lockPath, { force: true });
                recoveredStaleLock = true;
            }
        }

        throw new RouterInstanceLockError(`Could not acquire WhatsApp router lock: ${this.lockPath}`);
    }

    async release(): Promise<void> {
        if (!this.held) return;

        const owner = await this.readOwner();
        if (owner?.token === this.token) {
            await rm(this.lockPath, { force: true });
        }
        this.held = false;
    }

    private async readOwner(): Promise<LockOwner | undefined> {
        try {
            const parsed = JSON.parse(await readFile(this.lockPath, 'utf8')) as Partial<LockOwner>;
            if (
                typeof parsed.pid === 'number'
                && typeof parsed.token === 'string'
                && typeof parsed.startedAt === 'string'
            ) {
                return parsed as LockOwner;
            }
        } catch {
            // Invalid or missing locks are stale and can be replaced.
        }
        return undefined;
    }
}

function isAlreadyExistsError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
    }
}
