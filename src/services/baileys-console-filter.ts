type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';

import { t } from '../i18n.js';

const noisyBaileysPatterns = [
    t('baileys.filter.failedDecrypt'),
    t('baileys.filter.sessionError'),
    t('baileys.filter.badMac'),
    t('baileys.filter.closingOpenSession'),
    t('baileys.filter.closingSession')
];

const stringifyConsolePart = (part: unknown): string => {
    if (part instanceof Error) {
        return `${part.name}: ${part.message}\n${part.stack ?? ''}`;
    }

    if (typeof part === 'string') {
        return part;
    }

    try {
        return JSON.stringify(part);
    } catch {
        return String(part);
    }
};

export const shouldSuppressBaileysConsoleMessage = (args: unknown[]): boolean => {
    const message = args.map(stringifyConsolePart).join(' ');
    return noisyBaileysPatterns.some(pattern => message.includes(pattern));
};

export const installBaileysConsoleFilter = (verbose: boolean): (() => void) => {
    if (verbose) {
        return () => {};
    }

    const methods: ConsoleMethod[] = ['log', 'info', 'warn', 'error'];
    const originals = new Map<ConsoleMethod, (...args: any[]) => void>();
    const patched = new Map<ConsoleMethod, (...args: any[]) => void>();

    for (const method of methods) {
        const original = console[method].bind(console);
        originals.set(method, original);

        const replacement = (...args: unknown[]) => {
            if (shouldSuppressBaileysConsoleMessage(args)) {
                return;
            }

            original(...args);
        };

        patched.set(method, replacement);
        console[method] = replacement as typeof console[typeof method];
    }

    return () => {
        for (const method of methods) {
            const replacement = patched.get(method);
            const original = originals.get(method);
            if (replacement && original && console[method] === replacement) {
                console[method] = original as typeof console[typeof method];
            }
        }
    };
};
