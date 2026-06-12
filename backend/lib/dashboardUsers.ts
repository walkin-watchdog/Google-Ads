import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { sendDashboardInviteEmail, sendDashboardPasswordResetEmail } from './email';

const TOKEN_BYTES = 32;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_EMAIL_MAX = 5;
const LOGIN_IP_MAX = 30;
const FORGOT_WINDOW_SECONDS = 60 * 60;
const FORGOT_EMAIL_MAX = 3;
const FORGOT_IP_MAX = 20;
const DUMMY_PASSWORD_HASH =
    '$argon2id$v=19$m=65536,t=3,p=4$MJRf5INhjzv7XwbHRsM0tg$GOF6erG5kAmja5t3nPpQWRCe9nZspj+pB83TfKb8bWQ';

export type DashboardUserStatus = 'invited' | 'active' | 'disabled';
export type DashboardTokenPurpose = 'invite' | 'password_reset';

export class DashboardUserValidationError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 400) {
        super(message);
        this.name = 'DashboardUserValidationError';
        this.statusCode = statusCode;
    }
}

export class DashboardAuthRateLimitError extends Error {
    retryAfterSeconds: number;
    statusCode = 429;

    constructor(retryAfterSeconds: number) {
        super('Too many attempts. Try again later.');
        this.name = 'DashboardAuthRateLimitError';
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

export type DashboardUserRow = {
    id: string;
    email: string;
    emailNormalized: string;
    name: string;
    status: DashboardUserStatus;
    invitedAt: string | null;
    activatedAt: string | null;
    lastLoginAt: string | null;
    createdAt: string;
    updatedAt: string;
};

export type CreateDashboardUserResult = {
    user: DashboardUserRow;
    invited: boolean;
};

export type LoginResult = {
    user: DashboardUserRow;
};

export type PasswordTokenVerification = {
    valid: boolean;
    purpose: DashboardTokenPurpose | null;
    user: DashboardUserRow | null;
};

export type DashboardUserMailers = {
    sendInviteEmail?: typeof sendDashboardInviteEmail;
    sendPasswordResetEmail?: typeof sendDashboardPasswordResetEmail;
};

type Queryable = Pick<Pool | PoolClient, 'query'>;

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

export function normalizeEmail(value: unknown): string {
    const text = String(value || '').trim().toLowerCase();
    if (!text || text.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        throw new DashboardUserValidationError('A valid email address is required.');
    }
    return text;
}

function normalizeName(value: unknown): string {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    if (!text) throw new DashboardUserValidationError('Name is required.');
    if (text.length > 120) throw new DashboardUserValidationError('Name must be 120 characters or fewer.');
    return text;
}

function normalizeUserId(value: unknown): string {
    const text = String(value || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
        throw new DashboardUserValidationError('user_id must be a UUID.');
    }
    return text;
}

export function validateDashboardPassword(value: unknown): string {
    const password = String(value || '');
    if (password.length < 12 || password.length > 200) {
        throw new DashboardUserValidationError('Password must be 12 to 200 characters.');
    }
    if (!password.trim()) throw new DashboardUserValidationError('Password cannot be all whitespace.');
    if (!/[a-z]/i.test(password) || !/\d/.test(password)) {
        throw new DashboardUserValidationError('Password must include at least one letter and one number.');
    }
    return password;
}

function token(): string {
    return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function rowToUser(row: any): DashboardUserRow {
    return {
        id: String(row.id),
        email: String(row.email),
        emailNormalized: String(row.email_normalized),
        name: String(row.name),
        status: row.status as DashboardUserStatus,
        invitedAt: row.invited_at ? new Date(row.invited_at).toISOString() : null,
        activatedAt: row.activated_at ? new Date(row.activated_at).toISOString() : null,
        lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
}

function publicUser(user: DashboardUserRow): DashboardUserRow {
    return { ...user };
}

async function hashPassword(password: string): Promise<string> {
    return Bun.password.hash(password, {
        algorithm: 'argon2id',
        memoryCost: 65536,
        timeCost: 3
    });
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
    return Bun.password.verify(password, hash);
}

export async function ensureDashboardUsersSchema(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;

        CREATE TABLE IF NOT EXISTS dashboard_users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email TEXT NOT NULL,
            email_normalized TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            password_hash TEXT,
            status TEXT NOT NULL CHECK (status IN ('invited','active','disabled')),
            invited_at TIMESTAMP WITH TIME ZONE,
            activated_at TIMESTAMP WITH TIME ZONE,
            last_login_at TIMESTAMP WITH TIME ZONE,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS dashboard_user_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
            purpose TEXT NOT NULL CHECK (purpose IN ('invite','password_reset')),
            token_hash TEXT NOT NULL UNIQUE,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            used_at TIMESTAMP WITH TIME ZONE,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_by TEXT
        );

        CREATE INDEX IF NOT EXISTS dashboard_user_tokens_active_idx
            ON dashboard_user_tokens(user_id, purpose, expires_at)
            WHERE used_at IS NULL;
        CREATE INDEX IF NOT EXISTS dashboard_user_tokens_expiry_idx
            ON dashboard_user_tokens(expires_at);

        CREATE TABLE IF NOT EXISTS dashboard_auth_rate_limits (
            scope_hash TEXT NOT NULL,
            action TEXT NOT NULL,
            window_start TIMESTAMP WITH TIME ZONE NOT NULL,
            window_seconds INTEGER NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (scope_hash, action, window_start)
        );
        CREATE INDEX IF NOT EXISTS dashboard_auth_rate_limits_expiry_idx
            ON dashboard_auth_rate_limits(window_start);

        ALTER TABLE dashboard_sessions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES dashboard_users(id) ON DELETE CASCADE;
        ALTER TABLE dashboard_sessions ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'magic';
        ALTER TABLE dashboard_sessions ADD COLUMN IF NOT EXISTS csrf_hash TEXT;
        ALTER TABLE dashboard_sessions ADD COLUMN IF NOT EXISTS idle_expires_at TIMESTAMP WITH TIME ZONE;
        CREATE INDEX IF NOT EXISTS dashboard_sessions_user_id_idx ON dashboard_sessions(user_id);
        CREATE INDEX IF NOT EXISTS dashboard_sessions_idle_expires_idx ON dashboard_sessions(idle_expires_at);
        CREATE INDEX IF NOT EXISTS dashboard_sessions_active_user_idx
            ON dashboard_sessions(user_id, expires_at, idle_expires_at)
            WHERE revoked_at IS NULL AND auth_method = 'user';
    `);

    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'dashboard_users_active_password_chk'
                  AND conrelid = 'dashboard_users'::regclass
            ) THEN
                ALTER TABLE dashboard_users
                ADD CONSTRAINT dashboard_users_active_password_chk
                CHECK (status <> 'active' OR password_hash IS NOT NULL);
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'dashboard_sessions_auth_method_chk'
                  AND conrelid = 'dashboard_sessions'::regclass
            ) THEN
                ALTER TABLE dashboard_sessions
                ADD CONSTRAINT dashboard_sessions_auth_method_chk
                CHECK (auth_method IN ('magic','user'));
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'dashboard_sessions_user_auth_chk'
                  AND conrelid = 'dashboard_sessions'::regclass
            ) THEN
                ALTER TABLE dashboard_sessions
                ADD CONSTRAINT dashboard_sessions_user_auth_chk
                CHECK (
                    (auth_method = 'user' AND user_id IS NOT NULL)
                    OR (auth_method = 'magic' AND user_id IS NULL)
                );
            END IF;
        END $$;
    `);
}

export async function cleanupDashboardUserAuth(pool: Pool): Promise<void> {
    await pool.query(`
        DELETE FROM dashboard_user_tokens
        WHERE expires_at < now() - INTERVAL '7 days'
           OR used_at < now() - INTERVAL '7 days'
    `);
    await pool.query(`
        DELETE FROM dashboard_auth_rate_limits
        WHERE window_start + (window_seconds * INTERVAL '1 second') < now() - INTERVAL '1 hour'
    `);
}

async function createUserToken(client: Queryable, input: {
    userId: string;
    purpose: DashboardTokenPurpose;
    ttlMs: number;
    createdBy?: string | null;
}): Promise<string> {
    const rawToken = token();
    await client.query(
        `UPDATE dashboard_user_tokens
         SET used_at = COALESCE(used_at, now())
         WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
        [input.userId, input.purpose]
    );
    await client.query(
        `INSERT INTO dashboard_user_tokens (user_id, purpose, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [
            input.userId,
            input.purpose,
            sha256(rawToken),
            new Date(Date.now() + input.ttlMs).toISOString(),
            input.createdBy || null
        ]
    );
    return rawToken;
}

export async function createDashboardUser(
    pool: Pool,
    input: { email: unknown; name: unknown; createdBy?: string | null },
    mailers: DashboardUserMailers = {}
): Promise<CreateDashboardUserResult> {
    await cleanupDashboardUserAuth(pool).catch(() => undefined);
    const emailNormalized = normalizeEmail(input.email);
    const name = normalizeName(input.name);
    const client = await pool.connect();
    let inviteToken = '';
    let user: DashboardUserRow | null = null;
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `INSERT INTO dashboard_users (email, email_normalized, name, status, invited_at)
             VALUES ($1, $2, $3, 'invited', now())
             ON CONFLICT (email_normalized) DO NOTHING
             RETURNING *`,
            [String(input.email).trim(), emailNormalized, name]
        );
        if (!rows[0]) throw new DashboardUserValidationError('A dashboard user with this email already exists.', 409);
        user = rowToUser(rows[0]);
        inviteToken = await createUserToken(client, {
            userId: user.id,
            purpose: 'invite',
            ttlMs: INVITE_TTL_MS,
            createdBy: input.createdBy || null
        });
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
    await (mailers.sendInviteEmail || sendDashboardInviteEmail)({ email: user.email, name: user.name, token: inviteToken });
    return { user: publicUser(user), invited: true };
}

export async function resendDashboardUserInvitation(
    pool: Pool,
    input: { userId: unknown; createdBy?: string | null },
    mailers: DashboardUserMailers = {}
): Promise<CreateDashboardUserResult> {
    const userId = normalizeUserId(input.userId);
    const client = await pool.connect();
    let inviteToken = '';
    let user: DashboardUserRow | null = null;
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(`SELECT * FROM dashboard_users WHERE id = $1 FOR UPDATE`, [userId]);
        if (!rows[0]) throw new DashboardUserValidationError('Dashboard user not found.', 404);
        user = rowToUser(rows[0]);
        if (user.status !== 'invited') {
            throw new DashboardUserValidationError(
                user.status === 'disabled'
                    ? 'User is disabled.'
                    : 'Active users must use the password-reset flow.',
                409
            );
        }
        inviteToken = await createUserToken(client, {
            userId: user.id,
            purpose: 'invite',
            ttlMs: INVITE_TTL_MS,
            createdBy: input.createdBy || null
        });
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
    await (mailers.sendInviteEmail || sendDashboardInviteEmail)({ email: user.email, name: user.name, token: inviteToken });
    return { user: publicUser(user), invited: true };
}

export async function listDashboardUsers(pool: Pool, input: { status?: unknown } = {}): Promise<DashboardUserRow[]> {
    const status = String(input.status || '').trim();
    if (status && !['invited', 'active', 'disabled'].includes(status)) {
        throw new DashboardUserValidationError('status must be invited, active, or disabled.');
    }
    const { rows } = status
        ? await pool.query(`SELECT * FROM dashboard_users WHERE status = $1 ORDER BY created_at DESC`, [status])
        : await pool.query(`SELECT * FROM dashboard_users ORDER BY created_at DESC`);
    return rows.map(rowToUser);
}

export async function disableDashboardUser(pool: Pool, input: { userId: unknown }): Promise<DashboardUserRow> {
    const userId = normalizeUserId(input.userId);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `UPDATE dashboard_users
             SET status = 'disabled', updated_at = now()
             WHERE id = $1
             RETURNING *`,
            [userId]
        );
        if (!rows[0]) throw new DashboardUserValidationError('Dashboard user not found.', 404);
        await client.query(
            `UPDATE dashboard_user_tokens
             SET used_at = COALESCE(used_at, now())
             WHERE user_id = $1 AND used_at IS NULL`,
            [userId]
        );
        await client.query(`UPDATE dashboard_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
        await client.query(`UPDATE dashboard_push_subscriptions SET revoked_at = COALESCE(revoked_at, now()), updated_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
        await client.query(
            `UPDATE lead_notification_deliveries
             SET status = 'stale', locked_by = NULL, locked_at = NULL,
                 last_error = 'Dashboard user was disabled.', updated_at = now()
             WHERE user_id = $1 AND status IN ('queued','running')`,
            [userId]
        );
        await client.query('COMMIT');
        return rowToUser(rows[0]);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

export async function enableDashboardUser(pool: Pool, input: { userId: unknown }): Promise<DashboardUserRow> {
    const userId = normalizeUserId(input.userId);
    const { rows } = await pool.query(
        `UPDATE dashboard_users
         SET status = CASE WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [userId]
    );
    if (!rows[0]) throw new DashboardUserValidationError('Dashboard user not found.', 404);
    return rowToUser(rows[0]);
}

export async function revokeDashboardUserSessions(pool: Pool, input: { userId: unknown }): Promise<{ user: DashboardUserRow; revokedSessions: number }> {
    const userId = normalizeUserId(input.userId);
    const userResult = await pool.query(`SELECT * FROM dashboard_users WHERE id = $1`, [userId]);
    if (!userResult.rows[0]) throw new DashboardUserValidationError('Dashboard user not found.', 404);
    const update = await pool.query(
        `UPDATE dashboard_sessions
         SET revoked_at = COALESCE(revoked_at, now())
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
    );
    return { user: rowToUser(userResult.rows[0]), revokedSessions: Number(update.rowCount || 0) };
}

function scopeHash(action: string, scope: string, value: string): string {
    return sha256(`${action}:${scope}:${value}`);
}

function clientIp(value: unknown): string {
    const text = String(value || '').split(',')[0].trim();
    return text || 'unknown';
}

async function incrementRateLimit(pool: Pool, input: {
    action: string;
    scope: string;
    value: string;
    windowSeconds: number;
    max: number;
}): Promise<void> {
    const hash = scopeHash(input.action, input.scope, input.value);
    const { rows } = await pool.query(
        `WITH bucket AS (
             SELECT to_timestamp(floor(extract(epoch from now()) / $2::int) * $2::int) AS window_start
         ),
         upserted AS (
             INSERT INTO dashboard_auth_rate_limits (scope_hash, action, window_start, window_seconds, count)
             SELECT $1, $3, bucket.window_start, $2, 1 FROM bucket
             ON CONFLICT (scope_hash, action, window_start)
             DO UPDATE SET count = dashboard_auth_rate_limits.count + 1, updated_at = now()
             RETURNING count, window_start, window_seconds
         )
         SELECT count,
                ceil(extract(epoch from (window_start + (window_seconds * INTERVAL '1 second') - now())))::int AS retry_after
         FROM upserted`,
        [hash, input.windowSeconds, input.action]
    );
    const row = rows[0];
    if (Number(row?.count || 0) > input.max) {
        throw new DashboardAuthRateLimitError(Math.max(1, Number(row.retry_after || input.windowSeconds)));
    }
}

async function assertRateLimitAvailable(pool: Pool, input: {
    action: string;
    scope: string;
    value: string;
    windowSeconds: number;
    max: number;
}): Promise<void> {
    const hash = scopeHash(input.action, input.scope, input.value);
    const { rows } = await pool.query(
        `WITH bucket AS (
             SELECT to_timestamp(floor(extract(epoch from now()) / $2::int) * $2::int) AS window_start
         )
         SELECT count,
                ceil(extract(epoch from (dashboard_auth_rate_limits.window_start + (dashboard_auth_rate_limits.window_seconds * INTERVAL '1 second') - now())))::int AS retry_after
         FROM dashboard_auth_rate_limits, bucket
         WHERE scope_hash = $1
           AND action = $3
           AND dashboard_auth_rate_limits.window_start = bucket.window_start
         LIMIT 1`,
        [hash, input.windowSeconds, input.action]
    );
    const row = rows[0];
    if (Number(row?.count || 0) >= input.max) {
        throw new DashboardAuthRateLimitError(Math.max(1, Number(row.retry_after || input.windowSeconds)));
    }
}

async function clearEmailLoginFailures(pool: Pool, emailNormalized: string): Promise<void> {
    await pool.query(
        `DELETE FROM dashboard_auth_rate_limits WHERE action = 'login_failed' AND scope_hash = $1`,
        [scopeHash('login_failed', 'email', emailNormalized)]
    );
}

export async function authenticateDashboardUser(pool: Pool, input: { email: unknown; password: unknown; ip?: unknown }): Promise<LoginResult> {
    await cleanupDashboardUserAuth(pool).catch(() => undefined);
    const emailNormalized = normalizeEmail(input.email);
    const password = String(input.password || '');
    const ip = clientIp(input.ip);
    await assertRateLimitAvailable(pool, { action: 'login_failed', scope: 'email', value: emailNormalized, windowSeconds: LOGIN_WINDOW_SECONDS, max: LOGIN_EMAIL_MAX });
    await assertRateLimitAvailable(pool, { action: 'login_ip', scope: 'ip', value: ip, windowSeconds: LOGIN_WINDOW_SECONDS, max: LOGIN_IP_MAX });

    const { rows } = await pool.query(`SELECT * FROM dashboard_users WHERE email_normalized = $1`, [emailNormalized]);
    const row = rows[0];
    const usableHash = row?.status === 'active' && row?.password_hash ? String(row.password_hash) : null;
    const ok = await verifyPassword(password, usableHash || DUMMY_PASSWORD_HASH).catch(() => false);
    if (!usableHash || !ok) {
        let rateLimitError: DashboardAuthRateLimitError | null = null;
        for (const limit of [
            { action: 'login_failed', scope: 'email', value: emailNormalized, windowSeconds: LOGIN_WINDOW_SECONDS, max: LOGIN_EMAIL_MAX },
            { action: 'login_ip', scope: 'ip', value: ip, windowSeconds: LOGIN_WINDOW_SECONDS, max: LOGIN_IP_MAX }
        ]) {
            try {
                await incrementRateLimit(pool, limit);
            } catch (err: any) {
                if (err instanceof DashboardAuthRateLimitError && !rateLimitError) rateLimitError = err;
                else throw err;
            }
        }
        console.warn('dashboard_login_failed', {
            emailHash: sha256(emailNormalized).slice(0, 16),
            ipHash: sha256(ip).slice(0, 16)
        });
        if (rateLimitError) throw rateLimitError;
        throw new DashboardUserValidationError('Invalid email or password.', 401);
    }
    await clearEmailLoginFailures(pool, emailNormalized).catch(() => undefined);
    await pool.query(`UPDATE dashboard_users SET last_login_at = now(), updated_at = now() WHERE id = $1`, [row.id]);
    return { user: rowToUser({ ...row, last_login_at: new Date() }) };
}

export async function requestDashboardPasswordReset(
    pool: Pool,
    input: { email: unknown; ip?: unknown },
    mailers: DashboardUserMailers = {}
): Promise<void> {
    let emailNormalized = '';
    try {
        emailNormalized = normalizeEmail(input.email);
    } catch {
        return;
    }
    await incrementRateLimit(pool, { action: 'forgot_email', scope: 'email', value: emailNormalized, windowSeconds: FORGOT_WINDOW_SECONDS, max: FORGOT_EMAIL_MAX });
    await incrementRateLimit(pool, { action: 'forgot_ip', scope: 'ip', value: clientIp(input.ip), windowSeconds: FORGOT_WINDOW_SECONDS, max: FORGOT_IP_MAX });
    const client = await pool.connect();
    let resetToken = '';
    let user: DashboardUserRow | null = null;
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(`SELECT * FROM dashboard_users WHERE email_normalized = $1 FOR UPDATE`, [emailNormalized]);
        if (rows[0] && rows[0].status === 'active' && rows[0].password_hash) {
            user = rowToUser(rows[0]);
            resetToken = await createUserToken(client, {
                userId: user.id,
                purpose: 'password_reset',
                ttlMs: RESET_TTL_MS,
                createdBy: 'forgot-password'
            });
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
    if (user && resetToken) {
        await (mailers.sendPasswordResetEmail || sendDashboardPasswordResetEmail)({ email: user.email, name: user.name, token: resetToken });
    }
}

export async function inspectDashboardPasswordToken(pool: Pool, rawToken: unknown): Promise<PasswordTokenVerification> {
    const text = String(rawToken || '').trim();
    if (text.length < 20 || text.length > 200) return { valid: false, purpose: null, user: null };
    const { rows } = await pool.query(
        `SELECT token.purpose, user_row.*
         FROM dashboard_user_tokens token
         JOIN dashboard_users user_row ON user_row.id = token.user_id
         WHERE token.token_hash = $1
           AND token.used_at IS NULL
           AND token.expires_at > now()
           AND user_row.status <> 'disabled'`,
        [sha256(text)]
    );
    if (!rows[0]) return { valid: false, purpose: null, user: null };
    return {
        valid: true,
        purpose: rows[0].purpose as DashboardTokenPurpose,
        user: rowToUser(rows[0])
    };
}

export async function consumeDashboardPasswordToken(pool: Pool, input: { token: unknown; password: unknown }): Promise<DashboardUserRow> {
    const rawToken = String(input.token || '').trim();
    if (rawToken.length < 20 || rawToken.length > 200) {
        throw new DashboardUserValidationError('Invalid or expired reset link.', 400);
    }
    const password = validateDashboardPassword(input.password);
    const tokenHash = sha256(rawToken);
    const preflight = await pool.query(
        `SELECT 1
         FROM dashboard_user_tokens token
         JOIN dashboard_users user_row ON user_row.id = token.user_id
         WHERE token.token_hash = $1
           AND token.used_at IS NULL
           AND token.expires_at > now()
           AND user_row.status <> 'disabled'
         LIMIT 1`,
        [tokenHash]
    );
    if (!preflight.rows[0]) {
        throw new DashboardUserValidationError('Invalid or expired reset link.', 400);
    }
    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT token.id AS token_id, token.purpose, user_row.*
             FROM dashboard_user_tokens token
             JOIN dashboard_users user_row ON user_row.id = token.user_id
             WHERE token.token_hash = $1
               AND token.used_at IS NULL
               AND token.expires_at > now()
               AND user_row.status <> 'disabled'
             FOR UPDATE OF token, user_row`,
            [tokenHash]
        );
        const row = rows[0];
        if (!row) throw new DashboardUserValidationError('Invalid or expired reset link.', 400);
        await client.query(`UPDATE dashboard_user_tokens SET used_at = now() WHERE id = $1`, [row.token_id]);
        const update = await client.query(
            `UPDATE dashboard_users
             SET password_hash = $2,
                 status = 'active',
                 activated_at = COALESCE(activated_at, now()),
                 updated_at = now()
             WHERE id = $1
             RETURNING *`,
            [row.id, passwordHash]
        );
        if (row.purpose === 'password_reset') {
            await client.query(`UPDATE dashboard_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked_at IS NULL`, [row.id]);
            await client.query(`UPDATE dashboard_push_subscriptions SET revoked_at = COALESCE(revoked_at, now()), updated_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [row.id]);
            await client.query(
                `UPDATE lead_notification_deliveries
                 SET status = 'stale', locked_by = NULL, locked_at = NULL,
                     last_error = 'Dashboard password was reset.', updated_at = now()
                 WHERE user_id = $1 AND status IN ('queued','running')`,
                [row.id]
            );
        }
        await client.query('COMMIT');
        console.log('dashboard_password_token_consumed', { userId: row.id, purpose: row.purpose });
        return rowToUser(update.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}
