import {
    deferGoogleAdsQuota,
    type GoogleAdsQuotaExhaustionSignal,
    googleAdsQuotaFeedbackDelayMs,
    GoogleAdsQuotaError,
    recordGoogleAdsQueryResourceConsumption,
    waitForGoogleAdsQuota
} from './googleAdsQuota';

const DEFAULT_GOOGLE_ADS_API_VERSION = 'v24';
const DEFAULT_GOOGLE_ADS_FETCH_TIMEOUT_MS = 25_000;
const DEFAULT_GOOGLE_ADS_STREAM_TOTAL_DEADLINE_MS = 10 * 60_000;
const DEFAULT_GOOGLE_ADS_MAX_RETRIES = 4;
const DEFAULT_GOOGLE_ADS_RETRY_BASE_MS = 1_000;
const DEFAULT_GOOGLE_ADS_RETRY_MAX_MS = 60_000;

export type GoogleAdsRetryMode = 'read' | 'validate_only' | 'mutate';

export interface GoogleAdsJsonRequest {
    token: string;
    path: string;
    method?: string;
    body?: any;
    retryMode?: GoogleAdsRetryMode;
    timeoutMs?: number;
    totalDeadlineMs?: number;
}

export interface GoogleAdsJsonResponse<T = any> {
    data: T;
    requestId: string | null;
    apiVersion: string;
    attempts: number;
}

export interface ExecuteGaqlOptions {
    maxRows?: number;
}

export interface ExecuteGaqlResult {
    rows: any[];
    rowCount: number;
    truncated: boolean;
    requestId: string | null;
    apiVersion: string;
}

interface GoogleAdsRawResponse {
    response: Response;
    requestId: string | null;
    apiVersion: string;
    attempts: number;
    finish: () => void;
}

export class GoogleAdsApiError extends Error {
    status: number | null;
    requestId: string | null;
    apiVersion: string;
    googleAdsErrors: any[];
    retryable: boolean;
    payload: any;

    constructor(message: string, input: {
        status?: number | null;
        requestId?: string | null;
        apiVersion: string;
        googleAdsErrors?: any[];
        retryable?: boolean;
        payload?: any;
    }) {
        super(message);
        this.name = 'GoogleAdsApiError';
        this.status = input.status ?? null;
        this.requestId = input.requestId ?? null;
        this.apiVersion = input.apiVersion;
        this.googleAdsErrors = input.googleAdsErrors || [];
        this.retryable = input.retryable === true;
        this.payload = input.payload;
    }
}

function numberEnv(name: string, fallback: number, minimum = 0): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isFinite(value) && value >= minimum ? value : fallback;
}

export function googleAdsApiVersion(): string {
    const version = String(process.env.GOOGLE_ADS_API_VERSION || DEFAULT_GOOGLE_ADS_API_VERSION).trim();
    if (!/^v\d+$/.test(version)) {
        throw new Error('GOOGLE_ADS_API_VERSION must match v<major>, for example v24.');
    }
    return version;
}

export function googleAdsApiUrl(path: string): string {
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    return `https://googleads.googleapis.com/${googleAdsApiVersion()}/${normalizedPath}`;
}

export function googleAdsHeaders(token: string): Record<string, string> {
    const devToken = process.env.GOOGLE_DEVELOPER_TOKEN || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';
    const loginCustomerId = process.env.GOOGLE_LOGIN_CUSTOMER_ID || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'developer-token': devToken,
        'Content-Type': 'application/json'
    };
    if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId).trim().replace(/-/g, '');
    return headers;
}

