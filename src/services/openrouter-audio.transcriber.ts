import https from 'node:https';
import { readFile } from 'node:fs/promises';
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
            const body = JSON.stringify({
                model,
                input_audio: {
                    data: audioBuffer.toString('base64'),
                    format: 'wav'
                }
            });

            const response = await postJson({
                url: OPENROUTER_AUDIO_TRANSCRIPTIONS_URL,
                apiKey,
                body
            });

            return extractTranscriptionText(response);
        }
    };
}

interface PostJsonOptions {
    url: string;
    apiKey: string;
    body: string;
}

async function postJson(options: PostJsonOptions): Promise<unknown> {
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
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(options.body)),
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

    const payload = response as { text?: unknown; error?: { message?: unknown } | string };
    if (payload.error) {
        const message = typeof payload.error === 'string'
            ? payload.error
            : String(payload.error.message ?? 'unknown error');
        throw new Error(`OpenRouter STT failed: ${message}`);
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
