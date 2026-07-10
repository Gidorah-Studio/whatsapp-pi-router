import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import { createStoragePaths } from './storage-path.js';

export const CHILD_PI_THINKING_LEVELS = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
] as const;

export type ChildPiThinkingLevel = typeof CHILD_PI_THINKING_LEVELS[number];

export interface ChildPiFileConfig {
    model?: string;
    thinking?: ChildPiThinkingLevel;
}

export interface ResolvedChildPiConfig extends ChildPiFileConfig {
    modelSource: 'environment' | 'file' | 'default';
    thinkingSource: 'environment' | 'file' | 'default';
}

const isThinkingLevel = (value: string): value is ChildPiThinkingLevel =>
    CHILD_PI_THINKING_LEVELS.includes(value as ChildPiThinkingLevel);

const normalizeModel = (value: unknown, source: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
        throw new Error(`${source} must be a string`);
    }

    return value.trim() || undefined;
};

const normalizeThinking = (value: unknown, source: string): ChildPiThinkingLevel | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
        throw new Error(`${source} must be one of: ${CHILD_PI_THINKING_LEVELS.join(', ')}`);
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (!isThinkingLevel(normalized)) {
        throw new Error(`${source} must be one of: ${CHILD_PI_THINKING_LEVELS.join(', ')}`);
    }

    return normalized;
};

export function getChildPiConfigPath(): string {
    return join(createStoragePaths().root, 'child-pi.json');
}

export async function loadChildPiFileConfig(): Promise<ChildPiFileConfig> {
    let raw: string;
    try {
        raw = await readFile(getChildPiConfigPath(), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        throw new Error(`Failed to read WhatsApp child Pi settings: ${error instanceof Error ? error.message : String(error)}`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Invalid JSON in ${getChildPiConfigPath()}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${getChildPiConfigPath()} must contain a JSON object`);
    }

    const config = parsed as { model?: unknown; thinking?: unknown };
    return {
        model: normalizeModel(config.model, 'Saved child Pi model'),
        thinking: normalizeThinking(config.thinking, 'Saved child Pi thinking level')
    };
}

export async function saveChildPiFileConfig(config: ChildPiFileConfig): Promise<void> {
    const model = normalizeModel(config.model, 'Child Pi model');
    const thinking = normalizeThinking(config.thinking, 'Child Pi thinking level');
    const storagePaths = createStoragePaths();
    const targetPath = getChildPiConfigPath();
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    const serialized = JSON.stringify({
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {})
    }, null, 2);

    await mkdir(storagePaths.root, { recursive: true });
    await writeFile(temporaryPath, `${serialized}\n`, 'utf8');
    await rename(temporaryPath, targetPath);
}

export async function loadResolvedChildPiConfig(): Promise<ResolvedChildPiConfig> {
    const fromFile = await loadChildPiFileConfig();
    const envModel = normalizeModel(process.env.WHATSAPP_PI_ROUTER_MODEL, 'WHATSAPP_PI_ROUTER_MODEL');
    const envThinking = normalizeThinking(process.env.WHATSAPP_PI_ROUTER_THINKING, 'WHATSAPP_PI_ROUTER_THINKING');

    return {
        model: envModel ?? fromFile.model,
        thinking: envThinking ?? fromFile.thinking,
        modelSource: envModel ? 'environment' : fromFile.model ? 'file' : 'default',
        thinkingSource: envThinking ? 'environment' : fromFile.thinking ? 'file' : 'default'
    };
}
