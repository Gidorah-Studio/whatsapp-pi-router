import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { SessionManager } from './services/session.manager.js';
import { WhatsAppService } from './services/whatsapp.service.js';
import { MenuHandler } from './ui/menu.handler.js';
import { RecentsService } from './services/recents.service.js';
import { AudioService } from './services/audio.service.js';
import { extractIncomingText } from './services/incoming-message.resolver.js';
import { IncomingMediaService } from './services/incoming-media.service.js';
import { WhatsAppPiLogger } from './services/whatsapp-pi.logger.js';
import { ReactionSender } from './services/reaction.sender.js';
import { initI18n, t } from './i18n.js';
import { loadRouterAllowConfig } from './services/router-allow.config.js';
import { IdentityMapService, isLidJid, isPhoneJid, normalizeDirectJid, type IdentityMapEntry } from './services/identity-map.service.js';
import { OutboundQueueService } from './services/outbound-queue.service.js';
import { loadResolvedChildPiConfig, type ResolvedChildPiConfig } from './services/child-pi.config.js';
import { resolveRoutedSessionLaunch, type RoutedSessionLaunch } from './services/routed-session.service.js';
import { TextToSpeechService } from './services/text-to-speech.service.js';
import {
    getDefaultResolvedVoiceReplyConfig,
    loadResolvedVoiceReplyConfig,
    type ResolvedVoiceReplyConfig,
    type VoiceReplyMode
} from './services/voice-reply.config.js';
import { buildVoiceReplyPromptLines, planVoiceReply } from './services/voice-reply.service.js';
import { createStoragePaths } from './services/storage-path.js';
import { ConnectionEventJournal } from './services/connection-lifecycle.js';
import { RouterInstanceLock, RouterInstanceLockError } from './services/router-instance-lock.js';
import {
    cleanupImageHandoff,
    createImageHandoffDirectory,
    loadImageHandoff,
    type RoutedImageHandoff
} from './services/outbound-image.service.js';

const CHILD_WHATSAPP_MEDIA_EXTENSION_PATH = fileURLToPath(
    new URL('./child-whatsapp-media.extension.ts', import.meta.url)
);

const shutdownState = globalThis as typeof globalThis & {
    __whatsappPiShutdown?: {
        installed: boolean;
        stop?: () => Promise<void>;
    };
};

const toConversationId = (remoteJid: string): string => {
    if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@lid')) {
        return remoteJid;
    }

    const localPart = remoteJid.split('@')[0].split(':')[0];
    return /^\d+$/.test(localPart) ? `+${localPart}` : remoteJid;
};

const firstNormalized = (...values: Array<string | undefined>): string | undefined => {
    for (const value of values) {
        const normalized = normalizeDirectJid(value);
        if (normalized) return normalized;
    }
    return undefined;
};

const firstLidJid = (...values: Array<string | undefined>): string | undefined => {
    for (const value of values) {
        const normalized = normalizeDirectJid(value);
        if (isLidJid(normalized)) return normalized;
    }
    return undefined;
};

const firstPhoneJid = (...values: Array<string | undefined>): string | undefined => {
    for (const value of values) {
        const normalized = normalizeDirectJid(value);
        if (isPhoneJid(normalized)) return normalized;
    }
    return undefined;
};

const formatLinkedIdentityLine = (identity?: IdentityMapEntry): string => {
    const values = [
        identity?.externalRecordId ? `externalRecordId=${identity.externalRecordId}` : undefined,
        identity?.email ? `email=${identity.email}` : undefined,
        identity?.phone ? `phone=${identity.phone}` : undefined,
    ].filter(Boolean);

    return values.length > 0
        ? `Known linked identity: ${values.join(', ')}`
        : 'Known linked identity: none';
};

const buildPrompt = (params: {
    messageHeader: string;
    text: string;
    remoteJid: string;
    replyJid: string;
    alternateJid?: string;
    isGroup: boolean;
    pushName: string;
    participant: string;
    conversationId: string;
    identity?: IdentityMapEntry;
    voiceReplyMode: VoiceReplyMode;
    incomingWasVoice: boolean;
}): string => [
    '[WhatsApp routed conversation]',
    `Conversation type: ${params.isGroup ? 'group' : 'direct'}`,
    `Conversation JID: ${params.remoteJid}`,
    `Reply JID: ${params.replyJid}`,
    ...(params.alternateJid ? [`Alternate WhatsApp JID: ${params.alternateJid}`] : []),
    `Conversation identity key: ${params.conversationId}`,
    `WhatsApp display name candidate: ${params.pushName}`,
    `Sender/participant: ${params.participant}`,
    formatLinkedIdentityLine(params.identity),
    'Identity rule: linked phone, email, and external record ID are stable lookup keys. WhatsApp display names are user-controlled weak candidates only; use them for greeting, manual/internal candidate matching, or clarifying questions, but not for silent account/contact lookup. Do not reveal private/internal record details to the WhatsApp contact unless the user explicitly asks in an internal context.',
    '',
    `${params.messageHeader} ${params.text}`,
    '',
    'Reply naturally to the WhatsApp sender. For a normal reply, return only the message text to send back. When the user requests an image, create the image file and call send_wa_image(path, caption?) instead; do not merely promise to create or send it.',
    ...buildVoiceReplyPromptLines(params.voiceReplyMode, params.incomingWasVoice),
].join('\n');

interface RoutedPiTurnResult {
    text: string;
    image?: RoutedImageHandoff;
    cleanup(): Promise<void>;
}

