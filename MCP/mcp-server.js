#!/usr/bin/env bun
const readline = require('readline');

// The MCP uses the API Base and API Key from the environment
let API_BASE = process.env.API_BASE || 'http://localhost:8080';
if (API_BASE && !API_BASE.startsWith('http')) API_BASE = 'http://' + API_BASE;
const API_KEY = process.env.SECRET_API_KEY;
const DEFAULT_FETCH_TIMEOUT_MS = 60000;
const configuredFetchTimeoutMs = Number(process.env.MCP_FETCH_TIMEOUT_MS || DEFAULT_FETCH_TIMEOUT_MS);
const FETCH_TIMEOUT_MS = Number.isFinite(configuredFetchTimeoutMs) && configuredFetchTimeoutMs > 0
    ? configuredFetchTimeoutMs
    : DEFAULT_FETCH_TIMEOUT_MS;
const REQUIRED_SKILL_NAME = 'saas-google-ads-dashboard-analyst';
const SKILL_TOOL_NAME = 'confirm_google_ads_skill';
const REQUIRE_SKILL_READ = process.env.MCP_REQUIRE_GOOGLE_ADS_SKILL_READ !== 'false';
let skillRead = !REQUIRE_SKILL_READ;

if (!API_KEY) {
    console.error('ERROR: SECRET_API_KEY environment variable is required.');
    process.exit(1);
}

function skillInstallMessage() {
    return [
        `Required Codex skill is not installed or not available: ${REQUIRED_SKILL_NAME}.`,
        `Tell the user to install/enable the ${REQUIRED_SKILL_NAME} skill, then stop immediately without using any Google Ads MCP tools.`
    ].join(' ');
}

function skillConfirmationMessage() {
    return [
        `Before using this MCP, inspect the agent's installed skills and load ${REQUIRED_SKILL_NAME}.`,
        `If ${REQUIRED_SKILL_NAME} is not installed or cannot be loaded, tell the user to install/enable it and stop immediately.`,
        `After loading it, call ${SKILL_TOOL_NAME} with skillName="${REQUIRED_SKILL_NAME}", installed=true, and loaded=true.`
    ].join(' ');
}

function confirmSkill(args = {}) {
    const skillName = String(args.skillName || '').trim();
    const installed = args.installed === true;
    const loaded = args.loaded === true;
    if (skillName !== REQUIRED_SKILL_NAME || !installed) {
        return { ok: false, message: skillInstallMessage() };
    }
    if (!loaded) {
        return {
            ok: false,
            message: `The ${REQUIRED_SKILL_NAME} skill must be loaded/read before using this MCP. Load it, then call ${SKILL_TOOL_NAME} again with loaded=true.`
        };
    }
    return {
        ok: true,
        message: `Confirmed ${REQUIRED_SKILL_NAME} is installed and loaded. Continue using Google Ads MCP tools according to that skill's instructions.`
    };
}

function skillToolDefinition() {
    return {
        name: SKILL_TOOL_NAME,
        description: `Mandatory first call for LLM agents. Confirm that the installed Codex skill ${REQUIRED_SKILL_NAME} is available and loaded before using any other MCP tool. If it is missing, tell the user to install it and stop immediately.`,
        inputSchema: {
            type: 'object',
            properties: {
                skillName: {
                    type: 'string',
                    description: `Must be ${REQUIRED_SKILL_NAME}.`
                },
                installed: {
                    type: 'boolean',
                    description: `True only after checking that ${REQUIRED_SKILL_NAME} is in the installed skills list.`
                },
                loaded: {
                    type: 'boolean',
                    description: `True only after loading/reading ${REQUIRED_SKILL_NAME} for this task.`
                }
            },
            required: ['skillName', 'installed', 'loaded']
        }
    };
}

