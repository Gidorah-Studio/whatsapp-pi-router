const PLAIN_TEXT_EXTENSIONS = new Set(['txt', 'csv', 'tsv', 'md', 'json', 'xml', 'html', 'htm', 'log', 'yaml', 'yml']);
const PREVIEW_CHARACTERS = 1200;
// Enough bytes for the preview even when every character is four bytes of UTF-8.
const PREVIEW_BYTES = PREVIEW_CHARACTERS * 4;

/** Documents the agent's read tool shows as-is. Other formats are parsed by the agent from the saved file. */
export function isPlainTextDocument(fileName: string): boolean {
    const extension = fileName.toLowerCase().split('.').pop() ?? '';
    return fileName.includes('.') && PLAIN_TEXT_EXTENSIONS.has(extension);
}

export function plainTextPreview(content: Buffer): string {
    return content.subarray(0, PREVIEW_BYTES).toString('utf8')
        .replace(/^﻿/, '').replace(/�+$/, '').replace(/\n{3,}/g, '\n\n')
        .trim().slice(0, PREVIEW_CHARACTERS);
}
