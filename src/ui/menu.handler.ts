import { WhatsAppService } from '../services/whatsapp.service.js';
import { SessionManager, type Contact } from '../services/session.manager.js';
import { validatePhoneNumber, type RecentConversationMessage, type RecentConversationSummary } from '../models/whatsapp.types.js';
import { RecentsService } from '../services/recents.service.js';
import { showMessageDetailView } from './message-detail.view.js';
import { showMessageReplyView } from './message-reply.view.js';
import * as qrcode from 'qrcode-terminal';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { t } from '../i18n.js';
import { updateRouterAllowFileConfig } from '../services/router-allow.config.js';
import { IdentityMapService, normalizeIdentityEmail, normalizePhoneDigits } from '../services/identity-map.service.js';
import {
    CHILD_PI_THINKING_LEVELS,
    loadChildPiFileConfig,
    loadResolvedChildPiConfig,
    saveChildPiFileConfig,
    type ChildPiFileConfig
} from '../services/child-pi.config.js';
import {
    DEFAULT_TTS_MODEL,
    DEFAULT_TTS_SPEED,
    DEFAULT_TTS_VOICE,
    loadResolvedVoiceReplyConfig,
    loadVoiceReplyFileConfig,
    saveVoiceReplyFileConfig,
    type VoiceReplyFileConfig,
    type VoiceReplyMode
} from '../services/voice-reply.config.js';

interface HistoryOptionEntry {
    label: string;
    message: RecentConversationMessage;
}

interface GroupedRecentEntry {
    conversations: RecentConversationSummary[];
    sharedPreview: string;
    sharedTime: number;
}

export class MenuHandler {
    private readonly printedAllowedContacts: string[] = [];
    private readonly printedAllowedGroups: string[] = [];

    constructor(
        private readonly whatsappService: WhatsAppService,
        private readonly sessionManager: SessionManager,
        private readonly recentsService: RecentsService,
        private readonly identityMapService: IdentityMapService
    ) {}

    async handleCommand(ctx: ExtensionCommandContext) {
        const status = this.whatsappService.getEffectiveStatus();
        const registered = await this.sessionManager.isRegistered();
        const title = t('menu.whatsapp.title', { status });
        const recentsLabel = t('menu.root.recents');
        const allowedContactsLabel = t('menu.root.allowedNumbers');
        const allowedGroupsLabel = t('menu.root.allowedGroups');
        const disconnectWhatsAppLabel = t('menu.root.disconnectWhatsApp');
        const connectWhatsAppLabel = t('menu.root.connectWhatsApp');
        const allowAllDirectChatsLabel = t(this.sessionManager.getAllowAllDirectChats()
            ? 'menu.root.allowAllDirectChatsOn'
            : 'menu.root.allowAllDirectChatsOff');
        const groupReplyModeLabel = t(this.sessionManager.getGroupReplyMode() === 'mentions'
            ? 'menu.root.groupRepliesMentions'
            : 'menu.root.groupRepliesAll');
        const childPiSettingsLabel = t('menu.root.childPiSettings');
        const voiceRepliesLabel = t('menu.root.voiceReplies');
        const logoffDeleteSessionLabel = t('menu.root.logoffDeleteSession');
        const pairNewDeviceLabel = t('menu.root.pairNewDevice');
        const diagnosticsLabel = t('menu.root.diagnostics');
        const backLabel = t('menu.root.back');
        const options: string[] = [];

        if (status === 'connected') {
            options.push(recentsLabel);
            options.push(allowedContactsLabel);
            options.push(allowedGroupsLabel);
            options.push(allowAllDirectChatsLabel);
            options.push(groupReplyModeLabel);
            options.push(disconnectWhatsAppLabel);
        } else {
            const freshPairingRequired = status === 'reauth-required' || (status === 'logged-out' && registered);
            if (freshPairingRequired) {
                options.push(pairNewDeviceLabel);
            } else {
                options.push(connectWhatsAppLabel);
                if (registered) {
                    options.push(pairNewDeviceLabel);
                }
            }
            options.push(allowAllDirectChatsLabel);
            options.push(groupReplyModeLabel);
        }

        options.push(diagnosticsLabel);
        options.push(childPiSettingsLabel);
        options.push(voiceRepliesLabel);

        if (registered) {
            options.push(logoffDeleteSessionLabel);
        }

        options.push(backLabel);

        const choice = await ctx.ui.select(title, options);

        switch (choice) {
            case connectWhatsAppLabel:
                if (status === 'connected') {
                    ctx.ui.notify(t('menu.root.alreadyConnected'), 'info');
                    break;
                }
                this.whatsappService.setQRCodeCallback((qr) => {
                    qrcode.generate(qr, { small: true });
                });
                await this.whatsappService.start();
                ctx.ui.notify(registered ? t('menu.root.reconnectStarted') : t('menu.root.pairingStarted'), 'info');
                break;
            case pairNewDeviceLabel: {
                const confirmed = await ctx.ui.confirm(
                    t('menu.root.pairNewDeviceTitle'),
                    t('menu.root.pairNewDeviceConfirm')
                );
                if (!confirmed) break;
                this.whatsappService.setQRCodeCallback((qr) => {
                    qrcode.generate(qr, { small: true });
                });
                await this.whatsappService.resetAndStartPairing('operator-request');
                ctx.ui.notify(t('menu.root.credentialsResetPairingStarted'), 'info');
                break;
            }
            case diagnosticsLabel:
                await this.showConnectionDiagnostics(ctx);
                break;
            case disconnectWhatsAppLabel:
                if (status !== 'connected') {
                    ctx.ui.notify(t('menu.root.alreadyDisconnected'), 'info');
                    break;
                }
                await this.whatsappService.stop();
                ctx.ui.notify(t('menu.root.agentDisconnected'), 'warning');
                break;
            case logoffDeleteSessionLabel: {
                const confirmLogoff = await ctx.ui.confirm(t('menu.root.logoffTitle'), t('menu.root.logoffConfirmMessage'));
                if (confirmLogoff) {
                    await this.whatsappService.logout();
                    ctx.ui.notify(t('menu.root.loggedOffAndDeleted'), 'info');
                }
                break;
            }
            case allowedContactsLabel:
                await this.manageAllowList(ctx);
                break;
            case allowedGroupsLabel:
                await this.manageAllowedGroups(ctx);
                break;
            case allowAllDirectChatsLabel:
                await this.toggleAllowAllDirectChats(ctx);
                break;
            case groupReplyModeLabel:
                await this.toggleGroupReplyMode(ctx);
                break;
            case childPiSettingsLabel:
                await this.manageChildPiSettings(ctx);
                break;
            case voiceRepliesLabel:
                await this.manageVoiceReplySettings(ctx);
                break;
            case recentsLabel:
                await this.manageRecents(ctx);
                break;
        }
    }