function retryConfig() {
    return {
        maxRetries: Math.floor(numberEnv('GOOGLE_ADS_MAX_RETRIES', DEFAULT_GOOGLE_ADS_MAX_RETRIES, 0)),
        baseMs: numberEnv('GOOGLE_ADS_RETRY_BASE_MS', DEFAULT_GOOGLE_ADS_RETRY_BASE_MS, 0),
        maxMs: numberEnv('GOOGLE_ADS_RETRY_MAX_MS', DEFAULT_GOOGLE_ADS_RETRY_MAX_MS, 1),
        timeoutMs: numberEnv('GOOGLE_ADS_FETCH_TIMEOUT_MS', DEFAULT_GOOGLE_ADS_FETCH_TIMEOUT_MS, 1_000),
        streamDeadlineMs: numberEnv('GOOGLE_ADS_STREAM_TOTAL_DEADLINE_MS', DEFAULT_GOOGLE_ADS_STREAM_TOTAL_DEADLINE_MS, 1_000)
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function requestIdFrom(response: Response): string | null {
    return response.headers.get('request-id')
        || response.headers.get('x-google-ads-request-id')
        || response.headers.get('x-request-id');
}

function retryAfterMs(response: Response): number | null {
    const raw = response.headers.get('retry-after');
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = new Date(raw).getTime();
    return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function googleAdsQuotaRequest(input: GoogleAdsJsonRequest, method = input.method || 'POST', retryMode = input.retryMode || 'read') {
    return {
        path: input.path,
        method,
        body: input.body,
        retryMode
    };
}

function googleErrorEnvelopes(payload: any): any[] {
    return Array.isArray(payload) ? payload : [payload];
}

function googleErrorDetails(payload: any): any[] {
    return googleErrorEnvelopes(payload).flatMap((envelope: any) => {
        const details = envelope?.error?.details;
        if (!Array.isArray(details)) return [];
        return details.flatMap((detail: any) => detail?.errors || detail?.googleAdsFailure?.errors || []);
    });
}

function googleErrorStatus(payload: any): string {
    const status = googleErrorEnvelopes(payload)
        .map((envelope: any) => String(envelope?.error?.status || '').toUpperCase())
        .find(Boolean);
    return status || '';
}

function googleErrorSummary(payload: any): string {
    const error = googleErrorDetails(payload)[0];
    const enumCode = Object.values(error?.errorCode || {}).map(value => String(value || '').trim()).find(Boolean);
    const message = String(error?.message || '').trim();
    if (enumCode && message) return `${enumCode}: ${message}`;
    if (enumCode) return enumCode;
    if (message) return message;
    return googleErrorEnvelopes(payload)
        .map((envelope: any) => String(envelope?.error?.message || '').trim())
        .find(Boolean) || '';
}

function googleAdsQuotaExhaustionSignal(payload: any): GoogleAdsQuotaExhaustionSignal | null {
    const status = googleErrorStatus(payload);
    const message = JSON.stringify(payload || '').toUpperCase();
    if (message.includes('EXCESSIVE_LONG_TERM_QUERY_RESOURCE_CONSUMPTION')) return 'long_term_query_resource';
    if (message.includes('EXCESSIVE_SHORT_TERM_QUERY_RESOURCE_CONSUMPTION')) return 'short_term_query_resource';
    if (status === 'RESOURCE_EXHAUSTED' || message.includes('RESOURCE_EXHAUSTED')) return 'resource_exhausted';
    return null;
}

function isRetryablePayload(payload: any): boolean {
    const status = googleErrorStatus(payload);
    if (['RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED'].includes(status)) return true;
    if (googleAdsQuotaExhaustionSignal(payload)) return true;
    const message = JSON.stringify(payload || '').toUpperCase();
    return message.includes('UNAVAILABLE')
        || message.includes('DEADLINE_EXCEEDED');
}

function isResourceExhaustedPayload(payload: any): boolean {
    return googleAdsQuotaExhaustionSignal(payload) !== null;
}

function isRetryableStatus(status: number): boolean {
    return [408, 429, 500, 502, 503, 504].includes(status);
}

function canRetry(mode: GoogleAdsRetryMode): boolean {
    return mode === 'read' || mode === 'validate_only';
}

function remainingDeadlineMs(startedAt: number, totalDeadlineMs: number): number {
    return Math.max(0, totalDeadlineMs - (Date.now() - startedAt));
}

function requestTimeoutMs(input: GoogleAdsJsonRequest, config: ReturnType<typeof retryConfig>, totalDeadlineMs: number, startedAt: number): number {
    const configured = input.timeoutMs || (input.path.endsWith('googleAds:searchStream') ? totalDeadlineMs : config.timeoutMs);
    return Math.max(1, Math.min(configured, remainingDeadlineMs(startedAt, totalDeadlineMs) || 1));
}

function backoffMs(attempt: number, response: Response | null, config = retryConfig()): number {
    const retryAfter = response ? retryAfterMs(response) : null;
    if (retryAfter !== null) return Math.min(retryAfter, config.maxMs);
    const exponential = Math.min(config.maxMs, config.baseMs * Math.pow(2, Math.max(0, attempt - 1)));
    return Math.floor(Math.random() * Math.max(1, exponential + 1));
}

async function sleepBeforeRetry(attempt: number, response: Response | null, config: ReturnType<typeof retryConfig>, startedAt: number, totalDeadlineMs: number, lastError: any): Promise<void> {
    const delayMs = backoffMs(attempt, response, config);
    if (delayMs >= remainingDeadlineMs(startedAt, totalDeadlineMs)) throw lastError;
    await sleep(delayMs);
}

async function parseJsonOrText(response: Response): Promise<any> {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return { rawText: text };
    }
}

function googleAdsBodyReadError(err: any, raw: GoogleAdsRawResponse): GoogleAdsApiError {
    return new GoogleAdsApiError(
        err?.name === 'AbortError'
            ? 'Google Ads API response body timed out before it was fully read.'
            : err?.message || 'Google Ads API response body could not be read.',
        {
            status: raw.response.status,
            requestId: raw.requestId,
            apiVersion: raw.apiVersion,
            retryable: true,
            payload: err
        }
    );
}

async function recordQueryResourceConsumption(input: GoogleAdsJsonRequest, payload: any): Promise<void> {
    await recordGoogleAdsQueryResourceConsumption(googleAdsQuotaRequest(input), payload).catch(err => {
        console.warn('Failed to record Google Ads query resource consumption:', err?.message || err);
    });
}

async function fetchGoogleAdsRaw(input: GoogleAdsJsonRequest): Promise<GoogleAdsRawResponse> {
    const apiVersion = googleAdsApiVersion();
    const config = retryConfig();
    const retryMode = input.retryMode || 'read';
    const method = input.method || 'POST';
    const startedAt = Date.now();
    const totalDeadlineMs = input.totalDeadlineMs || config.streamDeadlineMs;
    let attempt = 0;
    let lastError: any = null;

    while (attempt <= config.maxRetries) {
        attempt += 1;
        if (remainingDeadlineMs(startedAt, totalDeadlineMs) <= 0) {
            throw lastError || new GoogleAdsApiError('Google Ads API total deadline was exhausted before the next retry.', { apiVersion, retryable: canRetry(retryMode) });
        }
        let timeoutMs = requestTimeoutMs(input, config, totalDeadlineMs, startedAt);
        let controller: AbortController | null = null;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let response: Response | null = null;
        let keepTimeoutForBody = false;
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            if (timeout) clearTimeout(timeout);
        };
        try {
            const quotaInput = googleAdsQuotaRequest(input, method, retryMode);
            await waitForGoogleAdsQuota(quotaInput);
            if (remainingDeadlineMs(startedAt, totalDeadlineMs) <= 0) {
                throw lastError || new GoogleAdsApiError('Google Ads API total deadline was exhausted before the request could be sent.', { apiVersion, retryable: canRetry(retryMode) });
            }
            timeoutMs = requestTimeoutMs(input, config, totalDeadlineMs, startedAt);
            controller = new AbortController();
            timeout = setTimeout(() => controller?.abort(), timeoutMs);
            response = await fetch(googleAdsApiUrl(input.path), {
                method,
                headers: googleAdsHeaders(input.token),
                body: input.body === undefined ? undefined : JSON.stringify(input.body),
                signal: controller.signal
            });
            const requestId = requestIdFrom(response);
            if (response.ok) {
                keepTimeoutForBody = true;
                return { response, requestId, apiVersion, attempts: attempt, finish };
            }

            const payload = await parseJsonOrText(response);
            const retryable = canRetry(retryMode) && (isRetryableStatus(response.status) || isRetryablePayload(payload));
            const exhaustionSignal = googleAdsQuotaExhaustionSignal(payload);
            const quotaDelayMs = googleAdsQuotaFeedbackDelayMs({
                retryAfterMs: retryAfterMs(response),
                resourceExhausted: response.status === 429 || isResourceExhaustedPayload(payload),
                exhaustionSignal
            });
            if (quotaDelayMs !== null) {
                await deferGoogleAdsQuota(quotaInput, quotaDelayMs).catch(err => {
                    console.warn('Failed to update Google Ads quota governor feedback:', err?.message || err);
                });
            }
            const errorSummary = googleErrorSummary(payload);
            lastError = new GoogleAdsApiError(`Google Ads API request failed with status ${response.status}${errorSummary ? `: ${errorSummary}` : ''}.`, {
                status: response.status,
                requestId,
                apiVersion,
                googleAdsErrors: googleErrorDetails(payload),
                retryable,
                payload
            });
            if (!retryable || attempt > config.maxRetries || remainingDeadlineMs(startedAt, totalDeadlineMs) <= 0) throw lastError;
            await sleepBeforeRetry(attempt, response, config, startedAt, totalDeadlineMs, lastError);
        } catch (err: any) {
            if (err instanceof GoogleAdsApiError) throw err;
            if (err instanceof GoogleAdsQuotaError) {
                throw new GoogleAdsApiError(err.message, {
                    status: null,
                    requestId: response ? requestIdFrom(response) : null,
                    apiVersion,
                    retryable: true,
                    payload: { retryAfterMs: err.retryAfterMs }
                });
            }
            const retryable = canRetry(retryMode);
            lastError = new GoogleAdsApiError(
                err?.name === 'AbortError'
                    ? `Google Ads API request timed out after ${timeoutMs}ms.`
                    : err?.message || 'Google Ads API request failed.',
                { status: null, requestId: response ? requestIdFrom(response) : null, apiVersion, retryable, payload: err }
            );
            if (!retryable || attempt > config.maxRetries || remainingDeadlineMs(startedAt, totalDeadlineMs) <= 0) throw lastError;
            await sleepBeforeRetry(attempt, response, config, startedAt, totalDeadlineMs, lastError);
        } finally {
            if (!keepTimeoutForBody) finish();
        }
    }

    throw lastError || new GoogleAdsApiError('Google Ads API request failed.', { apiVersion });
}

export async function requestGoogleAdsJson<T = any>(input: GoogleAdsJsonRequest): Promise<GoogleAdsJsonResponse<T>> {
    const raw = await fetchGoogleAdsRaw(input);
    let data: any;
    try {
        data = await parseJsonOrText(raw.response);
        if (data?.error) {
            throw new GoogleAdsApiError(`Google Ads API request failed: ${JSON.stringify(data.error)}`, {
                status: raw.response.status,
                requestId: raw.requestId,
                apiVersion: raw.apiVersion,
                googleAdsErrors: googleErrorDetails(data),
                retryable: isRetryablePayload(data),
                payload: data
            });
        }
        await recordQueryResourceConsumption(input, data);
    } catch (err: any) {
        if (err instanceof GoogleAdsApiError) throw err;
        throw googleAdsBodyReadError(err, raw);
    } finally {
        raw.finish();
    }
    return { data: data as T, requestId: raw.requestId, apiVersion: raw.apiVersion, attempts: raw.attempts };
}

export const camelToSnake = (str: string): string => str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

export const flattenObject = (obj: any, prefix = ''): Record<string, any> => {
    let result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj || {})) {
        const newKey = prefix ? `${prefix}.${camelToSnake(key)}` : camelToSnake(key);
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            Object.assign(result, flattenObject(value, newKey));
        } else {
            result[newKey] = typeof value === 'string' && newKey.startsWith('metrics.') ? Number(value) : value;
        }
    }
    return result;
};

