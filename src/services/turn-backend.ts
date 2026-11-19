import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedChildPiConfig } from './child-pi.config.js';
import { runManagedProcess } from './managed-process.js';
import type { RoutedSessionLaunch } from './routed-session.service.js';
import { RouterError } from './router-errors.js';

export type TurnBackendKind = 'cli' | 'sdk';

/** One admitted turn, already staged on disk. Both backends receive exactly this. */
export interface TurnExecution {
    sessionLaunch: RoutedSessionLaunch;
    prompt: string;
    cwd: string;
    images: Array<{ path: string; mimeType: string }>;
    childPiConfig: ResolvedChildPiConfig;
    /** Extensions the conversation session loads. Nothing else is discovered. */
    extensionPaths: string[];
    /** Tool allowlist across built-in and extension tools; undefined keeps Pi's defaults. */
    tools?: string[];
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    timeoutMs: number;
    maxOutputBytes: number;
}

/** Runs the model turn and returns the final assistant text. Delivery stays with the router. */
export interface TurnBackend {
    readonly kind: TurnBackendKind;
    execute(turn: TurnExecution): Promise<string>;
}

export function resolveTurnBackendKind(env: NodeJS.ProcessEnv = process.env): TurnBackendKind {
    const value = env.WHATSAPP_PI_ROUTER_BACKEND?.trim().toLowerCase();
    if (!value || value === 'cli') return 'cli';
    if (value === 'sdk') return 'sdk';
    throw new Error('WHATSAPP_PI_ROUTER_BACKEND must be "cli" or "sdk"');
}

export function resolveChildTools(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
    const value = env.WHATSAPP_PI_ROUTER_CHILD_TOOLS;
    if (value === undefined || !value.trim()) return undefined;
    const names = [...new Set(value.split(',').map(name => name.trim()).filter(Boolean))];
    if (!names.length || names.some(name => !/^[A-Za-z0-9_.-]{1,64}$/.test(name))) {
        throw new Error('WHATSAPP_PI_ROUTER_CHILD_TOOLS must be a comma-separated list of tool names');
    }
    return names;
}

export function resolveChildExtensionPaths(mediaExtensionPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
    const extra = env.WHATSAPP_PI_ROUTER_CHILD_EXTENSION_PATH?.trim();
    if (!extra) return [mediaExtensionPath];
    if (!isAbsolute(extra)) throw new Error('WHATSAPP_PI_ROUTER_CHILD_EXTENSION_PATH must be an absolute path');
    return [mediaExtensionPath, extra];
}

const cliBackend: TurnBackend = {
    kind: 'cli',
    execute(turn) {
        const args = [...turn.sessionLaunch.args];
        if (turn.childPiConfig.model) args.push('--model', turn.childPiConfig.model);
        if (turn.childPiConfig.thinking) args.push('--thinking', turn.childPiConfig.thinking);
        if (turn.tools) args.push('--tools', turn.tools.join(','));
        args.push('--no-extensions');
        for (const path of turn.extensionPaths) args.push('--extension', path);
        args.push('--print');
        for (const image of turn.images) args.push(`@${image.path}`);
        return runManagedProcess(turn.env.WHATSAPP_PI_ROUTER_PI_BIN || 'pi', args, {
            cwd: turn.cwd, env: turn.env, input: turn.prompt, signal: turn.signal,
            timeoutMs: turn.timeoutMs, maxOutputBytes: turn.maxOutputBytes,
        });
    },
};

const SDK_WORKER_PATH = fileURLToPath(new URL('./sdk-turn-worker.mjs', import.meta.url));
const SDK_RESULT_PREFIX = 'WHATSAPP_SDK_RESULT:';

const sdkBackend: TurnBackend = {
    kind: 'sdk',
    async execute(turn) {
        const { mode, route, forkPath } = turn.sessionLaunch;
        if (mode === 'migrate' && !forkPath) throw new RouterError('child-failed');
        const request = {
            session: { mode, directory: route.directory, ...(forkPath ? { forkPath } : {}) },
            prompt: turn.prompt,
            images: turn.images,
            extensionPaths: turn.extensionPaths,
            ...(turn.childPiConfig.model ? { model: turn.childPiConfig.model } : {}),
            ...(turn.childPiConfig.thinking ? { thinking: turn.childPiConfig.thinking } : {}),
            ...(turn.tools ? { tools: turn.tools } : {}),
        };
        const output = await runManagedProcess(process.execPath, [SDK_WORKER_PATH], {
            cwd: turn.cwd, env: turn.env, input: JSON.stringify(request), signal: turn.signal,
            timeoutMs: turn.timeoutMs, maxOutputBytes: turn.maxOutputBytes,
        });
        const line = output.split('\n').reverse().find(candidate => candidate.startsWith(SDK_RESULT_PREFIX));
        if (!line) throw new RouterError('child-failed');
        const result = JSON.parse(line.slice(SDK_RESULT_PREFIX.length)) as { text?: unknown };
        if (typeof result.text !== 'string') throw new RouterError('child-failed');
        return result.text;
    },
};

export function createTurnBackend(kind: TurnBackendKind): TurnBackend {
    return kind === 'sdk' ? sdkBackend : cliBackend;
}