    private async showConnectionDiagnostics(ctx: ExtensionCommandContext) {
        const diagnostics = await this.whatsappService.getDiagnostics();
        const lastDisconnect = diagnostics.lastDisconnect;
        const recent = diagnostics.recentEvents.slice(-5).map(event => {
            const code = event.statusCode === undefined ? '' : ` code=${event.statusCode}`;
            const reason = event.reason ? ` reason=${event.reason}` : '';
            return `${event.timestamp} ${event.type} state=${event.state}${code}${reason}`;
        });
        const lines = [
            'WhatsApp Connection Diagnostics',
            `Status: ${diagnostics.status}`,
            `Credentials: ${diagnostics.authStatePresent ? 'present' : 'missing'}`,
            `Instance lock owned: ${diagnostics.instanceLockOwned ? 'yes' : 'no'}`,
            `Operator action required: ${diagnostics.operatorActionRequired ? 'yes' : 'no'}`,
            `Connected since: ${diagnostics.connectedSince ?? 'not connected in this process'}`,
            `Reconnect attempts: ${diagnostics.reconnectAttempts}`,
            `Next retry: ${diagnostics.nextRetryAt ?? 'none'}`,
            `Process started: ${diagnostics.processStartedAt}`,
            `Process uptime: ${diagnostics.processUptimeSeconds}s`,
            `Last disconnect: ${lastDisconnect
                ? `${lastDisconnect.timestamp} (${lastDisconnect.classification ?? 'unknown'}, code ${lastDisconnect.statusCode ?? 'unknown'}, ${lastDisconnect.reason ?? 'no reason'})`
                : 'none recorded'}`,
            `Event log: ${diagnostics.eventLogPath}`,
            ...(recent.length > 0 ? ['Recent lifecycle events:', ...recent] : [])
        ];
        ctx.ui.notify(lines.join('\n'), 'info');
    }

    private async toggleAllowAllDirectChats(ctx: ExtensionCommandContext) {
        const nextAllowAll = !this.sessionManager.getAllowAllDirectChats();

        if (nextAllowAll) {
            const confirmed = await ctx.ui.confirm(
                t('menu.root.allowAllDirectChatsConfirmTitle'),
                t('menu.root.allowAllDirectChatsConfirmMessage')
            );
            if (!confirmed) {
                await this.handleCommand(ctx);
                return;
            }
        }

        try {
            await updateRouterAllowFileConfig({ allowAllDirectChats: nextAllowAll });
            this.sessionManager.setAllowAllDirectChats(nextAllowAll);
            ctx.ui.notify(nextAllowAll
                ? t('menu.root.allowAllDirectChatsEnabled')
                : t('menu.root.allowAllDirectChatsDisabled'), nextAllowAll ? 'warning' : 'info');
        } catch (error) {
            ctx.ui.notify(t('menu.root.allowAllDirectChatsSaveFailure', {
                error: error instanceof Error ? error.message : String(error)
            }), 'error');
        }

        await this.handleCommand(ctx);
    }

    private async toggleGroupReplyMode(ctx: ExtensionCommandContext) {
        const nextMode = this.sessionManager.getGroupReplyMode() === 'mentions' ? 'all' : 'mentions';

        if (nextMode === 'all') {
            const confirmed = await ctx.ui.confirm(
                t('menu.root.groupRepliesAllConfirmTitle'),
                t('menu.root.groupRepliesAllConfirmMessage')
            );
            if (!confirmed) {
                await this.handleCommand(ctx);
                return;
            }
        }

        try {
            await updateRouterAllowFileConfig({ groupReplyMode: nextMode });
            this.sessionManager.setGroupReplyMode(nextMode);
            ctx.ui.notify(nextMode === 'mentions'
                ? t('menu.root.groupRepliesMentionsEnabled')
                : t('menu.root.groupRepliesAllEnabled'), nextMode === 'mentions' ? 'info' : 'warning');
        } catch (error) {
            ctx.ui.notify(t('menu.root.groupRepliesSaveFailure', {
                error: error instanceof Error ? error.message : String(error)
            }), 'error');
        }

        await this.handleCommand(ctx);
    }