export async function executeGaqlWithMetadata(token: string, customerId: string, query: string, options: ExecuteGaqlOptions = {}): Promise<ExecuteGaqlResult> {
    const rows: any[] = [];
    const maxRows = Number.isFinite(Number(options.maxRows)) && Number(options.maxRows) > 0 ? Math.floor(Number(options.maxRows)) : null;
    let truncated = false;
    const searchInput: GoogleAdsJsonRequest = {
        token,
        path: `customers/${customerId}/googleAds:searchStream`,
        body: { query },
        retryMode: 'read'
    };
    const raw = await fetchGoogleAdsRaw(searchInput);

    function pushRows(chunkRows: any[] = []): void {
        for (const row of chunkRows) {
            if (maxRows !== null && rows.length >= maxRows) {
                truncated = true;
                return;
            }
            rows.push(flattenObject(row));
        }
    }

    try {
        if (!raw.response.body) {
            const data = await parseJsonOrText(raw.response);
            const chunks = Array.isArray(data) ? data : [data];
            for (const chunk of chunks) {
                if (chunk?.error) throw new GoogleAdsApiError(`Google Ads SearchStream failed: ${JSON.stringify(chunk.error)}`, {
                    status: raw.response.status,
                    requestId: raw.requestId,
                    apiVersion: raw.apiVersion,
                    googleAdsErrors: googleErrorDetails(chunk),
                    payload: chunk
                });
                await recordQueryResourceConsumption(searchInput, chunk);
                pushRows(chunk?.results || []);
                if (truncated) break;
            }
        } else {
            for await (const chunk of streamJsonArrayObjects(raw.response.body)) {
                if (chunk?.error) throw new GoogleAdsApiError(`Google Ads SearchStream failed: ${JSON.stringify(chunk.error)}`, {
                    status: raw.response.status,
                    requestId: raw.requestId,
                    apiVersion: raw.apiVersion,
                    googleAdsErrors: googleErrorDetails(chunk),
                    payload: chunk
                });
                await recordQueryResourceConsumption(searchInput, chunk);
                pushRows(chunk?.results || []);
                if (truncated) break;
            }
        }
    } catch (err: any) {
        if (err instanceof GoogleAdsApiError) throw err;
        throw googleAdsBodyReadError(err, raw);
    } finally {
        raw.finish();
    }

    return { rows, rowCount: rows.length, truncated, requestId: raw.requestId, apiVersion: raw.apiVersion };
}

