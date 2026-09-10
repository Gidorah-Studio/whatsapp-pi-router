import { readFile } from 'fs/promises';
import { atomicWritePrivate, isMissingFile, SerialQueue } from './private-storage.js';
import { createStoragePaths, ensureStorageDirectories as ensureStorageRoots, migrateLegacyStorage } from './storage-path.js';
import type {
    MessageDirection,
    RecentConversationMessage,
    RecentConversationSummary,
    RecentsStore
} from '../models/whatsapp.types.js';
import { SessionManager } from './session.manager.js';

const MAX_RECENT_CONVERSATIONS = 500;
export const MAX_MESSAGES_PER_CONVERSATION = 200;

export interface RecentsMessageInput {
    messageId: string;
    senderNumber: string;
    senderName?: string;
    participantJid?: string;
    participantName?: string;
    text: string;
    direction: MessageDirection;
    timestamp: number;
}

export class RecentsService {
    private readonly storagePaths;
    private readonly writes = new SerialQueue();
    private storageError?: Error;
    private readonly dataDir: string;
    private readonly storePath: string;
    private store: RecentsStore = {
        conversations: [],
        messagesBySender: {},
        updatedAt: Date.now()
    };

    constructor(private readonly sessionManager: SessionManager, root?: string) {
        this.storagePaths = createStoragePaths(root);
        this.dataDir = this.storagePaths.recentsDir;
        this.storePath = this.storagePaths.recentsPath;
    }

    async drain(): Promise<void> { await this.writes.drain(); }

    async ensureInitialized() {
        await ensureStorageRoots({
            root: this.storagePaths.root,
            authStateDir: this.storagePaths.authStateDir,
            recentsDir: this.dataDir,
            logDir: this.storagePaths.logDir
        });
        await migrateLegacyStorage({
            root: this.storagePaths.root,
            legacyRoot: this.storagePaths.legacyRoot
        });
        await this.loadStore();
    }

    private async loadStore() {
        try {
            const content = await readFile(this.storePath, 'utf-8');
            const parsed = JSON.parse(content) as Partial<RecentsStore>;
            if (!parsed || !Array.isArray(parsed.conversations) || !parsed.messagesBySender ||
                typeof parsed.messagesBySender !== 'object' || Array.isArray(parsed.messagesBySender)) {
                throw new Error('Invalid recents store');
            }

            this.store = {
                conversations: Array.isArray(parsed.conversations) ? parsed.conversations.slice(0, MAX_RECENT_CONVERSATIONS) : [],
                messagesBySender: parsed.messagesBySender && typeof parsed.messagesBySender === 'object'
                    ? this.normalizeMessagesMap(parsed.messagesBySender)
                    : {},
                updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()
            };

            this.rebuildConversationState();
            this.storageError = undefined;
        } catch (error) {
            if (!isMissingFile(error)) {
                this.storageError = new Error('Recents storage unavailable; existing file preserved', { cause: error });
                throw this.storageError;
            }
            this.storageError = undefined;
            this.store = {
                conversations: [],
                messagesBySender: {},
                updatedAt: Date.now()
            };
        }
    }

    private normalizeMessagesMap(messagesBySender: RecentsStore['messagesBySender']): RecentsStore['messagesBySender'] {
        const normalized: RecentsStore['messagesBySender'] = {};

        for (const [senderNumber, messages] of Object.entries(messagesBySender)) {
            if (!Array.isArray(messages)) continue;
            normalized[senderNumber] = messages
                .filter((message): message is RecentConversationMessage => this.isValidMessage(message))
                .map(message => ({ ...message, timestamp: this.normalizeTimestamp(message.timestamp) }))
                .sort((left, right) => left.timestamp - right.timestamp)
                .slice(-MAX_MESSAGES_PER_CONVERSATION);
        }

        return normalized;
    }

    private isValidMessage(message: unknown): message is RecentConversationMessage {
        return Boolean(
            message &&
            typeof message === 'object' &&
            typeof (message as RecentConversationMessage).messageId === 'string' &&
            typeof (message as RecentConversationMessage).senderNumber === 'string' &&
            ((message as RecentConversationMessage).participantJid === undefined ||
                typeof (message as RecentConversationMessage).participantJid === 'string') &&
            ((message as RecentConversationMessage).participantName === undefined ||
                typeof (message as RecentConversationMessage).participantName === 'string') &&
            typeof (message as RecentConversationMessage).text === 'string' &&
            (message as RecentConversationMessage).text.trim().length > 0 &&
            ((message as RecentConversationMessage).direction === 'incoming' || (message as RecentConversationMessage).direction === 'outgoing') &&
            typeof (message as RecentConversationMessage).timestamp === 'number'
        );
    }

    private rebuildConversationState() {
        const previousNames = new Map(
            this.store.conversations.map(conversation => [conversation.senderNumber, conversation.senderName] as const)
        );
        const summaries = new Map<string, RecentConversationSummary>();

        for (const [senderNumber, messages] of Object.entries(this.store.messagesBySender)) {
            const latestMessage = this.getLatestConversationMessage(messages);
            if (!latestMessage) continue;

            summaries.set(senderNumber, {
                senderNumber,
                senderName: previousNames.get(senderNumber),
                lastMessagePreview: this.buildPreview(latestMessage.text),
                lastMessageTime: latestMessage.timestamp,
                lastMessageDirection: latestMessage.direction,
                messageCount: messages.length,
                isAllowed: this.sessionManager.isConversationAllowed(senderNumber)
            });
        }

        this.store.conversations = this.sortConversationsByLatestMessage(Array.from(summaries.values()))
            .slice(0, MAX_RECENT_CONVERSATIONS);
    }

