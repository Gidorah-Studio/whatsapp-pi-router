import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { createStoragePaths } from './storage-path.js';

export type IdentityMapSource = 'auto' | 'manual';

export interface IdentityMapEntry {
    conversationId: string;
    whatsappJid?: string;
    lidJid?: string;
    phone?: string;
    phoneJid?: string;
    alternateJid?: string;
    pushName?: string;
    email?: string;
    externalRecordId?: string;
    addressingMode?: string;
    /** Explicit operator clear: do not resurrect external enrichment. */
    enrichmentDisabled?: boolean;
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
    lidJid?: string;
    phoneJid?: string;
    alternateJid?: string;
    addressingMode?: string;
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

export function normalizeDirectJid(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;

    if (!trimmed.includes('@')) {
        const digits = normalizePhoneDigits(trimmed);
        return digits ? `${digits}@s.whatsapp.net` : trimmed;
    }

    const [localPart, domain = ''] = trimmed.split('@');
    const normalizedLocal = localPart.split(':')[0].replace(/^\+/, '');
    return domain ? `${normalizedLocal}@${domain}` : normalizedLocal;
}

export function isLidJid(jid: string | undefined): boolean {
    return Boolean(jid?.endsWith('@lid'));
}

export function isPhoneJid(jid: string | undefined): boolean {
    return Boolean(jid?.endsWith('@s.whatsapp.net'));
}

function phoneJidFromDigits(digits: string | undefined): string | undefined {
    return digits ? `${digits}@s.whatsapp.net` : undefined;
}

function phoneConversationIdFromDigits(digits: string | undefined): string | undefined {
    return digits ? `+${digits}` : undefined;
}

function phoneDigitsFromJid(jid: string | undefined): string | undefined {
    if (!isPhoneJid(jid)) return undefined;
    return normalizePhoneDigits(jid?.split('@')[0]);
}

function isPhoneConversationId(conversationId: string): boolean {
    return /^\+\d+$/.test(conversationId);
}

function hasLinkedIdentity(entry: IdentityMapEntry): boolean {
    return Boolean(entry.externalRecordId || entry.email || entry.phone);
}

export class IdentityMapService {
    private readonly storagePaths;
    private readonly storePath: string;
    private readonly enrichmentPath: string;
    private entries = new Map<string, IdentityMapEntry>();
    private initialized = false;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(root?: string) {
        this.storagePaths = createStoragePaths(root);
        this.storePath = join(this.storagePaths.root, 'identity-map.json');
        this.enrichmentPath = join(this.storagePaths.root, 'identity-enrichment.json');
    }

    async ensureInitialized() {
        if (this.initialized) return;
        await mkdir(this.storagePaths.root, { recursive: true });
        await this.loadStore();
        this.initialized = true;
    }

    get(conversationId: string): IdentityMapEntry | undefined {
        return this.entries.get(conversationId);
    }

    /** Fresh business context only. Never store this merged view or use it for delivery routing. */
    async getResolvedIdentity(conversationId: string): Promise<IdentityMapEntry | undefined> {
        await this.ensureInitialized();
        const base = this.get(conversationId);
        if (!base || base.enrichmentDisabled) return base;

        try {
            const store = JSON.parse(await readFile(this.enrichmentPath, 'utf8'));
            if (store?.version !== 1 || !store.identities || Array.isArray(store.identities)
                || typeof store.identities !== 'object') throw new Error('Invalid enrichment store');
            const candidate = store.identities[conversationId];
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return base;
            const fields = ['phone', 'email', 'externalRecordId'] as const;
            // Bind enrichment to the router identity observed by the sync. A manual
            // relink or changed WhatsApp phone must invalidate the old CRM context.
            if (!candidate.basis || fields.some(key => candidate.basis[key] !== (base[key] || null))) return base;
            if (fields.some(key => candidate[key] != null && typeof candidate[key] !== 'string')) return base;
            return {
                ...base,
                phone: base.phone || normalizePhoneDigits(candidate.phone),
                email: base.email || normalizeIdentityEmail(candidate.email),
                externalRecordId: base.externalRecordId || candidate.externalRecordId?.trim() || undefined,
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                // No raw file contents, paths or errors in customer-facing output.
                console.warn('[IdentityMap] External enrichment unavailable; using router identity only.');
            }
            return base;
        }
    }

