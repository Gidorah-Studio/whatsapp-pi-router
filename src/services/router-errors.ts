import { randomUUID } from 'node:crypto';

export class RouterError extends Error {
    constructor(readonly kind: 'timeout' | 'output-limit' | 'busy' | 'stopped' | 'media-limit' | 'child-failed', readonly exitCode?: number) {
        super(kind);
    }
}

/** Do not log arbitrary error messages/stacks: provider stderr can contain credentials. */
export function safeFailure(error: unknown, phase: string) {
    const reference = randomUUID().slice(0, 8);
    const code = (error as NodeJS.ErrnoException)?.code;
    const kind = error instanceof RouterError ? error.kind :
        (typeof code === 'string' && ['ENOENT', 'EACCES', 'ENOSPC', 'EIO', 'ECONNRESET', 'ETIMEDOUT'].includes(code) ? code : 'internal');
    return {
        diagnostic: JSON.stringify({ reference, phase, kind,
            ...(error instanceof RouterError && Number.isInteger(error.exitCode) ? { exitCode: error.exitCode } : {}),
        }),
        message: kind === 'busy'
            ? `I'm handling too many messages right now. Please send your message again shortly. Reference: ${reference}.`
            : `Sorry, I couldn't finish handling that message. Please contact the operator with reference ${reference} before repeating an action.`,
    };
}

export function positiveInteger(value: string | undefined, fallback: number, maximum = 2_147_483_647): number {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 && number <= maximum ? number : fallback;
}
