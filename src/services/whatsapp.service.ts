import {
    makeWASocket,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    extractMessageContent
} from 'baileys';
import P from 'pino';
import { SessionManager } from './session.manager.js';
import { IncomingMessage, SessionStatus } from '../models/whatsapp.types.js';
import { MessageSender } from './message.sender.js';
import { installBaileysConsoleFilter } from './baileys-console-filter.js';
import { t } from '../i18n.js';
import { appendFileSync } from 'fs';
import { createStoragePaths } from './storage-path.js';
import type { WhatsAppImageMimeType } from './outbound-image.service.js';
import {
    ConnectionEventJournal,
    classifyDisconnect,
    type ConnectionLifecycleEvent,
    type NewConnectionLifecycleEvent
} from './connection-lifecycle.js';

const LOG_FILE = createStoragePaths().logPath;
function fileLog(msg: string) {
    try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [WhatsApp-Pi] ${msg}\n`); } catch {
        // File logging is best-effort.
    }
}

export interface WhatsAppStartOptions {
    allowPairingOnAuthFailure?: boolean;
}

interface DisconnectPayload {
    error?: unknown;
}

interface ConnectionUpdateEvent {
    connection?: 'close' | 'open' | string;
    lastDisconnect?: DisconnectPayload;
    qr?: string;
}

interface IncomingMessageKey {
    id?: string;
    remoteJid?: string;
    remoteJidAlt?: string;
    fromMe?: boolean;
    participant?: string;
    participantAlt?: string;
    senderLid?: string;
    senderPn?: string;
    previousRemoteJid?: string;
    addressingMode?: string;
}

interface IncomingMessageContextInfo {
    mentionedJid?: string[];
}

interface IncomingMessageWithContext {
    contextInfo?: IncomingMessageContextInfo;
}

interface IncomingMessageContent {
    conversation?: string;
    extendedTextMessage?: {
        text?: string;
        contextInfo?: IncomingMessageContextInfo;
    };
    imageMessage?: IncomingMessageWithContext;
    videoMessage?: IncomingMessageWithContext;
    documentMessage?: IncomingMessageWithContext;
    audioMessage?: IncomingMessageWithContext;
    stickerMessage?: IncomingMessageWithContext;
    buttonsMessage?: IncomingMessageWithContext;
    templateMessage?: IncomingMessageWithContext;
}

interface IncomingMessageLike {
    key: IncomingMessageKey;
    message?: IncomingMessageContent;
    pushName?: string;
    messageTimestamp?: number | string;
}

interface MessagesUpsertEvent {
    messages?: IncomingMessageLike[];
}

interface LidMappingPayload {
    lid?: string;
    pn?: string;
}

interface PhoneNumberSharePayload {
    lid?: string;
    jid?: string;
}

interface MessageUpdatePayload {
    key?: { id?: string; remoteJid?: string; fromMe?: boolean };
    update?: { status?: unknown };
}

interface MessageReceiptPayload {
    key?: { id?: string; remoteJid?: string; fromMe?: boolean };
    receipt?: unknown;
}

type WhatsAppOutgoingContent =
    | { text: string }
    | { audio: { url: string }; mimetype: 'audio/ogg; codecs=opus'; ptt: true }
    | { image: { url: string }; mimetype: WhatsAppImageMimeType; caption?: string };

interface WhatsAppSocketLike {
    user?: { id?: string; lid?: string };
    ev: {
        on(event: string, handler: (payload: any) => void | Promise<void>): void;
        removeAllListeners(event: string): void;
    };
    end(reason?: unknown): void | Promise<void>;
    logout(): Promise<void>;
    sendMessage(jid: string, content: WhatsAppOutgoingContent): Promise<{ key?: { id?: string } } | undefined>;
    sendPresenceUpdate(presence: 'composing' | 'recording' | 'paused', jid: string): Promise<void>;
    readMessages(messages: Array<{ remoteJid: string; id: string; fromMe: boolean }>): Promise<void>;
    groupMetadata(jid: string): Promise<{ id: string; subject: string; participants: Array<{ id: string }> }>;
    groupFetchAllParticipating(): Promise<Record<string, { id: string; subject: string; participants: Array<{ id: string }> }>>;
    signalRepository?: {
        lidMapping?: {
            getLIDForPN(pn: string): Promise<string | null>;
            getPNForLID(lid: string): Promise<string | null>;
            storeLIDPNMappings(mappings: Array<{ lid: string; pn: string }>): Promise<void>;
        };
    };
}

interface LastDisconnectLike {
    error?: unknown;
}

interface BoomLikeError {
    output?: {
        statusCode?: number;
    };
    message?: string;
}

export interface WhatsAppDiagnostics {
    status: SessionStatus;
    authStatePresent: boolean;
    instanceLockOwned: boolean;
    operatorActionRequired: boolean;
    reconnectAttempts: number;
    nextRetryAt?: string;
    connectedSince?: string;
    processStartedAt: string;
    processUptimeSeconds: number;
    eventLogPath: string;
    lastDisconnect?: ConnectionLifecycleEvent;
    recentEvents: ConnectionLifecycleEvent[];
}

export class WhatsAppService {
    private static readonly INITIAL_RECONNECT_DELAY_MS = 5_000;
    private static readonly MAX_RECONNECT_DELAY_MS = 120_000;

    private socket?: WhatsAppSocketLike;
    private sessionManager: SessionManager;
    private messageSender: MessageSender;
    private isReconnecting = false;
    private reconnectAttempts = 0;
    private verboseMode = false;
    private onIncomingMessageRecorded?: (message: IncomingMessage) => void | Promise<void>;
    private saveCreds?: () => Promise<void>;
    private restoreBaileysConsoleFilter?: () => void;
    private reconnectTimeout?: ReturnType<typeof setTimeout>;
    private intentionalStop = false;
    private onQRCode?: (qr: string) => void;
    private onMessage?: (m: MessagesUpsertEvent) => void;
    private onStatusUpdate?: (status: string) => void;
    private onLidMapping?: (mapping: { lid: string; pn: string }) => void | Promise<void>;
    private lastRemoteJid: string | null = null;
    private qrWasShown = false;
    private boundGroupJid: string | null = null;
    private groupMetadataCache: Map<string, { id: string; subject: string; participants: Array<{ id: string }> }> = new Map();
    private nextRetryAt?: string;
    private connectedSince?: string;
    private instanceOwnershipCheck: () => boolean = () => true;
    private acquireInstanceOwnership: () => Promise<void> = async () => {};
    private readonly processStartedAt = new Date().toISOString();

    constructor(
        sessionManager: SessionManager,
        private readonly connectionJournal = new ConnectionEventJournal()
    ) {
        this.sessionManager = sessionManager;
        this.messageSender = new MessageSender(this);
    }

    public setGroupBinding(groupJid: string) {
        this.boundGroupJid = groupJid;
    }

    public getBoundGroupJid(): string | null {
        return this.boundGroupJid;
    }

    public getStatus(): SessionStatus {
        return this.sessionManager.getStatus();
    }

    public getEffectiveStatus(): SessionStatus {
        const status = this.sessionManager.getStatus();
        if (status === 'connected' && !this.socket) {
            return 'disconnected';
        }

        return status;
    }

    public async recordLifecycleEvent(event: NewConnectionLifecycleEvent): Promise<void> {
        try {
            await this.connectionJournal.record(event);
        } catch (error) {
            console.error('[WhatsApp-Pi] Failed to record connection lifecycle event:', error);
        }
    }

    public async getDiagnostics(): Promise<WhatsAppDiagnostics> {
        const lifecycleEvents = await this.connectionJournal.readRecent(100);
        const recentEvents = lifecycleEvents.slice(-12);
        const lastDisconnect = [...lifecycleEvents].reverse().find(event => event.type === 'connection-close');
        const status = this.getEffectiveStatus();

        return {
            status,
            authStatePresent: await this.sessionManager.isRegistered(),
            instanceLockOwned: this.instanceOwnershipCheck(),
            operatorActionRequired: status === 'reauth-required' || status === 'connection-conflict',
            reconnectAttempts: this.reconnectAttempts,
            ...(this.nextRetryAt ? { nextRetryAt: this.nextRetryAt } : {}),
            ...(this.connectedSince ? { connectedSince: this.connectedSince } : {}),
            processStartedAt: this.processStartedAt,
            processUptimeSeconds: Math.round(process.uptime()),
            eventLogPath: this.connectionJournal.getPath(),
            ...(lastDisconnect ? { lastDisconnect } : {}),
            recentEvents
        };
    }

    public setInstanceOwnershipHandlers(
        check: () => boolean,
        acquire: () => Promise<void>
    ) {
        this.instanceOwnershipCheck = check;
        this.acquireInstanceOwnership = acquire;
    }

    private async ensureInstanceOwnership() {
        if (!this.instanceOwnershipCheck()) {
            await this.acquireInstanceOwnership();
        }
        if (!this.instanceOwnershipCheck()) {
            throw new Error('This Pi process does not own the WhatsApp auth lock. Stop the other router instance before connecting or changing credentials.');
        }
    }

    public setIncomingMessageRecorder(callback: (message: IncomingMessage) => void | Promise<void>) {
        this.onIncomingMessageRecorded = callback;
    }

    public getSocket(): WhatsAppSocketLike | undefined {
        return this.socket;
    }

    public isVerbose(): boolean {
        return this.verboseMode;
    }

    public setVerboseMode(verbose: boolean) {
        this.verboseMode = verbose;
        if (verbose) {
            this.restoreBaileysConsoleFilter?.();
            this.restoreBaileysConsoleFilter = undefined;
        }
    }

    private normalizeContactNumber(value: string): string {
        if (value.startsWith('+')) {
            return value;
        }

        if (/^\d+$/.test(value)) {
            return `+${value}`;
        }

        return value;
    }

    private getConversationSenderId(remoteJid: string): string {
        if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@lid')) {
            return remoteJid;
        }

        return this.normalizeContactNumber(remoteJid.split('@')[0]);
    }

    private getDirectSenderCandidates(message: IncomingMessageLike, remoteJid: string): string[] {
        const rawCandidates = [
            remoteJid,
            message.key.remoteJidAlt,
            message.key.senderPn,
            message.key.senderLid,
            message.key.previousRemoteJid,
        ];
        const candidates = new Set<string>();

        for (const raw of rawCandidates) {
            if (!raw) continue;
            const normalizedJid = this.normalizeRecipientJid(raw);
            candidates.add(this.getConversationSenderId(normalizedJid));
        }

        return [...candidates];
    }

    private normalizeRecipientJid(jid: string): string {
        if (jid.includes('@')) {
            const [localPart, domain = ''] = jid.split('@');
            const normalizedLocal = localPart.split(':')[0].replace(/^\+/, '');
            return domain ? `${normalizedLocal}@${domain}` : normalizedLocal;
        }
        const digits = jid.startsWith('+') ? jid.slice(1) : jid;
        return `${digits}@s.whatsapp.net`;
    }

    private isDirectPhoneJid(jid: string): boolean {
        return jid.endsWith('@s.whatsapp.net');
    }

    private isLidJid(jid: string): boolean {
        return jid.endsWith('@lid');
    }

    private async getMappedLidForPhoneJid(phoneJid: string): Promise<string | undefined> {
        const lid = await this.socket?.signalRepository?.lidMapping?.getLIDForPN(phoneJid);
        return lid && this.isLidJid(lid) ? this.normalizeRecipientJid(lid) : undefined;
    }

    private async resolveLidPreferredRecipientJid(recipient: string): Promise<string> {
        const normalized = this.resolveOutboundRecipientJid(recipient);
        if (SessionManager.isGroupJid(normalized) || this.isLidJid(normalized)) {
            return normalized;
        }

        if (!this.isDirectPhoneJid(normalized)) {
            return normalized;
        }

        try {
            const mappedLid = await this.getMappedLidForPhoneJid(normalized);
            if (mappedLid) {
                fileLog(`Resolved outbound ${normalized} to LID ${mappedLid}`);
                return mappedLid;
            }
        } catch (error) {
            fileLog(`Failed to resolve LID for ${normalized}: ${error instanceof Error ? error.message : String(error)}`);
        }

        return normalized;
    }

    public async storeLidPnMapping(lid: string, pn: string): Promise<void> {
        const lidJid = this.normalizeRecipientJid(lid);
        const pnJid = this.normalizeRecipientJid(pn);
        if (!this.isLidJid(lidJid) || !this.isDirectPhoneJid(pnJid)) {
            return;
        }

        try {
            await this.socket?.signalRepository?.lidMapping?.storeLIDPNMappings([{ lid: lidJid, pn: pnJid }]);
            fileLog(`Stored LID mapping ${pnJid} -> ${lidJid}`);
        } catch (error) {
            fileLog(`Failed to store LID mapping ${pnJid} -> ${lidJid}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    public resolveOutboundRecipientJid(recipient: string): string {
        if (SessionManager.isGroupJid(recipient)) {
            return recipient;
        }

        const senderNumber = this.normalizeContactNumber(recipient.split('@')[0]);
        const allowedContact = this.sessionManager.getAllowedContact(recipient)
            ?? this.sessionManager.getAllowedContact(senderNumber);

        if (allowedContact?.sendNumber) {
            return this.normalizeRecipientJid(allowedContact.sendNumber);
        }

        return this.normalizeRecipientJid(recipient);
    }

    private normalizeJidForComparison(jid: string): string {
        const [localPart, domain = ''] = jid.split('@');
        const normalizedLocal = localPart.split(':')[0];
        return domain ? `${normalizedLocal}@${domain}` : normalizedLocal;
    }

    private getAgentJidCandidates(): string[] {
        const user = this.socket?.user;
        const rawJids = [
            user?.id,
            user?.lid,
            this.sessionManager.getOperatorJid()
        ].filter((jid): jid is string => Boolean(jid));
        const candidates = new Set<string>();

        for (const jid of rawJids) {
            candidates.add(this.normalizeJidForComparison(jid));
        }

        return [...candidates];
    }

    private getMentionedJids(message: IncomingMessageContent | undefined): string[] {
        let content: any = message;

        for (let depth = 0; depth < 5 && content; depth++) {
            const extracted = extractMessageContent(content) ?? content;
            const nested = extracted?.ephemeralMessage?.message
                || extracted?.viewOnceMessage?.message
                || extracted?.viewOnceMessageV2?.message
                || extracted?.viewOnceMessageV2Extension?.message;
            if (nested) {
                content = nested;
                continue;
            }
            content = extracted;
            break;
        }

        if (!content || typeof content !== 'object') {
            return [];
        }

        const mentioned = new Set<string>();
        for (const value of [content, ...Object.values(content)]) {
            if (!value || typeof value !== 'object') continue;
            const contextInfo = (value as IncomingMessageWithContext).contextInfo;
            for (const jid of contextInfo?.mentionedJid ?? []) {
                if (typeof jid === 'string' && jid.trim()) {
                    mentioned.add(jid);
                }
            }
        }
        return [...mentioned];
    }

    private addJidCandidate(candidates: Set<string>, jid: string | null | undefined) {
        if (!jid) return;
        candidates.add(this.normalizeJidForComparison(jid));
    }

    private async getAgentMentionJidCandidates(): Promise<Set<string>> {
        const candidates = new Set(this.getAgentJidCandidates());
        const mapping = this.socket?.signalRepository?.lidMapping;
        if (!mapping) {
            return candidates;
        }

        const rawJids = [
            this.socket?.user?.id,
            this.socket?.user?.lid,
            this.sessionManager.getOperatorJid()
        ].filter((jid): jid is string => Boolean(jid));

        for (const rawJid of rawJids) {
            const jid = this.normalizeRecipientJid(rawJid);
            try {
                if (this.isDirectPhoneJid(jid)) {
                    this.addJidCandidate(candidates, await mapping.getLIDForPN(jid));
                } else if (this.isLidJid(jid)) {
                    this.addJidCandidate(candidates, await mapping.getPNForLID(jid));
                }
            } catch (error) {
                if (this.isVerbose()) {
                    console.error('[WhatsApp-Pi] Failed to resolve agent mention identity:', error);
                }
            }
        }

        return candidates;
    }

    private async isAgentMentioned(message: IncomingMessageContent | undefined): Promise<boolean> {
        const agentJids = await this.getAgentMentionJidCandidates();
        if (agentJids.size === 0) {
            return false;
        }

        return this.getMentionedJids(message).some((jid) =>
            agentJids.has(this.normalizeJidForComparison(jid))
        );
    }

    private async shouldRouteGroupMessage(message: IncomingMessageContent | undefined): Promise<boolean> {
        return this.sessionManager.getGroupReplyMode() === 'all' || await this.isAgentMentioned(message);
    }

    private getDisconnectStatusCode(error: unknown): number | undefined {
        if (!error || typeof error !== 'object') {
            return undefined;
        }

        const candidate = error as BoomLikeError;
        return candidate.output?.statusCode;
    }

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        if (typeof error === 'object' && error !== null && 'message' in error) {
            const candidate = error as { message?: unknown };
            return typeof candidate.message === 'string' ? candidate.message : '';
        }

        return '';
    }

    private clearReconnectTimeout() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
    }

    private getReconnectDelayMs(): number {
        const delay = WhatsAppService.INITIAL_RECONNECT_DELAY_MS * (2 ** Math.max(0, this.reconnectAttempts - 1));
        return Math.min(delay, WhatsAppService.MAX_RECONNECT_DELAY_MS);
    }

    private async scheduleReconnect(options: WhatsAppStartOptions) {
        if (this.intentionalStop) return;
        this.isReconnecting = true;
        this.reconnectAttempts++;
        const delay = this.getReconnectDelayMs();
        this.nextRetryAt = new Date(Date.now() + delay).toISOString();
        const previousState = this.sessionManager.getStatus();
        await this.sessionManager.setStatus('reconnecting');
        this.onStatusUpdate?.(t('service.whatsapp.reconnecting'));
        await this.recordLifecycleEvent({
            type: 'reconnect-scheduled',
            state: 'reconnecting',
            previousState,
            classification: 'transient',
            action: 'reconnect',
            reason: 'retry-with-backoff',
            reconnectAttempt: this.reconnectAttempts,
            nextRetryAt: this.nextRetryAt,
            authStatePresent: await this.sessionManager.isRegistered()
        });
        this.clearReconnectTimeout();
        this.reconnectTimeout = setTimeout(() => {
            void (async () => {
                this.isReconnecting = false;
                this.nextRetryAt = undefined;
                if (this.intentionalStop) return;
                try {
                    await this.start(options);
                } catch {
                    if (!this.intentionalStop) {
                        await this.scheduleReconnect(options);
                    }
                }
            })();
        }, delay);
    }

    private cleanupSocket() {
        this.clearReconnectTimeout();

        if (!this.socket) {
            return;
        }

        this.restoreBaileysConsoleFilter?.();
        this.restoreBaileysConsoleFilter = undefined;
        this.socket.ev.removeAllListeners('connection.update');
        this.socket.ev.removeAllListeners('creds.update');
        this.socket.ev.removeAllListeners('messages.upsert');
        this.socket.ev.removeAllListeners('lid-mapping.update');
        this.socket.ev.removeAllListeners('chats.phoneNumberShare');
        this.socket.ev.removeAllListeners('messages.update');
        this.socket.ev.removeAllListeners('message-receipt.update');

        try {
            this.socket.end(undefined);
        } catch {
            // Best-effort cleanup
        }

        this.socket = undefined;
    }

    private setSocket(socket: WhatsAppSocketLike) {
        this.socket = socket;
    }

    private registerSocketListeners(socket: WhatsAppSocketLike, options: WhatsAppStartOptions, saveCreds: () => Promise<void>) {
        socket.ev.on('creds.update', async () => {
            // A creds file also exists during QR pairing with registered=false.
            // Only connection-open marks the session as registered.
            await saveCreds();
        });

        socket.ev.on('connection.update', async (update) => {
            await this.handleConnectionUpdate(update, options);
        });

        socket.ev.on('messages.upsert', (payload) => {
            void this.handleIncomingMessages(payload);
        });

        socket.ev.on('lid-mapping.update', (payload: LidMappingPayload) => {
            void this.handleLidMappingUpdate(payload);
        });

        socket.ev.on('chats.phoneNumberShare', (payload: PhoneNumberSharePayload) => {
            void this.handlePhoneNumberShare(payload);
        });

        socket.ev.on('messages.update', (payload: MessageUpdatePayload[]) => {
            this.logMessageUpdates(payload);
        });

        socket.ev.on('message-receipt.update', (payload: MessageReceiptPayload[]) => {
            this.logMessageReceipts(payload);
        });
    }

    private async handleLidMappingUpdate(payload: LidMappingPayload) {
        const lid = payload?.lid ? this.normalizeRecipientJid(payload.lid) : undefined;
        const pn = payload?.pn ? this.normalizeRecipientJid(payload.pn) : undefined;
        if (!lid || !pn || !this.isLidJid(lid) || !this.isDirectPhoneJid(pn)) {
            return;
        }

        fileLog(`LID mapping update ${pn} -> ${lid}`);
        await this.onLidMapping?.({ lid, pn });
    }

    private async handlePhoneNumberShare(payload: PhoneNumberSharePayload) {
        const lid = payload?.lid ? this.normalizeRecipientJid(payload.lid) : undefined;
        const pn = payload?.jid ? this.normalizeRecipientJid(payload.jid) : undefined;
        if (!lid || !pn || !this.isLidJid(lid) || !this.isDirectPhoneJid(pn)) {
            return;
        }

        await this.storeLidPnMapping(lid, pn);
        await this.onLidMapping?.({ lid, pn });
    }

    private logMessageUpdates(payload: MessageUpdatePayload[] | undefined) {
        for (const item of payload ?? []) {
            const jid = item.key?.remoteJid;
            const id = item.key?.id;
            const status = item.update?.status;
            if (jid || id || status !== undefined) {
                fileLog(`Message update jid=${jid ?? 'unknown'} id=${id ?? 'unknown'} status=${String(status)}`);
            }
        }
    }

    private logMessageReceipts(payload: MessageReceiptPayload[] | undefined) {
        for (const item of payload ?? []) {
            const jid = item.key?.remoteJid;
            const id = item.key?.id;
            if (jid || id) {
                fileLog(`Message receipt jid=${jid ?? 'unknown'} id=${id ?? 'unknown'}`);
            }
        }
    }

    private async createSocket(): Promise<WhatsAppSocketLike> {
        const { state, saveCreds } = await this.sessionManager.getAuthState();
        this.saveCreds = saveCreds;
        const { version } = await fetchLatestBaileysVersion();

        const logger = P({ level: this.verboseMode ? 'trace' : 'silent' });

        const groupMetadataCache = this.groupMetadataCache;

        const socket = makeWASocket({
            version,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            syncFullHistory: false,
            logger,
            cachedGroupMetadata: async (jid: string) => {
                return groupMetadataCache.get(jid) as any;
            }
        }) as WhatsAppSocketLike;

        return socket;
    }

    async start(options: WhatsAppStartOptions = {}) {
        await this.ensureInstanceOwnership();
        this.intentionalStop = false;
        if (this.isReconnecting) return;

        const previousState = this.sessionManager.getStatus();
        await this.sessionManager.setStatus('connecting');
        this.onStatusUpdate?.(t('service.whatsapp.connecting'));
        await this.recordLifecycleEvent({
            type: 'connection-start',
            state: 'connecting',
            previousState,
            action: 'none',
            reason: 'socket-start-requested',
            authStatePresent: await this.sessionManager.isRegistered()
        });

        this.cleanupSocket();

        const originalConsoleLog = console.log;
        const originalConsoleWarn = console.warn;
        const originalConsoleError = console.error;
        let socketInitialized = false;

        if (!this.verboseMode) {
            console.log = () => {};
            console.warn = () => {};
            console.error = () => {};
        }

        try {
            const socket = await this.createSocket();
            this.setSocket(socket);
            this.registerSocketListeners(socket, options, this.saveCreds ?? (async () => {}));
            socketInitialized = true;
        } catch (error) {
            await this.sessionManager.setStatus('disconnected');
            await this.recordLifecycleEvent({
                type: 'connection-start-failed',
                state: 'disconnected',
                previousState: 'connecting',
                classification: 'unknown',
                action: 'reconnect',
                reason: 'socket-start-failed',
                error: this.getErrorMessage(error),
                authStatePresent: await this.sessionManager.isRegistered()
            });
            throw error;
        } finally {
            if (!this.verboseMode) {
                console.log = originalConsoleLog;
                console.warn = originalConsoleWarn;
                console.error = originalConsoleError;
                if (socketInitialized) {
                    this.restoreBaileysConsoleFilter = installBaileysConsoleFilter(this.verboseMode);
                }
            }
        }
    }

    private async handleConnectionUpdate(update: ConnectionUpdateEvent, options: WhatsAppStartOptions) {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            await this.handlePairingQr(qr);
        }

        if (connection === 'close') {
            await this.handleConnectionClosed(lastDisconnect, options);
            return;
        }

        if (connection === 'open') {
            await this.handleConnectionOpen();
        }
    }

    private async handlePairingQr(qr: string) {
        const previousState = this.sessionManager.getStatus();
        await this.sessionManager.setStatus('pairing');
        await this.recordLifecycleEvent({
            type: 'pairing-qr-issued',
            state: 'pairing',
            previousState,
            action: 'none',
            reason: 'new-pairing-qr',
            authStatePresent: await this.sessionManager.isRegistered()
        });
        this.onQRCode?.(qr);
        this.onStatusUpdate?.(t('service.whatsapp.typeToConnect'));
        this.qrWasShown = true;
    }

    private async handleConnectionOpen() {
        if (this.verboseMode) {
            console.log(t('service.whatsapp.connectionOpened'));
        }

        const previousState = this.sessionManager.getStatus();
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.nextRetryAt = undefined;
        this.connectedSince = new Date().toISOString();
        this.clearReconnectTimeout();
        await this.saveCreds?.();
        await this.sessionManager.markAuthStateAvailable();
        await this.sessionManager.setStatus('connected');
        await this.recordLifecycleEvent({
            type: 'connection-open',
            state: 'connected',
            previousState,
            action: 'none',
            reason: 'socket-opened',
            authStatePresent: true
        });
        this.onStatusUpdate?.(t('service.whatsapp.connected'));

        if (this.qrWasShown) {
            this.qrWasShown = false;
            console.log(t('service.whatsapp.qrConnected'));
            console.log(t('service.whatsapp.qrWelcomeMessage'));
            void this.sendQrWelcome();
        }
    }

    private async sendQrWelcome(): Promise<void> {
        const rawId = this.socket?.user?.id;
        if (!rawId) return;
        const selfJid = this.normalizeJidForComparison(rawId);
        await this.sessionManager.setOperatorJid(selfJid);
        try {
            await this.socket?.sendMessage(selfJid, { text: t('service.whatsapp.qrWelcomeMessage') });
        } catch {
            // Best-effort — welcome send failure must not abort the session.
        }
    }

    public getOperatorJid(): string {
        const liveJid = this.socket?.user?.id || this.socket?.user?.lid;
        return liveJid
            ? this.normalizeJidForComparison(liveJid)
            : this.sessionManager.getOperatorJid();
    }

    private async handleConnectionClosed(
        lastDisconnect: LastDisconnectLike | undefined,
        options: WhatsAppStartOptions
    ) {
        const previousState = this.sessionManager.getStatus();
        const statusCode = this.getDisconnectStatusCode(lastDisconnect?.error);
        const errorMessage = this.getErrorMessage(lastDisconnect?.error);
        const decision = classifyDisconnect(statusCode, errorMessage, this.intentionalStop);
        const authStatePresent = await this.sessionManager.isRegistered();
        const nextState = decision.classification === 'intentional'
            ? 'stopped'
            : decision.classification === 'reauth-required'
                ? 'reauth-required'
                : decision.classification === 'connection-conflict'
                    ? 'connection-conflict'
                    : 'disconnected';

        await this.recordLifecycleEvent({
            type: 'connection-close',
            state: nextState,
            previousState,
            classification: decision.classification,
            action: decision.action,
            statusCode,
            reason: decision.reason,
            error: errorMessage,
            reconnectAttempt: this.reconnectAttempts,
            authStatePresent,
            intentional: this.intentionalStop
        });

        if (decision.classification === 'intentional') {
            return;
        }

        this.connectedSince = undefined;
        if (this.verboseMode) {
            console.error(t('service.whatsapp.connectionClosed', {
                statusCode: statusCode ?? 'unknown',
                shouldReconnect: String(decision.action === 'reconnect')
            }));
        }

        if (decision.classification === 'reauth-required') {
            this.cleanupSocket();
            this.isReconnecting = false;
            this.reconnectAttempts = 0;
            this.nextRetryAt = undefined;
            await this.sessionManager.setStatus('reauth-required');
            this.onStatusUpdate?.(t('service.whatsapp.reauthRequired'));
            return;
        }

        if (decision.classification === 'connection-conflict') {
            this.cleanupSocket();
            this.isReconnecting = false;
            this.reconnectAttempts = 0;
            this.nextRetryAt = undefined;
            await this.sessionManager.setStatus('connection-conflict');
            this.onStatusUpdate?.(t('service.whatsapp.conflict'));
            return;
        }

        if (!this.isReconnecting) {
            await this.saveCreds?.();
            this.cleanupSocket();
            await this.scheduleReconnect(options);
        }
    }

    private extractText(message: IncomingMessageContent | undefined): string {
        return message?.conversation || message?.extendedTextMessage?.text || '';
    }

    private getIncomingTimestamp(timestamp: number | string | undefined): number {
        if (typeof timestamp === 'number') {
            return timestamp;
        }

        if (typeof timestamp === 'string') {
            const parsed = Number(timestamp);
            return Number.isFinite(parsed) ? parsed : Date.now();
        }

        return Date.now();
    }

    private async recordIncomingMessage(message: IncomingMessageLike, remoteJid: string, text: string) {
        const isGroup = remoteJid.endsWith('@g.us');
        const rawParticipantJid = isGroup
            ? message.key.participantAlt || message.key.participant
            : undefined;
        const participantJid = rawParticipantJid
            ? this.normalizeRecipientJid(rawParticipantJid)
            : undefined;

        void Promise.resolve(this.onIncomingMessageRecorded?.({
            id: message.key.id ?? remoteJid,
            remoteJid,
            pushName: message.pushName || undefined,
            ...(participantJid ? { participantJid } : {}),
            ...(isGroup && message.pushName ? { participantName: message.pushName } : {}),
            text,
            timestamp: this.getIncomingTimestamp(message.messageTimestamp)
        })).catch(error => {
            if (this.verboseMode) {
                console.error(t('service.whatsapp.failedRecordRecentMessage'), error);
            }
        });
    }

    private shouldRecordIgnoredMessages(): boolean {
        return process.env.WHATSAPP_ROUTER_RECORD_IGNORED === 'true';
    }

    public async handleIncomingMessages(payload: MessagesUpsertEvent) {
        if (this.sessionManager.getStatus() !== 'connected') return;

        const message = payload.messages?.[0];
        if (!message || !message.key.remoteJid) return;
        if (message.key.fromMe) return;

        const text = this.extractText(message.message);

        const remoteJid = message.key.remoteJid;
        const isGroup = remoteJid.endsWith('@g.us');

        if (this.boundGroupJid) {
            // Group-only mode narrows the source before allow-list checks run.
            if (remoteJid !== this.boundGroupJid) return;
        }

        // Eagerly cache group metadata on incoming messages so it's
        // available for sender-key encryption when we reply
        if (isGroup) {
            void this.prepareGroupSession(remoteJid);
        }

        const senderCandidates = isGroup
            ? [this.getConversationSenderId(remoteJid)]
            : this.getDirectSenderCandidates(message, remoteJid);
        const senderJid = senderCandidates[0] ?? this.getConversationSenderId(remoteJid);

        const pushName = message.pushName || undefined;

        if (this.boundGroupJid) {
            if (!this.sessionManager.isAllowedGroup(this.boundGroupJid)) {
                if (this.shouldRecordIgnoredMessages()) {
                    void this.recordIncomingMessage(message, remoteJid, text);
                }
                await this.sessionManager.trackIgnoredNumber(this.boundGroupJid, pushName);
                return;
            }

            if (!await this.shouldRouteGroupMessage(message.message)) {
                if (this.isVerbose()) {
                    console.log(t('service.whatsapp.ignoredGroupWithoutMention', { groupJid: remoteJid }));
                }
                void this.recordIncomingMessage(message, remoteJid, text);
                return;
            }

            void this.recordIncomingMessage(message, remoteJid, text);
            this.lastRemoteJid = remoteJid;
            this.onMessage?.(payload);
            return;
        }

        if (!senderCandidates.some(candidate => this.sessionManager.isConversationAllowed(candidate))) {
            if (this.isVerbose()) {
                console.log(t('service.whatsapp.ignoredNotAllowed', { senderJid }));
            }
            if (this.shouldRecordIgnoredMessages()) {
                void this.recordIncomingMessage(message, remoteJid, text);
            }
            await this.sessionManager.trackIgnoredNumber(senderJid, pushName);
            return;
        }

        if (isGroup && !await this.shouldRouteGroupMessage(message.message)) {
            if (this.isVerbose()) {
                console.log(t('service.whatsapp.ignoredGroupWithoutMention', { groupJid: remoteJid }));
            }
            void this.recordIncomingMessage(message, remoteJid, text);
            return;
        }

        void this.recordIncomingMessage(message, remoteJid, text);
        this.lastRemoteJid = remoteJid;
        this.onMessage?.(payload);
    }

    setQRCodeCallback(callback: (qr: string) => void) {
        this.onQRCode = callback;
    }

    setMessageCallback(callback: (m: MessagesUpsertEvent) => void) {
        this.onMessage = callback;
    }

    setStatusCallback(callback: (status: string) => void) {
        this.onStatusUpdate = callback;
    }

    setLidMappingCallback(callback: (mapping: { lid: string; pn: string }) => void | Promise<void>) {
        this.onLidMapping = callback;
    }

    public getLastRemoteJid(): string | null {
        return this.lastRemoteJid;
    }

    private getActiveSocket(): WhatsAppSocketLike | null {
        if (!this.socket || this.getStatus() !== 'connected') {
            return null;
        }

        return this.socket;
    }

    /**
     * Pre-loads group metadata into the cache for Baileys' cachedGroupMetadata.
     * This ensures Baileys can resolve group participants for Signal
     * sender-key encryption, preventing "No sessions" errors.
     */
    public async prepareGroupSession(jid: string): Promise<void> {
        if (!jid.endsWith('@g.us')) return;
        if (this.groupMetadataCache.has(jid)) {
            fileLog(`Group metadata cache HIT for ${jid}`);
            return;
        }
        const socket = this.getActiveSocket();
        if (!socket) return;
        try {
            fileLog(`Fetching group metadata for ${jid}...`);
            const metadata = await socket.groupMetadata(jid);
            this.groupMetadataCache.set(jid, metadata);
            fileLog(`Cached group metadata for ${jid} (${metadata.participants?.length ?? 0} participants)`);
        } catch (error) {
            fileLog(`FAILED to fetch group metadata for ${jid}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async sendMessage(jid: string, text: string) {
        const recipientJid = await this.resolveLidPreferredRecipientJid(jid);

        // Ensure we show the typing indicator before sending
        await this.sendPresence(recipientJid, 'composing');

        const result = await this.messageSender.send({
            recipientJid,
            text: text
        });

        // After sending, we can stop the typing indicator
        await this.sendPresence(recipientJid, 'paused');

        if (!result.success) {
            console.error(t('service.whatsapp.failedSendMessage', { jid: recipientJid, error: result.error ?? t('message.sender.unknownError') }));
        }

        return result;
    }

    async sendVoiceMessage(jid: string, audioPath: string) {
        const recipientJid = await this.resolveLidPreferredRecipientJid(jid);
        const socket = this.getActiveSocket();

        if (!socket) {
            return {
                success: false,
                error: t('service.whatsapp.notConnected'),
                attempts: 0,
                recipientJid
            };
        }

        try {
            await this.sendPresence(recipientJid, 'recording');
            await this.prepareGroupSession(recipientJid);
            const response = await socket.sendMessage(recipientJid, {
                audio: { url: audioPath },
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            });

            return {
                success: true,
                messageId: response?.key?.id,
                attempts: 1,
                recipientJid
            };
        } catch (error) {
            console.error(t('service.whatsapp.failedSendVoiceMessage', {
                jid: recipientJid,
                error: error instanceof Error ? error.message : String(error)
            }));
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                attempts: 1,
                recipientJid
            };
        } finally {
            await this.sendPresence(recipientJid, 'paused');
        }
    }

    async sendImageMessage(
        jid: string,
        imagePath: string,
        mimeType: WhatsAppImageMimeType,
        caption?: string
    ) {
        const recipientJid = await this.resolveLidPreferredRecipientJid(jid);
        const socket = this.getActiveSocket();

        if (!socket) {
            return {
                success: false,
                error: t('service.whatsapp.notConnected'),
                attempts: 0,
                recipientJid
            };
        }

        try {
            await this.sendPresence(recipientJid, 'composing');
            await this.prepareGroupSession(recipientJid);
            const response = await socket.sendMessage(recipientJid, {
                image: { url: imagePath },
                mimetype: mimeType,
                ...(caption ? { caption } : {})
            });

            return {
                success: true,
                messageId: response?.key?.id,
                attempts: 1,
                recipientJid
            };
        } catch (error) {
            console.error(t('service.whatsapp.failedSendImageMessage', {
                jid: recipientJid,
                error: error instanceof Error ? error.message : String(error)
            }));
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                attempts: 1,
                recipientJid
            };
        } finally {
            await this.sendPresence(recipientJid, 'paused');
        }
    }

    async sendMenuMessage(jid: string, text: string) {
        const normalizedJid = await this.resolveLidPreferredRecipientJid(jid);
        const socket = this.getActiveSocket();

        if (!socket) {
            return {
                success: false,
                error: t('service.whatsapp.notConnected'),
                attempts: 0
            };
        }

        try {
            await this.sendPresence(normalizedJid, 'composing');
            const response = await socket.sendMessage(normalizedJid, { text });
            await this.sendPresence(normalizedJid, 'paused');

            return {
                success: true,
                messageId: response?.key?.id,
                attempts: 1,
                recipientJid: normalizedJid
            };
        } catch (error: unknown) {
            await this.sendPresence(normalizedJid, 'paused');
            console.error(t('service.whatsapp.failedSendMenuMessage', { jid: normalizedJid }), error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                attempts: 1,
                recipientJid: normalizedJid
            };
        }
    }

    async sendPresence(jid: string, presence: 'composing' | 'recording' | 'paused') {
        const socket = this.getActiveSocket();
        if (!socket) return;
        try {
            await socket.sendPresenceUpdate(presence, jid);
        } catch (error) {
            if (this.verboseMode) {
                console.error(t('service.whatsapp.failedPresenceUpdate', { jid }), error);
            }
        }
    }

    async markRead(jid: string, messageId: string, fromMe: boolean = false) {
        const socket = this.getActiveSocket();
        if (!socket) return;
        try {
            await socket.readMessages([{ remoteJid: jid, id: messageId, fromMe }]);
        } catch (error) {
            if (this.verboseMode) {
                console.error(t('service.whatsapp.failedMarkRead'), error);
            }
        }
    }

    async resetAndStartPairing(reason = 'operator-request'): Promise<{ quarantinePath?: string }> {
        await this.ensureInstanceOwnership();
        const previousState = this.sessionManager.getStatus();
        this.intentionalStop = true;
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.nextRetryAt = undefined;
        this.connectedSince = undefined;
        this.cleanupSocket();

        const quarantinePath = await this.sessionManager.quarantineAuthState(reason);
        await this.recordLifecycleEvent({
            type: 'auth-state-quarantined',
            state: 'reauth-required',
            previousState,
            action: 'pair-new-device',
            reason,
            authStatePresent: false,
            intentional: true
        });

        this.intentionalStop = false;
        await this.start({ allowPairingOnAuthFailure: true });
        return { ...(quarantinePath ? { quarantinePath } : {}) };
    }

    async logout() {
        await this.ensureInstanceOwnership();
        const previousState = this.sessionManager.getStatus();
        this.intentionalStop = true;
        let remoteLogoutError: string | undefined;
        let localDeleteError: string | undefined;

        try {
            await this.socket?.logout();
        } catch (error) {
            remoteLogoutError = this.getErrorMessage(error);
        } finally {
            this.cleanupSocket();
            this.isReconnecting = false;
            this.reconnectAttempts = 0;
            this.nextRetryAt = undefined;
            this.connectedSince = undefined;
            try {
                await this.sessionManager.deleteAuthState();
            } catch (error) {
                localDeleteError = this.getErrorMessage(error);
            }
        }

        await this.recordLifecycleEvent({
            type: localDeleteError ? 'auth-state-delete-failed' : 'auth-state-deleted',
            state: localDeleteError ? 'reauth-required' : 'logged-out',
            previousState,
            classification: localDeleteError ? 'unknown' : 'intentional',
            action: localDeleteError ? 'pair-new-device' : 'none',
            reason: localDeleteError ? 'local-credential-delete-failed' : 'operator-logout',
            ...((localDeleteError || remoteLogoutError) ? { error: localDeleteError || remoteLogoutError } : {}),
            authStatePresent: localDeleteError ? await this.sessionManager.isRegistered() : false,
            intentional: true
        });

        if (localDeleteError) {
            throw new Error(`Failed to delete local WhatsApp credentials: ${localDeleteError}`);
        }
        this.onStatusUpdate?.(t('service.whatsapp.loggedOut'));
    }

    async stop() {
        const previousState = this.sessionManager.getStatus();
        this.intentionalStop = true;
        try {
            await this.saveCreds?.();
        } catch (error) {
            if (this.verboseMode) {
                console.error(t('service.whatsapp.failedPersistAuthState'), error);
            }
        }

        this.cleanupSocket();
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.nextRetryAt = undefined;
        this.connectedSince = undefined;
        await this.sessionManager.setStatus('stopped');
        await this.recordLifecycleEvent({
            type: 'connection-stop',
            state: 'stopped',
            previousState,
            classification: 'intentional',
            action: 'none',
            reason: 'extension-stop',
            authStatePresent: await this.sessionManager.isRegistered(),
            intentional: true
        });
        this.onStatusUpdate?.(t('service.whatsapp.disconnected'));
    }
}