    private async manageChildPiSettings(ctx: ExtensionCommandContext) {
        let saved: ChildPiFileConfig;
        let effective: Awaited<ReturnType<typeof loadResolvedChildPiConfig>>;
        try {
            saved = await loadChildPiFileConfig();
            effective = await loadResolvedChildPiConfig();
        } catch (error) {
            ctx.ui.notify(t('menu.childPi.loadFailure', {
                error: error instanceof Error ? error.message : String(error)
            }), 'error');
            await this.handleCommand(ctx);
            return;
        }

        const formatEffectiveValue = (
            value: string | undefined,
            source: 'environment' | 'file' | 'default'
        ): string => {
            if (source === 'environment') return `${value} [environment override]`;
            if (source === 'file') return `${value} [saved]`;
            return t('menu.childPi.piDefault');
        };

        const modelLabel = t('menu.childPi.model', {
            value: formatEffectiveValue(effective.model, effective.modelSource)
        });
        const thinkingLabel = t('menu.childPi.thinking', {
            value: formatEffectiveValue(effective.thinking, effective.thinkingSource)
        });
        const resetLabel = t('menu.childPi.reset');
        const backLabel = t('menu.root.back');
        const choice = await ctx.ui.select(t('menu.childPi.title'), [
            modelLabel,
            thinkingLabel,
            resetLabel,
            backLabel
        ]);

        if (!choice || choice === backLabel) {
            await this.handleCommand(ctx);
            return;
        }

        if (choice === modelLabel) {
            const input = await ctx.ui.input(
                t('menu.childPi.modelPrompt'),
                saved.model ?? effective.model ?? 'openai-codex/gpt-5.6-luna'
            );
            if (input !== undefined) {
                const model = input.trim();
                if (!model) {
                    ctx.ui.notify(t('menu.childPi.modelRequired'), 'error');
                } else {
                    try {
                        await saveChildPiFileConfig({
                            ...saved,
                            model: model.toLowerCase() === 'default' ? undefined : model
                        });
                        await this.notifyChildPiSettingsSaved(ctx);
                    } catch (error) {
                        ctx.ui.notify(t('menu.childPi.saveFailure', {
                            error: error instanceof Error ? error.message : String(error)
                        }), 'error');
                    }
                }
            }
            await this.manageChildPiSettings(ctx);
            return;
        }

        if (choice === thinkingLabel) {
            const piDefaultLabel = t('menu.childPi.usePiDefault');
            const thinkingChoice = await ctx.ui.select(t('menu.childPi.thinkingPrompt'), [
                piDefaultLabel,
                ...CHILD_PI_THINKING_LEVELS
            ]);
            if (thinkingChoice) {
                try {
                    await saveChildPiFileConfig({
                        ...saved,
                        thinking: thinkingChoice === piDefaultLabel
                            ? undefined
                            : thinkingChoice as typeof CHILD_PI_THINKING_LEVELS[number]
                    });
                    await this.notifyChildPiSettingsSaved(ctx);
                } catch (error) {
                    ctx.ui.notify(t('menu.childPi.saveFailure', {
                        error: error instanceof Error ? error.message : String(error)
                    }), 'error');
                }
            }
            await this.manageChildPiSettings(ctx);
            return;
        }

        if (choice === resetLabel) {
            const confirmed = await ctx.ui.confirm(
                t('menu.childPi.resetTitle'),
                t('menu.childPi.resetConfirm')
            );
            if (confirmed) {
                try {
                    await saveChildPiFileConfig({});
                    await this.notifyChildPiSettingsSaved(ctx);
                } catch (error) {
                    ctx.ui.notify(t('menu.childPi.saveFailure', {
                        error: error instanceof Error ? error.message : String(error)
                    }), 'error');
                }
            }
            await this.manageChildPiSettings(ctx);
        }
    }

    private async notifyChildPiSettingsSaved(ctx: ExtensionCommandContext) {
        const effective = await loadResolvedChildPiConfig();
        ctx.ui.notify(t('menu.childPi.saved', {
            model: effective.model ?? t('menu.childPi.piDefault'),
            thinking: effective.thinking ?? t('menu.childPi.piDefault')
        }), 'info');
    }

    private async manageVoiceReplySettings(ctx: ExtensionCommandContext) {
        let saved: VoiceReplyFileConfig;
        let effective: Awaited<ReturnType<typeof loadResolvedVoiceReplyConfig>>;
        try {
            saved = await loadVoiceReplyFileConfig();
            effective = await loadResolvedVoiceReplyConfig();
        } catch (error) {
            ctx.ui.notify(t('menu.voice.loadFailure', {
                error: error instanceof Error ? error.message : String(error)
            }), 'error');
            await this.handleCommand(ctx);
            return;
        }

        const formatValue = (value: string | number, source: 'environment' | 'file' | 'default') => {
            if (source === 'environment') return `${value} [environment override]`;
            if (source === 'file') return `${value} [saved]`;
            return `${value} [default]`;
        };
        const modeLabels: Record<VoiceReplyMode, string> = {
            off: t('menu.voice.mode.off'),
            explicit: t('menu.voice.mode.explicit'),
            mirror: t('menu.voice.mode.mirror'),
            'mirror-explicit': t('menu.voice.mode.mirrorExplicit'),
            always: t('menu.voice.mode.always')
        };
        const modeChoices = Object.entries(modeLabels) as Array<[VoiceReplyMode, string]>;
        const modeLabel = t('menu.voice.mode', {
            value: formatValue(modeLabels[effective.mode], effective.modeSource)
        });
        const modelLabel = t('menu.voice.model', {
            value: formatValue(effective.model, effective.modelSource)
        });
        const voiceLabel = t('menu.voice.voice', {
            value: formatValue(effective.voice, effective.voiceSource)
        });
        const speedLabel = t('menu.voice.speed', {
            value: formatValue(effective.speed, effective.speedSource)
        });
        const resetLabel = t('menu.voice.reset');
        const backLabel = t('menu.root.back');
        const choice = await ctx.ui.select(t('menu.voice.title'), [
            modeLabel,
            modelLabel,
            voiceLabel,
            speedLabel,
            resetLabel,
            backLabel
        ]);

        if (!choice || choice === backLabel) {
            await this.handleCommand(ctx);
            return;
        }

        if (choice === modeLabel) {
            const selected = await ctx.ui.select(t('menu.voice.modePrompt'), modeChoices.map(([, label]) => label));
            const mode = modeChoices.find(([, label]) => label === selected)?.[0];
            if (mode) {
                await this.saveVoiceSettings(ctx, { ...saved, mode });
            }
            await this.manageVoiceReplySettings(ctx);
            return;
        }

        if (choice === modelLabel) {
            const input = await ctx.ui.input(t('menu.voice.modelPrompt'), saved.model ?? effective.model);
            if (input !== undefined) {
                const model = input.trim();
                if (!model) {
                    ctx.ui.notify(t('menu.voice.valueRequired'), 'error');
                } else {
                    await this.saveVoiceSettings(ctx, {
                        ...saved,
                        model: model.toLowerCase() === 'default' ? undefined : model
                    });
                }
            }
            await this.manageVoiceReplySettings(ctx);
            return;
        }

        if (choice === voiceLabel) {
            const input = await ctx.ui.input(t('menu.voice.voicePrompt'), saved.voice ?? effective.voice);
            if (input !== undefined) {
                const voice = input.trim();
                if (!voice) {
                    ctx.ui.notify(t('menu.voice.valueRequired'), 'error');
                } else {
                    await this.saveVoiceSettings(ctx, {
                        ...saved,
                        voice: voice.toLowerCase() === 'default' ? undefined : voice
                    });
                }
            }
            await this.manageVoiceReplySettings(ctx);
            return;
        }

        if (choice === speedLabel) {
            const input = await ctx.ui.input(t('menu.voice.speedPrompt'), String(saved.speed ?? effective.speed));
            if (input !== undefined) {
                const trimmed = input.trim();
                const speed = trimmed.toLowerCase() === 'default' ? undefined : Number(trimmed);
                if (speed !== undefined && (!Number.isFinite(speed) || speed < 0.5 || speed > 2)) {
                    ctx.ui.notify(t('menu.voice.speedInvalid'), 'error');
                } else {
                    await this.saveVoiceSettings(ctx, { ...saved, speed });
                }
            }
            await this.manageVoiceReplySettings(ctx);
            return;
        }

        if (choice === resetLabel) {
            const confirmed = await ctx.ui.confirm(t('menu.voice.resetTitle'), t('menu.voice.resetConfirm'));
            if (confirmed) await this.saveVoiceSettings(ctx, {});
            await this.manageVoiceReplySettings(ctx);
        }
    }

