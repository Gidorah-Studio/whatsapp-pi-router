import { chmod, mkdir, readdir, readFile, rename, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { createStoragePaths } from './storage-path.js';
import type { RecentsService } from './recents.service.js';
import type { WhatsAppPiLogger } from './whatsapp-pi.logger.js';
import type { WhatsAppService } from './whatsapp.service.js';

const DEFAULT_POLL_MS = 2000;
const MIN_POLL_MS = 500;
const MAX_TEXT_LENGTH = 4096;

interface OutboundQueueJob {
    id?: unknown;
    version?: unknown;
    phone?: unknown;
    jid?: unknown;
    recipientJid?: unknown;
    text?: unknown;
    source?: unknown;
    leadId?: unknown;
    approvedBy?: unknown;
    createdAt?: unknown;
    contactName?: unknown;
}

interface ValidatedOutboundJob {
    id: string;
    job: Record<string, unknown>;
    recipientJid: string;
    recentSenderNumber: string;
    text: string;
}

export class OutboundQueueService {
    private readonly storagePaths = createStoragePaths();
    private timer?: ReturnType<typeof setTimeout>;
    private running = false;
    private processing = false;

    constructor(
        private readonly whatsappService: WhatsAppService,
        private readonly recentsService: RecentsService,
        private readonly logger: WhatsAppPiLogger,
    ) {}

    async start(): Promise<void> {
        if (this.running) return;
        await this.ensureQueueDirectories();
        this.running = true;
        this.logger.log(`[WhatsApp-Pi-Router] Outbound queue polling ${this.storagePaths.outboundPendingDir} every ${this.getPollMs()}ms`);
        this.schedule(0);
    }

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    private async ensureQueueDirectories(): Promise<void> {
        for (const path of [
            this.storagePaths.outboundQueueDir,
            this.storagePaths.outboundPendingDir,
            this.storagePaths.outboundProcessingDir,
            this.storagePaths.outboundSentDir,
            this.storagePaths.outboundFailedDir,
        ]) {
            await mkdir(path, { recursive: true, mode: 0o700 });
            await chmod(path, 0o700).catch(() => undefined);
        }
    }

    private getPollMs(): number {
        const configured = Number.parseInt(process.env.WHATSAPP_ROUTER_OUTBOUND_POLL_MS || '', 10);
        if (Number.isFinite(configured) && configured >= MIN_POLL_MS) {
            return configured;
        }
        return DEFAULT_POLL_MS;
    }

    private schedule(delayMs = this.getPollMs()): void {
        if (!this.running) return;
        this.timer = setTimeout(() => {
            void this.tick();
        }, delayMs);
    }

    private async tick(): Promise<void> {
        if (!this.running) return;
        if (this.processing) {
            this.schedule();
            return;
        }

        this.processing = true;
        let processedJob = false;
        try {
            processedJob = await this.processNextPendingJob();
        } catch (error) {
            this.logger.error('[WhatsApp-Pi-Router] Outbound queue tick failed:', error);
        } finally {
            this.processing = false;
            this.schedule(processedJob ? 0 : this.getPollMs());
        }
    }

    private async processNextPendingJob(): Promise<boolean> {
        if (this.whatsappService.getEffectiveStatus() !== 'connected') {
            return false;
        }

        const files = (await readdir(this.storagePaths.outboundPendingDir))
            .filter(file => file.endsWith('.json'))
            .sort();

        for (const file of files) {
            const claimedPath = await this.claimPendingFile(file);
            if (!claimedPath) continue;
            await this.processClaimedJob(claimedPath);
            return true;
        }

        return false;
    }

    private async claimPendingFile(file: string): Promise<string | null> {
        const pendingPath = join(this.storagePaths.outboundPendingDir, file);
        const processingPath = join(this.storagePaths.outboundProcessingDir, file);
        try {
            await rename(pendingPath, processingPath);
            return processingPath;
        } catch (error) {
            const code = typeof error === 'object' && error !== null && 'code' in error
                ? (error as { code?: string }).code
                : undefined;
            if (code === 'ENOENT') return null;
            this.logger.warn(`[WhatsApp-Pi-Router] Failed to claim outbound queue file ${file}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    private async processClaimedJob(processingPath: string): Promise<void> {
        let raw = '';
        let parsed: unknown;
        let validated: ValidatedOutboundJob | undefined;

        try {
            raw = await readFile(processingPath, 'utf-8');
            parsed = JSON.parse(raw) as unknown;
            validated = this.validateJob(parsed, basename(processingPath, '.json'));
        } catch (error) {
            await this.completeJob(processingPath, this.storagePaths.outboundFailedDir, {
                id: basename(processingPath, '.json'),
                status: 'failed',
                failedAt: new Date().toISOString(),
                error: error instanceof Error ? error.message : String(error),
                original: raw ? raw.slice(0, 2000) : undefined,
            });
            return;
        }

        try {
            this.logger.log(`[WhatsApp-Pi-Router] Sending outbound queue job ${validated.id} to ${validated.recipientJid}`);
            const result = await this.whatsappService.sendMessage(validated.recipientJid, validated.text);
            const actualRecipientJid = result.recipientJid ?? validated.recipientJid;

            if (!result.success) {
                await this.completeJob(processingPath, this.storagePaths.outboundFailedDir, {
                    ...validated.job,
                    id: validated.id,
                    status: 'failed',
                    recipientJid: validated.recipientJid,
                    failedAt: new Date().toISOString(),
                    result,
                    error: result.error ?? 'WhatsApp send failed',
                });
                return;
            }

            await this.recentsService.recordMessage({
                messageId: result.messageId ?? `outbound-${validated.id}-${Date.now()}`,
                senderNumber: this.toRecentSenderNumber(actualRecipientJid),
                senderName: typeof validated.job.contactName === 'string' ? validated.job.contactName : undefined,
                text: validated.text,
                direction: 'outgoing',
                timestamp: Date.now(),
            });

            await this.completeJob(processingPath, this.storagePaths.outboundSentDir, {
                ...validated.job,
                id: validated.id,
                status: 'sent',
                recipientJid: actualRecipientJid,
                requestedRecipientJid: validated.recipientJid,
                sentAt: new Date().toISOString(),
                result,
            });
        } catch (error) {
            await this.completeJob(processingPath, this.storagePaths.outboundFailedDir, {
                ...(validated?.job ?? {}),
                id: validated?.id ?? basename(processingPath, '.json'),
                status: 'failed',
                recipientJid: validated?.recipientJid,
                failedAt: new Date().toISOString(),
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private validateJob(parsed: unknown, fileId: string): ValidatedOutboundJob {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Outbound job must be a JSON object');
        }

        const job = parsed as Record<string, unknown> & OutboundQueueJob;
        const id = this.normalizeJobId(job.id, fileId);
        const text = typeof job.text === 'string' ? job.text.trim() : '';
        if (!text) {
            throw new Error('Outbound job requires non-empty text');
        }
        if (text.length > MAX_TEXT_LENGTH) {
            throw new Error(`Outbound job text exceeds ${MAX_TEXT_LENGTH} characters`);
        }

        const recipientJid = this.normalizeRecipientJid(job);
        return {
            id,
            job,
            recipientJid,
            recentSenderNumber: this.toRecentSenderNumber(recipientJid),
            text,
        };
    }

    private normalizeJobId(id: unknown, fallback: string): string {
        const value = (typeof id === 'string' ? id : fallback).trim();
        if (!/^[A-Za-z0-9._-]{1,120}$/.test(value)) {
            throw new Error('Outbound job id must be 1-120 characters of letters, numbers, dot, underscore, or dash');
        }
        return value;
    }

    private normalizeRecipientJid(job: OutboundQueueJob): string {
        const rawJid = this.stringValue(job.jid) ?? this.stringValue(job.recipientJid);
        if (rawJid) {
            return this.normalizeDirectJid(rawJid);
        }

        const phone = this.stringValue(job.phone);
        if (!phone) {
            throw new Error('Outbound job requires phone or jid');
        }
        return this.phoneToJid(phone);
    }

    private normalizeDirectJid(value: string): string {
        const trimmed = value.trim();
        if (!trimmed.includes('@')) {
            return this.phoneToJid(trimmed);
        }
        if (trimmed.endsWith('@g.us')) {
            throw new Error('Outbound queue does not send group messages');
        }
        if (!trimmed.endsWith('@s.whatsapp.net') && !trimmed.endsWith('@lid')) {
            throw new Error('Outbound job jid must be a direct WhatsApp JID');
        }
        return trimmed;
    }

    private phoneToJid(phone: string): string {
        const digits = phone.replace(/\D+/g, '');
        if (digits.length < 8 || digits.length > 18) {
            throw new Error('Outbound job phone must include a country/area code and 8-18 digits total');
        }
        return `${digits}@s.whatsapp.net`;
    }

    private toRecentSenderNumber(jid: string): string {
        if (jid.endsWith('@g.us') || jid.endsWith('@lid')) return jid;
        const local = jid.split('@')[0].split(':')[0];
        return /^\d+$/.test(local) ? `+${local}` : jid;
    }

    private stringValue(value: unknown): string | undefined {
        if (typeof value !== 'string') return undefined;
        const trimmed = value.trim();
        return trimmed || undefined;
    }

    private async completeJob(processingPath: string, destinationDir: string, payload: Record<string, unknown>): Promise<void> {
        await writeFile(processingPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
        await rename(processingPath, join(destinationDir, basename(processingPath)));
    }
}