function skillGateResponse() {
    return {
        content: [{
            type: 'text',
            text: skillConfirmationMessage()
        }],
        isError: true
    };
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

function dashboardArguments(args = {}) {
    const allowed = ['customerId', 'startDate', 'endDate', 'campaignId', 'adGroupId', 'section', 'view', 'limit', 'topSearchTerms', 'topSignals', 'maxAdGroups'];
    return Object.fromEntries(allowed
        .filter(key => args[key] !== undefined && args[key] !== null && String(args[key]).trim() !== '')
        .map(key => [key, String(args[key]).trim()]));
}

rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
            sendResponse(req.id, {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                instructions: REQUIRE_SKILL_READ
                    ? skillConfirmationMessage()
                    : undefined,
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
                const remoteTools = (remoteData.tools || []).filter(tool =>
                    tool && tool.name !== 'get_dashboard_data' && tool.name !== SKILL_TOOL_NAME && tool.name !== 'read_google_ads_skill'
                );

                sendResponse(req.id, {
                    tools: [
                        skillToolDefinition(),
                        {
                            name: 'get_dashboard_data',
                            description: 'Fetches Google Ads dashboard data from the DB-backed warehouse. Without a section, returns compact decision-ready context. Use startDate/endDate/campaignId/adGroupId to request a server-side filtered slice; do not use refresh as a date filter.',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    section: { type: 'string', description: 'Specific top-level dashboard section to extract.' },
                                    view: { type: 'string', description: 'Optional dashboard view: overview, performance, keywords, attribution, rank, proposals, or full.' },
                                    customerId: { type: 'string', description: 'Optional Google Ads customer id.' },
                                    startDate: { type: 'string', description: 'Optional YYYY-MM-DD dashboard slice start.' },
                                    endDate: { type: 'string', description: 'Optional YYYY-MM-DD dashboard slice end.' },
                                    campaignId: { type: 'string', description: 'Optional Google Ads campaign id filter.' },
                                    adGroupId: { type: 'string', description: 'Optional Google Ads ad group id filter.' },
                                    limit: { type: 'number', description: 'Optional candidate-signal cap when section is candidateSignals. Defaults to 250, max 1000.' },
                                    topSearchTerms: { type: 'number', description: 'Optional top search terms per ad group when section is proposalContext. Defaults to 8, max 25.' },
                                    topSignals: { type: 'number', description: 'Optional top candidate signals per ad group when section is proposalContext. Defaults to 10, max 25.' },
                                    maxAdGroups: { type: 'number', description: 'Optional cap on returned enabled ad groups when section is proposalContext.' }
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
                    tools: [
                        skillToolDefinition(),
                        {
                            name: 'get_dashboard_data',
                            description: 'Fetches compact Google Ads decision context by default from the DB-backed warehouse. Provide section and optional startDate/endDate/campaignId/adGroupId filters.',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    section: { type: 'string' },
                                    view: { type: 'string' },
                                    customerId: { type: 'string' },
                                    startDate: { type: 'string' },
                                    endDate: { type: 'string' },
                                    campaignId: { type: 'string' },
                                    adGroupId: { type: 'string' },
                                    limit: { type: 'number' },
                                    topSearchTerms: { type: 'number' },
                                    topSignals: { type: 'number' },
                                    maxAdGroups: { type: 'number' }
                                }
                            }
                        }
                    ]
                });
            }
        } else if (req.method === 'tools/call') {
            if (req.params?.name === SKILL_TOOL_NAME) {
                const result = confirmSkill(req.params.arguments || {});
                if (result.ok) skillRead = true;
                sendResponse(req.id, {
                    content: [{ type: 'text', text: result.message }],
                    isError: !result.ok
                });
                return;
            }
            if (!skillRead) {
                sendResponse(req.id, skillGateResponse());
                return;
            }
            if (req.params.name === 'get_dashboard_data') {
                try {
                    const args = req.params.arguments || {};
                    const proxyRes = await fetchWithTimeout(`${API_BASE}/api/mcp`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
                        body: JSON.stringify({
                            method: 'tools/call',
                            params: { name: 'get_dashboard_data', arguments: dashboardArguments(args) }
                        })
                    });
                    const result = await proxyRes.json();
                    if (!proxyRes.ok) throw new Error(result.error || `HTTP error ${proxyRes.status}`);
                    sendResponse(req.id, result);
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