    private async saveVoiceSettings(ctx: ExtensionCommandContext, config: VoiceReplyFileConfig) {
        try {
            await saveVoiceReplyFileConfig(config);
            const effective = await loadResolvedVoiceReplyConfig();
            ctx.ui.notify(t('menu.voice.saved', {
                mode: effective.mode,
                model: effective.model || DEFAULT_TTS_MODEL,
                voice: effective.voice || DEFAULT_TTS_VOICE,
                speed: effective.speed ?? DEFAULT_TTS_SPEED
            }), 'info');
        } catch (error) {
            ctx.ui.notify(t('menu.voice.saveFailure', {
                error: error instanceof Error ? error.message : String(error)
            }), 'error');
        }
    }

    private async manageAllowList(ctx: ExtensionCommandContext) {
        const list = this.sortContactsAlphabetically(this.sessionManager.getAllowList());
        const title = t('menu.allowed.title');
        const addNumberLabel = t('menu.allowed.addNumber');
        const backLabel = t('menu.root.back');
        const options = [...list.map(contact => this.formatAllowedContactOption(contact)), addNumberLabel, backLabel];

        const choice = await ctx.ui.select(title, options);

        if (choice === addNumberLabel) {
            const num = await ctx.ui.input(t('menu.allowed.enterNumber'));
            if (num && validatePhoneNumber(num)) {
                await this.sessionManager.addNumber(num);
                ctx.ui.notify(t('menu.allowed.addedToAllowList', { number: num }), 'info');
            } else {
                ctx.ui.notify(t('menu.allowed.invalidNumber'), 'error');
            }
            await this.manageAllowList(ctx);
            return;
        }

        if (choice === backLabel || !choice) {
            await this.handleCommand(ctx);
            return;
        }

        const selectedContact = list.find(contact => this.formatAllowedContactOption(contact) === choice);
        if (!selectedContact) {
            await this.manageAllowList(ctx);
            return;
        }

        await this.manageAllowedContact(ctx, selectedContact);
    }

    private async manageAllowedContact(ctx: ExtensionCommandContext, contact: Contact) {
        const displayName = this.formatAllowedContactOption(contact);
        const title = t('menu.allowed.contact.title', { displayName });
        const historyLabel = t('menu.allowed.contact.history');
        const sendMessageLabel = t('menu.allowed.contact.sendMessage');
        const printNumberLabel = t('menu.allowed.contact.printNumber');
        const removeAliasLabel = t('menu.allowed.contact.removeAlias');
        const addAliasLabel = t('menu.allowed.contact.addAlias');
        const removeNumberLabel = t('menu.allowed.contact.removeNumber');
        const addSendNumberLabel = t('menu.allowed.contact.addNumber');
        const removeSendNumberLabel = t('menu.allowed.contact.removeSendNumber');
        const backLabel = t('menu.allowed.contact.back');
        const options = [historyLabel];
        if (contact.sendNumber) {
            options.push(sendMessageLabel);
            options.push(removeSendNumberLabel);
        } else {
            options.push(addSendNumberLabel);
        }
        options.push(printNumberLabel);
        if (contact.name) {
            options.push(removeAliasLabel);
        } else {
            options.push(addAliasLabel);
        }
        options.push(removeNumberLabel, backLabel);

        const choice = await ctx.ui.select(title, options);

        if (choice === addSendNumberLabel) {
            const input = await ctx.ui.input(t('menu.allowed.contact.enterNumber', { displayName }));
            const trimmed = input?.trim() || '';
            if (!validatePhoneNumber(trimmed)) {
                ctx.ui.notify(t('menu.allowed.invalidNumber'), 'error');
                await this.manageAllowedContact(ctx, contact);
                return;
            }
            await this.sessionManager.setContactSendNumber(contact.number, trimmed);
            ctx.ui.notify(t('menu.allowed.contact.numberAdded', { displayName }), 'info');
            await this.manageAllowedContact(ctx, { ...contact, sendNumber: trimmed });
            return;
        }

        if (choice === removeSendNumberLabel) {
            await this.sessionManager.removeContactSendNumber(contact.number);
            ctx.ui.notify(t('menu.allowed.contact.numberRemoved', { displayName }), 'info');
            await this.manageAllowedContact(ctx, { ...contact, sendNumber: undefined });
            return;
        }

        if (choice === sendMessageLabel) {
            await this.sendMessageToAllowedContact(ctx, contact);
            await this.manageAllowedContact(ctx, contact);
            return;
        }

        if (choice === historyLabel) {
            await this.showConversationHistoryForContact(ctx, contact.number, displayName);
            await this.manageAllowedContact(ctx, contact);
            return;
        }

        if (choice === printNumberLabel) {
            this.printAllowedContact(ctx, contact.number);
            await this.manageAllowedContact(ctx, contact);
            return;
        }

        if (choice === addAliasLabel) {
            const alias = await ctx.ui.input(t('menu.allowed.enterAlias', { number: contact.number }));
            const trimmedAlias = alias?.trim() || '';

            if (!trimmedAlias) {
                ctx.ui.notify(t('menu.allowed.pleaseEnterAlias'), 'error');
                await this.manageAllowedContact(ctx, contact);
                return;
            }

            await this.sessionManager.setAllowedContactAlias(contact.number, trimmedAlias);
            ctx.ui.notify(t('menu.allowed.aliasAdded', { number: contact.number }), 'info');
            await this.manageAllowedContact(ctx, { ...contact, name: trimmedAlias });
            return;
        }

        if (choice === removeAliasLabel) {
            await this.sessionManager.removeAllowedContactAlias(contact.number);
            ctx.ui.notify(t('menu.allowed.aliasRemoved', { number: contact.number }), 'info');
            await this.manageAllowedContact(ctx, { ...contact, name: undefined });
            return;
        }

        if (choice === removeNumberLabel) {
            const ok = await ctx.ui.confirm(t('menu.allowed.removeConfirmTitle'), t('menu.allowed.removeConfirmMessage', { displayName }));
            if (ok) {
                await this.sessionManager.removeNumber(contact.number);
                ctx.ui.notify(t('menu.allowed.removed', { displayName }), 'info');
            }
            await this.manageAllowList(ctx);
            return;
        }

        await this.manageAllowList(ctx);
    }

