import https from 'node:https';
import type { WhatsAppPiLogger } from './whatsapp-pi.logger.js';

export interface SpeechSynthesisOptions {
    model: string;
    voice: string;
    speed: number;
}

export interface SpeechSynthesizer {
    synthesize(text: string, options: SpeechSynthesisOptions): Promise<Buffer>;
}

type AudioLogger = Pick<WhatsAppPiLogger, 'log' | 'error'>;

const OPENROUTER_SPEECH_URL = 'https://openrouter.ai/api/v1/audio/speech';
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export function createOpenRouterSpeechSynthesizer(logger: AudioLogger): SpeechSynthesizer {
    return {
        async synthesize(text: string, options: SpeechSynthesisOptions): Promise<Buffer> {
            const apiKey = process.env.OPENROUTER_API_KEY?.trim();
            if (!apiKey) {
                throw new Error('WhatsApp TTS requires OPENROUTER_API_KEY');
            }

            logger.log(`[WhatsApp-Pi-Router] OpenRouter TTS synthesize with ${options.model}, voice ${options.voice}, speed ${options.speed}`);
            const body = JSON.stringify({
                model: options.model,
                input: text,
                voice: options.voice,
                response_format: 'mp3',
                speed: options.speed
            });

            return await postForAudio({
                url: OPENROUTER_SPEECH_URL,
                apiKey,
                body
            });
        }
    };
}

interface PostForAudioOptions {
    url: string;
    apiKey: string;
    body: string;
}

async function postForAudio(options: PostForAudioOptions): Promise<Buffer> {
    const url = new URL(options.url);
    if (url.protocol !== 'https:') {
        throw new Error(`OpenRouter TTS URL must use https: ${url.protocol}`);
    }

    return await new Promise<Buffer>((resolve, reject) => {
        const request = https.request(url, {
            method: 'POST',
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
                Authorization: `Bearer ${options.apiKey}`,
                Accept: 'audio/mpeg',
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(options.body)),
                'HTTP-Referer': 'https://github.com/x4484/whatsapp-pi-router',
                'X-Title': 'whatsapp-pi-router'
            }
        }, (response) => {
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            const statusCode = response.statusCode ?? 0;

            response.on('data', (chunk: Buffer | string) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                totalBytes += buffer.length;
                if (totalBytes > MAX_RESPONSE_BYTES) {
                    response.destroy(new Error(`OpenRouter TTS response exceeded ${MAX_RESPONSE_BYTES} bytes`));
                    return;
                }
                chunks.push(buffer);
            });

            response.on('error', reject);
            response.on('end', () => {
                const responseBuffer = Buffer.concat(chunks);
                if (statusCode < 200 || statusCode >= 300) {
                    reject(new Error(`OpenRouter TTS failed: HTTP ${statusCode}${formatErrorBody(responseBuffer)}`));
                    return;
                }

                const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
                if (contentType && !contentType.startsWith('audio/')) {
                    reject(new Error(`OpenRouter TTS returned unexpected content type ${contentType}${formatErrorBody(responseBuffer)}`));
                    return;
                }
                if (responseBuffer.length === 0) {
                    reject(new Error('OpenRouter TTS returned an empty audio response'));
                    return;
                }

                resolve(responseBuffer);
            });
        });

        request.on('timeout', () => {
            request.destroy(new Error(`OpenRouter TTS timed out after ${REQUEST_TIMEOUT_MS}ms`));
        });
        request.on('error', reject);
        request.write(options.body);
        request.end();
    });
}

function formatErrorBody(body: Buffer): string {
    const text = body.toString('utf8').trim();
    if (!text) return '';
    const snippet = text.length <= 500 ? text : `${text.slice(0, 500)}…`;
    return ` - ${snippet}`;
}
