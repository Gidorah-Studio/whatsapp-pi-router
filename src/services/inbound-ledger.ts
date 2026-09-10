import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWritePrivate, isMissingFile, SerialQueue } from './private-storage.js';

type Entry = { at: number; state: 'claimed' | 'completed' | 'failed' };
export interface InboundClaimStore {
    claim(keys: string[]): Promise<boolean>;
    finish(keys: string[], state: 'completed' | 'failed'): Promise<void>;
}

/** At-most-once dispatch within the retention window, not an exactly-once delivery queue.
 * Claims survive crashes: replay never reruns a possibly side-effecting agent turn.
 * Saturated/corrupt/unwritable stores fail closed rather than silently losing deduplication.
 */
export class InboundLedger implements InboundClaimStore {
    private entries: Record<string, Entry> = {};
    private loaded = false;
    private readonly writes = new SerialQueue();
    constructor(
        private readonly path?: string,
        private readonly retentionMs = 7 * 24 * 60 * 60 * 1000,
        private readonly maxEntries = 20_000,
        private readonly now = Date.now,
    ) {}

    private async load(): Promise<void> {
        if (this.loaded) return;
        if (this.path) {
            try {
                const parsed = JSON.parse(await readFile(this.path, 'utf8'));
                if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
                    throw new Error('Invalid inbound ledger');
                }
                for (const [key, value] of Object.entries(parsed.entries)) {
                    const entry = value as Entry;
                    if (!/^[a-f0-9]{64}$/.test(key) || !Number.isFinite(entry?.at) ||
                        !['claimed', 'completed', 'failed'].includes(entry?.state)) throw new Error('Invalid inbound ledger entry');
                }
                this.entries = parsed.entries;
            } catch (error) {
                if (!isMissingFile(error)) throw new Error('Inbound ledger unavailable; dispatch stopped', { cause: error });
            }
        }
        this.loaded = true;
    }

    private async save(next: Record<string, Entry>): Promise<void> {
        if (this.path) await atomicWritePrivate(this.path, JSON.stringify({ version: 1, entries: next }));
        this.entries = next;
    }

    claim(keys: string[]): Promise<boolean> {
        return this.writes.run(async () => {
            await this.load();
            const now = this.now();
            const next = Object.fromEntries(Object.entries(this.entries).filter(([, e]) => e.at > now - this.retentionMs));
            const existing = keys.map(key => next[key]).find(Boolean);
            const missing = keys.filter(key => !next[key]);
            if (Object.keys(next).length + missing.length > this.maxEntries) throw new Error('Inbound ledger capacity reached');
            // Replays can teach us a new PN/LID alias. Persist it even when suppressing the turn.
            for (const key of missing) next[key] = existing ?? { at: now, state: 'claimed' };
            if (missing.length) await this.save(next);
            return !existing;
        });
    }

    finish(keys: string[], state: 'completed' | 'failed'): Promise<void> {
        return this.writes.run(async () => {
            await this.load();
            const next = { ...this.entries };
            for (const key of keys) if (next[key]) next[key] = { ...next[key], state };
            await this.save(next);
        });
    }
}

export function inboundDedupKeys(key: {
    id?: string; remoteJid?: string; remoteJidAlt?: string; senderLid?: string;
    senderPn?: string; previousRemoteJid?: string;
}): string[] {
    if (!key.id || !key.remoteJid) return [];
    const jids = key.remoteJid.endsWith('@g.us') ? [key.remoteJid] :
        [key.remoteJid, key.remoteJidAlt, key.senderLid, key.senderPn, key.previousRemoteJid];
    return [...new Set(jids.filter((jid): jid is string => Boolean(jid))
        .map(jid => jid.replace(/:\d+@/, '@')))]
        .map(jid => createHash('sha256').update(JSON.stringify([jid, key.id])).digest('hex'));
}
