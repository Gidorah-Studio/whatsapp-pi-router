import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createStoragePaths } from './storage-path.js';
import type { GroupReplyMode } from '../models/whatsapp.types.js';

export interface RouterAllowConfig {
    allowAllDirectChats: boolean;
    allowAllGroups: boolean;
    groupReplyMode: GroupReplyMode;
    allow: string[];
}

const defaultRouterAllowConfig = (): RouterAllowConfig => ({
    allowAllDirectChats: false,
    allowAllGroups: false,
    groupReplyMode: 'all',
    allow: []
});

export const isTruthyConfigValue = (value: unknown): boolean => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on', '*', 'all'].includes(value.trim().toLowerCase());
};

export const normalizeGroupReplyMode = (value: unknown): GroupReplyMode | undefined => {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    return normalized === 'all' || normalized === 'mentions' ? normalized : undefined;
};

export function getRouterAllowConfigPath(): string {
    return join(createStoragePaths().root, 'router-allow.json');
}

const normalizeAllowValues = (values: unknown[]): string[] => values
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean);

export const parseRouterAllowConfig = (raw: string): RouterAllowConfig => {
    const parsed = JSON.parse(raw) as unknown;

    if (Array.isArray(parsed)) {
        return {
            ...defaultRouterAllowConfig(),
            allow: normalizeAllowValues(parsed)
        };
    }

    if (!parsed || typeof parsed !== 'object') {
        return defaultRouterAllowConfig();
    }

    const config = parsed as {
        allow?: unknown[];
        allowAll?: unknown;
        allowAllDirect?: unknown;
        allowAllDirectChats?: unknown;
        allowAllGroups?: unknown;
        groupReplyMode?: unknown;
    };

    const allowAllDirectChatsValue = config.allowAllDirectChats ?? config.allowAllDirect ?? config.allowAll;

    return {
        allowAllDirectChats: isTruthyConfigValue(allowAllDirectChatsValue),
        allowAllGroups: isTruthyConfigValue(config.allowAllGroups),
        groupReplyMode: normalizeGroupReplyMode(config.groupReplyMode) ?? 'all',
        allow: Array.isArray(config.allow) ? normalizeAllowValues(config.allow) : []
    };
};

export async function loadRouterAllowFileConfig(): Promise<RouterAllowConfig> {
    try {
        const raw = await readFile(getRouterAllowConfigPath(), 'utf8');
        return parseRouterAllowConfig(raw);
    } catch {
        return defaultRouterAllowConfig();
    }
}

export async function loadRouterAllowConfig(): Promise<RouterAllowConfig> {
    const fromEnv = (process.env.WHATSAPP_ROUTER_ALLOW_NUMBERS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    const envAllowAllDirectChats = isTruthyConfigValue(process.env.WHATSAPP_ROUTER_ALLOW_ALL)
        || isTruthyConfigValue(process.env.WHATSAPP_ROUTER_ALLOW_ALL_DIRECT_CHATS);
    const envAllowAllGroups = isTruthyConfigValue(process.env.WHATSAPP_ROUTER_ALLOW_ALL_GROUPS);
    const fromFile = await loadRouterAllowFileConfig();

    return {
        allowAllDirectChats: envAllowAllDirectChats || fromFile.allowAllDirectChats,
        allowAllGroups: envAllowAllGroups || fromFile.allowAllGroups,
        groupReplyMode: fromFile.groupReplyMode,
        allow: [...fromEnv, ...fromFile.allow]
    };
}

export async function saveRouterAllowFileConfig(config: RouterAllowConfig): Promise<void> {
    const storagePaths = createStoragePaths();
    await mkdir(storagePaths.root, { recursive: true });
    await writeFile(getRouterAllowConfigPath(), JSON.stringify({
        allowAllDirectChats: config.allowAllDirectChats,
        allowAllGroups: config.allowAllGroups,
        groupReplyMode: config.groupReplyMode,
        allow: config.allow
    }, null, 2));
}

export async function updateRouterAllowFileConfig(patch: Partial<Pick<RouterAllowConfig, 'allowAllDirectChats' | 'allowAllGroups' | 'groupReplyMode'>>): Promise<RouterAllowConfig> {
    const current = await loadRouterAllowFileConfig();
    const next = { ...current, ...patch };
    await saveRouterAllowFileConfig(next);
    return next;
}
