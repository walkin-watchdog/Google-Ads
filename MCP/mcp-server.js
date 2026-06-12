#!/usr/bin/env bun
const fs = require('fs');
const readline = require('readline');

// The MCP uses the API Base and API Key from the environment
let API_BASE = process.env.API_BASE || 'http://localhost:8080';
if (API_BASE && !API_BASE.startsWith('http')) API_BASE = 'http://' + API_BASE;
const API_KEY = process.env.SECRET_API_KEY;
const DEFAULT_FETCH_TIMEOUT_MS = 20000;
const configuredFetchTimeoutMs = Number(process.env.MCP_FETCH_TIMEOUT_MS || DEFAULT_FETCH_TIMEOUT_MS);
const FETCH_TIMEOUT_MS = Number.isFinite(configuredFetchTimeoutMs) && configuredFetchTimeoutMs > 0
    ? configuredFetchTimeoutMs
    : DEFAULT_FETCH_TIMEOUT_MS;

if (!API_KEY) {
    console.error('ERROR: SECRET_API_KEY environment variable is required.');
    process.exit(1);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    return await new Promise((resolve, reject) => {
        let settled = false;
        const failWithTimeout = () => {
            if (settled) return;
            settled = true;
            controller.abort();
            reject(new Error(`Timed out after ${timeoutMs}ms calling ${url}`));
        };
        const timeout = setTimeout(failWithTimeout, timeoutMs);

        const handleFailure = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (err && err.name === 'AbortError') {
                reject(new Error(`Timed out after ${timeoutMs}ms calling ${url}`));
                return;
            }
            reject(err);
        };

        fetch(url, { ...options, signal: controller.signal })
            .then(async (response) => {
                const bodyText = await response.text();
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve({
                    ok: response.ok,
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                    text: async () => bodyText,
                    json: async () => bodyText ? JSON.parse(bodyText) : {}
                });
            })
            .catch(handleFailure);
    });
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
            sendResponse(req.id, {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "lightweight-dashboard-mcp", version: "1.0.0" }
            });
        } else if (req.method === 'tools/list') {
            try {
                const proxyRes = await fetchWithTimeout(`${API_BASE}/api/mcp`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
                    body: JSON.stringify({ method: 'tools/list' })
                });
                const remoteData = proxyRes.ok ? await proxyRes.json() : { tools: [] };
                const remoteTools = (remoteData.tools || []).filter(tool => tool && tool.name !== 'get_dashboard_data');

                sendResponse(req.id, {
                    tools: [
                        {
                            name: 'get_dashboard_data',
                            description: 'Fetches Google Ads dashboard data. Without a section, returns compact decision-ready context. Provide section such as decisionContext, sourceCoverage, negatives, configuredKeywords, searchTerms, keywordPlanner, qualityScores, landingPages, devicePerformance, dayOfWeekPerformance, dayAndHourPerformance, leadAttribution, auctionInsightsStatus, candidateSignals, keywords, campaigns, dailyTrend, or summary for full data.',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    section: { type: 'string', description: 'Specific top-level dashboard section to extract.' }
                                }
                            }
                        },
                        ...remoteTools
                    ]
                });
            } catch (err) {
                console.error(`[MCP Proxy Error] Failed to fetch tools from backend: ${err.message}`);
                // fallback to local only
                sendResponse(req.id, {
                    tools: [{
                        name: 'get_dashboard_data',
                        description: 'Fetches compact Google Ads decision context by default. Provide a section such as decisionContext, sourceCoverage, negatives, configuredKeywords, searchTerms, keywordPlanner, candidateSignals, keywords, campaigns, dailyTrend, or summary.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                section: { type: 'string' }
                            }
                        }
                    }]
                });
            }
        } else if (req.method === 'tools/call') {
            if (req.params.name === 'get_dashboard_data') {
                try {
                    const section = req.params.arguments?.section;
                    if (!section) {
                        const proxyRes = await fetchWithTimeout(`${API_BASE}/api/mcp`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
                            body: JSON.stringify({
                                method: 'tools/call',
                                params: { name: 'get_decision_context', arguments: {} }
                            })
                        });
                        const result = await proxyRes.json();
                        if (!proxyRes.ok) throw new Error(result.error || `HTTP error ${proxyRes.status}`);
                        sendResponse(req.id, result);
                        return;
                    }

                    const res = await fetchWithTimeout(`${API_BASE}/api/dashboard`, {
                        headers: { 'Authorization': `Bearer ${API_KEY}` }
                    });
                    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                    let data = await res.json();

                    if (section && Object.prototype.hasOwnProperty.call(data || {}, section)) {
                        // Return the full untruncated array for the requested section
                        data = { [section]: data[section] };
                    } else if (section) {
                        data = {
                            error: `Unknown dashboard section: ${section}`,
                            availableSections: Object.keys(data || {}).sort()
                        };
                    }

                    sendResponse(req.id, {
                        content: [{ type: 'text', text: JSON.stringify(data) }]
                    });
                } catch (err) {
                    sendResponse(req.id, {
                        content: [{ type: 'text', text: `Failed to fetch data: ${err.message}` }],
                        isError: true
                    });
                }
            } else {
                // Proxy everything else to cloud MCP
                try {
                    const proxyRes = await fetchWithTimeout(`${API_BASE}/api/mcp`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
                        body: JSON.stringify({ method: 'tools/call', params: req.params })
                    });

                    const result = await proxyRes.json();
                    if (!proxyRes.ok) throw new Error(result.error || `HTTP error ${proxyRes.status}`);

                    sendResponse(req.id, result);
                } catch (err) {
                    console.error(`[MCP Proxy Error] Failed to call tool: ${err.message}`);
                    sendResponse(req.id, {
                        content: [{ type: 'text', text: `Cloud MCP error: ${err.message}` }],
                        isError: true
                    });
                }
            }
        }
    } catch (e) {
        // Ignore parse errors silently to not break stdio
    }
});

function sendResponse(id, result) {
    console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function sendError(id, code, message) {
    console.log(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
}
