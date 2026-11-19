// Runs one routed turn through the Pi SDK inside its own process, so the router
// can enforce deadlines and terminate the whole process tree as it does for the CLI.
import { readFile } from 'node:fs/promises';
import {
    createAgentSessionFromServices,
    createAgentSessionServices,
    getAgentDir,
    resolveCliModel,
    SessionManager,
} from '@earendil-works/pi-coding-agent';

const RESULT_PREFIX = 'WHATSAPP_SDK_RESULT:';

async function readRequest() {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    return JSON.parse(raw);
}

// The router starts this process in the conversation's working directory. Using
// process.cwd(), as the CLI does, keeps sessions written by either backend resumable
// by the other even when the configured path is a symlink.
const cwd = process.cwd();

function openSession(request) {
    const { mode, directory, forkPath } = request.session;
    if (mode === 'migrate') return SessionManager.forkFrom(forkPath, cwd, directory);
    // Same as `pi --session-dir <dir> --continue`: resume the latest session or create one.
    return SessionManager.continueRecent(cwd, directory);
}

async function loadImages(images) {
    const loaded = [];
    for (const image of images) {
        loaded.push({ type: 'image', mimeType: image.mimeType, data: (await readFile(image.path)).toString('base64') });
    }
    return loaded;
}

function finalAssistantText(session) {
    const last = session.state.messages.at(-1);
    if (last?.role !== 'assistant') return '';
    if (last.stopReason === 'error' || last.stopReason === 'aborted') throw new Error('Assistant turn did not complete');
    return last.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
}

let session;
try {
    const request = await readRequest();
    const services = await createAgentSessionServices({
        cwd,
        agentDir: getAgentDir(),
        // Only the listed extensions load: never the operator's packages or the router itself.
        resourceLoaderOptions: { noExtensions: true, additionalExtensionPaths: request.extensionPaths },
    });
    let model;
    let thinkingLevel = request.thinking;
    if (request.model) {
        const resolved = resolveCliModel({
            cliModel: request.model, cliThinking: request.thinking, modelRuntime: services.modelRuntime,
        });
        if (resolved.error || !resolved.model) throw new Error('Configured child model could not be resolved');
        model = resolved.model;
        thinkingLevel ??= resolved.thinkingLevel;
    }
    const created = await createAgentSessionFromServices({
        services,
        sessionManager: openSession(request),
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(request.tools ? { tools: request.tools } : {}),
    });
    session = created.session;
    // Mirrors `pi --thinking`: record the configured level in the resumed session.
    if (session.model && thinkingLevel) session.setThinkingLevel(thinkingLevel);
    await session.bindExtensions({ mode: 'print' });

    const references = request.images.map(image => `<file name="${image.path}"></file>\n`).join('');
    await session.prompt(references + request.prompt, { images: await loadImages(request.images) });
    const text = finalAssistantText(session);
    session.dispose();
    await new Promise((resolve, reject) => process.stdout.write(
        `\n${RESULT_PREFIX}${JSON.stringify({ text })}\n`, error => error ? reject(error) : resolve(),
    ));
    process.exit(0);
} catch {
    // No provider errors, prompts, paths, or credentials cross the process boundary.
    try { session?.dispose(); } catch { /* exiting anyway */ }
    process.exit(1);
}
