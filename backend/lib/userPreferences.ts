import type { Pool, PoolClient } from 'pg';

export class UserPreferenceValidationError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 400) {
        super(message);
        this.name = 'UserPreferenceValidationError';
        this.statusCode = statusCode;
    }
}

type Queryable = Pick<Pool | PoolClient, 'query'>;

export type UserPreferencesRecord = Record<string, unknown>;

export const VALID_PREFERENCE_KEYS = [
    'overviewCardMetrics',
    'overviewCardVisibility'
] as const;

export type ValidPreferenceKey = (typeof VALID_PREFERENCE_KEYS)[number];

const VALID_PREFERENCE_KEY_SET = new Set<string>(VALID_PREFERENCE_KEYS);

const OVERVIEW_TIME_SERIES_METRIC_KEYS = new Set([
    'conversions',
    'cpa',
    'cvr',
    'allConversions',
    'spend',
    'impressions',
    'clicks',
    'ctr',
    'avgCpc',
    'conversionsValue',
    'conversionValueCost',
    'actualRoas',
    'impressionShare',
    'lostISBudget',
    'lostISRank'
]);

const OVERVIEW_CARD_COUNT = 7;

function validateUserId(userId: unknown): string {
    const text = String(userId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
        throw new UserPreferenceValidationError('user_id must be a valid UUID.');
    }
    return text;
}

export function validatePreferenceKey(key: unknown): ValidPreferenceKey {
    const text = String(key || '').trim();
    if (!text) {
        throw new UserPreferenceValidationError('Preference key is required.');
    }
    if (text.length > 100) {
        throw new UserPreferenceValidationError('Preference key must be 100 characters or fewer.');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(text)) {
        throw new UserPreferenceValidationError('Preference key contains invalid characters.');
    }
    if (!VALID_PREFERENCE_KEY_SET.has(text)) {
        throw new UserPreferenceValidationError(`Unsupported preference key '${text}'.`);
    }
    return text as ValidPreferenceKey;
}

export function validatePreferenceValue(key: string, value: unknown): unknown {
    if (value === undefined) {
        throw new UserPreferenceValidationError(`Value for preference '${key}' cannot be undefined.`);
    }

    if (key === 'overviewCardMetrics') {
        if (!Array.isArray(value) || value.length !== OVERVIEW_CARD_COUNT) {
            throw new UserPreferenceValidationError(
                `'overviewCardMetrics' must be an array of exactly ${OVERVIEW_CARD_COUNT} metric keys.`
            );
        }
        if (new Set(value).size !== value.length) {
            throw new UserPreferenceValidationError(`'overviewCardMetrics' cannot contain duplicate metric keys.`);
        }
        for (const item of value) {
            if (typeof item !== 'string' || !OVERVIEW_TIME_SERIES_METRIC_KEYS.has(item)) {
                throw new UserPreferenceValidationError(`Invalid metric key '${String(item)}' in 'overviewCardMetrics'.`);
            }
        }
        return value;
    }

    if (key === 'overviewCardVisibility') {
        if (!Array.isArray(value) || value.length !== OVERVIEW_CARD_COUNT) {
            throw new UserPreferenceValidationError(
                `'overviewCardVisibility' must be an array of exactly ${OVERVIEW_CARD_COUNT} booleans.`
            );
        }
        for (const item of value) {
            if (typeof item !== 'boolean') {
                throw new UserPreferenceValidationError(`All elements in 'overviewCardVisibility' must be booleans.`);
            }
        }
        return value;
    }

    throw new UserPreferenceValidationError(`Unsupported preference key '${key}'.`);
}

export async function ensureUserPreferencesSchema(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS dashboard_user_preferences (
            user_id UUID NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
            pref_key VARCHAR(100) NOT NULL,
            pref_value JSONB NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, pref_key)
        );

        CREATE INDEX IF NOT EXISTS dashboard_user_preferences_user_idx
            ON dashboard_user_preferences(user_id);
    `);
}

export async function getUserPreferences(
    db: Queryable,
    userId: string
): Promise<UserPreferencesRecord> {
    const validUserId = validateUserId(userId);
    const { rows } = await db.query(
        `SELECT pref_key, pref_value
         FROM dashboard_user_preferences
         WHERE user_id = $1`,
        [validUserId]
    );

    const preferences: UserPreferencesRecord = {};
    for (const row of rows) {
        if (VALID_PREFERENCE_KEY_SET.has(row.pref_key)) {
            preferences[row.pref_key] = row.pref_value;
        }
    }
    return preferences;
}

export async function getUserPreference(
    db: Queryable,
    userId: string,
    key: string
): Promise<unknown | null> {
    const validUserId = validateUserId(userId);
    const validKey = validatePreferenceKey(key);
    const { rows } = await db.query(
        `SELECT pref_value
         FROM dashboard_user_preferences
         WHERE user_id = $1 AND pref_key = $2`,
        [validUserId, validKey]
    );

    if (rows.length === 0) return null;
    return rows[0].pref_value;
}

export async function setUserPreference(
    db: Queryable,
    userId: string,
    key: string,
    value: unknown
): Promise<unknown> {
    const validUserId = validateUserId(userId);
    const validKey = validatePreferenceKey(key);
    const validatedValue = validatePreferenceValue(validKey, value);

    const jsonString = JSON.stringify(validatedValue);

    await db.query(
        `INSERT INTO dashboard_user_preferences (user_id, pref_key, pref_value, updated_at)
         VALUES ($1, $2, $3::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, pref_key)
         DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = CURRENT_TIMESTAMP`,
        [validUserId, validKey, jsonString]
    );

    return validatedValue;
}

export async function setUserPreferences(
    db: Queryable,
    userId: string,
    preferences: Record<string, unknown>
): Promise<UserPreferencesRecord> {
    const validUserId = validateUserId(userId);
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
        throw new UserPreferenceValidationError('Preferences must be an object.');
    }

    const keys = Object.keys(preferences);
    if (keys.length === 0) {
        throw new UserPreferenceValidationError('Preferences object cannot be empty.');
    }

    const validatedMap: Record<string, unknown> = {};
    for (const k of keys) {
        const validKey = validatePreferenceKey(k);
        const validValue = validatePreferenceValue(validKey, preferences[k]);
        validatedMap[validKey] = validValue;
    }

    await db.query(
        `INSERT INTO dashboard_user_preferences (user_id, pref_key, pref_value, updated_at)
         SELECT $1::uuid, entry.key, entry.value, CURRENT_TIMESTAMP
         FROM jsonb_each($2::jsonb) AS entry(key, value)
         ON CONFLICT (user_id, pref_key)
         DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = CURRENT_TIMESTAMP`,
        [validUserId, JSON.stringify(validatedMap)]
    );

    return getUserPreferences(db, validUserId);
}
