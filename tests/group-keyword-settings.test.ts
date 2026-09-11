import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MenuHandler } from '../src/ui/menu.handler.js';
import { SessionManager } from '../src/services/session.manager.js';
import { getRouterAllowConfigPath, loadRouterAllowFileConfig, loadRouterAllowConfig, parseRouterAllowConfig, saveRouterAllowFileConfig, updateRouterAllowFileConfig } from '../src/services/router-allow.config.js';

async function harness() {
    const root = await mkdtemp(join(tmpdir(), 'router-keyword-settings-'));
    const oldHome = process.env.HOME;
    process.env.HOME = root;
    const manager = new SessionManager(join(root, 'manager'), join(root, 'missing'));
    await manager.ensureInitialized();
    const menu = new MenuHandler({ getEffectiveStatus: () => 'connected' } as any, manager, {} as any, {} as any);
    const initial = { ...parseRouterAllowConfig('{}'), groupReplyMode: 'mentions' as const, groupReplyKeywords: ['emily'], allow: ['+15551234567'] };
    await saveRouterAllowFileConfig(initial);
    manager.setGroupReplyMode(initial.groupReplyMode);
    manager.setGroupReplyKeywords(initial.groupReplyKeywords);
    return {
        manager, menu,
        async cleanup() {
            if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
            await rm(root, { recursive: true, force: true });
        },
    };
}

function context(choices: Array<string | undefined>, input?: string, confirmation = false) {
    const notices: Array<{ text: string; type: string }> = [];
    const editors: string[] = [];
    return {
        notices, editors,
        ctx: { ui: {
            async select(_title: string, options: string[]) {
                const next = choices.shift();
                if (next !== undefined) assert.ok(options.includes(next), `Missing menu option: ${next}`);
                return next;
            },
            async editor(title: string, value: string) {
                assert.match(title, /one word or phrase per line/);
                editors.push(value);
                return input;
            },
            async confirm() { return confirmation; },
            notify(text: string, type: string) { notices.push({ text, type }); },
        } } as any,
    };
}

test('keyword settings persist, survive other setting updates, and reload without changing access lists', async () => {
    const h = await harness();
    try {
        await Promise.all([
            updateRouterAllowFileConfig({ groupReplyKeywords: [' Emily ', 'SALES TEAM'] }),
            updateRouterAllowFileConfig({ groupReplyMode: 'mentions-or-keywords' }),
        ]);
        const loaded = await loadRouterAllowConfig();
        assert.deepEqual(loaded.groupReplyKeywords, ['emily', 'sales team']);
        assert.equal(loaded.groupReplyMode, 'mentions-or-keywords');
        assert.deepEqual(loaded.allow, ['+15551234567']);
        if (process.platform !== 'win32') assert.equal((await stat(getRouterAllowConfigPath())).mode & 0o777, 0o600);
        const restarted = new SessionManager();
        restarted.setGroupReplyMode(loaded.groupReplyMode);
        restarted.setGroupReplyKeywords(loaded.groupReplyKeywords);
        assert.equal(restarted.matchesGroupReplyKeywords('Hey sales team!'), true);
        const copy = restarted.getGroupReplyKeywords();
        copy.length = 0;
        assert.equal(restarted.matchesGroupReplyKeywords('Emily'), true);
    } finally { await h.cleanup(); }
});

test('menu edits keywords without enabling them, then selecting the combined mode applies immediately', async () => {
    const h = await harness();
    try {
        const edit = context(['Group Keywords: 1', undefined], 'EMILY\nSales team');
        await h.menu.handleCommand(edit.ctx);
        assert.deepEqual(edit.editors, ['emily']);
        assert.deepEqual(h.manager.getGroupReplyKeywords(), ['emily', 'sales team']);
        assert.equal(h.manager.getGroupReplyMode(), 'mentions');
        assert.match(edit.notices[0].text, /Select Mentions, keywords or replies/);
        const select = context(['Group Replies: Mentions or Replies', 'Mentions, keywords or replies', undefined]);
        await h.menu.handleCommand(select.ctx);
        assert.equal(h.manager.getGroupReplyMode(), 'mentions-or-keywords');
        assert.equal((await loadRouterAllowFileConfig()).groupReplyMode, 'mentions-or-keywords');
        const clear = context(['Group Keywords: 2', undefined], '');
        await h.menu.handleCommand(clear.ctx);
        assert.deepEqual(h.manager.getGroupReplyKeywords(), []);
        assert.match(clear.notices[0].text, /mentions and replies to the agent/);
    } finally { await h.cleanup(); }
});

test('cancelled editor, cancelled mode selection and declined all-message confirmation change nothing', async () => {
    const h = await harness();
    try {
        const original = await readFile(getRouterAllowConfigPath(), 'utf8');
        await h.menu.handleCommand(context(['Group Keywords: 1', undefined]).ctx);
        await h.menu.handleCommand(context(['Group Replies: Mentions or Replies', undefined, undefined]).ctx);
        await h.menu.handleCommand(context(['Group Replies: Mentions or Replies', 'All messages', undefined]).ctx);
        assert.equal(await readFile(getRouterAllowConfigPath(), 'utf8'), original);
        assert.equal(h.manager.getGroupReplyMode(), 'mentions');
    } finally { await h.cleanup(); }
});

test('invalid editor input and failed saves preserve live keyword settings', async () => {
    const h = await harness();
    try {
        const invalid = context(['Group Keywords: 1', undefined], '*');
        await h.menu.handleCommand(invalid.ctx);
        assert.equal(invalid.notices[0].type, 'error');
        assert.deepEqual(h.manager.getGroupReplyKeywords(), ['emily']);
        const path = getRouterAllowConfigPath();
        await rm(path);
        await mkdir(path);
        const failed = context(['Group Keywords: 1', undefined], 'newword');
        await h.menu.handleCommand(failed.ctx);
        assert.equal(failed.notices[0].type, 'error');
        assert.deepEqual(h.manager.getGroupReplyKeywords(), ['emily']);
        assert.equal(h.manager.getGroupReplyMode(), 'mentions');
    } finally { await h.cleanup(); }
});
