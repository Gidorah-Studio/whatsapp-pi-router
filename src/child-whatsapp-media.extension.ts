import { resolve, join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { formatReplyContext, MAX_REPLY_CONTEXT_BYTES, RECENT_CONTEXT_LIMIT, type ReplyContext } from './services/reply-context.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import {
    MAX_WHATSAPP_IMAGE_CAPTION_LENGTH,
    stageImageHandoff
} from './services/outbound-image.service.js';

export default function (pi: ExtensionAPI) {
    // This is system context for this invocation only, never a user/assistant message.
    // Honcho's standard agent_end text capture therefore does not ingest the window itself.
    pi.on('before_agent_start', async (event) => {
        const dir = process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR;
        if (!dir) return;
        const path = join(dir, 'reply-context.json');
        try {
            if ((await stat(path)).size > MAX_REPLY_CONTEXT_BYTES) throw new Error('Context too large');
            const context = JSON.parse(await readFile(path, 'utf8')) as ReplyContext;
            if (context.version !== 1 || !Array.isArray(context.recentMessages) || context.recentMessages.length > RECENT_CONTEXT_LIMIT || typeof context.conversationJid !== 'string') throw new Error('Invalid context');
            return { systemPrompt: event.systemPrompt + '\n\n' + formatReplyContext(context) };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            return { systemPrompt: event.systemPrompt + '\n\nThe temporary WhatsApp quote/recent context could not be loaded. Ask the user to specify the target instead of guessing from an older topic.' };
        }
    });
    pi.registerTool({
        name: 'send_wa_image',
        label: 'Send WhatsApp Image',
        description: 'Hand a generated local PNG or JPEG image to the parent WhatsApp router for delivery to the current conversation. The image file must already exist. An optional caption is sent with the image.',
        promptSnippet: 'send_wa_image(path, caption?) - Send an existing local image to the current WhatsApp conversation. Render the image first, then call this tool with its path. Do not claim it was sent unless this tool succeeds.',
        promptGuidelines: [
            'Use send_wa_image when a WhatsApp user requests a generated or rendered image. Create the image file first, then pass its local path and an optional caption.',
            'After send_wa_image succeeds, do not produce a duplicate text reply or confirmation; the parent router will deliver the image and caption.'
        ],
        parameters: Type.Object({
            path: Type.String({ minLength: 1, description: 'Path to an existing local PNG or JPEG image' }),
            caption: Type.Optional(Type.String({
                maxLength: MAX_WHATSAPP_IMAGE_CAPTION_LENGTH,
                description: 'Optional WhatsApp image caption'
            }))
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            if (signal?.aborted) {
                throw new Error('WhatsApp image handoff was cancelled');
            }
            const handoffDir = process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR?.trim();
            if (!handoffDir) {
                throw new Error('send_wa_image is only available inside a routed WhatsApp turn');
            }

            const rawPath = params.path?.trim().replace(/^@/, '');
            if (!rawPath) {
                throw new Error('send_wa_image requires an image path');
            }
            const sourcePath = resolve(ctx.cwd, rawPath);
            const image = await stageImageHandoff({
                sourcePath,
                handoffDir,
                ...(params.caption ? { caption: params.caption } : {})
            });

            return {
                content: [{
                    type: 'text' as const,
                    text: 'Image prepared for WhatsApp delivery. Do not send a follow-up text response.'
                }],
                details: {
                    success: true,
                    mimeType: image.mimeType,
                    caption: image.caption
                },
                terminate: true
            };
        }
    });
}
