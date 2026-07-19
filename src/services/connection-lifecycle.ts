import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DisconnectReason } from 'baileys';
import { createStoragePaths } from './storage-path.js';

export type DisconnectClassification =
    | 'intentional'
    | 'transient'
    | 'reauth-required'
    | 'connection-conflict'
    | 'unknown';

export type DisconnectAction = 'none' | 'reconnect' | 'pair-new-device' | 'resolve-conflict';

export interface DisconnectDecision {
    classification: DisconnectClassification;
    action: DisconnectAction;
    reason: string;
}

export interface ConnectionLifecycleEvent {
    timestamp: string;
    type: string;
    state: string;
    previousState?: string;
    classification?: DisconnectClassification;
    action?: DisconnectAction;
    statusCode?: number;
    reason?: string;
    error?: string;
    reconnectAttempt?: number;
    nextRetryAt?: string;
    authStatePresent?: boolean;
    intentional?: boolean;
    pid: number;
    uptimeSeconds: number;
    routerVersion: string;
}

export type NewConnectionLifecycleEvent = Omit<
    ConnectionLifecycleEvent,
    'timestamp' | 'pid' | 'uptimeSeconds' | 'routerVersion'
>;

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_LENGTH = 500;

export function sanitizeLifecycleError(message: string): string {
    return message
        .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
        .replace(/(?:sk|sk-or)-[A-Za-z0-9_-]{8,}/g, '[REDACTED_TOKEN]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_ERROR_LENGTH);
}

export function classifyDisconnect(
    statusCode: number | undefined,
    errorMessage: string,
    intentional = false
): DisconnectDecision {
    if (intentional) {
        return {
            classification: 'intentional',
            action: 'none',
            reason: 'intentional-stop'
        };
    }

    if (errorMessage.toLowerCase().includes('bad mac')) {
        return {
            classification: 'reauth-required',
            action: 'pair-new-device',
            reason: 'bad-mac'
        };
    }

    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        return {
            classification: 'reauth-required',
            action: 'pair-new-device',
            reason: 'logged-out'
        };
    }

    if (statusCode === DisconnectReason.badSession || statusCode === 500) {
        return {
            classification: 'reauth-required',
            action: 'pair-new-device',
            reason: 'bad-session'
        };
    }

    if (statusCode === 400 || errorMessage.toLowerCase().includes('bad-request')) {
        return {
            classification: 'reauth-required',
            action: 'pair-new-device',
            reason: 'authentication-rejected'
        };
    }

    if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
        return {
            classification: 'connection-conflict',
            action: 'resolve-conflict',
            reason: 'connection-replaced'
        };
    }

    if (
        statusCode === DisconnectReason.connectionLost
        || statusCode === DisconnectReason.timedOut
        || statusCode === DisconnectReason.connectionClosed
        || statusCode === DisconnectReason.restartRequired
        || statusCode === 408
        || statusCode === 428
        || statusCode === 515
    ) {
        return {
            classification: 'transient',
            action: 'reconnect',
            reason: statusCode === DisconnectReason.restartRequired ? 'restart-required' : 'connection-interrupted'
        };
    }

    return {
        classification: 'unknown',
        action: 'reconnect',
        reason: 'unknown-disconnect'
    };
}

export class ConnectionEventJournal {
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly logPath = createStoragePaths().connectionEventsPath,
        private readonly maxLogBytes = DEFAULT_MAX_LOG_BYTES,
        private readonly routerVersion = process.env.npm_package_version || '0.1.0'
    ) {}

    getPath(): string {
        return this.logPath;
    }

    async record(event: NewConnectionLifecycleEvent): Promise<void> {
        const entry: ConnectionLifecycleEvent = {
            ...event,
            ...(event.error ? { error: sanitizeLifecycleError(event.error) } : {}),
            timestamp: new Date().toISOString(),
            pid: process.pid,
            uptimeSeconds: Math.round(process.uptime()),
            routerVersion: this.routerVersion
        };
        const line = `${JSON.stringify(entry)}\n`;

        const write = this.writeQueue.then(async () => {
            await mkdir(dirname(this.logPath), { recursive: true, mode: 0o700 });
            await this.rotateIfNeeded(Buffer.byteLength(line));
            await appendFile(this.logPath, line, { encoding: 'utf8', mode: 0o600 });
        });
        this.writeQueue = write.catch(() => undefined);
        await write;
    }

    async readRecent(limit = 10): Promise<ConnectionLifecycleEvent[]> {
        await this.writeQueue;
        let contents: string;
        try {
            contents = await readFile(this.logPath, 'utf8');
        } catch {
            return [];
        }

        return contents
            .trim()
            .split('\n')
            .filter(Boolean)
            .slice(-Math.max(0, limit))
            .flatMap(line => {
                try {
                    return [JSON.parse(line) as ConnectionLifecycleEvent];
                } catch {
                    return [];
                }
            });
    }

    private async rotateIfNeeded(incomingBytes: number): Promise<void> {
        try {
            const current = await stat(this.logPath);
            if (current.size + incomingBytes <= this.maxLogBytes) {
                return;
            }
        } catch {
            return;
        }

        const rotatedPath = `${this.logPath}.1`;
        await rm(rotatedPath, { force: true });
        await rename(this.logPath, rotatedPath);
    }
}
