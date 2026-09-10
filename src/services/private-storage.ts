import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Single-writer queue. A failed operation does not poison subsequent writes. */
export class SerialQueue {
    private tail: Promise<unknown> = Promise.resolve();
    run<T>(task: () => Promise<T>): Promise<T> {
        const result = this.tail.then(task, task);
        this.tail = result.catch(() => undefined);
        return result;
    }
    async drain(): Promise<void> { await this.tail; }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
}

/** Never truncate the live file. Temp files are exclusive, private, and on the same filesystem. */
export async function atomicWritePrivate(path: string, content: string): Promise<void> {
    await ensurePrivateDirectory(dirname(path));
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temp, 'wx', 0o600);
        try {
            await file.writeFile(content, 'utf8');
            await file.sync();
        } finally { await file.close(); }
        await rename(temp, path);
        if (process.platform !== 'win32') {
            const directory = await open(dirname(path), 'r');
            try { await directory.sync(); }
            catch (error) {
                if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            } finally { await directory.close(); }
        }
    } finally { await rm(temp, { force: true }); }
}

export function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
