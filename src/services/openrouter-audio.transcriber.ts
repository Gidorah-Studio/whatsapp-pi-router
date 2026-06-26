import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { WhatsAppPiLogger } from './whatsapp-pi.logger.js';
import type { AudioTranscriber } from './whisper-cpp-audio.transcriber.js';

type AudioLogger = Pick<WhatsAppPiLogger, 'log' | 'error'>;

const OPENROUTER_AUDIO_TRANSCRIPTIONS_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
const DEFAULT_OPENROUTER_STT_MODEL = 'openai/whisper-1';
const REQUEST_TIMEOUT_MS = 120_000;

export function createOpenRouterAudioTranscriber(logger: AudioLogger): AudioTranscriber {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
        throw new Error('STT_PROVIDER=openrouter requires OPENROUTER_API_KEY');
    }

    const model = process.env.STT_MODEL?.trim() || DEFAULT_OPENROUTER_STT_MODEL;

    return {
        async transcribe(inputPath: string): Promise<string> {
            logger.log(`[WhatsApp-Pi] OpenRouter STT transcribe with ${model}`);
            const audioBuffer = await readFile(inputPath);
            const boundary = `----whatsapp-pi-router-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            const body = buildMultipartBody(boundary, [
                { name: 'model', value: model },
                { name: 'response_format', value: 'json' },
                {
                    name: 'file',
                    fileName: basename(inputPath),
                    contentType: 'audio/wav',
                    value: audioBuffer
                }
            ]);

            const response = await postMultipartJson({
                url: OPENROUTER_AUDIO_TRANSCRIPTIONS_URL,
                apiKey,
                boundary,
                body
            });

            return extractTranscriptionText(response);
        }
    };
}

type MultipartPart =
    | { name: string; value: string }
    | { name: string; fileName: string; contentType: string; value: Buffer };

function buildMultipartBody(boundary: string, parts: MultipartPart[]): Buffer {
    const chunks: Buffer[] = [];

    for (const part of parts) {
        if (!('fileName' in part)) {
            chunks.push(Buffer.from(
                `--${boundary}\r\n`
                + `Content-Disposition: form-data; name="${escapeHeaderValue(part.name)}"\r\n\r\n`
                + `${part.value}\r\n`,
                'utf8'
            ));
            continue;
        }

        chunks.push(Buffer.from(
            `--${boundary}\r\n`
            + `Content-Disposition: form-data; name="${escapeHeaderValue(part.name)}"; filename="${escapeHeaderValue(part.fileName)}"\r\n`
            + `Content-Type: ${part.contentType}\r\n\r\n`,
            'utf8'
        ));
        chunks.push(part.value);
        chunks.push(Buffer.from('\r\n', 'utf8'));
    }

    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    return Buffer.concat(chunks);
}

function escapeHeaderValue(value: string): string {
    return value.replace(/["\\\r\n]/g, '_');
}

interface PostMultipartJsonOptions {
    url: string;
    apiKey: string;
    boundary: string;
    body: Buffer;
}

async function postMultipartJson(options: PostMultipartJsonOptions): Promise<unknown> {
    const url = new URL(options.url);
    if (url.protocol !== 'https:') {
        throw new Error(`OpenRouter STT URL must use https: ${url.protocol}`);
    }

    return await new Promise<unknown>((resolve, reject) => {
        const request = https.request(url, {
            method: 'POST',
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
                Authorization: `Bearer ${options.apiKey}`,
                'Content-Type': `multipart/form-data; boundary=${options.boundary}`,
                'Content-Length': String(options.body.length),
                'HTTP-Referer': 'https://github.com/x4484/whatsapp-pi-router',
                'X-Title': 'whatsapp-pi-router'
            }
        }, (response) => {
            const responseChunks: Buffer[] = [];

            response.on('data', (chunk: Buffer | string) => {
                responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });

            response.on('end', () => {
                const responseText = Buffer.concat(responseChunks).toString('utf8');
                const statusCode = response.statusCode ?? 0;

                if (statusCode < 200 || statusCode >= 300) {
                    reject(new Error(`OpenRouter STT failed: HTTP ${statusCode}${formatErrorBody(responseText)}`));
                    return;
                }

                try {
                    resolve(JSON.parse(responseText));
                } catch (error) {
                    reject(new Error(`OpenRouter STT returned invalid JSON: ${snippet(responseText)}`));
                }
            });
        });

        request.on('timeout', () => {
            request.destroy(new Error(`OpenRouter STT timed out after ${REQUEST_TIMEOUT_MS}ms`));
        });
        request.on('error', reject);
        request.write(options.body);
        request.end();
    });
}

function extractTranscriptionText(response: unknown): string {
    if (!response || typeof response !== 'object') {
        throw new Error('OpenRouter STT returned an empty response');
    }

    const payload = response as { text?: unknown; error?: { message?: unknown } };
    if (payload.error?.message) {
        throw new Error(`OpenRouter STT failed: ${String(payload.error.message)}`);
    }

    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) {
        throw new Error('OpenRouter STT returned no transcription text');
    }

    return text;
}

function formatErrorBody(body: string): string {
    const trimmed = body.trim();
    return trimmed ? ` - ${snippet(trimmed)}` : '';
}

function snippet(value: string): string {
    return value.length <= 500 ? value : `${value.slice(0, 500)}…`;
}
