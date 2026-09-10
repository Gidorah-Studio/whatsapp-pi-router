import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPiForConversation } from '../src/whatsapp-router.js';

test('quoted image plus current image and temporary context reach child without entering user stdin; cleanup removes all', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'reply-context-handoff-'));
    const old = process.env.WHATSAPP_PI_ROUTER_PI_BIN;
    try {
        const binary = join(root, 'fake-pi.mjs');
        await writeFile(binary, `#!/usr/bin/env node\nimport {writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';
            let text='';for await(const c of process.stdin)text+=c;
            const contextPath=join(process.env.WHATSAPP_PI_ROUTER_IMAGE_HANDOFF_DIR,'reply-context.json');
            writeFileSync('received.json',JSON.stringify({text,args:process.argv.slice(2),contextPath,context:JSON.parse(readFileSync(contextPath,'utf8'))}));console.log('answer');`);
        await chmod(binary, 0o700);
        process.env.WHATSAPP_PI_ROUTER_PI_BIN = binary;
        const route = { key: 'test', directory: join(root, 'session'), legacySessionId: 'legacy' };
        const result = await runPiForConversation({
            sessionLaunch: { args: ['--session-dir', route.directory, '--continue'], mode: 'create', route },
            prompt: 'ghost explain this', cwd: root, mediaDir: join(root, 'media'),
            imageBuffer: Buffer.from('current bytes'), imageMimeType: 'image/png',
            quotedImageBuffer: Buffer.from('quoted bytes'), quotedImageMimeType: 'image/jpeg',
            replyContext: { version: 1, conversationJid: 'approved@g.us', recentMessages: [], quoted: { kind: 'image', provenance: 'WhatsApp', text: 'CONTEXT_ONLY_CANARY', imageStatus: 'attached', imageIndex: 2 } },
            childPiConfig: { modelSource: 'default', thinkingSource: 'default' }, signal: new AbortController().signal,
        });
        const r = JSON.parse(await readFile(join(root, 'received.json'), 'utf8'));
        assert.equal(r.text, 'ghost explain this');
        assert(!JSON.stringify(r.args).includes('CONTEXT_ONLY_CANARY'));
        assert.equal(r.context.quoted.text, 'CONTEXT_ONLY_CANARY');
        const paths = r.args.filter((a: string) => a.startsWith('@')).map((a: string) => a.slice(1));
        assert.equal(paths.length, 2);
        assert.equal(await readFile(paths[0], 'utf8'), 'current bytes');
        assert.equal(await readFile(paths[1], 'utf8'), 'quoted bytes');
        for (const p of [...paths, r.contextPath]) assert.equal((await stat(p)).mode & 0o777, 0o600);
        await result.cleanup();
        for (const p of [...paths, r.contextPath]) await assert.rejects(stat(p));
        assert.deepEqual(await readdir(join(root, 'media', 'outbound-images')), []);
    } finally {
        if (old === undefined) delete process.env.WHATSAPP_PI_ROUTER_PI_BIN;
        else process.env.WHATSAPP_PI_ROUTER_PI_BIN = old;
        await rm(root, { recursive: true, force: true });
    }
});
