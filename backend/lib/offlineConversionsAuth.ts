import crypto from 'crypto';
import { Pool } from 'pg';

export interface OfflineConversionsBasicAuthStatus {
    configured: boolean;
    username: string | null;
    passwordConfigured: boolean;
    passwordRevealAvailable: boolean;
    updatedAt: string | null;
}

export interface OfflineConversionsBasicAuthInput {
    username: any;
    password?: any;
}

const PASSWORD_KEY_BYTES = 64;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_IV_BYTES = 12;
const MAX_USERNAME_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 1024;

function clean(value: any): string {
    return String(value ?? '').trim();
}

function normalizeUsername(value: any): string {
    const username = clean(value);
    if (!username) throw new Error('Basic Auth username is required.');
    if (username.includes(':')) throw new Error('Basic Auth username cannot contain a colon.');
    if (Buffer.byteLength(username, 'utf8') > MAX_USERNAME_LENGTH) {
        throw new Error(`Basic Auth username must be ${MAX_USERNAME_LENGTH} bytes or fewer.`);
    }
    return username;
}

function normalizePassword(value: any): string {
    const password = String(value ?? '');
    if (!password) throw new Error('Basic Auth password is required.');
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_LENGTH) {
        throw new Error(`Basic Auth password must be ${MAX_PASSWORD_LENGTH} bytes or fewer.`);
    }
    return password;
}

function hashPassword(password: string, salt = crypto.randomBytes(PASSWORD_SALT_BYTES).toString('hex')): {
    passwordHash: string;
    passwordSalt: string;
} {
    return {
        passwordHash: crypto.scryptSync(password, salt, PASSWORD_KEY_BYTES).toString('hex'),
        passwordSalt: salt
    };
}

function encryptionSecret(): string {
    return String(process.env.OFFLINE_CONVERSIONS_AUTH_ENCRYPTION_KEY || process.env.SECRET_API_KEY || '').trim();
}

function encryptionKey(): Buffer | null {
    const secret = encryptionSecret();
    return secret ? crypto.createHash('sha256').update(secret).digest() : null;
}

function encryptPassword(password: string): {
    passwordCiphertext: string | null;
    passwordIv: string | null;
    passwordAuthTag: string | null;
} {
    const key = encryptionKey();
    if (!key) {
        return {
            passwordCiphertext: null,
            passwordIv: null,
            passwordAuthTag: null
        };
    }
    const iv = crypto.randomBytes(PASSWORD_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    return {
        passwordCiphertext: ciphertext.toString('hex'),
        passwordIv: iv.toString('hex'),
        passwordAuthTag: cipher.getAuthTag().toString('hex')
    };
}

function decryptPassword(row: any): string {
    const key = encryptionKey();
    if (!key) throw new Error('Password reveal is unavailable because the encryption key is not configured.');
    if (!row?.password_ciphertext || !row?.password_iv || !row?.password_auth_tag) {
        throw new Error('Password reveal is unavailable until the Basic Auth password is rotated.');
    }
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.password_iv, 'hex'));
        decipher.setAuthTag(Buffer.from(row.password_auth_tag, 'hex'));
        return Buffer.concat([
            decipher.update(Buffer.from(row.password_ciphertext, 'hex')),
            decipher.final()
        ]).toString('utf8');
    } catch {
        throw new Error('Password reveal failed. Rotate the Basic Auth password to restore reveal support.');
    }
}

