import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

export const MAX_WHATSAPP_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_WHATSAPP_IMAGE_CAPTION_LENGTH = 1024;
export const IMAGE_HANDOFF_MANIFEST = 'result.json';

export type WhatsAppImageMimeType = 'image/jpeg' | 'image/png';

export interface RoutedImageHandoff {
    path: string;
    mimeType: WhatsAppImageMimeType;
    caption?: string;
}

interface ImageHandoffManifest {
    version: 1;
    type: 'image';
    imageFile: string;
    mimeType: WhatsAppImageMimeType;
    caption?: string;
}

export async function createImageHandoffDirectory(mediaDir: string): Promise<string> {
    const root = join(mediaDir, 'outbound-images');
    const handoffDir = join(root, `turn-${Date.now()}-${randomUUID()}`);
    await mkdir(handoffDir, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700).catch(() => undefined);
    await chmod(handoffDir, 0o700);
    return handoffDir;
}

export async function stageImageHandoff(params: {
    sourcePath: string;
    handoffDir: string;
    caption?: string;
}): Promise<RoutedImageHandoff> {
    const sourcePath = resolve(params.sourcePath);
    const sourceStats = await lstat(sourcePath);
    if (!sourceStats.isFile()) {
        throw new Error('WhatsApp image path must point to a regular file');
    }
    validateImageSize(sourceStats.size);

    const mimeType = await detectImageMimeType(sourcePath);
    const caption = normalizeCaption(params.caption);
    await mkdir(params.handoffDir, { recursive: true, mode: 0o700 });
    await chmod(params.handoffDir, 0o700);

    const imageFile = `${randomUUID()}${extensionForMimeType(mimeType)}`;
    const stagedPath = join(params.handoffDir, imageFile);
    await copyFile(sourcePath, stagedPath, fsConstants.COPYFILE_EXCL);
    await chmod(stagedPath, 0o600);

    const manifest: ImageHandoffManifest = {
        version: 1,
        type: 'image',
        imageFile,
        mimeType,
        ...(caption ? { caption } : {})
    };
    const manifestPath = join(params.handoffDir, IMAGE_HANDOFF_MANIFEST);
    const tempManifestPath = join(params.handoffDir, `.result-${randomUUID()}.tmp`);

    try {
        await writeFile(tempManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx'
        });
        await chmod(tempManifestPath, 0o600);
        await rename(tempManifestPath, manifestPath);
    } catch (error) {
        await Promise.allSettled([
            rm(tempManifestPath, { force: true }),
            rm(stagedPath, { force: true })
        ]);
        throw error;
    }

    return {
        path: stagedPath,
        mimeType,
        ...(caption ? { caption } : {})
    };
}

export async function loadImageHandoff(handoffDir: string): Promise<RoutedImageHandoff | undefined> {
    const manifestPath = join(handoffDir, IMAGE_HANDOFF_MANIFEST);
    let raw: string;
    try {
        raw = await readFile(manifestPath, 'utf8');
    } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') return undefined;
        throw error;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch (error) {
        throw new Error(`Invalid WhatsApp image handoff JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid WhatsApp image handoff: expected an object');
    }

    const manifest = parsed as Partial<ImageHandoffManifest>;
    if (manifest.version !== 1 || manifest.type !== 'image') {
        throw new Error('Invalid WhatsApp image handoff version or type');
    }
    if (typeof manifest.imageFile !== 'string'
        || basename(manifest.imageFile) !== manifest.imageFile
        || !/^[A-Za-z0-9._-]{1,160}$/.test(manifest.imageFile)) {
        throw new Error('Invalid WhatsApp image handoff filename');
    }

    const imagePath = resolve(handoffDir, manifest.imageFile);
    const expectedDirectory = resolve(handoffDir);
    if (dirname(imagePath) !== expectedDirectory) {
        throw new Error('WhatsApp image handoff escaped its private directory');
    }

    const imageStats = await lstat(imagePath);
    if (!imageStats.isFile() || imageStats.isSymbolicLink()) {
        throw new Error('WhatsApp image handoff must reference a regular staged file');
    }
    validateImageSize(imageStats.size);

    const detectedMimeType = await detectImageMimeType(imagePath);
    if (manifest.mimeType !== detectedMimeType) {
        throw new Error(`WhatsApp image handoff MIME mismatch: expected ${detectedMimeType}`);
    }
    const caption = normalizeCaption(manifest.caption);

    return {
        path: imagePath,
        mimeType: detectedMimeType,
        ...(caption ? { caption } : {})
    };
}

export async function cleanupImageHandoff(handoffDir: string): Promise<void> {
    await rm(handoffDir, { recursive: true, force: true });
}

async function detectImageMimeType(path: string): Promise<WhatsAppImageMimeType> {
    const handle = await open(path, 'r');
    try {
        const header = Buffer.alloc(12);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        const bytes = header.subarray(0, bytesRead);

        if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
            return 'image/png';
        }
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
            return 'image/jpeg';
        }
    } finally {
        await handle.close();
    }

    throw new Error('WhatsApp image must be a PNG or JPEG file');
}

function normalizeCaption(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
        throw new Error('WhatsApp image caption must be text');
    }
    const caption = value.trim();
    if (!caption) return undefined;
    if (caption.length > MAX_WHATSAPP_IMAGE_CAPTION_LENGTH) {
        throw new Error(`WhatsApp image caption exceeds ${MAX_WHATSAPP_IMAGE_CAPTION_LENGTH} characters`);
    }
    return caption;
}

function validateImageSize(size: number): void {
    if (size <= 0) {
        throw new Error('WhatsApp image file is empty');
    }
    if (size > MAX_WHATSAPP_IMAGE_BYTES) {
        throw new Error(`WhatsApp image exceeds ${MAX_WHATSAPP_IMAGE_BYTES} bytes`);
    }
}

function extensionForMimeType(mimeType: WhatsAppImageMimeType): string {
    if (mimeType === 'image/png') return '.png';
    return '.jpg';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}
