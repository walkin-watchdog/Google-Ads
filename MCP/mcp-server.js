#!/usr/bin/env bun
const fs = require('fs');
const readline = require('readline');

// The MCP uses the API Base and API Key from the environment
let API_BASE = process.env.API_BASE || 'http://localhost:8080';
if (API_BASE && !API_BASE.startsWith('http')) API_BASE = 'http://' + API_BASE;
const API_KEY = process.env.SECRET_API_KEY;

if (!API_KEY) {
    console.error('ERROR: SECRET_API_KEY environment variable is required.');
    process.exit(1);
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
                const proxyRes = await fetch(`${API_BASE}/api/mcp`, {
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
                            description: 'Fetches the Google Ads dashboard data. Provide a section (e.g. "keywords", "searchTerms", "keywordPlanner", "campaigns", "dailyTrend", "summary") to fetch full specific data without payload overload.',
                            inputSchema: { 
                                type: 'object', 
                                properties: {
                                    section: { type: 'string', description: 'Specific key to extract (e.g., keywords)' }
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
                        description: 'Fetches the Google Ads dashboard data. Provide a section such as keywords, searchTerms, keywordPlanner, campaigns, dailyTrend, or summary.',
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
                    const res = await fetch(`${API_BASE}/api/dashboard`, {
                        headers: { 'Authorization': `Bearer ${API_KEY}` }
                    });
                    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                    let data = await res.json();
                    
                    const section = req.params.arguments?.section;
                    if (section && data[section]) {
                        // Return the full untruncated array for the requested section
                        data = { [section]: data[section] };
                    } else if (!section) {
                        // Default to just the summary payload to prevent crashing on full dump
                        data = { 
                            error: "You requested the full payload which is too large. Returned summary only. Call again with section='keywords', 'searchTerms', 'campaigns', etc. to get full arrays.",
                            summary: data.summary, 
                            periodComparison: data.periodComparison 
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
                    const proxyRes = await fetch(`${API_BASE}/api/mcp`, {
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
