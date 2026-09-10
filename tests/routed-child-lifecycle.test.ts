import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runPiForConversation } from '../src/whatsapp-router.js';
import { createJiti } from 'jiti';

const config = { modelSource: 'default', thinkingSource: 'default' } as const;

test('routed child receives stdin, private image and no recursive extensions; handoff is cleaned', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'router-child-integration-'));
    const old = process.env.WHATSAPP_PI_ROUTER_PI_BIN;
    try {
        const binary = join(root, 'fake-pi.mjs');
        await writeFile(binary, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';
            let text='';for await(const chunk of process.stdin) text+=chunk;
            writeFileSync('received.json',JSON.stringify({text,args:process.argv.slice(2)}));
            console.log('Hello from the child');\n`);
        await chmod(binary, 0o700);
        process.env.WHATSAPP_PI_ROUTER_PI_BIN = binary;
        const route = { key: 'test', directory: join(root, 'session'), legacySessionId: 'legacy' };
        const result = await runPiForConversation({
            sessionLaunch: { args: ['--session-dir', route.directory, '--continue'], mode: 'create', route },
            prompt: 'private incoming message', cwd: root, mediaDir: join(root, 'media'),
            imageBuffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), imageMimeType: 'image/png',
            childPiConfig: config, signal: new AbortController().signal,
        });
        const received = JSON.parse(await readFile(join(root, 'received.json'), 'utf8'));
        assert.equal(received.text, 'private incoming message');
        assert.ok(!received.args.includes('private incoming message'));
        assert.ok(received.args.includes('--no-extensions'));
        assert.ok(received.args.includes('--print'));
        const image = received.args.find((arg: string) => arg.startsWith('@')).slice(1);
        assert.equal((await stat(image)).mode & 0o777, 0o600);
        assert.equal(result.text, 'Hello from the child');
        await result.cleanup();
        await assert.rejects(stat(image));
        assert.deepEqual(await readdir(join(root, 'media', 'outbound-images')), []);
    } finally {
        if (old === undefined) delete process.env.WHATSAPP_PI_ROUTER_PI_BIN;
        else process.env.WHATSAPP_PI_ROUTER_PI_BIN = old;
        await rm(root, { recursive: true, force: true });
    }
});

test('media worker can load the source AudioService via its production TypeScript loader without starting work', async () => {
    const jiti = createJiti(import.meta.url);
    const module = await jiti.import<{ AudioService: unknown }>(join(process.cwd(), 'src/services/audio.service.ts'));
    assert.equal(typeof module.AudioService, 'function');
});
