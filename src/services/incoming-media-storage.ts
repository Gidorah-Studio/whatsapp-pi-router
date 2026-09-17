import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createStoragePaths } from './storage-path.js';
import { ensurePrivateDirectory } from './private-storage.js';

/** Only this turn's temporary artifacts are deleted; retained documents and legacy files are untouched. */
export async function createIncomingMediaTurn(conversation: string, root = createStoragePaths().mediaDir) {
    const key = createHash('sha256').update(conversation).digest('hex').slice(0, 32);
    const incoming = join(root, 'incoming');
    const directory = join(incoming, key);
    await ensurePrivateDirectory(root);
    await ensurePrivateDirectory(incoming);
    await ensurePrivateDirectory(directory);
    const temporary = await mkdtemp(join(directory, 'turn-'));
    await chmod(temporary, 0o700);
    return {
        temporary,
        async saveDocument(fileName: string, buffer: Buffer): Promise<string> {
            const documents = join(directory, 'documents');
            await ensurePrivateDirectory(documents);
            const sanitized = fileName.replace(/[^a-z0-9._-]/gi, '_').slice(-120) || 'document';
            const path = join(documents, `${randomUUID()}_${sanitized}`);
            await writeFile(path, buffer, { flag: 'wx', mode: 0o600 });
            return path;
        },
        async saveTemporaryDocument(fileName: string, buffer: Buffer): Promise<string> {
            const sanitized = fileName.replace(/[^a-z0-9._-]/gi, '_').slice(-120) || 'document';
            const path = join(temporary, `${randomUUID()}_${sanitized}`);
            await writeFile(path, buffer, { flag: 'wx', mode: 0o600 });
            return path;
        },
        cleanup: () => rm(temporary, { recursive: true, force: true }),
    };
}
export type IncomingMediaTurn = Awaited<ReturnType<typeof createIncomingMediaTurn>>;
