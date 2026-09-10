import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Never let tests that exercise default storage/log paths touch the operator's live router.
const home = await mkdtemp(join(tmpdir(), 'whatsapp-router-test-home-'));
try {
    const directory = resolve('.test-dist/tests');
    const tests = (await readdir(directory)).filter(file => file.endsWith('.test.js')).map(file => join(directory, file));
    const child = spawn(process.execPath, ['--test', ...tests], {
        stdio: 'inherit',
        env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, '.pi', 'agent') },
    });
    process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => resolve(code ?? 1));
    });
} finally { await rm(home, { recursive: true, force: true }); }
