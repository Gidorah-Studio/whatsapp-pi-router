import { createHash } from 'node:crypto';
import { ensurePrivateDirectory } from './private-storage.js';
import { join } from 'node:path';
import { SessionManager as PiSessionManager } from '@earendil-works/pi-coding-agent';
import { createStoragePaths } from './storage-path.js';

export interface RoutedSessionRoute {
    key: string;
    directory: string;
    legacySessionId: string;
}

export interface RoutedSessionLaunch {
    args: string[];
    mode: 'create' | 'continue' | 'migrate';
    route: RoutedSessionRoute;
}

export function createRoutedSessionRoute(remoteJid: string): RoutedSessionRoute {
    const kind = remoteJid.endsWith('@g.us') ? 'group' : 'direct';
    const hash = createHash('sha256').update(remoteJid).digest('hex').slice(0, 16);
    const key = `${kind}-${hash}`;

    return {
        key,
        directory: join(createStoragePaths().root, 'child-sessions', key),
        legacySessionId: `whatsapp-${key}`
    };
}

export async function resolveRoutedSessionLaunch(remoteJid: string, cwd: string): Promise<RoutedSessionLaunch> {
    const route = createRoutedSessionRoute(remoteJid);
    await ensurePrivateDirectory(route.directory);

    const routedSessions = await PiSessionManager.list(cwd, route.directory);
    if (routedSessions.length > 0) {
        return {
            args: ['--session-dir', route.directory, '--continue'],
            mode: 'continue',
            route
        };
    }

    const legacySessions = await PiSessionManager.list(cwd);
    const legacySession = legacySessions.find((session) => session.id === route.legacySessionId);
    if (legacySession) {
        return {
            args: ['--fork', legacySession.path, '--session-dir', route.directory],
            mode: 'migrate',
            route
        };
    }

    return {
        args: ['--session-dir', route.directory, '--continue'],
        mode: 'create',
        route
    };
}
