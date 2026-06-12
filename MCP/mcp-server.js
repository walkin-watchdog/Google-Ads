#!/usr/bin/env bun
const crypto = require('crypto');
const readline = require('readline');

const MCP_PROTOCOL_VERSION = '2025-11-25';
const MCP_MIN_PROTOCOL_VERSION = '2025-11-25';
const API_BASE = normalizeApiBase(process.env.API_BASE || 'http://localhost:7860');
const API_KEY = process.env.MCP_API_KEY;
const DEFAULT_FETCH_TIMEOUT_MS = 60000;
const FETCH_TIMEOUT_MS = positiveInt(process.env.MCP_FETCH_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS);

let sessionId = process.env.MCP_SESSION_ID || crypto.randomUUID();
let initialized = false;

if (!API_KEY) {
    console.error('ERROR: MCP_API_KEY environment variable is required. Configure backend MCP_API_KEYS_JSON with this key hash.');
    process.exit(1);
}

function normalizeApiBase(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return 'http://localhost:7860';
    return trimmed.startsWith('http') ? trimmed.replace(/\/+$/, '') : `http://${trimmed.replace(/\/+$/, '')}`;
}

function positiveInt(value, fallback) {
    const number = Number(value || fallback);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function send(payload) {
    process.stdout.write(JSON.stringify(payload) + '\n');
}

function response(id, result) {
    send({ jsonrpc: '2.0', id: id ?? null, result });
}

function error(id, code, message, data) {
    const payload = { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
    if (data !== undefined) payload.error.data = data;
    send(payload);
}

async function postBackend(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${API_BASE}/api/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': API_KEY,
                'X-MCP-Session-Id': sessionId
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        const returnedSessionId = res.headers.get('x-mcp-session-id');
        if (returnedSessionId) sessionId = returnedSessionId;
        if (res.status === 204) return null;
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    } catch (err) {
        if (err && err.name === 'AbortError') {
            throw new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms calling backend MCP endpoint.`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

function normalizeMcpProtocolVersion(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const [year, month, day] = text.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day
    ) {
        return null;
    }
    return text;
}

function isSupportedMcpProtocolVersion(value) {
    const version = normalizeMcpProtocolVersion(value);
    return Boolean(version && version >= MCP_MIN_PROTOCOL_VERSION);
}

function assertModernInitialize(req) {
    if (!isSupportedMcpProtocolVersion(req?.params?.protocolVersion)) {
        const requested = normalizeMcpProtocolVersion(req?.params?.protocolVersion) || String(req?.params?.protocolVersion || 'missing').trim() || 'missing';
        throw Object.assign(new Error(`Unsupported MCP protocol version ${requested}. This proxy requires ${MCP_MIN_PROTOCOL_VERSION} or newer and currently negotiates ${MCP_PROTOCOL_VERSION}.`), {
            code: -32602
        });
    }
}

async function forward(req) {
    const backend = await postBackend(req);
    if (backend && backend.error) {
        error(req.id, backend.error.code || -32603, backend.error.message || 'Backend MCP error.', backend.error.data);
        return false;
    }
    if (backend && Object.prototype.hasOwnProperty.call(backend, 'result')) {
        response(req.id, backend.result);
    }
    return true;
}

async function handleLine(line) {
    if (!line.trim()) return;
    let req;
    try {
        req = JSON.parse(line);
    } catch (err) {
        error(null, -32700, 'Parse error');
        return;
    }

    try {
        if (req.jsonrpc !== '2.0') {
            error(req.id, -32600, 'JSON-RPC version must be 2.0.');
            return;
        }
        if (req.method === 'initialize') {
            assertModernInitialize(req);
            await forward(req);
            initialized = false;
            return;
        }
        if (req.method === 'notifications/initialized') {
            const backend = await postBackend(req);
            if (backend && backend.error) {
                error(req.id, backend.error.code || -32603, backend.error.message || 'Backend MCP error.', backend.error.data);
                return;
            }
            initialized = true;
            return;
        }
        if (!initialized) {
            error(req.id, -32002, 'MCP session is not initialized. Send initialize and notifications/initialized first.');
            return;
        }
        if (req.method === 'tools/list' || req.method === 'tools/call') {
            await forward(req);
            return;
        }
        error(req.id, -32601, `Method not found: ${req.method}`);
    } catch (err) {
        error(req.id, err.code || -32603, err.message || 'Internal MCP proxy error.');
    }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let requestQueue = Promise.resolve();

rl.on('line', line => {
    requestQueue = requestQueue
        .then(() => handleLine(line))
        .catch(err => {
            error(null, err.code || -32603, err.message || 'Internal MCP proxy error.');
        });
});
