import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { createStoragePaths } from './storage-path.js';

export type IdentityMapSource = 'auto' | 'manual';

export interface IdentityMapEntry {
    conversationId: string;
    whatsappJid?: string;
    pushName?: string;
    phone?: string;
    phoneJid?: string;
    email?: string;
    externalRecordId?: string;
    source: IdentityMapSource;
    updatedAt: number;
}

interface IdentityMapStore {
    version: 1;
    identities: Record<string, IdentityMapEntry>;
    updatedAt: number;
}

export interface IncomingIdentityInput {
    conversationId: string;
    whatsappJid: string;
    pushName?: string;
}

const STORE_VERSION = 1;

export function normalizePhoneDigits(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const digits = value.replace(/\D+/g, '');
    return digits || undefined;
}

export function normalizeIdentityEmail(value: string | undefined): string | undefined {
    const normalized = value?.trim().toLowerCase();
    return normalized || undefined;
}

function phoneJidFromDigits(digits: string | undefined): string | undefined {
    return digits ? `${digits}@s.whatsapp.net` : undefined;
}

function isPhoneConversationId(conversationId: string): boolean {
    return /^\+\d+$/.test(conversationId);
}

function isPhoneJid(jid: string): boolean {
    return jid.endsWith('@s.whatsapp.net');
}

function hasLinkedIdentity(entry: IdentityMapEntry): boolean {
    return Boolean(entry.externalRecordId || entry.email || entry.phone);
}

export class IdentityMapService {
    private readonly storagePaths = createStoragePaths();
    private readonly storePath = join(this.storagePaths.root, 'identity-map.json');
    private entries = new Map<string, IdentityMapEntry>();
    private initialized = false;
    private writeQueue: Promise<void> = Promise.resolve();

    async ensureInitialized() {
        if (this.initialized) return;
        await mkdir(this.storagePaths.root, { recursive: true });
        await this.loadStore();
        this.initialized = true;
    }

    get(conversationId: string): IdentityMapEntry | undefined {
        return this.entries.get(conversationId);
    }

    getLinkedIdentity(conversationId: string): { kind: 'externalRecordId' | 'email' | 'phone'; value: string } | undefined {
        const entry = this.get(conversationId);
        if (!entry) return undefined;
        if (entry.externalRecordId) return { kind: 'externalRecordId', value: entry.externalRecordId };
        if (entry.email) return { kind: 'email', value: entry.email };
        if (entry.phone) return { kind: 'phone', value: entry.phone };
        return undefined;
    }

    hasLinkedIdentity(conversationId: string): boolean {
        const entry = this.get(conversationId);
        return entry ? hasLinkedIdentity(entry) : false;
    }

    async recordIncomingIdentity(input: IncomingIdentityInput) {
        await this.ensureInitialized();
        const now = Date.now();
        const existing = this.entries.get(input.conversationId);
        const phone = this.derivePhone(input.conversationId, input.whatsappJid);
        const next: IdentityMapEntry = {
            conversationId: input.conversationId,
            whatsappJid: input.whatsappJid,
            pushName: input.pushName || existing?.pushName,
            phone: existing?.phone ?? phone,
            phoneJid: existing?.phoneJid ?? phoneJidFromDigits(phone),
            email: existing?.email,
            externalRecordId: existing?.externalRecordId,
            source: existing?.source ?? 'auto',
            updatedAt: existing ? existing.updatedAt : now
        };

        if (this.entriesEqual(existing, next)) {
            return;
        }

        next.updatedAt = now;
        this.entries.set(input.conversationId, next);
        await this.persistQueued();
    }

