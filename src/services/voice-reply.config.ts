import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStoragePaths } from './storage-path.js';

export const VOICE_REPLY_MODES = [
    'off',
    'explicit',
    'mirror',
    'mirror-explicit',
    'always'
] as const;

export type VoiceReplyMode = typeof VOICE_REPLY_MODES[number];
export type VoiceReplyConfigSource = 'environment' | 'file' | 'default';

export const DEFAULT_TTS_MODEL = 'x-ai/grok-voice-tts-1.0';
export const DEFAULT_TTS_VOICE = 'eve';
export const DEFAULT_TTS_SPEED = 1;

export interface VoiceReplyFileConfig {
    mode?: VoiceReplyMode;
    model?: string;
    voice?: string;
    speed?: number;
}

export interface ResolvedVoiceReplyConfig {
    mode: VoiceReplyMode;
    model: string;
    voice: string;
    speed: number;
    modeSource: VoiceReplyConfigSource;
    modelSource: VoiceReplyConfigSource;
    voiceSource: VoiceReplyConfigSource;
    speedSource: VoiceReplyConfigSource;
}

const isVoiceReplyMode = (value: string): value is VoiceReplyMode =>
    VOICE_REPLY_MODES.includes(value as VoiceReplyMode);

const normalizeMode = (value: unknown, source: string): VoiceReplyMode | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
        throw new Error(`${source} must be one of: ${VOICE_REPLY_MODES.join(', ')}`);
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (!isVoiceReplyMode(normalized)) {
        throw new Error(`${source} must be one of: ${VOICE_REPLY_MODES.join(', ')}`);
    }

    return normalized;
};

const normalizeString = (value: unknown, source: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
        throw new Error(`${source} must be a string`);
    }

    return value.trim() || undefined;
};

const normalizeSpeed = (value: unknown, source: string): number | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const normalized = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(normalized) || normalized < 0.5 || normalized > 2) {
        throw new Error(`${source} must be a number from 0.5 to 2`);
    }

    return normalized;
};

export function getVoiceReplyConfigPath(): string {
    return join(createStoragePaths().root, 'voice-replies.json');
}

export async function loadVoiceReplyFileConfig(): Promise<VoiceReplyFileConfig> {
    let raw: string;
    try {
        raw = await readFile(getVoiceReplyConfigPath(), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw new Error(`Failed to read WhatsApp voice reply settings: ${error instanceof Error ? error.message : String(error)}`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Invalid JSON in ${getVoiceReplyConfigPath()}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${getVoiceReplyConfigPath()} must contain a JSON object`);
    }

    const config = parsed as { mode?: unknown; model?: unknown; voice?: unknown; speed?: unknown };
    return {
        mode: normalizeMode(config.mode, 'Saved voice reply mode'),
        model: normalizeString(config.model, 'Saved TTS model'),
        voice: normalizeString(config.voice, 'Saved TTS voice'),
        speed: normalizeSpeed(config.speed, 'Saved TTS speed')
    };
}

export async function saveVoiceReplyFileConfig(config: VoiceReplyFileConfig): Promise<void> {
    const mode = normalizeMode(config.mode, 'Voice reply mode');
    const model = normalizeString(config.model, 'TTS model');
    const voice = normalizeString(config.voice, 'TTS voice');
    const speed = normalizeSpeed(config.speed, 'TTS speed');
    const storagePaths = createStoragePaths();
    const targetPath = getVoiceReplyConfigPath();
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    const serialized = JSON.stringify({
        ...(mode ? { mode } : {}),
        ...(model ? { model } : {}),
        ...(voice ? { voice } : {}),
        ...(speed !== undefined ? { speed } : {})
    }, null, 2);

    await mkdir(storagePaths.root, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, `${serialized}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
}

export function getDefaultResolvedVoiceReplyConfig(): ResolvedVoiceReplyConfig {
    return {
        mode: 'off',
        model: DEFAULT_TTS_MODEL,
        voice: DEFAULT_TTS_VOICE,
        speed: DEFAULT_TTS_SPEED,
        modeSource: 'default',
        modelSource: 'default',
        voiceSource: 'default',
        speedSource: 'default'
    };
}

export async function loadResolvedVoiceReplyConfig(): Promise<ResolvedVoiceReplyConfig> {
    const fromFile = await loadVoiceReplyFileConfig();
    const envMode = normalizeMode(process.env.WHATSAPP_PI_ROUTER_TTS_MODE, 'WHATSAPP_PI_ROUTER_TTS_MODE');
    const envModel = normalizeString(process.env.WHATSAPP_PI_ROUTER_TTS_MODEL, 'WHATSAPP_PI_ROUTER_TTS_MODEL');
    const envVoice = normalizeString(process.env.WHATSAPP_PI_ROUTER_TTS_VOICE, 'WHATSAPP_PI_ROUTER_TTS_VOICE');
    const envSpeed = normalizeSpeed(process.env.WHATSAPP_PI_ROUTER_TTS_SPEED, 'WHATSAPP_PI_ROUTER_TTS_SPEED');

    return {
        mode: envMode ?? fromFile.mode ?? 'off',
        model: envModel ?? fromFile.model ?? DEFAULT_TTS_MODEL,
        voice: envVoice ?? fromFile.voice ?? DEFAULT_TTS_VOICE,
        speed: envSpeed ?? fromFile.speed ?? DEFAULT_TTS_SPEED,
        modeSource: envMode ? 'environment' : fromFile.mode ? 'file' : 'default',
        modelSource: envModel ? 'environment' : fromFile.model ? 'file' : 'default',
        voiceSource: envVoice ? 'environment' : fromFile.voice ? 'file' : 'default',
        speedSource: envSpeed !== undefined ? 'environment' : fromFile.speed !== undefined ? 'file' : 'default'
    };
}
