import { AudioService } from './audio.service.js';
import type { IncomingResolution } from './incoming-message.resolver.js';
import { WhatsAppPiLogger } from './whatsapp-pi.logger.js';
import { t } from '../i18n.js';
import { downloadBoundedMedia } from './bounded-media.js';
import type { IncomingMediaTurn } from './incoming-media-storage.js';
import { runMediaWorker } from './media-worker.js';
import { safeFailure } from './router-errors.js';

export interface ProcessedIncomingContent {
    text: string;
    imageBuffer?: Buffer;
    imageMimeType?: string;
    documentPath?: string;
}

export class IncomingMediaService {
    constructor(
        private readonly audioService: AudioService,
        private readonly logger = new WhatsAppPiLogger(false),
        private readonly downloadMedia = downloadBoundedMedia,
        private readonly runWorker = runMediaWorker,
    ) {}

    async process(resolved: IncomingResolution, _pushName: string, turn: IncomingMediaTurn, signal?: AbortSignal): Promise<ProcessedIncomingContent> {
        signal?.throwIfAborted();
        if (resolved.kind === 'audio') {
            const transcription = await this.audioService.transcribe(resolved.audioMessage, turn, signal);
            return { text: t('incoming.media.audioTranscribed', { transcription }) };
        }
        if (resolved.kind === 'image') {
            const imageBuffer = await this.downloadMedia(resolved.imageMessage, 'image', signal);
            const rawMime = String(resolved.imageMessage.mimetype || 'image/jpeg');
            let imageMimeType = rawMime.toLowerCase().split(';')[0].trim();
            if (imageMimeType === 'image/jpg') imageMimeType = 'image/jpeg';
            return { text: resolved.text || t('incoming.media.image'), imageBuffer, imageMimeType };
        }
        if (resolved.kind === 'document') return this.processDocument(resolved.documentMessage, turn, signal, false);
        return { text: resolved.text };
    }

    async processQuotedPdf(document: any, turn: IncomingMediaTurn, signal?: AbortSignal): Promise<ProcessedIncomingContent> {
        const fileName = String(document?.fileName || 'quoted.pdf').slice(0, 255);
        const mimeType = String(document?.mimetype || 'application/octet-stream').toLowerCase().split(';')[0].trim();
        if (mimeType !== 'application/pdf' && !fileName.toLowerCase().endsWith('.pdf')) {
            throw new Error('Quoted document is not a PDF');
        }
        return this.processDocument(document, turn, signal, true);
    }

    private async processDocument(document: any, turn: IncomingMediaTurn, signal?: AbortSignal, temporary = false): Promise<ProcessedIncomingContent> {
        const fileName = String(document.fileName || 'unnamed_document').slice(0, 255);
        const mimeType = String(document.mimetype || 'application/octet-stream').slice(0, 100);
        const buffer = await this.downloadMedia(document, 'document', signal);
        const path = temporary
            ? await turn.saveTemporaryDocument(fileName, buffer)
            : await turn.saveDocument(fileName, buffer);
        let text = t('incoming.media.documentReceived', { fileName }) + '\n'
            + t('incoming.media.documentMimeType', { mimeType }) + '\n'
            + t('incoming.media.documentSize', { size: `${(buffer.length / 1024).toFixed(1)} KB` }) + '\n'
            + t('incoming.media.documentLocation', { relativePath: path });
        if (mimeType.toLowerCase().split(';')[0].trim() === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
            try {
                const preview = (await this.runWorker('pdf', path, signal)).trim();
                text += `\n\n${preview ? t('incoming.media.documentPdfPreviewHeading') + '\n' + preview : t('incoming.media.documentPdfFallbackNotice')}`;
            } catch (error) {
                signal?.throwIfAborted();
                this.logger.warn(safeFailure(error, 'pdf-preview').diagnostic);
                text += `\n\n${t('incoming.media.documentPdfFallbackNotice')}`;
            }
        }
        if (document.caption) text += `\n\n${t('incoming.media.documentDescription', { caption: String(document.caption).slice(0, 65536) })}`;
        return { text, documentPath: path };
    }
}