    async setManualMapping(conversationId: string, patch: Pick<Partial<IdentityMapEntry>, 'phone' | 'email' | 'externalRecordId' | 'pushName' | 'whatsappJid'>) {
        await this.ensureInitialized();
        const existing = this.entries.get(conversationId);
        const phone = patch.phone ? normalizePhoneDigits(patch.phone) : existing?.phone;
        const next: IdentityMapEntry = {
            conversationId,
            whatsappJid: patch.whatsappJid ?? existing?.whatsappJid,
            pushName: patch.pushName ?? existing?.pushName,
            phone,
            phoneJid: phone ? phoneJidFromDigits(phone) : existing?.phoneJid,
            email: patch.email ? normalizeIdentityEmail(patch.email) : existing?.email,
            externalRecordId: patch.externalRecordId?.trim() || existing?.externalRecordId,
            source: 'manual',
            updatedAt: Date.now()
        };
        this.entries.set(conversationId, next);
        await this.persistQueued();
        return next;
    }

    async clearLinkedIdentity(conversationId: string) {
        await this.ensureInitialized();
        const existing = this.entries.get(conversationId);
        if (!existing) return;
        const next: IdentityMapEntry = {
            conversationId,
            whatsappJid: existing.whatsappJid,
            pushName: existing.pushName,
            source: existing.source,
            updatedAt: Date.now()
        };
        this.entries.set(conversationId, next);
        await this.persistQueued();
    }

    private derivePhone(conversationId: string, whatsappJid: string): string | undefined {
        if (isPhoneConversationId(conversationId)) {
            return normalizePhoneDigits(conversationId);
        }
        if (isPhoneJid(whatsappJid)) {
            return normalizePhoneDigits(whatsappJid.split('@')[0]);
        }
        return undefined;
    }

    private async loadStore() {
        try {
            const raw = await readFile(this.storePath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<IdentityMapStore>;
            const identities = parsed.identities && typeof parsed.identities === 'object'
                ? parsed.identities
                : {};

            this.entries = new Map(Object.entries(identities)
                .map(([conversationId, entry]) => [conversationId, this.cleanEntry(conversationId, entry)] as const)
                .filter((entry): entry is readonly [string, IdentityMapEntry] => Boolean(entry[1])));
        } catch {
            this.entries = new Map();
        }
    }

    private cleanEntry(conversationId: string, value: unknown): IdentityMapEntry | undefined {
        if (!value || typeof value !== 'object') return undefined;
        const candidate = value as Partial<IdentityMapEntry>;
        return {
            conversationId,
            whatsappJid: typeof candidate.whatsappJid === 'string' ? candidate.whatsappJid : undefined,
            pushName: typeof candidate.pushName === 'string' ? candidate.pushName : undefined,
            phone: typeof candidate.phone === 'string' ? normalizePhoneDigits(candidate.phone) : undefined,
            phoneJid: typeof candidate.phoneJid === 'string' ? candidate.phoneJid : undefined,
            email: typeof candidate.email === 'string' ? normalizeIdentityEmail(candidate.email) : undefined,
            externalRecordId: typeof candidate.externalRecordId === 'string' ? candidate.externalRecordId : undefined,
            source: candidate.source === 'manual' ? 'manual' : 'auto',
            updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now()
        };
    }

    private entriesEqual(left: IdentityMapEntry | undefined, right: IdentityMapEntry): boolean {
        return Boolean(left)
            && left?.conversationId === right.conversationId
            && left?.whatsappJid === right.whatsappJid
            && left?.pushName === right.pushName
            && left?.phone === right.phone
            && left?.phoneJid === right.phoneJid
            && left?.email === right.email
            && left?.externalRecordId === right.externalRecordId
            && left?.source === right.source;
    }

    private async persistQueued() {
        this.writeQueue = this.writeQueue.then(() => this.persistStore(), () => this.persistStore());
        await this.writeQueue;
    }

    private async persistStore() {
        const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
        const store: IdentityMapStore = {
            version: STORE_VERSION,
            identities: Object.fromEntries([...this.entries.entries()].sort(([left], [right]) => left.localeCompare(right))),
            updatedAt: Date.now()
        };
        const serialized = JSON.stringify(store, null, 2);
        await mkdir(this.storagePaths.root, { recursive: true });
        await writeFile(tempPath, serialized);
        try {
            await rename(tempPath, this.storePath);
        } catch {
            await writeFile(this.storePath, serialized);
            await rm(tempPath, { force: true });
        }
    }
}
