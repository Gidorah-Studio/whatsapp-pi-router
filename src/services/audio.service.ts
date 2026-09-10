import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WhatsAppPiLogger } from './whatsapp-pi.logger.js';
import { createOpenRouterAudioTranscriber } from './openrouter-audio.transcriber.js';
import { tryCreateWhisperCppAudioTranscriber, type AudioTranscriber } from './whisper-cpp-audio.transcriber.js';
import { downloadBoundedMedia, mediaTimeout } from './bounded-media.js';
import { createIncomingMediaTurn, type IncomingMediaTurn } from './incoming-media-storage.js';
import { runMediaWorker } from './media-worker.js';
import { RouterError, safeFailure } from './router-errors.js';

const execFileAsync = promisify(execFile);
type AudioLogger = Pick<WhatsAppPiLogger, 'log' | 'error'>;

export class AudioService {
    constructor(
        private readonly logger: AudioLogger = new WhatsAppPiLogger(false),
        private readonly audioTranscriber?: AudioTranscriber | null,
    ) {}

    async transcribe(audioMessage: any, turn?: IncomingMediaTurn, signal?: AbortSignal): Promise<string> {
        const owned = turn ?? await createIncomingMediaTurn('standalone-audio');
        try {
            const input = join(owned.temporary, 'audio.ogg');
            const buffer = await downloadBoundedMedia(audioMessage, 'audio', signal);
            await writeFile(input, buffer, { mode: 0o600, flag: 'wx' });
            return await runMediaWorker('audio', input, signal);
        } finally {
            if (!turn) await owned.cleanup();
        }
    }

    /** Called inside the killable media subprocess, never on the router's event loop. */
    async transcribeFile(input: string): Promise<string> {
        const wav = `${input}.wav`;
        // Bound decoded duration and output, not just compressed upload bytes.
        await writeFile(wav, '', { mode: 0o600, flag: 'wx' });
        await execFileAsync('ffmpeg', [
            '-y', '-i', input, '-t', '600', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
        ], { windowsHide: true, timeout: mediaTimeout(), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
        if ((await stat(wav)).size >= 600 * 16000 * 2) throw new RouterError('media-limit');
        const transcriber = this.audioTranscriber === undefined ? createConfiguredAudioTranscriber(this.logger) : this.audioTranscriber;
        if (!transcriber) throw new Error('No audio transcription provider available');
        const text = String(await transcriber.transcribe(wav)).trim();
        if (!text) throw new Error('Empty transcription');
        return text;
    }
}

function createConfiguredAudioTranscriber(logger: AudioLogger): AudioTranscriber | null {
    const provider = (process.env.STT_PROVIDER || 'local').trim().toLowerCase();
    if (provider === 'openrouter') {
        const localFallback = tryCreateWhisperCppAudioTranscriber(logger);
        try {
            const primary = createOpenRouterAudioTranscriber(logger);
            if (!localFallback) return primary;
            return {
                async transcribe(path: string) {
                    try { return await primary.transcribe(path); }
                    catch (error) {
                        logger.error(safeFailure(error, 'stt-fallback').diagnostic);
                        return localFallback.transcribe(path);
                    }
                },
            };
        } catch (error) {
            logger.error(safeFailure(error, 'stt-provider').diagnostic);
            if (localFallback) return localFallback;
            return { async transcribe() { throw new Error('Audio provider unavailable'); } };
        }
    }
    return tryCreateWhisperCppAudioTranscriber(logger);
}