    private printAllowedContact(ctx: ExtensionCommandContext, contactNumber: string) {
        this.printedAllowedContacts.push(contactNumber);
        const output = this.printedAllowedContacts
            .map((entry) => `  • ${entry}`)
            .join('\n');
        console.log([
            t('menu.allowed.printAllowedNumbersTitle'),
            output
        ].join('\n'));
        ctx.ui.notify(this.printedAllowedContacts.join('\n'), 'info');
    }

    private async manageAllowedGroups(ctx: ExtensionCommandContext) {
        const list = this.sortContactsAlphabetically(this.sessionManager.getAllowedGroups());
        const title = t('menu.allowedGroups.title');
        const addGroupLabel = t('menu.allowedGroups.addGroup');
        const backLabel = t('menu.root.back');
        const options = [...list.map(group => this.formatAllowedGroupOption(group)), addGroupLabel, backLabel];

        const choice = await ctx.ui.select(title, options);

        if (choice === addGroupLabel) {
            const groupJid = await ctx.ui.input(t('menu.allowedGroups.enterGroup'));
            if (groupJid && SessionManager.isGroupJid(groupJid)) {
                await this.sessionManager.addAllowedGroup(groupJid);
                ctx.ui.notify(t('menu.allowedGroups.addedToAllowList', { groupJid }), 'info');
            } else {
                ctx.ui.notify(t('menu.allowedGroups.invalidGroup'), 'error');
            }
            await this.manageAllowedGroups(ctx);
            return;
        }

        if (choice === backLabel || !choice) {
            await this.handleCommand(ctx);
            return;
        }

        const selectedGroup = list.find(group => this.formatAllowedGroupOption(group) === choice);
        if (!selectedGroup) {
            await this.manageAllowedGroups(ctx);
            return;
        }

        await this.manageAllowedGroup(ctx, selectedGroup);
    }

    private async manageAllowedGroup(ctx: ExtensionCommandContext, group: Contact) {
        const displayName = this.formatAllowedGroupOption(group);
        const title = t('menu.allowedGroups.group.title', { displayName });
        const historyLabel = t('menu.allowedGroups.group.history');
        const sendMessageLabel = t('menu.allowedGroups.group.sendMessage');
        const printGroupLabel = t('menu.allowedGroups.group.printGroup');
        const removeAliasLabel = t('menu.allowedGroups.group.removeAlias');
        const addAliasLabel = t('menu.allowedGroups.group.addAlias');
        const removeGroupLabel = t('menu.allowedGroups.group.removeGroup');
        const backLabel = t('menu.allowedGroups.group.back');
        const options = [historyLabel, sendMessageLabel, printGroupLabel];
        if (group.name) {
            options.push(removeAliasLabel);
        } else {
            options.push(addAliasLabel);
        }
        options.push(removeGroupLabel, backLabel);

        const choice = await ctx.ui.select(title, options);

        if (choice === sendMessageLabel) {
            await this.sendMessageToAllowedGroup(ctx, group);
            await this.manageAllowedGroup(ctx, group);
            return;
        }

        if (choice === historyLabel) {
            await this.showConversationHistoryForContact(ctx, group.number, displayName);
            await this.manageAllowedGroup(ctx, group);
            return;
        }

        if (choice === printGroupLabel) {
            this.printAllowedGroup(ctx, group.number);
            await this.manageAllowedGroup(ctx, group);
            return;
        }

        if (choice === addAliasLabel) {
            const alias = await ctx.ui.input(t('menu.allowedGroups.enterAlias', { groupJid: group.number }));
            const trimmedAlias = alias?.trim() || '';

            if (!trimmedAlias) {
                ctx.ui.notify(t('menu.allowedGroups.pleaseEnterAlias'), 'error');
                await this.manageAllowedGroup(ctx, group);
                return;
            }

            await this.sessionManager.setAllowedGroupAlias(group.number, trimmedAlias);
            ctx.ui.notify(t('menu.allowedGroups.aliasAdded', { groupJid: group.number }), 'info');
            await this.manageAllowedGroup(ctx, { ...group, name: trimmedAlias });
            return;
        }

        if (choice === removeAliasLabel) {
            await this.sessionManager.removeAllowedGroupAlias(group.number);
            ctx.ui.notify(t('menu.allowedGroups.aliasRemoved', { groupJid: group.number }), 'info');
            await this.manageAllowedGroup(ctx, { ...group, name: undefined });
            return;
        }

        if (choice === removeGroupLabel) {
            const ok = await ctx.ui.confirm(t('menu.allowedGroups.removeConfirmTitle'), t('menu.allowedGroups.removeConfirmMessage', { displayName }));
            if (ok) {
                await this.sessionManager.removeAllowedGroup(group.number);
                ctx.ui.notify(t('menu.allowedGroups.removed', { displayName }), 'info');
            }
            await this.manageAllowedGroups(ctx);
            return;
        }

        await this.manageAllowedGroups(ctx);
    }