export async function executeGaqlRows(token: string, customerId: string, query: string, options: ExecuteGaqlOptions = {}): Promise<any[]> {
    return (await executeGaqlWithMetadata(token, customerId, query, options)).rows;
}

async function* streamJsonArrayObjects(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let completed = false;
    let buffer = '';
    let scanIndex = 0;
    let objectStart = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    function* scanCompleteObjects(): Generator<any> {
        while (scanIndex < buffer.length) {
            const char = buffer[scanIndex];
            if (objectStart < 0) {
                if (char === '{') {
                    objectStart = scanIndex;
                    depth = 1;
                    inString = false;
                    escaped = false;
                }
                scanIndex += 1;
                continue;
            }
            if (escaped) {
                escaped = false;
                scanIndex += 1;
                continue;
            }
            if (char === '\\' && inString) {
                escaped = true;
                scanIndex += 1;
                continue;
            }
            if (char === '"') {
                inString = !inString;
                scanIndex += 1;
                continue;
            }
            if (inString) {
                scanIndex += 1;
                continue;
            }
            if (char === '{') depth += 1;
            if (char === '}') depth -= 1;
            if (depth === 0) {
                const objectEnd = scanIndex + 1;
                const json = buffer.slice(objectStart, objectEnd);
                yield JSON.parse(json);
                buffer = buffer.slice(objectEnd);
                scanIndex = 0;
                objectStart = -1;
                depth = 0;
                inString = false;
                escaped = false;
                continue;
            }
            scanIndex += 1;
        }
        if (objectStart > 0) {
            buffer = buffer.slice(objectStart);
            scanIndex -= objectStart;
            objectStart = 0;
        } else if (objectStart < 0 && buffer.length > 1024) {
            buffer = buffer.slice(-1024);
            scanIndex = buffer.length;
        }
    }

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            for (const object of scanCompleteObjects()) {
                yield object;
            }
        }
        const tail = decoder.decode();
        if (tail) {
            buffer += tail;
            for (const object of scanCompleteObjects()) {
                yield object;
            }
        }
        if (objectStart >= 0 || buffer.trim().replace(/^[\[\],\s]+|[\[\],\s]+$/g, '')) {
            throw new Error('Google Ads SearchStream returned incomplete JSON.');
        }
        completed = true;
    } finally {
        if (!completed) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

export async function* executeGaqlStreamRows(input: {
    token: string;
    customerId: string;
    query: string;
    timeoutMs?: number;
    totalDeadlineMs?: number;
}): AsyncGenerator<Record<string, any>> {
    const searchInput: GoogleAdsJsonRequest = {
        token: input.token,
        path: `customers/${input.customerId}/googleAds:searchStream`,
        body: { query: input.query },
        retryMode: 'read',
        timeoutMs: input.timeoutMs,
        totalDeadlineMs: input.totalDeadlineMs
    };
    const raw = await fetchGoogleAdsRaw(searchInput);

    if (!raw.response.body) {
        try {
            const data = await parseJsonOrText(raw.response);
            const chunks = Array.isArray(data) ? data : [data];
            for (const chunk of chunks) {
                if (chunk?.error) throw new GoogleAdsApiError(`Google Ads SearchStream failed: ${JSON.stringify(chunk.error)}`, {
                    status: raw.response.status,
                    requestId: raw.requestId,
                    apiVersion: raw.apiVersion,
                    googleAdsErrors: googleErrorDetails(chunk),
                    payload: chunk
                });
                await recordQueryResourceConsumption(searchInput, chunk);
                for (const row of chunk?.results || []) yield flattenObject(row);
            }
        } catch (err: any) {
            if (err instanceof GoogleAdsApiError) throw err;
            throw googleAdsBodyReadError(err, raw);
        } finally {
            raw.finish();
        }
        return;
    }

    try {
        for await (const chunk of streamJsonArrayObjects(raw.response.body)) {
            if (chunk?.error) throw new GoogleAdsApiError(`Google Ads SearchStream failed: ${JSON.stringify(chunk.error)}`, {
                status: raw.response.status,
                requestId: raw.requestId,
                apiVersion: raw.apiVersion,
                googleAdsErrors: googleErrorDetails(chunk),
                payload: chunk
            });
            await recordQueryResourceConsumption(searchInput, chunk);
            for (const row of chunk?.results || []) yield flattenObject(row);
        }
    } catch (err: any) {
        if (err instanceof GoogleAdsApiError) throw err;
        throw googleAdsBodyReadError(err, raw);
    } finally {
        raw.finish();
    }
}
