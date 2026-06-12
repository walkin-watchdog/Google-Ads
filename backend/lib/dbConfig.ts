import { type PoolConfig } from 'pg';

export type DashboardPoolConfig = PoolConfig & {
    query_timeout?: number;
    statement_timeout?: number;
};

function normalizedEnv(name: string, env: NodeJS.ProcessEnv): string {
    return String(env[name] || '').trim().toLowerCase();
}

function databaseUrlSslMode(env: NodeJS.ProcessEnv): string {
    const url = env.DATABASE_URL || '';
    if (!url) return '';
    try {
        return new URL(url).searchParams.get('sslmode')?.trim().toLowerCase() || '';
    } catch {
        return '';
    }
}

export function databaseSslConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig['ssl'] {
    const explicit = normalizedEnv('DATABASE_SSL', env) || normalizedEnv('PGSSLMODE', env) || databaseUrlSslMode(env);

    if (['disable', 'false', '0', 'off', 'no'].includes(explicit)) return false;
    if (['require', 'true', '1', 'on', 'yes'].includes(explicit)) return { rejectUnauthorized: false };
    if (['verify-ca', 'verify-full'].includes(explicit)) return { rejectUnauthorized: true };

    const deploymentMode = normalizedEnv('DEPLOYMENT_MODE', env) || normalizedEnv('HOSTING_MODE', env);
    if (deploymentMode === 'vps' || deploymentMode === 'oci') return false;

    return env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
}

export function createPoolConfig(
    overrides: Partial<DashboardPoolConfig> = {},
    env: NodeJS.ProcessEnv = process.env
): DashboardPoolConfig {
    return {
        connectionString: env.DATABASE_URL,
        ssl: databaseSslConfig(env),
        ...overrides
    };
}
