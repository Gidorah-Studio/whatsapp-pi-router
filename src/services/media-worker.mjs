// Native OCR/STT runs outside the router so deadlines can actually stop the work.
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

const [kind, path, outputPath] = process.argv.slice(2);
const PLAIN_TEXT = /\.(txt|csv|tsv|md|json|xml|html?|log|ya?ml)$/i;
const MAX_EXTRACTED_CHARACTERS = 500_000;
const PREVIEW_CHARACTERS = 1200;
try {
    let text;
    if (kind === 'pdf') {
        const { LiteParse } = await import('@llamaindex/liteparse');
        const result = await new LiteParse({ ocrEnabled: true, numWorkers: 1, maxPages: 3 }).parse(path);
        text = String(result.text ?? '').slice(0, 1200);
    } else if (kind === 'document') {
        if (!outputPath) throw new Error('Document extraction requires an output path');
        let full;
        if (PLAIN_TEXT.test(path)) {
            full = await readFile(path, 'utf8');
        } else {
            // Office formats are converted by LibreOffice; text is already embedded, so OCR is skipped.
            const { LiteParse } = await import('@llamaindex/liteparse');
            const result = await new LiteParse({ ocrEnabled: false, numWorkers: 1, maxPages: 50 }).parse(path);
            full = String(result.text ?? '');
        }
        // Converted spreadsheets pad pages with long runs of blank lines.
        full = full.replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_EXTRACTED_CHARACTERS);
        if (full) await writeFile(outputPath, full, { mode: 0o600, flag: 'wx' });
        text = full.slice(0, PREVIEW_CHARACTERS);
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