const runPiForConversation = async (params: {
    sessionLaunch: RoutedSessionLaunch;
    prompt: string;
    cwd: string;
    imageBuffer?: Buffer;
    imageMimeType?: string;
    childPiConfig: ResolvedChildPiConfig;
}): Promise<RoutedPiTurnResult> => {
    const piBin = process.env.WHATSAPP_PI_ROUTER_PI_BIN || 'pi';
    const args = [...params.sessionLaunch.args];
    const handoffDir = await createImageHandoffDirectory(createStoragePaths().mediaDir);

    try {
        if (params.childPiConfig.model) {
            args.push('--model', params.childPiConfig.model);
        }
        if (params.childPiConfig.thinking) {
            args.push('--thinking', params.childPiConfig.thinking);
        }
        args.push(
            '--no-extensions',
            '--extension', CHILD_WHATSAPP_MEDIA_EXTENSION_PATH,
            '--print'
        );

        if (params.imageBuffer && params.imageMimeType) {
            const ext = params.imageMimeType.includes('png') ? 'png' : params.imageMimeType.includes('webp') ? 'webp' : 'jpg';
            const dir = join(tmpdir(), 'whatsapp-pi-router');
            await mkdir(dir, { recursive: true });
            const imagePath = join(dir, `${params.sessionLaunch.route.key}-${Date.now()}.${ext}`);
            await writeFile(imagePath, params.imageBuffer);
            args.push(`@${imagePath}`);
        }

        args.push(params.prompt);

        const text = await new Promise<string>((resolve, reject) => {
            const child = spawn(piBin, args, {
                cwd: params.cwd,
                env: {
                    ...process.env,
                    WHATSAPP_PI_ROUTER_CHILD: '1',
                    WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR: handoffDir,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
                child.kill('SIGTERM');
                reject(new Error('Timed out waiting for Pi response'));
            }, Number(process.env.WHATSAPP_PI_ROUTER_TIMEOUT_MS || 10 * 60 * 1000));

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.on('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error(stderr.trim() || `pi exited with code ${code}`));
                }
            });
        });
        const image = await loadImageHandoff(handoffDir);

        return {
            text,
            ...(image ? { image } : {}),
            cleanup: () => cleanupImageHandoff(handoffDir)
        };
    } catch (error) {
        await cleanupImageHandoff(handoffDir).catch(() => undefined);
        throw error;
    }
};

