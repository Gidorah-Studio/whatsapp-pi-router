// Native OCR/STT runs outside the router so deadlines can actually stop the work.
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const [kind, path] = process.argv.slice(2);
try {
    let text;
    if (kind === 'pdf') {
        const { LiteParse } = await import('@llamaindex/liteparse');
        const result = await new LiteParse({ ocrEnabled: true, numWorkers: 1, maxPages: 3 }).parse(path);
        text = String(result.text ?? '').slice(0, 1200);
    } else if (kind === 'audio') {
        const jiti = createJiti(import.meta.url);
        const source = new URL('./audio.service.ts', import.meta.url);
        const { AudioService } = await jiti.import(fileURLToPath(existsSync(source) ? source : new URL('./audio.service.js', import.meta.url)));
        text = await new AudioService({ log() {}, error() {} }).transcribeFile(path);
    } else {
        throw new Error('Unsupported media operation');
    }
    await new Promise((resolve, reject) => process.stdout.write(`\nWHATSAPP_MEDIA_RESULT:${JSON.stringify({ text })}\n`, error => error ? reject(error) : resolve()));
    // Native OCR worker threads/context caches must not keep a completed job alive.
    process.exit(0);
} catch {
    // No provider stderr, paths, or credentials cross the subprocess boundary.
    process.exit(1);
}
