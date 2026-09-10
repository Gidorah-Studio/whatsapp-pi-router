import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises';
import { createStoragePaths } from './storage-path.js';
import type { WhatsAppPiLogger } from './whatsapp-pi.logger.js';

type WhisperModule = {
    createWhisperContext: (options: { model: string; use_gpu?: boolean; no_prints?: boolean }) => {
        free?: () => void;
    };
    transcribeAsync: (context: { free?: () => void }, options: Record<string, unknown>) => Promise<{
        segments?: Array<[string, string, string] | { text?: string }>;
    }>;
};

type AudioLogger = Pick<WhatsAppPiLogger, 'log' | 'error'>;

type WhisperContext = ReturnType<WhisperModule['createWhisperContext']>;
type WhisperResult = Awaited<ReturnType<WhisperModule['transcribeAsync']>>;

const DEFAULT_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const MODEL_FILENAME = 'ggml-base.bin';

let whisperModule: WhisperModule | undefined;
let cachedContext: WhisperContext | undefined;
let cachedModelPath: string | undefined;

export interface AudioTranscriber {
    transcribe(inputPath: string): Promise<string>;
}

function loadWhisperModule(): WhisperModule {
    if (whisperModule) {
        return whisperModule;
    }

    const require = createRequire(import.meta.url);
    try {
        whisperModule = require('whisper-cpp-node') as WhisperModule;
        return whisperModule;
    } catch {
        throw new Error('whisper-cpp-node not installed. Run npm install.');
    }
}

function getModelPath(): string {
    const { root } = createStoragePaths();
    return join(root, 'whisper', 'models', MODEL_FILENAME);
}

async function downloadFile(url: string, targetPath: string): Promise<void> {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error('Model download failed');
    const reader = response.body.getReader();
    const file = await open(targetPath, 'wx', 0o600);
    let bytes = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > 512 * 1024 * 1024) throw new Error('Model download exceeded limit');
            await file.writeFile(value);
        }
        if (!bytes) throw new Error('Empty model download');
        await file.sync();
    } finally {
        await reader.cancel().catch(() => undefined);
        await file.close();
    }
}

async function ensureWhisperModel(logger: AudioLogger): Promise<string> {
    const modelPath = getModelPath();

    try {
        const stats = await stat(modelPath);
        if (stats.size > 0) {
            return modelPath;
        }
    } catch {
        // download below
    }

    logger.log(`[WhatsApp-Pi] Whisper.cpp model download: ${modelPath}`);
    await mkdir(dirname(modelPath), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(dirname(modelPath), 'download-'));
    try {
        const temporaryModel = join(staging, MODEL_FILENAME);
        await downloadFile(DEFAULT_MODEL_URL, temporaryModel);
        // Concurrent workers see either a complete model or no model, never a partial download.
        await rename(temporaryModel, modelPath);
        return modelPath;
    } finally { await rm(staging, { recursive: true, force: true }); }
}

async function createContext(modelPath: string, logger: AudioLogger): Promise<WhisperContext> {
    const { createWhisperContext } = loadWhisperModule();
    logger.log('[WhatsApp-Pi] Whisper.cpp context init');
    return createWhisperContext({
        model: modelPath,
        use_gpu: false,
        no_prints: true
    });
}

async function ensureContext(logger: AudioLogger): Promise<WhisperContext> {
    const modelPath = await ensureWhisperModel(logger);
    if (!cachedContext || cachedModelPath !== modelPath) {
        cachedContext?.free?.();
        cachedContext = await createContext(modelPath, logger);
        cachedModelPath = modelPath;
    }

    return cachedContext;
}

function extractText(result: WhisperResult): string {
    const segments = (result?.segments ?? []) as Array<[string, string, string] | { text?: string }>;
    return segments
        .map((segment) => Array.isArray(segment) ? segment[2] : segment.text)
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
}

export function tryCreateWhisperCppAudioTranscriber(logger: AudioLogger): AudioTranscriber | null {
    try {
        loadWhisperModule();
    } catch {
        return null;
    }

    return {
        async transcribe(inputPath: string): Promise<string> {
            const context = await ensureContext(logger);
            const { transcribeAsync } = loadWhisperModule();
            logger.log('[WhatsApp-Pi] Whisper.cpp transcribe');
            const result = await transcribeAsync(context, {
                fname_inp: inputPath,
                language: 'pt',
                no_timestamps: true,
                no_context: false,
                detect_language: false
            });

            return extractText(result);
        }
    };
}

export function freeWhisperCppContext() {
    cachedContext?.free?.();
    cachedContext = undefined;
    cachedModelPath = undefined;
}