export default function (pi: ExtensionAPI) {
    initI18n(pi);

    // Register verbose flag
    pi.registerFlag("verbose", {
        description: "Enable verbose mode (show Baileys trace logs)",
        type: "boolean",
        default: false
    });

    pi.registerFlag("whatsapp-pi-online", {
        description: "Enable WhatsApp-Pi on startup",
        type: "boolean",
        default: false
    });

    pi.registerFlag("whatsapp-group", {
        description: "Bind this agent to a specific WhatsApp group JID (e.g. 120363012345@g.us). When set, only messages from this group are processed.",
        type: "string",
        default: ""
    });

    const sessionManager = new SessionManager();
    const connectionJournal = new ConnectionEventJournal();
    const whatsappService = new WhatsAppService(sessionManager, connectionJournal);
    const recentsService = new RecentsService(sessionManager);
    const identityMapService = new IdentityMapService();
    const logger = new WhatsAppPiLogger(false);
    const outboundQueueService = new OutboundQueueService(whatsappService, recentsService, logger);
    const audioService = new AudioService(logger);
    const textToSpeechService = new TextToSpeechService(logger);
    const incomingMediaService = new IncomingMediaService(audioService, logger);
    const menuHandler = new MenuHandler(whatsappService, sessionManager, recentsService, identityMapService);
    let _ctx: ExtensionContext | undefined;
    let instanceLock: RouterInstanceLock | undefined;
    let routerActive = false;
    let ownershipPromise: Promise<void> | undefined;

    const acquireRouterOwnership = async () => {
        if (instanceLock?.isHeld()) return;
        if (!instanceLock) {
            throw new Error('WhatsApp router lock is not initialized yet. Wait for Pi startup to finish.');
        }
        if (ownershipPromise) {
            await ownershipPromise;
            return;
        }

        ownershipPromise = (async () => {
            let recoveredStaleLock = false;
            try {
                ({ recoveredStaleLock } = await instanceLock!.acquire());
            } catch (error) {
                const message = error instanceof RouterInstanceLockError
                    ? error.message
                    : `Could not acquire WhatsApp router lock: ${error instanceof Error ? error.message : String(error)}`;
                await whatsappService.recordLifecycleEvent({
                    type: 'instance-lock-rejected',
                    state: 'connection-conflict',
                    classification: error instanceof RouterInstanceLockError ? 'connection-conflict' : 'unknown',
                    action: error instanceof RouterInstanceLockError ? 'resolve-conflict' : 'none',
                    reason: error instanceof RouterInstanceLockError
                        ? 'another-router-process-is-active'
                        : 'instance-lock-acquisition-failed',
                    error: message
                });
                throw error instanceof RouterInstanceLockError ? error : new Error(message);
            }

            routerActive = true;
            await whatsappService.recordLifecycleEvent({
                type: 'instance-lock-acquired',
                state: 'stopped',
                action: 'none',
                reason: recoveredStaleLock ? 'stale-lock-recovered' : 'exclusive-lock-acquired',
                intentional: true
            });

            try {
                await outboundQueueService.start();
            } catch (error) {
                routerActive = false;
                await instanceLock!.release();
                const message = `WhatsApp router initialization failed after acquiring the instance lock: ${error instanceof Error ? error.message : String(error)}`;
                await whatsappService.recordLifecycleEvent({
                    type: 'router-initialization-failed',
                    state: 'stopped',
                    classification: 'unknown',
                    action: 'none',
                    reason: 'outbound-queue-start-failed',
                    error: message
                });
                throw new Error(message);
            }
        })();

        try {
            await ownershipPromise;
        } finally {
            ownershipPromise = undefined;
        }
    };

    whatsappService.setInstanceOwnershipHandlers(
        () => instanceLock?.isHeld() === true,
        acquireRouterOwnership
    );

    const formatFooterStatus = (status: string) => {
        if (status !== t("service.whatsapp.connected")) {
            return status;
        }

        if (sessionManager.getAllowAllDirectChats()) {
            return sessionManager.getAllowAllGroups()
                ? `${status} - All direct chats and groups`
                : `${status} - All direct chats`;
        }

        if (sessionManager.getAllowAllGroups()) {
            return `${status} - All groups`;
        }

        const allowedChats = sessionManager.getAllowList().length + sessionManager.getAllowedGroups().length;
        if (allowedChats === 0) {
            return `${status} - No chats`;
        }

        return `${status} to ${allowedChats} chat${allowedChats === 1 ? '' : 's'}`;
    };

    const refreshFooterStatus = () => {
        if (!_ctx) return;
        const status = whatsappService.getEffectiveStatus();
        const displayStatus = status === 'connected'
            ? t('service.whatsapp.connected')
            : status === 'connecting'
                ? t('service.whatsapp.connecting')
                : status === 'reconnecting'
                    ? t('service.whatsapp.reconnecting')
                    : status === 'reauth-required'
                        ? t('service.whatsapp.reauthRequired')
                        : status === 'connection-conflict'
                            ? t('service.whatsapp.conflict')
                            : t('service.whatsapp.disconnected');
        _ctx.ui.setStatus('whatsapp', formatFooterStatus(displayStatus));
    };

    let stopPromise: Promise<void> | undefined;
    const stopRouter = async () => {
        if (stopPromise) {
            await stopPromise;
            return;
        }
        if (!routerActive && !instanceLock?.isHeld()) {
            return;
        }

        stopPromise = (async () => {
            try {
                outboundQueueService.stop();
                if (routerActive) {
                    await whatsappService.stop();
                }
                await whatsappService.recordLifecycleEvent({
                    type: 'instance-lock-released',
                    state: 'stopped',
                    classification: 'intentional',
                    action: 'none',
                    reason: 'extension-stop',
                    intentional: true
                });
            } finally {
                routerActive = false;
                await instanceLock?.release();
            }
        })();

        try {
            await stopPromise;
        } finally {
            stopPromise = undefined;
        }
    };

    const installGracefulShutdownHandlers = () => {
        shutdownState.__whatsappPiShutdown ??= { installed: false };
        if (shutdownState.__whatsappPiShutdown.installed) {
            return;
        }

        shutdownState.__whatsappPiShutdown.installed = true;
        
        const shutdown = async (reason: string) => {
            try {
                await shutdownState.__whatsappPiShutdown?.stop?.();
            } catch (error) {
                logger.error(`[WhatsApp-Pi] Graceful shutdown failed during ${reason}:`, error);
            }
        };

        process.once('SIGINT', () => { void shutdown('SIGINT'); });
        process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
    };

    // Initial status setup
    pi.on("session_start", async (_event, ctx) => {
        _ctx = ctx;
        // Check verbose mode
        const isVerboseFlagSet = process.argv.includes("--verbose");

        const isVerbose = isVerboseFlagSet;

        whatsappService.setVerboseMode(isVerbose);
        logger.setVerbose(isVerbose);

        try {
            const childPiConfig = await loadResolvedChildPiConfig();
            logger.log(`[WhatsApp-Pi-Router] Child Pi model: ${childPiConfig.model ?? 'Pi default'} (${childPiConfig.modelSource}); thinking: ${childPiConfig.thinking ?? 'Pi default'} (${childPiConfig.thinkingSource})`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('[WhatsApp-Pi-Router] Invalid child Pi settings:', message);
            ctx.ui.notify(`WhatsApp child Pi settings are invalid: ${message}`, 'error');
        }

        try {
            const voiceConfig = await loadResolvedVoiceReplyConfig();
            logger.log(`[WhatsApp-Pi-Router] Voice replies: ${voiceConfig.mode} (${voiceConfig.modeSource}); model ${voiceConfig.model}; voice ${voiceConfig.voice}; speed ${voiceConfig.speed}`);
            if (voiceConfig.mode !== 'off' && !process.env.OPENROUTER_API_KEY?.trim()) {
                ctx.ui.notify('WhatsApp voice replies are enabled but OPENROUTER_API_KEY is not configured. Replies will fall back to text.', 'warning');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('[WhatsApp-Pi-Router] Invalid voice reply settings:', message);
            ctx.ui.notify(`WhatsApp voice reply settings are invalid: ${message}`, 'error');
        }

        if (isVerbose) {
            logger.log('[WhatsApp-Pi] Verbose mode enabled - Baileys trace logs will be shown');
        }
        ctx.ui.setStatus('whatsapp', '| WhatsApp: Disconnected');
        whatsappService.setStatusCallback((status) => {
            ctx.ui.setStatus('whatsapp', formatFooterStatus(status));
        });
        whatsappService.setLidMappingCallback(async ({ lid, pn }) => {
            await identityMapService.recordLidPnMapping(lid, pn);
        });

        // Set up group binding if configured
        const boundGroupJid = (pi.getFlag("whatsapp-group") as string) || "";
        if (boundGroupJid) {
            whatsappService.setGroupBinding(boundGroupJid);
            sessionManager.setGroupJidForAuth(boundGroupJid);
            logger.log(`[WhatsApp-Pi] Group-only mode: bound to ${boundGroupJid}`);
        }

        instanceLock ??= new RouterInstanceLock(sessionManager.getInstanceLockPath());

        await sessionManager.ensureInitialized();
        await whatsappService.recordLifecycleEvent({
            type: 'extension-start',
            state: sessionManager.getStatus(),
            action: 'none',
            reason: pi.getFlag('whatsapp-pi-online') === true ? 'auto-connect-enabled' : 'extension-loaded-offline',
            authStatePresent: await sessionManager.isRegistered()
        });
        const routerAllowConfig = await loadRouterAllowConfig();
        sessionManager.setAllowAllDirectChats(routerAllowConfig.allowAllDirectChats);
        sessionManager.setAllowAllGroups(routerAllowConfig.allowAllGroups);
        sessionManager.setGroupReplyMode(routerAllowConfig.groupReplyMode);
        if (routerAllowConfig.allowAllDirectChats) {
            logger.log('[WhatsApp-Pi] Router allow-all direct chats mode enabled; inbound direct chats will be routed without allowlist checks. Groups still require explicit allow unless group allow-all is enabled.');
        }
        if (routerAllowConfig.allowAllGroups) {
            logger.log('[WhatsApp-Pi] Router allow-all groups mode enabled; inbound group conversations will be routed without allowlist checks.');
        }
        if (routerAllowConfig.groupReplyMode === 'mentions') {
            logger.log('[WhatsApp-Pi] Group mention-only mode enabled; allowed group messages will route only when the connected WhatsApp agent is explicitly mentioned.');
        }
        for (const number of routerAllowConfig.allow) {
            await sessionManager.addNumber(number);
        }
        await recentsService.ensureInitialized();
        await identityMapService.ensureInitialized();
        installGracefulShutdownHandlers();
        shutdownState.__whatsappPiShutdown = {
            installed: shutdownState.__whatsappPiShutdown?.installed ?? false,
            stop: stopRouter
        };
        whatsappService.setIncomingMessageRecorder(async (message) => {
            const isGroup = message.remoteJid.endsWith('@g.us');
            const senderNumber = toConversationId(message.remoteJid);
            await recentsService.recordMessage({
                messageId: message.id,
                senderNumber,
                senderName: message.pushName,
                text: message.text || '',
                direction: 'incoming',
                timestamp: message.timestamp
            });
        });

        const isWhatsappPiOn = pi.getFlag("whatsapp-pi-online") === true;
        const registered = await sessionManager.isRegistered();

        // Disk state is authoritative. Session-history snapshots can outlive a
        // remote logout and must not overwrite reauth-required/conflict states.
        const reauthenticationRequired = sessionManager.getStatus() === 'reauth-required';

        if (isWhatsappPiOn && registered && !reauthenticationRequired) {
            ctx.ui.setStatus('whatsapp', '| WhatsApp: Auto-connecting...');

            // Retry logic (max 3 attempts, 3s delay)
            let attempts = 0;
            const maxAttempts = 4; // Initial + 3 retries

            const tryConnect = async () => {
                attempts++;
                try {
                    await whatsappService.start({ allowPairingOnAuthFailure: false });
                } catch (error) {
                    if (error instanceof RouterInstanceLockError) {
                        ctx.ui.notify(error.message, 'error');
                        ctx.ui.setStatus('whatsapp', '| WhatsApp: Disabled (Another Router Instance)');
                        return;
                    }
                    if (attempts < maxAttempts) {
                        ctx.ui.notify(`WhatsApp: Connection attempt ${attempts} failed. Retrying...`, 'warning');
                        setTimeout(tryConnect, 3000);
                    } else {
                        ctx.ui.notify('WhatsApp: Auto-connect failed after multiple attempts.', 'error');
                        ctx.ui.setStatus('whatsapp', '| WhatsApp: Connection Failed');
                    }
                }
            };

            await tryConnect();
        } else if (isWhatsappPiOn && reauthenticationRequired) {
            ctx.ui.setStatus('whatsapp', t('service.whatsapp.reauthRequired'));
            ctx.ui.notify('WhatsApp credentials were rejected. Open /whatsapp and choose Pair New Device to start a fresh QR pairing without restarting Pi.', 'warning');
        } else if (isWhatsappPiOn) {
            ctx.ui.notify('WhatsApp: Auto-connect requested, but no saved WhatsApp credentials were found. Use Connect WhatsApp once to scan the QR code.', 'warning');
        } else {
            ctx.ui.notify('WhatsApp: Use Connect / Reconnect WhatsApp. QR code will appear only if pairing is needed.', 'info');
        }

        ctx.ui.notify('WhatsApp: Session reset via /new is now fully supported.', 'info');
    });

    // Track whether send_wa_message tool already sent a reply this turn
    let toolSentToJid: string | null = null;

    const toRecentSenderNumber = (recipientJid: string): string => toConversationId(recipientJid);

    const sendRoutedReply = async (params: {
        replyJid: string;
        conversationId: string;
        rawReply: string;
        image?: RoutedImageHandoff;
        incomingWasVoice: boolean;
        voiceConfig: ResolvedVoiceReplyConfig;
    }): Promise<void> => {
        const plan = planVoiceReply(params.rawReply, params.voiceConfig.mode, params.incomingWasVoice);
        const text = params.image
            ? (params.image.caption || 'I created the image, but WhatsApp could not deliver it.')
            : (plan.text || 'I could not produce a reply for that message.');

        if (params.image) {
            try {
                const imageResult = await whatsappService.sendImageMessage(
                    params.replyJid,
                    params.image.path,
                    params.image.mimeType,
                    params.image.caption
                );
                if (imageResult.success) {
                    try {
                        await recentsService.recordMessage({
                            messageId: imageResult.messageId ?? `pi-router-image-${Date.now()}`,
                            senderNumber: params.conversationId,
                            senderName: 'Pi',
                            text: params.image.caption || '[Image]',
                            direction: 'outgoing',
                            timestamp: Date.now(),
                        });
                    } catch (error) {
                        logger.error('[WhatsApp-Pi-Router] Image sent but failed to record it in recents:', error);
                    }
                    logger.log(`[WhatsApp-Pi-Router] Sent image reply to ${params.replyJid}`);
                    return;
                }
                logger.error(`[WhatsApp-Pi-Router] Image delivery failed; falling back to text: ${imageResult.error ?? 'unknown error'}`);
            } catch (error) {
                logger.error(`[WhatsApp-Pi-Router] Image delivery failed; falling back to text: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        if (plan.useVoice && !params.image) {
            let artifact: Awaited<ReturnType<TextToSpeechService['createVoiceNote']>> | undefined;
            try {
                artifact = await textToSpeechService.createVoiceNote(text, params.voiceConfig);
                const voiceResult = await whatsappService.sendVoiceMessage(params.replyJid, artifact.path);
                if (voiceResult.success) {
                    await recentsService.recordMessage({
                        messageId: voiceResult.messageId ?? `pi-router-voice-${Date.now()}`,
                        senderNumber: params.conversationId,
                        senderName: 'Pi',
                        text,
                        direction: 'outgoing',
                        timestamp: Date.now(),
                    });
                    logger.log(`[WhatsApp-Pi-Router] Sent ${plan.reason} voice reply to ${params.replyJid}`);
                    return;
                }
                logger.error(`[WhatsApp-Pi-Router] Voice delivery failed; falling back to text: ${voiceResult.error ?? 'unknown error'}`);
            } catch (error) {
                logger.error(`[WhatsApp-Pi-Router] TTS failed; falling back to text: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
                if (artifact) {
                    try {
                        await artifact.cleanup();
                    } catch (error) {
                        logger.error('[WhatsApp-Pi-Router] Failed to clean up TTS files:', error);
                    }
                }
            }
        }

        const textResult = await whatsappService.sendMessage(params.replyJid, text);
        if (!textResult.success) {
            throw new Error(textResult.error ?? 'WhatsApp text fallback failed');
        }
        await recentsService.recordMessage({
            messageId: textResult.messageId ?? `pi-router-${Date.now()}`,
            senderNumber: params.conversationId,
            senderName: 'Pi',
            text,
            direction: 'outgoing',
            timestamp: Date.now(),
        });
    };

    const conversationTurnQueues = new Map<string, Promise<unknown>>();
    const enqueueConversationTurn = async <T>(conversationKey: string, task: () => Promise<T>): Promise<T> => {
        const previous = conversationTurnQueues.get(conversationKey) ?? Promise.resolve();
        const current = previous
            .catch((error) => {
                logger.error(`[WhatsApp-Pi-Router] Previous queued turn failed for ${conversationKey}:`, error);
            })
            .then(task);
        conversationTurnQueues.set(conversationKey, current);

        try {
            return await current;
        } finally {
            if (conversationTurnQueues.get(conversationKey) === current) {
                conversationTurnQueues.delete(conversationKey);
            }
        }
    };

    // Handle incoming messages by injecting them as user prompts
    whatsappService.setMessageCallback(async (m) => {
        const msg = m.messages?.[0];
        if (!msg?.message) return;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) return;

        const isGroup = remoteJid.endsWith('@g.us');
        const lidJid = isGroup
            ? undefined
            : firstLidJid(msg.key.remoteJid, msg.key.remoteJidAlt, msg.key.senderLid, msg.key.previousRemoteJid);
        const phoneJid = isGroup
            ? undefined
            : firstPhoneJid(msg.key.remoteJid, msg.key.remoteJidAlt, msg.key.senderPn, msg.key.participantAlt);
        const alternateJid = isGroup
            ? undefined
            : firstNormalized(msg.key.remoteJidAlt, msg.key.senderPn, msg.key.senderLid, msg.key.previousRemoteJid);
        const replyJid = isGroup ? remoteJid : (lidJid ?? normalizeDirectJid(remoteJid) ?? remoteJid);
        const participantJid = isGroup ? (msg.key.participantAlt || msg.key.participant) : (phoneJid ?? lidJid ?? remoteJid);
        const participant = participantJid?.split('@')[0] || 'unknown';
        const sender = (phoneJid ?? lidJid ?? remoteJid).split('@')[0] || "unknown";
        const pushName = msg.pushName || "WhatsApp User";

        // Mark as read on the actual incoming chat key, then type in the reply thread.
        if (msg.key.id) {
            whatsappService.markRead(remoteJid, msg.key.id, msg.key.fromMe);
            whatsappService.sendPresence(replyJid, 'composing');
        }

        // Reset tool-sent flag for this new incoming message
        toolSentToJid = null;

        const resolved = extractIncomingText(msg.message);
        if (resolved.kind === 'system') {
            logger.log(`[WhatsApp-Pi] ${pushName} (${sender}): ${resolved.text}`);
            return;
        }

        const { text, imageBuffer, imageMimeType } = await incomingMediaService.process(resolved, pushName);

        // Format message header with group context when applicable
        const messageHeader = isGroup
            ? `Message from ${pushName} (${participant}) in group ${remoteJid}:`
            : `Message from ${pushName} (${sender}):`;

        logger.log(`[WhatsApp-Pi] ${messageHeader} ${text}`);

        if (!isGroup && lidJid && phoneJid) {
            await Promise.all([
                whatsappService.storeLidPnMapping(lidJid, phoneJid),
                identityMapService.recordLidPnMapping(lidJid, phoneJid),
            ]);
        }

        // Handle commands before dispatching to the routed child Pi session.
        if (text.trim().toLowerCase().startsWith('/compact')) {
            logger.log(`[WhatsApp-Pi] Session compact requested by ${pushName}.`);
            await whatsappService.sendMessage(replyJid, "Per-conversation sessions are compacted by their own Pi runs. ✅");
            return;
        }

        if (text.trim().toLowerCase().startsWith('/abort')) {
            logger.log(`[WhatsApp-Pi] Abort requested by ${pushName}.`);
            await whatsappService.sendMessage(replyJid, "There is no active routed Pi turn to abort from WhatsApp yet. ✅");
            return;
        }

        const conversationId = toConversationId(replyJid);
        if (!isGroup) {
            await identityMapService.recordIncomingIdentity({
                conversationId,
                whatsappJid: replyJid,
                alternateJid,
                lidJid,
                phoneJid,
                pushName,
                addressingMode: msg.key.addressingMode,
            });
        }
        const identity = isGroup ? undefined : identityMapService.get(conversationId);
        let voiceConfig = getDefaultResolvedVoiceReplyConfig();
        try {
            voiceConfig = await loadResolvedVoiceReplyConfig();
        } catch (error) {
            logger.error('[WhatsApp-Pi-Router] Invalid voice reply settings; using text replies:', error);
        }
        const incomingWasVoice = resolved.kind === 'audio';
        const prompt = buildPrompt({
            messageHeader,
            text,
            remoteJid,
            replyJid,
            alternateJid,
            isGroup,
            pushName,
            participant,
            conversationId,
            identity,
            voiceReplyMode: voiceConfig.mode,
            incomingWasVoice,
        });

        try {
            const cwd = _ctx?.cwd ?? process.cwd();
            await enqueueConversationTurn(replyJid, async () => {
                const [childPiConfig, sessionLaunch] = await Promise.all([
                    loadResolvedChildPiConfig(),
                    resolveRoutedSessionLaunch(replyJid, cwd)
                ]);
                logger.log(`[WhatsApp-Pi-Router] Dispatching ${remoteJid} via reply ${replyJid} to ${sessionLaunch.route.directory} (${sessionLaunch.mode}) with model ${childPiConfig.model ?? 'Pi default'} and thinking ${childPiConfig.thinking ?? 'Pi default'}`);
                const turnResult = await runPiForConversation({
                    sessionLaunch,
                    prompt,
                    cwd,
                    childPiConfig,
                    ...(imageBuffer && imageMimeType ? { imageBuffer, imageMimeType } : {}),
                });
                try {
                    await sendRoutedReply({
                        replyJid,
                        conversationId,
                        rawReply: turnResult.text,
                        ...(turnResult.image ? { image: turnResult.image } : {}),
                        incomingWasVoice,
                        voiceConfig,
                    });
                } finally {
                    await turnResult.cleanup().catch(error => {
                        logger.error('[WhatsApp-Pi-Router] Failed to clean up image handoff files:', error);
                    });
                }
            });
        } catch (error) {
            logger.error('[WhatsApp-Pi-Router] routed Pi reply failed:', error);
            await whatsappService.sendMessage(
                replyJid,
                `Sorry, the routed Pi session failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    });

    // Register sanitized connection diagnostics for the operator Pi. Routed
    // child sessions run without this extension and cannot access this tool.
    pi.registerTool({
        name: 'get_whatsapp_health',
        label: 'Get WhatsApp Connection Health',
        description: 'Inspect sanitized WhatsApp router health, connection state, retry timing, last disconnect reason, instance-lock ownership, and recent lifecycle events. Use whenever the operator asks why WhatsApp is disconnected, whether it is connected, or requests WhatsApp logs/status. Does not expose messages, contacts, QR data, or credentials.',
        promptSnippet: 'get_whatsapp_health() - Inspect sanitized WhatsApp connection diagnostics and recent lifecycle events. Use this instead of refusing requests to diagnose WhatsApp connectivity.',
        parameters: Type.Object({}),
        async execute() {
            const diagnostics = await whatsappService.getDiagnostics();
            const selectEventFields = (event: typeof diagnostics.recentEvents[number]) => ({
                timestamp: event.timestamp,
                type: event.type,
                state: event.state,
                classification: event.classification,
                action: event.action,
                statusCode: event.statusCode,
                reason: event.reason,
                error: event.error,
                reconnectAttempt: event.reconnectAttempt,
                nextRetryAt: event.nextRetryAt,
                intentional: event.intentional
            });
            return {
                isError: false,
                details: undefined,
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        status: diagnostics.status,
                        authStatePresent: diagnostics.authStatePresent,
                        instanceLockOwned: diagnostics.instanceLockOwned,
                        operatorActionRequired: diagnostics.operatorActionRequired,
                        reconnectAttempts: diagnostics.reconnectAttempts,
                        nextRetryAt: diagnostics.nextRetryAt,
                        connectedSince: diagnostics.connectedSince,
                        processStartedAt: diagnostics.processStartedAt,
                        processUptimeSeconds: diagnostics.processUptimeSeconds,
                        eventLogPath: diagnostics.eventLogPath,
                        lastDisconnect: diagnostics.lastDisconnect
                            ? selectEventFields(diagnostics.lastDisconnect)
                            : undefined,
                        recentEvents: diagnostics.recentEvents.slice(-10).map(selectEventFields)
                    })
                }]
            };
        }
    });

    // Register send_wa_message tool (LLM-callable)
    pi.registerTool({
        name: "send_wa_message",
        label: "Send WhatsApp Message",
        description: "Send a WhatsApp message to a contact or group. The 'jid' parameter is the WhatsApp JID (e.g. 5511999998888@s.whatsapp.net for contacts, or 120363012345@g.us for groups). If omitted, replies to the last conversation.",
        promptSnippet: "send_wa_message(jid, message) - Send a WhatsApp message. jid is required (e.g. 5511999998888@s.whatsapp.net or 120363012345@g.us). IMPORTANT: After calling this tool, do NOT generate any follow-up text or confirmation — the message is already delivered to WhatsApp. Your entire response to the user should be sent ONLY through this tool, not repeated in chat.",
        parameters: Type.Object({
            jid: Type.Optional(Type.String({ description: "WhatsApp JID of the recipient" })),
            recipient_jid: Type.Optional(Type.String({ description: "Alternative name for jid" })),
            message: Type.String({ minLength: 1, description: "Plain-text message content to send" })
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            // Resolve JID: jid > recipient_jid > lastRemoteJid > operatorJid (QR-scanned number)
            const resolvedJid = params.jid || params.recipient_jid || whatsappService.getLastRemoteJid() || whatsappService.getOperatorJid();
            if (!resolvedJid) {
                return {
                    isError: true,
                    details: undefined,
                    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "No JID provided and no active conversation to reply to", attempts: 0 }) }]
                };
            }

            if (whatsappService.getStatus() !== 'connected') {
                return {
                    isError: true,
                    details: undefined,
                    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: t("tool.error.notConnected"), attempts: 0 }) }]
                };
            }

            const message = params.message ?? '';
            const formattedMessage = message
                .split('\n')
                .map((line: string) => `    ${line}`)
                .join('\n');

            logger.log([
                t("log.outgoing.title"),
                t("log.outgoing.to", { jid: resolvedJid }),
                t("log.outgoing.message"),
                formattedMessage
            ].join('\n'));

            const outboundJid = whatsappService.resolveOutboundRecipientJid(resolvedJid);
            const result = await whatsappService.sendMessage(outboundJid, message);
            const actualOutboundJid = result.recipientJid ?? outboundJid;

            if (result.success) {
                // Mark that tool already sent to this JID — prevents message_end from re-sending
                toolSentToJid = actualOutboundJid;
                await recentsService.recordMessage({
                    messageId: result.messageId!,
                    senderNumber: toRecentSenderNumber(actualOutboundJid),
                    text: message,
                    direction: 'outgoing',
                    timestamp: Date.now()
                });
                logger.log([
                    t("log.result.title"),
                    t("log.outgoing.to", { jid: resolvedJid }),
                    t("log.result.status.sent"),
                    t("log.result.messageId", { messageId: result.messageId ?? t("log.unknownMessageId") })
                ].join('\n'));
            } else {
                logger.log([
                    t("log.result.title"),
                    t("log.outgoing.to", { jid: resolvedJid }),
                    t("log.result.status.failed"),
                    t("log.result.error", { error: result.error ?? t("log.unknownError") })
                ].join('\n'));
            }

            return {
                isError: !result.success,
                details: undefined,
                content: [{ type: "text" as const, text: JSON.stringify({ success: result.success, messageId: result.messageId, error: result.error, attempts: result.attempts, recipientJid: result.recipientJid }) }]
            };
        }
    });

    // Register send_reaction tool (LLM-callable)
    pi.registerTool({
        name: "send_reaction",
        label: t("tool.sendReaction.label"),
        description: t("tool.sendReaction.description"),
        promptSnippet: "send_reaction(jid, messageId, emoji) - React to a WhatsApp message with an emoji. The 'jid' is the chat JID (e.g. 5511999998888@s.whatsapp.net), 'messageId' is the ID of the message to react to, and 'emoji' is the emoji to react with (e.g., 👍, ❤️, 😂).",
        parameters: Type.Object({
            jid: Type.String({ description: "WhatsApp JID of the chat (e.g. 5511999998888@s.whatsapp.net or 120363012345@g.us)" }),
            messageId: Type.String({ description: "ID of the message to react to" }),
            emoji: Type.String({ description: "Emoji to react with (e.g., 👍, ❤️, 😂). Use empty string to remove reaction." })
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            // Get socket from WhatsApp service
            const socket = whatsappService.getSocket();
            if (!socket) {
                return {
                    isError: true,
                    details: undefined,
                    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: t("service.whatsapp.notConnected") }) }]
                };
            }

            // Create sender with the socket
            const sender = new ReactionSender(socket as any);
            const result = await sender.sendReaction({
                jid: params.jid ?? '',
                messageId: params.messageId ?? '',
                emoji: params.emoji ?? ''
            });

            return {
                isError: !result.success,
                details: undefined,
                content: [{ type: "text" as const, text: JSON.stringify({ success: result.success, messageId: result.messageId, error: result.error }) }]
            };
        }
    });

    // Register list_wa_conversations tool (LLM-callable, read-only)
    pi.registerTool({
        name: "list_wa_conversations",
        label: t("tool.listConversations.label"),
        description: t("tool.listConversations.description"),
        promptSnippet: "list_wa_conversations({onlyIncoming?, onlyAllowed?, limit?}) - List recent WhatsApp conversations from the local recents store. Read-only; safe to call any time.",
        parameters: Type.Object({
            onlyIncoming: Type.Optional(Type.Boolean({ description: "Only return conversations whose last message is incoming (waiting for a reply)." })),
            onlyAllowed: Type.Optional(Type.Boolean({ description: "Only return conversations from senders/groups currently in the allow list." })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum number of conversations to return (default 20)." }))
        }),
        async execute(_toolCallId, params) {
            try {
                const conversations = await recentsService.getRecentConversations();
                let filtered = conversations;
                if (params.onlyIncoming) {
                    filtered = filtered.filter(c => c.lastMessageDirection === 'incoming');
                }
                if (params.onlyAllowed) {
                    filtered = filtered.filter(c => c.isAllowed);
                }
                const limit = typeof params.limit === 'number' ? params.limit : 20;
                filtered = filtered.slice(0, limit);
                return {
                    isError: false,
                    details: undefined,
                    content: [{ type: "text" as const, text: JSON.stringify({ success: true, count: filtered.length, conversations: filtered }) }]
                };
            } catch (error) {
                return {
                    isError: true,
                    details: undefined,
                    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) }]
                };
            }
        }
    });

    // Register get_wa_conversation_history tool (LLM-callable, read-only)
    pi.registerTool({
        name: "get_wa_conversation_history",
        label: t("tool.getHistory.label"),
        description: t("tool.getHistory.description"),
        promptSnippet: "get_wa_conversation_history({senderNumber, limit?}) - Get the most recent messages with a sender. `senderNumber` accepts +E164 (e.g. +14155551212), raw digits, or a JID (e.g. 14155551212@s.whatsapp.net, 120363012345@g.us). Read-only.",
        parameters: Type.Object({
            senderNumber: Type.String({ description: "Phone number (+E164 or raw digits) or WhatsApp JID of the conversation." }),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum number of messages to return (default 20)." }))
        }),
        async execute(_toolCallId, params) {
            if (!params.senderNumber || !params.senderNumber.trim()) {
                return {
                    isError: true,
                    details: undefined,
                    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: t("tool.error.missingSender") }) }]
                };
            }
            try {
                const messages = await recentsService.getConversationHistory(params.senderNumber);
                const limit = typeof params.limit === 'number' ? params.limit : 20;
                const sliced = messages.slice(-limit);
                return {
                    isError: false,
                    details: undefined,
                    content: [{ type: "text" as const, text: JSON.stringify({ success: true, count: sliced.length, messages: sliced }) }]
                };
            } catch (error) {
                return {
                    isError: true,
                    details: undefined,
                    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) }]
                };
            }
        }
    });

    // Register check_wa_new_messages tool (LLM-callable, read-only)
    pi.registerTool({
        name: "check_wa_new_messages",
        label: t("tool.checkNew.label"),
        description: t("tool.checkNew.description"),
        promptSnippet: "check_wa_new_messages({sinceTimestamp?}) - List conversations whose most recent message is incoming (i.e. waiting for a reply). Optional `sinceTimestamp` (ms epoch) filters to messages newer than that. Read-only.",
        parameters: Type.Object({
            sinceTimestamp: Type.Optional(Type.Integer({ minimum: 0, description: "Only include conversations whose last incoming message timestamp is strictly greater than this (ms since epoch)." }))
        }),
        async execute(_toolCallId, params) {
            try {
                const conversations = await recentsService.getRecentConversations();
                const since = typeof params.sinceTimestamp === 'number' ? params.sinceTimestamp : 0;
                const pending = conversations.filter(c =>
                    c.lastMessageDirection === 'incoming' && c.lastMessageTime > since
                );
                return {
                    isError: false,
                    details: undefined,
                    content: [{ type: "text" as const, text: JSON.stringify({ success: true, count: pending.length, conversations: pending }) }]
                };
            } catch (error) {
                return {
                    isError: true,
                    details: undefined,
                    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) }]
                };
            }
        }
    });

    // Suppress automatic message_end reply when tool already sent
    // This is checked by the message_end handler below

    // Register commands
    pi.registerCommand("whatsapp", {
        description: t("command.whatsapp.description"),
        handler: async (args, ctx) => {
            _ctx = ctx;
            await menuHandler.handleCommand(ctx);

            refreshFooterStatus();
        }
    });

    // Legacy whatsapp-pi behavior forwards assistant replies from the operator's
    // current Pi session to the last WhatsApp chat. The router sends replies
    // explicitly from the per-conversation child session, so keep legacy outbound
    // disabled by default to avoid leaking local/operator chats into WhatsApp.
    const mainSessionOutboundEnabled = () => process.env.WHATSAPP_ROUTER_ENABLE_MAIN_SESSION_OUTBOUND === 'true';

    pi.on("agent_start", async (_event, _ctx) => {
        if (!mainSessionOutboundEnabled()) return;
        if (sessionManager.getStatus() !== 'connected') return;
        const lastJid = whatsappService.getLastRemoteJid();
        if (lastJid) {
            await whatsappService.sendPresence(whatsappService.resolveOutboundRecipientJid(lastJid), 'composing');
        }
    });

    pi.on("message_end", async (event, ctx) => {
        if (!mainSessionOutboundEnabled()) return;
        if (sessionManager.getStatus() !== 'connected') return;

        const { message } = event;
        // Only reply if it's the assistant and we have a valid target
        if (message.role === "assistant") {
            const lastJid = whatsappService.getLastRemoteJid();
            const text = message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
            const outboundJid = lastJid
                ? whatsappService.resolveOutboundRecipientJid(lastJid)
                : null;

            // Skip if send_wa_message tool already sent a reply to this JID
            if (toolSentToJid === outboundJid) {
                toolSentToJid = null;
                return;
            }

            if (outboundJid && text) {
                try {
                    const result = await whatsappService.sendMessage(outboundJid, text);
                    const actualOutboundJid = result.recipientJid ?? outboundJid;
                    if (result.success) {
                        await recentsService.recordMessage({
                            messageId: result.messageId ?? `${Date.now()}`,
                            senderNumber: toRecentSenderNumber(actualOutboundJid),
                            text,
                            direction: 'outgoing',
                            timestamp: Date.now()
                        });
                        ctx.ui.notify(t("notify.replySent"), 'info');
                    } else {
                        ctx.ui.notify(t("notify.replyFailed"), 'error');
                    }
                } catch {
                    ctx.ui.notify(t("notify.replyFailed"), 'error');
                }
            }
        }
    });

    pi.on("session_shutdown", async () => {
        logger.log("[WhatsApp-Pi] Session shutdown detected. Stopping WhatsApp service...");
        await stopRouter();
    });
}