    findByJid(jid: string): IdentityMapEntry | undefined {
        const normalized = normalizeDirectJid(jid) ?? jid;
        const phone = phoneDigitsFromJid(normalized);
        const phoneConversationId = phoneConversationIdFromDigits(phone);

        return this.entries.get(normalized)
            ?? (phoneConversationId ? this.entries.get(phoneConversationId) : undefined)
            ?? [...this.entries.values()].find(entry =>
                entry.whatsappJid === normalized
                || entry.lidJid === normalized
                || entry.phoneJid === normalized
                || entry.alternateJid === normalized
                || (phone && entry.phone === phone));
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

        const whatsappJid = normalizeDirectJid(input.whatsappJid) ?? input.whatsappJid;
        const alternateJid = normalizeDirectJid(input.alternateJid);
        const lidJid = normalizeDirectJid(input.lidJid)
            ?? (isLidJid(whatsappJid) ? whatsappJid : undefined)
            ?? (isLidJid(alternateJid) ? alternateJid : undefined);
        const phoneJid = normalizeDirectJid(input.phoneJid)
            ?? (isPhoneJid(whatsappJid) ? whatsappJid : undefined)
            ?? (isPhoneJid(alternateJid) ? alternateJid : undefined);
        const phone = phoneDigitsFromJid(phoneJid) ?? this.derivePhone(input.conversationId, whatsappJid);

        const existing = this.entries.get(input.conversationId);
        const next = this.mergeEntry(input.conversationId, existing, {
            whatsappJid,
            alternateJid,
            lidJid,
            phone,
            phoneJid: phoneJid ?? phoneJidFromDigits(phone),
            pushName: input.pushName,
            addressingMode: input.addressingMode,
            source: existing?.source ?? 'auto'
        });

        if (this.entriesEqual(existing, next)) {
            return;
        }

        this.entries.set(input.conversationId, next);
        await this.persistQueued();
    }

    async recordLidPnMapping(lid: string, pn: string, source: IdentityMapSource = 'auto') {
        await this.ensureInitialized();
        const lidJid = normalizeDirectJid(lid);
        const phoneJid = normalizeDirectJid(pn);
        if (!isLidJid(lidJid) || !isPhoneJid(phoneJid)) {
            return;
        }

        const phone = phoneDigitsFromJid(phoneJid);
        const phoneConversationId = phoneConversationIdFromDigits(phone);
        const now = Date.now();
        const lidExisting = this.entries.get(lidJid!);
        const phoneExisting = phoneConversationId ? this.entries.get(phoneConversationId) : undefined;
        const lidNext = this.mergeEntry(lidJid!, lidExisting, {
            whatsappJid: lidExisting?.whatsappJid ?? lidJid,
            lidJid,
            phone,
            phoneJid,
            alternateJid: lidExisting?.alternateJid ?? phoneJid,
            email: lidExisting?.email ?? phoneExisting?.email,
            externalRecordId: lidExisting?.externalRecordId ?? phoneExisting?.externalRecordId,
            pushName: lidExisting?.pushName ?? phoneExisting?.pushName,
            source: lidExisting?.source ?? phoneExisting?.source ?? source,
            updatedAt: now
        });
        this.entries.set(lidJid!, lidNext);

        if (phoneConversationId) {
            const phoneNext = this.mergeEntry(phoneConversationId, phoneExisting, {
                whatsappJid: phoneExisting?.whatsappJid ?? phoneJid,
                lidJid,
                phone,
                phoneJid,
                alternateJid: phoneExisting?.alternateJid ?? lidJid,
                email: phoneExisting?.email ?? lidExisting?.email,
                externalRecordId: phoneExisting?.externalRecordId ?? lidExisting?.externalRecordId,
                pushName: phoneExisting?.pushName ?? lidExisting?.pushName,
                source: phoneExisting?.source ?? lidExisting?.source ?? source,
                updatedAt: now
            });
            this.entries.set(phoneConversationId, phoneNext);
        }

        await this.persistQueued();
    }

