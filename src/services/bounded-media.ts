import { downloadContentFromMessage } from 'baileys';
import type { Readable } from 'node:stream';
import { RouterError, positiveInteger } from './router-errors.js';

export const mediaByteLimit = () => positiveInteger(process.env.WHATSAPP_ROUTER_MEDIA_MAX_BYTES, 20 * 1024 * 1024, 100 * 1024 * 1024);
export const mediaTimeout = () => positiveInteger(process.env.WHATSAPP_ROUTER_MEDIA_TIMEOUT_MS, 120_000);

export async function collectBoundedStream(stream: Readable, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const abort = () => stream.destroy(new RouterError('timeout'));
    signal.addEventListener('abort', abort, { once: true });
    try {
        signal.throwIfAborted();
        for await (const chunk of stream) {
            signal.throwIfAborted();
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > maxBytes) throw new RouterError('media-limit');
            chunks.push(buffer);
        }
        return Buffer.concat(chunks, bytes);
    } finally {
        signal.removeEventListener('abort', abort);
        stream.destroy();
    }
}

export async function downloadBoundedMedia(message: Parameters<typeof downloadContentFromMessage>[0] & { fileLength?: unknown }, type: 'image' | 'document' | 'audio', signal?: AbortSignal): Promise<Buffer> {
    const maxBytes = mediaByteLimit();
    if (Number(message.fileLength) > maxBytes) throw new RouterError('media-limit');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), mediaTimeout());
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
        controller.signal.throwIfAborted();
        const stream = await downloadContentFromMessage(message, type, { options: { signal: controller.signal } });
        return await collectBoundedStream(stream, maxBytes, controller.signal);
    } catch (error) {
        if (signal?.aborted) throw new RouterError('stopped');
        if (controller.signal.aborted) throw new RouterError('timeout');
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}