    private getLatestConversationMessage(messages: RecentConversationMessage[]): RecentConversationMessage | undefined {
        return messages[messages.length - 1];
    }

    private sortConversationsByLatestMessage(conversations: RecentConversationSummary[]): RecentConversationSummary[] {
        return [...conversations].sort((left, right) => {
            if (right.lastMessageTime !== left.lastMessageTime) {
                return right.lastMessageTime - left.lastMessageTime;
            }

            return left.senderNumber.localeCompare(right.senderNumber);
        });
    }

    private stripSpecialCharacters(text: string): string {
        return text
            .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200D|\uFE0F/gu, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private buildPreview(text: string): string {
        const normalized = this.stripSpecialCharacters(text);
        if (normalized.length <= 80) return normalized;
        return `${normalized.slice(0, 77)}...`;
    }

    private async persistStore() {
        this.store.updatedAt = Date.now();
        await atomicWritePrivate(this.storePath, JSON.stringify(this.store, null, 2));
    }

    private normalizeNumber(input: string): string {
        // Group and LID JIDs should be stored as-is.
        if (input.endsWith('@g.us') || input.endsWith('@lid')) return input;
        const cleaned = input.replace(/@s\.whatsapp\.net$/, '');
        if (cleaned.startsWith('+')) {
            return cleaned;
        }
        if (/^\d+$/.test(cleaned)) {
            return `+${cleaned}`;
        }
        return cleaned;
    }

    private normalizeTimestamp(timestamp: number): number {
        return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
    }

    recordMessage(input: RecentsMessageInput): Promise<void> {
        return this.writes.run(() => this.recordMessageSerialized(input));
    }

    private async recordMessageSerialized(input: RecentsMessageInput) {
        if (this.storageError) throw this.storageError;
        const senderNumber = this.normalizeNumber(input.senderNumber);
        if (!senderNumber) return;

        const normalizedTimestamp = this.normalizeTimestamp(input.timestamp);
        const normalizedText = this.stripSpecialCharacters(input.text.slice(0, 16384));
        if (!normalizedText) return;

        const existing = this.store.messagesBySender[senderNumber] ?? [];
        const participantJid = input.participantJid?.trim() || undefined;
        const participantName = input.participantName?.trim() || undefined;
        const nextMessage: RecentConversationMessage = {
            messageId: input.messageId,
            senderNumber,
            ...(participantJid ? { participantJid } : {}),
            ...(participantName ? { participantName } : {}),
            text: normalizedText,
            direction: input.direction,
            timestamp: normalizedTimestamp
        };

        const filtered = existing.filter(message => message.messageId !== nextMessage.messageId);
        filtered.push(nextMessage);

        this.store.messagesBySender[senderNumber] = filtered
            .sort((left, right) => left.timestamp - right.timestamp)
            .slice(-MAX_MESSAGES_PER_CONVERSATION);

        const latest = this.store.messagesBySender[senderNumber].at(-1)!;
        const existingConversation = this.store.conversations.find(conversation => conversation.senderNumber === senderNumber);
        const summary: RecentConversationSummary = {
            senderNumber,
            senderName: input.senderName ?? existingConversation?.senderName,
            lastMessagePreview: this.buildPreview(latest.text),
            lastMessageTime: latest.timestamp,
            lastMessageDirection: latest.direction,
            messageCount: this.store.messagesBySender[senderNumber].length,
            isAllowed: this.sessionManager.isConversationAllowed(senderNumber)
        };

        this.store.conversations = this.sortConversationsByLatestMessage([
            summary,
            ...this.store.conversations.filter(item => item.senderNumber !== senderNumber)
        ]).slice(0, MAX_RECENT_CONVERSATIONS);

        const retained = new Set(this.store.conversations.map(conversation => conversation.senderNumber));
        for (const key of Object.keys(this.store.messagesBySender)) if (!retained.has(key)) delete this.store.messagesBySender[key];
        await this.persistStore();
    }

    async getRecentConversations(): Promise<RecentConversationSummary[]> {
        if (this.storageError) throw this.storageError;
        await this.drain();
        this.rebuildConversationState();
        return [...this.store.conversations];
    }

    async getConversationHistory(senderNumber: string): Promise<RecentConversationMessage[]> {
        if (this.storageError) throw this.storageError;
        await this.drain();
        const normalizedNumber = this.normalizeNumber(senderNumber);
        const messages = this.store.messagesBySender[normalizedNumber] ?? [];
        return [...messages]
            .sort((left, right) => left.timestamp - right.timestamp)
            .slice(-MAX_MESSAGES_PER_CONVERSATION);
    }

    async hasRecentConversations(): Promise<boolean> {
        const conversations = await this.getRecentConversations();
        return conversations.length > 0;
    }
}