    async setManualMapping(conversationId: string, patch: Pick<Partial<IdentityMapEntry>, 'phone' | 'email' | 'externalRecordId' | 'pushName' | 'whatsappJid' | 'lidJid' | 'phoneJid'>) {
        await this.ensureInitialized();
        const existing = this.entries.get(conversationId);
        const phone = patch.phone ? normalizePhoneDigits(patch.phone) : existing?.phone;
        const phoneJid = normalizeDirectJid(patch.phoneJid) ?? (phone ? phoneJidFromDigits(phone) : existing?.phoneJid);
        const lidJid = normalizeDirectJid(patch.lidJid) ?? existing?.lidJid;
        const next: IdentityMapEntry = {
            conversationId,
            whatsappJid: normalizeDirectJid(patch.whatsappJid) ?? patch.whatsappJid ?? existing?.whatsappJid,
            lidJid,
            pushName: patch.pushName ?? existing?.pushName,
            phone,
            phoneJid,
            alternateJid: existing?.alternateJid,
            email: patch.email ? normalizeIdentityEmail(patch.email) : existing?.email,
            externalRecordId: patch.externalRecordId?.trim() || existing?.externalRecordId,
            addressingMode: existing?.addressingMode,
            source: 'manual',
            enrichmentDisabled: false,
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
            lidJid: existing.lidJid,
            phoneJid: existing.phoneJid,
            alternateJid: existing.alternateJid,
            pushName: existing.pushName,
            addressingMode: existing.addressingMode,
            source: existing.source,
            enrichmentDisabled: true,
            updatedAt: Date.now()
        };
        this.entries.set(conversationId, next);
        await this.persistQueued();
    }

    private mergeEntry(conversationId: string, existing: IdentityMapEntry | undefined, patch: Partial<IdentityMapEntry>): IdentityMapEntry {
        return {
            conversationId,
            whatsappJid: patch.whatsappJid ?? existing?.whatsappJid,
            lidJid: patch.lidJid ?? existing?.lidJid,
            pushName: patch.pushName ?? existing?.pushName,
            phone: patch.phone ?? existing?.phone,
            phoneJid: patch.phoneJid ?? existing?.phoneJid,
            alternateJid: patch.alternateJid ?? existing?.alternateJid,
            email: patch.email ?? existing?.email,
            externalRecordId: patch.externalRecordId ?? existing?.externalRecordId,
            addressingMode: patch.addressingMode ?? existing?.addressingMode,
            enrichmentDisabled: patch.enrichmentDisabled ?? existing?.enrichmentDisabled,
            source: patch.source ?? existing?.source ?? 'auto',
            updatedAt: patch.updatedAt ?? Date.now()
        };
    }

    private derivePhone(conversationId: string, whatsappJid: string): string | undefined {
        if (isPhoneConversationId(conversationId)) {
            return normalizePhoneDigits(conversationId);
        }
        if (isPhoneJid(whatsappJid)) {
            return phoneDigitsFromJid(whatsappJid);
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
        const phone = typeof candidate.phone === 'string' ? normalizePhoneDigits(candidate.phone) : undefined;
        const phoneJid = normalizeDirectJid(candidate.phoneJid) ?? phoneJidFromDigits(phone);
        const lidJid = normalizeDirectJid(candidate.lidJid);
        return {
            conversationId,
            whatsappJid: typeof candidate.whatsappJid === 'string' ? normalizeDirectJid(candidate.whatsappJid) ?? candidate.whatsappJid : undefined,
            lidJid: isLidJid(lidJid) ? lidJid : undefined,
            pushName: typeof candidate.pushName === 'string' ? candidate.pushName : undefined,
            phone,
            phoneJid: isPhoneJid(phoneJid) ? phoneJid : undefined,
            alternateJid: typeof candidate.alternateJid === 'string' ? normalizeDirectJid(candidate.alternateJid) ?? candidate.alternateJid : undefined,
            email: typeof candidate.email === 'string' ? normalizeIdentityEmail(candidate.email) : undefined,
            externalRecordId: typeof candidate.externalRecordId === 'string' ? candidate.externalRecordId.trim() || undefined : undefined,
            addressingMode: typeof candidate.addressingMode === 'string' ? candidate.addressingMode : undefined,
            enrichmentDisabled: candidate.enrichmentDisabled === true,
            source: candidate.source === 'manual' ? 'manual' : 'auto',
            updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now()
        };
    }

    private entriesEqual(left: IdentityMapEntry | undefined, right: IdentityMapEntry): boolean {
        return Boolean(left)
            && left?.conversationId === right.conversationId
            && left?.whatsappJid === right.whatsappJid
            && left?.lidJid === right.lidJid
            && left?.pushName === right.pushName
            && left?.phone === right.phone
            && left?.phoneJid === right.phoneJid
            && left?.alternateJid === right.alternateJid
            && left?.email === right.email
            && left?.externalRecordId === right.externalRecordId
            && left?.addressingMode === right.addressingMode
            && left?.source === right.source
            && Boolean(left?.enrichmentDisabled) === Boolean(right.enrichmentDisabled);
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
