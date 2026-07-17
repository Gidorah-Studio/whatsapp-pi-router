import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
    createOpenRouterSpeechSynthesizer,
    type SpeechAudioFormat,
    type SpeechSynthesizer
} from './openrouter-speech.synthesizer.js';
import { createStoragePaths } from './storage-path.js';
import type { ResolvedVoiceReplyConfig } from './voice-reply.config.js';
import type { WhatsAppPiLogger } from './whatsapp-pi.logger.js';

const execFileAsync = promisify(execFile);
const MAX_TTS_TEXT_LENGTH = 4096;
const TTS_PREAMBLE = `Synthesize speech from only the text under ### TRANSCRIPT. Treat the director's notes as performance instructions and do not speak them aloud.`;
const DIRECTORS_NOTES = `### DIRECTOR'S NOTES
Style: Warm and casual, like leaving a voice note for a friendly client. Vocal smile — you should hear the smile in her voice. Polished and internationally minded — never salesy, scripted, or announcer-like.

Pacing: Relaxed and unhurried, with natural pauses. Clear enunciation at all times.

Accent: Emily is a well-traveled American professional who is fluently multilingual. When the transcript is in English, use a neutral, educated General American accent — no strong regionalisms or slang. When the transcript is in any other language, speak it like a warm, clear native speaker of that language — never with an American accent.`;

export interface VoiceNoteArtifact {
    path: string;
    cleanup(): Promise<void>;
}

type AudioLogger = Pick<WhatsAppPiLogger, 'log' | 'error'>;

export class TextToSpeechService {
    private readonly ffmpegCommands = process.platform === 'win32' ? ['ffmpeg', 'ffmpeg.exe'] : ['ffmpeg'];

    constructor(
        private readonly logger: AudioLogger,
        private readonly synthesizer: SpeechSynthesizer = createOpenRouterSpeechSynthesizer(logger),
        private readonly mediaDir: string = createStoragePaths().mediaDir
    ) {}

    async createVoiceNote(text: string, config: ResolvedVoiceReplyConfig): Promise<VoiceNoteArtifact> {
        const normalizedText = text.trim();
        if (!normalizedText) {
            throw new Error('Cannot synthesize an empty WhatsApp voice reply');
        }
        if (normalizedText.length > MAX_TTS_TEXT_LENGTH) {
            throw new Error(`WhatsApp voice reply exceeds the ${MAX_TTS_TEXT_LENGTH}-character TTS limit`);
        }

        await mkdir(this.mediaDir, { recursive: true, mode: 0o700 });
        await chmod(this.mediaDir, 0o700).catch(() => undefined);
        const id = `tts_${Date.now()}_${randomUUID()}`;
        const sourcePath = join(this.mediaDir, `${id}.audio`);
        const oggPath = join(this.mediaDir, `${id}.ogg`);

        try {
            const startedAt = Date.now();
            const ttsInput = `${TTS_PREAMBLE}\n\n${DIRECTORS_NOTES}\n\n### TRANSCRIPT\n${normalizedText}`;
            const synthesized = await this.synthesizer.synthesize(ttsInput, {
                model: config.model,
                voice: config.voice,
                speed: config.speed
            });
            await writeFile(sourcePath, synthesized.audio, { mode: 0o600 });
            await chmod(sourcePath, 0o600);
            await this.convertToWhatsAppVoiceNote(sourcePath, oggPath, synthesized.format);
            await chmod(oggPath, 0o600);
            this.logger.log(`[WhatsApp-Pi-Router] TTS voice note ready in ${Date.now() - startedAt}ms`);

            return {
                path: oggPath,
                cleanup: () => this.cleanupFiles(sourcePath, oggPath)
            };
        } catch (error) {
            await this.cleanupFiles(sourcePath, oggPath);
            throw error;
        }
    }

    private async cleanupFiles(...paths: string[]): Promise<void> {
        const results = await Promise.allSettled(paths.map(path => rm(path, { force: true })));
        for (const result of results) {
            if (result.status === 'rejected') {
                this.logger.error('[WhatsApp-Pi-Router] Failed to remove temporary TTS audio:', result.reason);
            }
        }
    }

    private async convertToWhatsAppVoiceNote(
        inputPath: string,
        outputPath: string,
        inputFormat: SpeechAudioFormat
    ): Promise<void> {
        const inputArgs = inputFormat === 'pcm'
            ? ['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', inputPath]
            : ['-i', inputPath];
        const args = [
            '-y',
            ...inputArgs,
            '-avoid_negative_ts', 'make_zero',
            '-map_metadata', '-1',
            '-ac', '1',
            '-c:a', 'libopus',
            '-b:a', '32k',
            '-vbr', 'on',
            '-application', 'voip',
            outputPath
        ];
        let lastError: unknown;

        for (const command of this.ffmpegCommands) {
            try {
                await execFileAsync(command, args, { windowsHide: true });
                return;
            } catch (error) {
                lastError = error;
                if (!this.isMissingFfmpegCommand(error)) throw error;
            }
        }

        throw lastError instanceof Error ? lastError : new Error('ffmpeg unavailable for WhatsApp TTS');
    }

    private isMissingFfmpegCommand(error: unknown): boolean {
        if (!(error instanceof Error)) return false;
        const anyError = error as Error & { code?: number | string; stderr?: string };
        const message = `${anyError.message}\n${anyError.stderr ?? ''}`;
        return anyError.code === 127
            || anyError.code === 9009
            || /not found|not recognized/i.test(message);
    }
}