    private printAllowedGroup(ctx: ExtensionCommandContext, groupJid: string) {
        this.printedAllowedGroups.push(groupJid);
        const output = this.printedAllowedGroups
            .map((entry) => `  • ${entry}`)
            .join('\n');
        console.log([
            t('menu.allowedGroups.printAllowedGroupsTitle'),
            output
        ].join('\n'));
        ctx.ui.notify(this.printedAllowedGroups.join('\n'), 'info');
    }

    private async manageRecents(ctx: ExtensionCommandContext) {
        const recentConversations = await this.recentsService.getRecentConversations();
        const groupedEntries = this.groupRecentConversations(recentConversations);
        const title = t('menu.recents.title');
        const backLabel = t('menu.root.back');
        const nextLabel = 'Next';
        const previousLabel = 'Previous';
        const pageSize = 10;

        if (groupedEntries.length === 0) {
            ctx.ui.notify(t('menu.recents.empty'), 'info');
            await this.handleCommand(ctx);
            return;
        }

        for (let page = 0; page * pageSize < groupedEntries.length;) {
            const start = page * pageSize;
            const pageEntries = groupedEntries.slice(start, start + pageSize);
            const options = [
                ...pageEntries.map(entry => this.formatGroupedRecentOption(entry)),
                ...(page > 0 ? [previousLabel] : []),
                ...(start + pageSize < groupedEntries.length ? [nextLabel] : []),
                backLabel
            ];

            const choice = await ctx.ui.select(title, options);
            if (!choice || choice === backLabel) {
                await this.handleCommand(ctx);
                return;
            }

            if (choice === nextLabel) {
                page += 1;
                continue;
            }

            if (choice === previousLabel) {
                page = Math.max(0, page - 1);
                continue;
            }

            const selectedEntry = pageEntries.find(entry =>
                this.formatGroupedRecentOption(entry) === choice
            );

            if (!selectedEntry) {
                return;
            }

            await this.manageRecentConversation(ctx, selectedEntry.conversations[0]);
            return;
        }
    }

    private async manageRecentConversation(ctx: ExtensionCommandContext, conversation: RecentConversationSummary) {
        await this.identityMapService.ensureInitialized();
        const displayName = this.getConversationDisplayName(conversation);
        const isGroup = SessionManager.isGroupJid(conversation.senderNumber);
        const allowedContact = isGroup
            ? this.sessionManager.getAllowedGroup(conversation.senderNumber)
            : this.sessionManager.getAllowedContact(conversation.senderNumber);
        const identity = isGroup ? undefined : this.identityMapService.get(conversation.senderNumber);
        const title = t('menu.recents.contact.title', { displayName });
        const historyLabel = t('menu.recents.contact.history');
        const allowContactLabel = isGroup
            ? t('menu.recents.contact.allowGroup')
            : t('menu.recents.contact.allowNumber');
        const linkPhoneLabel = t('menu.recents.contact.linkPhone');
        const linkEmailLabel = t('menu.recents.contact.linkEmail');
        const linkExternalRecordLabel = t('menu.recents.contact.linkExternalRecord');
        const clearIdentityLabel = t('menu.recents.contact.clearIdentity');
        const removeAliasLabel = t('menu.recents.contact.removeAlias');
        const backLabel = t('menu.recents.contact.back');
        const options: string[] = [historyLabel];

        if (!allowedContact) {
            options.push(allowContactLabel);
        }

        if (!isGroup) {
            options.push(linkPhoneLabel, linkEmailLabel, linkExternalRecordLabel);
            if (identity && (identity.phone || identity.email || identity.externalRecordId)) {
                options.push(clearIdentityLabel);
            }
        }

        if (allowedContact?.name) {
            options.push(removeAliasLabel);
        }

        options.push(backLabel);

        const choice = await ctx.ui.select(title, options);

        if (choice === allowContactLabel) {
            if (allowedContact) {
                ctx.ui.notify(t('menu.recents.alreadyAllowed', { number: conversation.senderNumber }), 'info');
            } else if (isGroup) {
                await this.sessionManager.addAllowedGroup(conversation.senderNumber, conversation.senderName);
                ctx.ui.notify(t('menu.recents.addedGroupToAllowList', { groupJid: conversation.senderNumber }), 'info');
            } else {
                await this.sessionManager.addNumber(conversation.senderNumber, conversation.senderName);
                ctx.ui.notify(t('menu.recents.addedToAllowList', { number: conversation.senderNumber }), 'info');
            }
            await this.manageRecentConversation(ctx, conversation);
            return;
        }

        if (choice === linkPhoneLabel) {
            await this.linkRecentPhone(ctx, conversation);
            return;
        }

        if (choice === linkEmailLabel) {
            await this.linkRecentEmail(ctx, conversation);
            return;
        }

        if (choice === linkExternalRecordLabel) {
            await this.linkRecentExternalRecord(ctx, conversation);
            return;
        }

        if (choice === clearIdentityLabel) {
            await this.identityMapService.clearLinkedIdentity(conversation.senderNumber);
            ctx.ui.notify(t('menu.recents.identityCleared', { number: conversation.senderNumber }), 'info');
            await this.manageRecentConversation(ctx, conversation);
            return;
        }

        if (choice === removeAliasLabel) {
            if (isGroup) {
                await this.sessionManager.removeAllowedGroupAlias(conversation.senderNumber);
            } else {
                await this.sessionManager.removeAllowedContactAlias(conversation.senderNumber);
            }
            ctx.ui.notify(t('menu.recents.aliasRemoved', { number: conversation.senderNumber }), 'info');
            await this.manageRecentConversation(ctx, {
                ...conversation,
                senderName: undefined
            });
            return;
        }

        if (choice === historyLabel) {
            await this.showConversationHistory(ctx, conversation);
            await this.manageRecentConversation(ctx, conversation);
            return;
        }

        await this.manageRecents(ctx);
    }

