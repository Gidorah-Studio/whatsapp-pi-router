import { fileURLToPath } from 'node:url';
import { runManagedProcess } from './managed-process.js';
import { mediaTimeout } from './bounded-media.js';
import { RouterError } from './router-errors.js';

/** `outputPath` is where the `document` operation writes the full extracted text; the return value is a short preview. */
export async function runMediaWorker(kind: 'pdf' | 'audio' | 'document', path: string, signal?: AbortSignal, outputPath?: string): Promise<string> {
    const output = await runManagedProcess(process.execPath, [
        '--max-old-space-size=512', fileURLToPath(new URL('./media-worker.mjs', import.meta.url)), kind, path, ...(outputPath ? [outputPath] : []),
    ], { signal, timeoutMs: mediaTimeout(), maxOutputBytes: 1024 * 1024 });
    const line = output.split('\n').reverse().find(line => line.startsWith('WHATSAPP_MEDIA_RESULT:'));
    if (!line) throw new RouterError('child-failed');
    const result = JSON.parse(line.slice('WHATSAPP_MEDIA_RESULT:'.length));
    if (typeof result.text !== 'string') throw new RouterError('child-failed');
    return result.text;
}
