import { t } from '../i18n.js';

export interface SendReactionOptions {
    jid: string;
    messageId: string;
    emoji: string;
}

export interface SendReactionResult {
    success: boolean;
    messageId?: string;
    error?: string;
}

// Socket interface that matches what we need from Baileys
interface ReactionSocket {
    sendMessage: (jid: string, content: { react: { text: string; key: { remoteJid: string; id: string; fromMe: boolean } } }) => Promise<{ key?: { id?: string | null } } | undefined>;
}

export class ReactionSender {
    constructor(private socket: ReactionSocket | null) {}

    async sendReaction(options: SendReactionOptions): Promise<SendReactionResult> {
        if (!this.socket) {
            return { success: false, error: t('service.whatsapp.notConnected') };
        }

        // Validate emoji (must be single emoji or empty string to remove)
        if (!this.isValidEmoji(options.emoji)) {
            return { success: false, error: t('tool.sendReaction.error.invalidEmoji') };
        }

        try {
            const result = await this.socket.sendMessage(options.jid, {
                react: {
                    text: options.emoji,
                    key: {
                        remoteJid: options.jid,
                        id: options.messageId,
                        fromMe: false
                    }
                }
            });

            return {
                success: true,
                messageId: result?.key?.id ?? undefined
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private isValidEmoji(emoji: string): boolean {
        // Allow empty string (removes reaction)
        if (emoji === '') return true;
        // Check if single emoji using Unicode emoji regex
        // This matches single Unicode emojis including variation selectors
        const emojiRegex = /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)$/u;
        return emojiRegex.test(emoji);
    }
}