    private async linkRecentPhone(ctx: ExtensionCommandContext, conversation: RecentConversationSummary) {
        const input = await ctx.ui.input(t('menu.recents.identity.enterPhone', { number: conversation.senderNumber }));
        const phone = normalizePhoneDigits(input || '');
        if (!phone) {
            ctx.ui.notify(t('menu.recents.identity.invalidPhone'), 'error');
            await this.manageRecentConversation(ctx, conversation);
            return;
        }

        await this.identityMapService.setManualMapping(conversation.senderNumber, {
            phone,
            pushName: conversation.senderName
        });
        ctx.ui.notify(t('menu.recents.identity.phoneLinked', { phone }), 'info');
        await this.manageRecentConversation(ctx, conversation);
    }

    private async linkRecentEmail(ctx: ExtensionCommandContext, conversation: RecentConversationSummary) {
        const input = await ctx.ui.input(t('menu.recents.identity.enterEmail', { number: conversation.senderNumber }));
        const email = normalizeIdentityEmail(input || '');
        if (!email || !email.includes('@')) {
            ctx.ui.notify(t('menu.recents.identity.invalidEmail'), 'error');
            await this.manageRecentConversation(ctx, conversation);
            return;
        }

        await this.identityMapService.setManualMapping(conversation.senderNumber, {
            email,
            pushName: conversation.senderName
        });
        ctx.ui.notify(t('menu.recents.identity.emailLinked', { email }), 'info');
        await this.manageRecentConversation(ctx, conversation);
    }

    private async linkRecentExternalRecord(ctx: ExtensionCommandContext, conversation: RecentConversationSummary) {
        const externalRecordId = (await ctx.ui.input(t('menu.recents.identity.enterExternalRecord', { number: conversation.senderNumber })))?.trim() || '';
        if (!externalRecordId) {
            ctx.ui.notify(t('menu.recents.identity.invalidExternalRecord'), 'error');
            await this.manageRecentConversation(ctx, conversation);
            return;
        }

        await this.identityMapService.setManualMapping(conversation.senderNumber, {
            externalRecordId,
            pushName: conversation.senderName
        });
        ctx.ui.notify(t('menu.recents.identity.externalRecordLinked', { externalRecordId }), 'info');
        await this.manageRecentConversation(ctx, conversation);
    }

    private async sendMessageToAllowedContact(ctx: ExtensionCommandContext, contact: Contact) {
        await this.sendPromptedMenuMessage(ctx, {
            displayName: this.formatAllowedContactOption(contact),
            senderNumber: contact.sendNumber!,
            senderName: contact.name
        });
    }

    private async sendMessageToAllowedGroup(ctx: ExtensionCommandContext, group: Contact) {
        await this.sendPromptedMenuMessage(ctx, {
            displayName: this.formatAllowedGroupOption(group),
            senderNumber: group.number,
            senderName: group.name
        });
    }

    private async sendPromptedMenuMessage(
        ctx: ExtensionCommandContext,
        options: {
            displayName: string;
            senderNumber: string;
            senderName?: string;
        }
    ) {
        const { displayName, senderNumber, senderName } = options;
        for (let attempt = 0; attempt < 2; attempt++) {
            const inputText = (await ctx.ui.input(t('menu.allowed.sendPrompt', { displayName })))?.trim() || '';

            if (!inputText) {
                ctx.ui.notify(t('menu.allowed.messageRequired'), 'error');
                continue;
            }

            const messageText = inputText;
            const result = await this.whatsappService.sendMenuMessage(this.toJid(senderNumber), messageText);
            if (result.success) {
                await this.recentsService.recordMessage({
                    messageId: result.messageId ?? `${Date.now()}`,
                    senderNumber,
                    senderName,
                    text: messageText,
                    direction: 'outgoing',
                    timestamp: Date.now()
                });
                ctx.ui.notify(t('menu.allowed.sendSuccess', { displayName }), 'info');
            } else {
                ctx.ui.notify(t('menu.allowed.sendFailure', { displayName, error: result.error ?? 'Unknown error' }), 'error');
            }
            return;
        }
    }

    private async showConversationHistory(ctx: ExtensionCommandContext, conversation: RecentConversationSummary) {
        await this.showConversationHistoryForContact(
            ctx,
            conversation.senderNumber,
            this.getConversationDisplayName(conversation),
            conversation.senderName
        );
    }

    private async showConversationHistoryForContact(
        ctx: ExtensionCommandContext,
        senderNumber: string,
        displayName: string,
        senderName?: string
    ) {
        const history = await this.recentsService.getConversationHistory(senderNumber);

        if (history.length === 0) {
            ctx.ui.notify(t('menu.recents.history.empty'), 'info');
            return;
        }

        const sortedHistory = this.sortHistoryByMostRecent(history);
        const pageSize = 10;
        const backLabel = t('menu.root.back');
        const nextLabel = 'Next';
        const previousLabel = 'Previous';

        for (let page = 0; page * pageSize < sortedHistory.length;) {
            const start = page * pageSize;
            const pageHistory = sortedHistory.slice(start, start + pageSize);
            const historyOptions = this.buildHistoryOptions(pageHistory);
            const choice = await ctx.ui.select(t('menu.recents.history.title', { displayName }), [
                ...historyOptions.map(option => option.label),
                ...(page > 0 ? [previousLabel] : []),
                ...(start + pageSize < sortedHistory.length ? [nextLabel] : []),
                backLabel
            ]);

            if (!choice || choice === backLabel) {
                return;
            }

            if (choice === nextLabel) {
                page += 1;
                continue;
            }

            if (choice === previousLabel) {
                page = Math.max(0, page - 1);
                continue;
            }

            const selectedMessage = this.resolveHistorySelection(choice, historyOptions);
            if (!selectedMessage) {
                return;
            }

            const detailAction = await showMessageDetailView(ctx, {
                title: t('menu.recents.history.messageTitle', { displayName }),
                messageId: selectedMessage.messageId,
                senderNumber: selectedMessage.senderNumber,
                senderName,
                text: selectedMessage.text,
                direction: selectedMessage.direction,
                timestamp: selectedMessage.timestamp
            });

            if (detailAction === 'reply') {
                await showMessageReplyView(ctx, {
                    selectedMessage: {
                        messageId: selectedMessage.messageId,
                        senderNumber: selectedMessage.senderNumber,
                        senderName,
                        text: selectedMessage.text,
                        direction: selectedMessage.direction,
                        timestamp: selectedMessage.timestamp
                    },
                    whatsappService: this.whatsappService,
                    recentsService: this.recentsService
                });
            }
        }
    }