function timingSafeStringEqual(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function rowToStatus(row: any): OfflineConversionsBasicAuthStatus {
    return {
        configured: Boolean(row?.username && row?.password_hash && row?.password_salt),
        username: row?.username || null,
        passwordConfigured: Boolean(row?.password_hash && row?.password_salt),
        passwordRevealAvailable: Boolean(row?.password_ciphertext && row?.password_iv && row?.password_auth_tag && encryptionKey()),
        updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null
    };
}

export async function ensureOfflineConversionsAuthSchema(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS offline_conversions_basic_auth_settings (
            id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            username TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            password_ciphertext TEXT,
            password_iv TEXT,
            password_auth_tag TEXT,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

export async function getOfflineConversionsBasicAuthStatus(pool: Pool): Promise<OfflineConversionsBasicAuthStatus> {
    await ensureOfflineConversionsAuthSchema(pool);
    const { rows } = await pool.query(
        `SELECT username, password_hash, password_salt, password_ciphertext, password_iv, password_auth_tag, updated_at
         FROM offline_conversions_basic_auth_settings
         WHERE id = 1`
    );
    return rowToStatus(rows[0]);
}

export async function upsertOfflineConversionsBasicAuth(
    pool: Pool,
    input: OfflineConversionsBasicAuthInput
): Promise<OfflineConversionsBasicAuthStatus> {
    await ensureOfflineConversionsAuthSchema(pool);
    const username = normalizeUsername(input.username);
    const suppliedPassword = input.password === undefined || input.password === null
        ? ''
        : String(input.password);
    const existing = await pool.query(
        `SELECT password_hash, password_salt, password_ciphertext, password_iv, password_auth_tag
         FROM offline_conversions_basic_auth_settings
         WHERE id = 1`
    );
    const existingRow = existing.rows[0];
    const passwordFields = suppliedPassword
        ? {
            ...hashPassword(normalizePassword(suppliedPassword)),
            ...encryptPassword(normalizePassword(suppliedPassword))
        }
        : existingRow
            ? {
                passwordHash: existingRow.password_hash,
                passwordSalt: existingRow.password_salt,
                passwordCiphertext: existingRow.password_ciphertext,
                passwordIv: existingRow.password_iv,
                passwordAuthTag: existingRow.password_auth_tag
            }
            : null;
    if (!passwordFields) throw new Error('Basic Auth password is required for initial setup.');

    const { rows } = await pool.query(
        `INSERT INTO offline_conversions_basic_auth_settings
            (id, username, password_hash, password_salt, password_ciphertext, password_iv, password_auth_tag, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE SET
            username = EXCLUDED.username,
            password_hash = EXCLUDED.password_hash,
            password_salt = EXCLUDED.password_salt,
            password_ciphertext = EXCLUDED.password_ciphertext,
            password_iv = EXCLUDED.password_iv,
            password_auth_tag = EXCLUDED.password_auth_tag,
            updated_at = CURRENT_TIMESTAMP
         RETURNING username, password_hash, password_salt, password_ciphertext, password_iv, password_auth_tag, updated_at`,
        [
            username,
            passwordFields.passwordHash,
            passwordFields.passwordSalt,
            passwordFields.passwordCiphertext,
            passwordFields.passwordIv,
            passwordFields.passwordAuthTag
        ]
    );
    return rowToStatus(rows[0]);
}

export async function revealOfflineConversionsBasicAuthPassword(pool: Pool): Promise<{
    username: string;
    password: string;
    updatedAt: string | null;
}> {
    await ensureOfflineConversionsAuthSchema(pool);
    const { rows } = await pool.query(
        `SELECT username, password_hash, password_salt, password_ciphertext, password_iv, password_auth_tag, updated_at
         FROM offline_conversions_basic_auth_settings
         WHERE id = 1`
    );
    const row = rows[0];
    if (!row?.username || !row?.password_hash || !row?.password_salt) {
        throw new Error('Offline conversions Basic Auth is not configured.');
    }
    return {
        username: row.username,
        password: decryptPassword(row),
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
}

export async function verifyOfflineConversionsBasicAuth(pool: Pool, username: string, password: string): Promise<{
    configured: boolean;
    ok: boolean;
}> {
    await ensureOfflineConversionsAuthSchema(pool);
    const { rows } = await pool.query(
        `SELECT username, password_hash, password_salt
         FROM offline_conversions_basic_auth_settings
         WHERE id = 1`
    );
    const row = rows[0];
    if (!row?.username || !row?.password_hash || !row?.password_salt) {
        return { configured: false, ok: false };
    }
    const userOk = timingSafeStringEqual(username, row.username);
    const candidateHash = hashPassword(password, row.password_salt).passwordHash;
    const passwordOk = timingSafeStringEqual(candidateHash, row.password_hash);
    return { configured: true, ok: userOk && passwordOk };
}
