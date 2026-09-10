import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import registerChildWhatsAppMedia from '../src/child-whatsapp-media.extension.js';
import { loadImageHandoff } from '../src/services/outbound-image.service.js';

const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
);

interface RegisteredTool {
    name: string;
    execute(
        toolCallId: string,
        params: { path: string; caption?: string },
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: { cwd: string }
    ): Promise<{ terminate?: boolean; content: Array<{ type: string; text: string }> }>;
}

test('child media extension registers send_wa_image and writes a parent-readable handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whatsapp-child-media-test-'));
    const sourcePath = join(root, 'sketch.png');
    const handoffDir = join(root, 'handoff');
    await writeFile(sourcePath, ONE_PIXEL_PNG);
    const originalHandoffDir = process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR;
    let registeredTool: RegisteredTool | undefined;
    const pi = {
        on() {},
        registerTool(tool: RegisteredTool) {
            registeredTool = tool;
        }
    } as unknown as ExtensionAPI;

    try {
        process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR = handoffDir;
        registerChildWhatsAppMedia(pi);
        assert.equal(registeredTool?.name, 'send_wa_image');
        assert.ok(registeredTool);

        const result = await registeredTool.execute(
            'test-call',
            { path: 'sketch.png', caption: 'Client sketch' },
            undefined,
            undefined,
            { cwd: root }
        );
        assert.equal(result.terminate, true);
        assert.match(result.content[0]?.text ?? '', /prepared for WhatsApp delivery/);

        const handoff = await loadImageHandoff(handoffDir);
        assert.equal(handoff?.mimeType, 'image/png');
        assert.equal(handoff?.caption, 'Client sketch');
    } finally {
        if (originalHandoffDir === undefined) delete process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR;
        else process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR = originalHandoffDir;
        await rm(root, { recursive: true, force: true });
    }
});