    private buildHistoryOptions(history: RecentConversationMessage[]): HistoryOptionEntry[] {
        return history.map(message => ({
            label: this.formatHistoryOption(message.timestamp, message.direction, message.text),
            message
        }));
    }

    private resolveHistorySelection(choice: string, options: HistoryOptionEntry[]): RecentConversationMessage | undefined {
        return options.find(option => option.label === choice)?.message;
    }

    private getRecentsGroupKey(conversation: RecentConversationSummary): string {
        if (conversation.lastMessageDirection === 'outgoing') {
            return `outgoing::${conversation.senderNumber}`;
        }
        const d = new Date(conversation.lastMessageTime);
        const minuteKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
        return `${conversation.lastMessagePreview}::${minuteKey}`;
    }

    private groupRecentConversations(conversations: RecentConversationSummary[]): GroupedRecentEntry[] {
        const groups = new Map<string, RecentConversationSummary[]>();
        for (const conversation of conversations) {
            const key = this.getRecentsGroupKey(conversation);
            const existing = groups.get(key) ?? [];
            existing.push(conversation);
            groups.set(key, existing);
        }
        return Array.from(groups.values()).map(members => ({
            conversations: members,
            sharedPreview: members[0].lastMessagePreview,
            sharedTime: members[0].lastMessageTime
        }));
    }

    private formatGroupedRecentOption(entry: GroupedRecentEntry): string {
        if (entry.conversations.length === 1) {
            return this.formatRecentConversationOption(entry.conversations[0]);
        }
        const time = this.formatDateTime(entry.sharedTime);
        const identifiers = entry.conversations
            .map(c => c.senderName ? `[${c.senderNumber}] ${c.senderName}` : `(${c.senderNumber})`)
            .join(' ');
        return `${identifiers} • ${time} • ${entry.sharedPreview}`;
    }

    private formatRecentConversationOption(conversation: RecentConversationSummary): string {
        const displayName = this.getConversationDisplayName(conversation);
        const time = this.formatDateTime(conversation.lastMessageTime);
        return `${displayName} • ${time} • ${conversation.lastMessagePreview}`;
    }

    private formatAllowedContactOption(contact: Contact): string {
        const base = contact.name ? `${contact.name} [${contact.number}]` : contact.number;
        return contact.sendNumber ? `${base} (${contact.sendNumber})` : base;
    }

    private formatAllowedGroupOption(group: Contact): string {
        return group.name ? `${group.name} (${group.number})` : group.number;
    }


    private sortContactsAlphabetically(contacts: Contact[]): Contact[] {
        return [...contacts].sort((left, right) => {
            const leftLabel = this.formatAllowedContactSortKey(left);
            const rightLabel = this.formatAllowedContactSortKey(right);
            return leftLabel.localeCompare(rightLabel, undefined, { sensitivity: 'base' });
        });
    }

    private formatAllowedContactSortKey(contact: Contact): string {
        return contact.name ? `${contact.name} ${contact.number}` : contact.number;
    }

    private parseContactNumberOption(choice: string): string {
        if (!choice.includes('(')) {
            return choice;
        }

        const match = choice.match(/\((.*?)\)/);
        return match?.[1] ?? choice;
    }

    private sortHistoryByMostRecent<T extends { timestamp: number }>(history: T[]): T[] {
        return [...history].sort((left, right) => {
            const dayComparison = this.getDayStart(right.timestamp) - this.getDayStart(left.timestamp);
            if (dayComparison !== 0) {
                return dayComparison;
            }

            return this.getTimeOfDay(right.timestamp) - this.getTimeOfDay(left.timestamp);
        });
    }

    private getTimeOfDay(timestamp: number): number {
        const date = new Date(timestamp);
        return date.getHours() * 60 * 60 * 1000
            + date.getMinutes() * 60 * 1000
            + date.getSeconds() * 1000
            + date.getMilliseconds();
    }

    private getDayStart(timestamp: number): number {
        const date = new Date(timestamp);
        return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    }

    private formatHistoryOption(timestamp: number, direction: string, text: string): string {
        const marker = direction === 'outgoing' ? t('menu.recents.history.sent') : t('menu.recents.history.received');
        const displayText = this.truncate(text, 60) || t('menu.recents.history.noText');
        return `${this.formatDateTimeWithSeconds(timestamp)} • ${marker} • ${displayText}`;
    }

    private getConversationDisplayName(conversation: RecentConversationSummary): string {
        const isGroup = SessionManager.isGroupJid(conversation.senderNumber);
        const allowedContact = isGroup
            ? this.sessionManager.getAllowedGroup(conversation.senderNumber)
            : this.sessionManager.getAllowedContact(conversation.senderNumber);
        const displayName = allowedContact?.name || conversation.senderName;
        const prefix = isGroup ? '[Group] ' : '';
        return displayName ? `${prefix}${displayName} (${conversation.senderNumber})` : `${prefix}${conversation.senderNumber}`;
    }

    private formatDateTime(timestamp: number): string {
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'short',
            timeStyle: 'short'
        }).format(new Date(timestamp));
    }

    private formatDateTimeWithSeconds(timestamp: number): string {
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'short',
            timeStyle: 'medium'
        }).format(new Date(timestamp));
    }

    private truncate(value: string, maxLength: number): string {
        const normalized = value.trim().replace(/\s+/g, ' ');
        if (!normalized) {
            return '';
        }
        if (normalized.length <= maxLength) {
            return normalized;
        }
        return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
    }

    private toJid(number: string): string {
        if (number.includes('@')) {
            return number;
        }

        const normalized = number.startsWith('+') ? number.slice(1) : number;
        return `${normalized}@s.whatsapp.net`;
    }
}
