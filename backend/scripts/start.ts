import dotenv from 'dotenv';
dotenv.config();

import { assertMcpApiKeysConfiguredForProduction } from '../lib/mcp/policy';

type SpawnedProcess = ReturnType<typeof Bun.spawn>;

let child: SpawnedProcess | null = null;

async function runStep(label: string, args: string[]): Promise<void> {
    console.log(`[startup] ${label}`);
    const proc = Bun.spawn(args, {
        cwd: __dirname + '/..',
        stdout: 'inherit',
        stderr: 'inherit'
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        throw new Error(`${label} failed with exit code ${exitCode}`);
    }
}

function forwardSignal(signal: 'SIGINT' | 'SIGTERM'): void {
    process.on(signal, () => {
        if (child) {
            child.kill(signal);
            return;
        }
        process.exit(0);
    });
}

async function run(): Promise<void> {
    console.log('[startup] MCP auth config');
    assertMcpApiKeysConfiguredForProduction();

    await runStep('client asset build', ['bun', 'run', 'build:client-assets']);
    await runStep('database migration', ['bun', 'run', 'scripts/migrate.ts']);

    console.log('[startup] server');
    child = Bun.spawn(['bun', 'run', 'server.ts'], {
        cwd: __dirname + '/..',
        env: { ...process.env, DASHBOARD_ORCHESTRATED_STARTUP: 'true' },
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit'
    });
    const exitCode = await child.exited;
    process.exit(exitCode);
}

forwardSignal('SIGINT');
forwardSignal('SIGTERM');

run().catch(err => {
    console.error('[startup] failed:', err?.message || err);
    process.exit(1);
});
