import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import path from 'path';

let server;
const smokeTest = process.env.RUN_LOCAL_MCP_SMOKE === '1' ? test : test.skip;

afterEach(async () => {
    if (server) {
        await new Promise(resolve => server.close(resolve));
        server = null;
    }
});

function jsonRpc(id, method, params = {}) {
    return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

async function readRequestJson(req) {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    return JSON.parse(raw);
}

function sendJson(res, status, payload, headers = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(body);
}

function createMockMcpBackendServer(calls) {
    return http.createServer(async (req, res) => {
        try {
            expect(req.url).toBe('/api/mcp');
            expect(req.headers['x-api-key']).toBe('test-key');
            const body = await readRequestJson(req);
            calls.push(body.method === 'tools/call' ? `${body.method}:${body.params?.name}` : body.method);
            const headers = { 'X-MCP-Session-Id': String(req.headers['x-mcp-session-id'] || 'session-1') };
            if (body.method === 'initialize') {
                return sendJson(res, 200, {
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        protocolVersion: '2025-11-25',
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: { name: 'mock', version: 'test' }
                    }
                }, headers);
            }
            if (body.method === 'notifications/initialized') {
                res.writeHead(204, headers);
                return res.end();
            }
            if (body.method === 'tools/list') {
                return sendJson(res, 200, {
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        tools: [
                            { name: 'confirm_google_ads_skill', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
                            { name: 'get_dashboard_data', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }
                        ]
                    }
                }, headers);
            }
            if (body.method === 'tools/call' && body.params?.name === 'confirm_google_ads_skill') {
                return sendJson(res, 200, {
                    jsonrpc: '2.0',
                    id: body.id,
                    result: { content: [], structuredContent: { ok: true }, isError: false }
                }, headers);
            }
            if (body.method === 'tools/call' && body.params?.name === 'get_dashboard_data') {
                return sendJson(res, 200, {
                    jsonrpc: '2.0',
                    id: body.id,
                    result: { content: [], structuredContent: { summary: { clicks: 1 } }, isError: false }
                }, headers);
            }
            return sendJson(res, 404, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'not found' } }, headers);
        } catch (error) {
            return sendJson(res, 500, { error: error.message });
        }
    });
}

async function listenOnPort(mockServer, port) {
    await new Promise((resolve, reject) => {
        const onError = error => {
            mockServer.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            mockServer.off('error', onError);
            resolve();
        };
        mockServer.once('error', onError);
        mockServer.once('listening', onListening);
        mockServer.listen(port, '127.0.0.1');
    });
}

async function startMockMcpBackend(calls) {
    const startPort = 18000 + Math.floor(Math.random() * 10000);
    let lastError;
    for (let offset = 0; offset < 50; offset += 1) {
        const port = startPort + offset;
        const mockServer = createMockMcpBackendServer(calls);
        try {
            await listenOnPort(mockServer, port);
            return { port, server: mockServer };
        } catch (error) {
            lastError = error;
            await new Promise(resolve => mockServer.close(resolve));
            if (error.code !== 'EADDRINUSE') break;
        }
    }
    throw lastError || new Error('Unable to start mock MCP backend.');
}

describe('local MCP stdio smoke', () => {
    smokeTest('initializes, lists tools, confirms skill, and fetches dashboard data', async () => {
        const calls = [];
        const mockBackend = await startMockMcpBackend(calls);
        server = mockBackend.server;

        const proc = Bun.spawn(['bun', path.join(import.meta.dir, '..', '..', 'MCP', 'mcp-server.js')], {
            env: {
                ...process.env,
                API_BASE: `http://127.0.0.1:${mockBackend.port}`,
                MCP_API_KEY: 'test-key'
            },
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe'
        });
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        async function readLine() {
            while (!buffer.includes('\n')) {
                const { value, done } = await reader.read();
                if (done) throw new Error('MCP process ended before response.');
                buffer += decoder.decode(value);
            }
            const index = buffer.indexOf('\n');
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            return JSON.parse(line);
        }

        async function write(line) {
            proc.stdin.write(line);
            await proc.stdin.flush();
        }

        await write(jsonRpc(1, 'initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'smoke', version: '1' }
        }));
        expect((await readLine()).result.protocolVersion).toBe('2025-11-25');

        await write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
        await write(jsonRpc(2, 'tools/list'));
        const toolsListResponse = await readLine();
        if (!toolsListResponse.result) throw new Error(JSON.stringify(toolsListResponse));
        expect(toolsListResponse.result.tools.map(tool => tool.name)).toEqual(['confirm_google_ads_skill', 'get_dashboard_data']);

        await write(jsonRpc(3, 'tools/call', {
            name: 'confirm_google_ads_skill',
            arguments: { skillName: 'saas-google-ads-dashboard-analyst', installed: true, loaded: true }
        }));
        const confirmResponse = await readLine();
        if (!confirmResponse.result) throw new Error(JSON.stringify(confirmResponse));
        expect(confirmResponse.result.structuredContent.ok).toBe(true);

        await write(jsonRpc(4, 'tools/call', {
            name: 'get_dashboard_data',
            arguments: { dateRangePreset: 'all_time' }
        }));
        const dashboardResponse = await readLine();
        if (!dashboardResponse.result) throw new Error(JSON.stringify(dashboardResponse));
        expect(dashboardResponse.result.structuredContent.summary.clicks).toBe(1);

        proc.kill();
        expect(calls).toEqual([
            'initialize',
            'notifications/initialized',
            'tools/list',
            'tools/call:confirm_google_ads_skill',
            'tools/call:get_dashboard_data'
        ]);
    });
});
