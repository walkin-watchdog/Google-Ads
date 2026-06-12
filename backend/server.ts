import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { Pool } from 'pg';
import { spawn, execSync } from 'child_process';
import { getAccessToken, getAccessibleCustomer, executeGaql, getResourceMetadata, listAccessibleCustomers } from './lib/googleAds';

const app = express();
const PORT = process.env.PORT || 8080;

let isRefreshing = false;

app.use(cors());
app.use(express.json());

// Serve static files from dashboard directory
app.use(express.static(path.join(__dirname, '..', 'client', 'dashboard')));

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Create table if it doesn't exist
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS dashboard_payloads (
                id VARCHAR(50) PRIMARY KEY,
                payload JSONB NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS proposals (
                proposal_id VARCHAR(100) PRIMARY KEY,
                payload JSONB NOT NULL,
                status VARCHAR(50) DEFAULT 'pending_review',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS ai_diagnoses (
                diagnosis_id VARCHAR(100) PRIMARY KEY,
                payload JSONB NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Database initialized.');
    } catch (err) {
        console.error('Failed to initialize database:', err);
    }
}
initDB();

// Middleware to check API key
const authenticate = (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid Authorization header' });
        return;
    }
    const token = authHeader.split(' ')[1];
    if (token !== process.env.SECRET_API_KEY) {
        res.status(403).json({ error: 'Forbidden: Invalid API Key' });
        return;
    }
    next();
};

// API: Get latest dashboard data
app.get('/api/dashboard', authenticate, async (req: Request, res: Response) => {
    try {
        const result = await pool.query(`SELECT payload FROM dashboard_payloads WHERE id = 'latest'`);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No data found. Please trigger a refresh.' });
        }
        
        const dashboardData = result.rows[0].payload;
        
        // Inject proposals from the database
        const proposalsResult = await pool.query(`SELECT payload FROM proposals`);
        dashboardData.proposals = proposalsResult.rows.map((r: any) => r.payload);

        // Inject AI diagnoses from the database
        const diagnosesResult = await pool.query(`SELECT payload FROM ai_diagnoses`);
        dashboardData.aiDiagnoses = diagnosesResult.rows.map((r: any) => r.payload);

        res.json(dashboardData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// API: Update proposal status
app.post('/api/proposals/:id/status', authenticate, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) {
        return res.status(400).json({ error: 'Missing status in request body' });
    }
    try {
        await pool.query(
            `UPDATE proposals 
             SET status = $1, payload = jsonb_set(payload, '{status}', to_jsonb($1::text))
             WHERE proposal_id = $2`,
            [status, id]
        );
        res.json({ message: 'Proposal status updated successfully.' });
    } catch (err: any) {
        console.error('Failed to update proposal status:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Trigger background refresh
app.post('/api/trigger-refresh', authenticate, (req: Request, res: Response) => {
    if (isRefreshing) {
        return res.status(202).json({ message: 'Refresh already in progress.' });
    }
    
    isRefreshing = true;
    console.log('Triggering background refresh with payload:', req.body);
    
    // Build command arguments
    const args = ['run', 'scripts/refresh_google_ads_data.ts'];
    if (req.body && req.body.startDate) {
        args.push('--start-date', req.body.startDate);
    }
    if (req.body && req.body.endDate) {
        args.push('--end-date', req.body.endDate);
        args.push('--date', req.body.endDate); // Use end date as targetDate for daily snapshots
    }
    
    // Spawn the refresh script
    const child = spawn('bun', args, {
        cwd: __dirname,
        stdio: 'inherit' // pipes stdout/stderr to the main server logs
    });

    child.on('close', (code) => {
        isRefreshing = false;
        console.log(`Refresh script exited with code ${code}`);
    });

    // Return immediately so external crons don't timeout
    res.status(202).json({ message: 'Refresh job started in the background.' });
});

// API: Cloud MCP proxy
app.post('/api/mcp', authenticate, async (req: Request, res: Response) => {
    try {
        const { method, params } = req.body;
        
        if (method === 'tools/list') {
            return res.json({
                tools: [
                    {
                        name: 'search_search',
                        description: 'Executes a GAQL query against the Google Ads API.',
                        inputSchema: {
                            type: 'object',
                            properties: { query: { type: 'string', description: 'The GAQL query to execute' } },
                            required: ['query']
                        }
                    },
                    {
                        name: 'customers_list_accessible_customers',
                        description: 'Lists the accessible Google Ads customers for the authenticated user.',
                        inputSchema: { type: 'object', properties: {} }
                    },
                    {
                        name: 'metadata_get_resource_metadata',
                        description: 'Describes resource schemas for building queries.',
                        inputSchema: {
                            type: 'object',
                            properties: { resource: { type: 'string', description: 'The resource name (e.g. campaign, ad_group) to get metadata for. Omit to get all.' } },
                            required: []
                        }
                    },
                    {
                        name: 'create_proposal',
                        description: 'Creates or updates a proposal card in the dashboard. MUST use these exact UI fields.',
                        inputSchema: {
                            type: 'object',
                            properties: { 
                                proposal: { 
                                    type: 'object', 
                                    properties: {
                                        proposal_id: { type: 'string', description: 'Unique ID (e.g. prop1)' },
                                        type: { type: 'string', description: 'e.g. BUDGET, OPTIMIZATION' },
                                        summary: { type: 'string', description: 'Short title/summary' },
                                        priority: { type: 'string', description: 'critical, high, medium, low' },
                                        risk_level: { type: 'string', description: 'high, medium, low' },
                                        reasoning_summary: { type: 'string', description: 'Evidence and reasoning' },
                                        status: { type: 'string', description: 'pending_review' }
                                    },
                                    required: ['proposal_id', 'type', 'summary', 'priority', 'risk_level', 'reasoning_summary']
                                } 
                            },
                            required: ['proposal']
                        }
                    },
                    {
                        name: 'create_diagnosis',
                        description: 'Creates or updates an AI diagnosis card on the dashboard.',
                        inputSchema: {
                            type: 'object',
                            properties: { 
                                diagnosis: { 
                                    type: 'object', 
                                    properties: {
                                        id: { type: 'string', description: 'Unique ID (e.g. diag1)' },
                                        title: { type: 'string', description: 'Short title' },
                                        description: { type: 'string', description: 'Detailed explanation' },
                                        severity: { type: 'string', description: 'success, warning, danger, info' }
                                    },
                                    required: ['id', 'title', 'description', 'severity']
                                } 
                            },
                            required: ['diagnosis']
                        }
                    },
                    {
                        name: 'clear_proposals',
                        description: 'Clears all existing proposals from the dashboard.',
                        inputSchema: { type: 'object', properties: {} }
                    },
                    {
                        name: 'clear_diagnoses',
                        description: 'Clears all existing AI diagnoses from the dashboard.',
                        inputSchema: { type: 'object', properties: {} }
                    },
                    {
                        name: 'trigger_refresh',
                        description: 'Triggers a synchronous refresh of the Google Ads data.',
                        inputSchema: { type: 'object', properties: {} }
                    }
                ]
            });
        }
        
        if (method === 'tools/call' && params) {
            if (params.name === 'search_search') {
                const query = params.arguments?.query;
                if (!query) return res.status(400).json({ error: 'Missing query argument' });
                
                const token = await getAccessToken();
                const customerId = await getAccessibleCustomer(token);
                const data = await executeGaql(token, customerId, query);
                
                return res.json({
                    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
                });
            } else if (params.name === 'customers_list_accessible_customers') {
                const token = await getAccessToken();
                const data = await listAccessibleCustomers(token);
                return res.json({
                    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
                });
            } else if (params.name === 'metadata_get_resource_metadata') {
                const resource = params.arguments?.resource;
                const token = await getAccessToken();
                
                let query = `SELECT name, category, selectable, filterable, sortable, selectable_with, data_type, is_repeated, enum_values FROM google_ads_field`;
                if (resource) {
                    query += ` WHERE name = '${resource}' OR name LIKE '${resource}.%'`;
                } else {
                    query += ` LIMIT 100`;
                }
                
                const data = await getResourceMetadata(token, query);
                return res.json({
                    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
                });
            } else if (params.name === 'create_proposal') {
                const proposal = params.arguments?.proposal;
                if (!proposal || !proposal.proposal_id) return res.status(400).json({ error: 'Missing or invalid proposal argument (proposal_id required)' });
                
                await pool.query(
                    `INSERT INTO proposals (proposal_id, payload, status) VALUES ($1, $2, $3)
                     ON CONFLICT (proposal_id) DO UPDATE SET payload = EXCLUDED.payload, status = EXCLUDED.status`,
                    [proposal.proposal_id, proposal, proposal.status || 'pending_review']
                );
                return res.json({ content: [{ type: 'text', text: 'Proposal created successfully.' }] });
            } else if (params.name === 'create_diagnosis') {
                const diagnosis = params.arguments?.diagnosis;
                if (!diagnosis || !diagnosis.id) return res.status(400).json({ error: 'Missing or invalid diagnosis argument (id required)' });
                
                await pool.query(
                    `INSERT INTO ai_diagnoses (diagnosis_id, payload) VALUES ($1, $2)
                     ON CONFLICT (diagnosis_id) DO UPDATE SET payload = EXCLUDED.payload`,
                    [diagnosis.id, diagnosis]
                );
                return res.json({ content: [{ type: 'text', text: 'Diagnosis created successfully.' }] });
            } else if (params.name === 'clear_proposals') {
                await pool.query(`TRUNCATE TABLE proposals`);
                return res.json({ content: [{ type: 'text', text: 'All proposals cleared successfully.' }] });
            } else if (params.name === 'clear_diagnoses') {
                await pool.query(`TRUNCATE TABLE ai_diagnoses`);
                return res.json({ content: [{ type: 'text', text: 'All AI diagnoses cleared successfully.' }] });
            } else if (params.name === 'trigger_refresh') {
                if (isRefreshing) {
                    return res.json({ content: [{ type: 'text', text: 'Refresh already in progress.' }] });
                }
                isRefreshing = true;
                try {
                    execSync('bun run scripts/refresh_google_ads_data.ts', { cwd: __dirname, stdio: 'pipe' });
                    isRefreshing = false;
                    return res.json({ content: [{ type: 'text', text: 'Data refresh completed successfully.' }] });
                } catch (err: any) {
                    isRefreshing = false;
                    return res.json({ content: [{ type: 'text', text: `Refresh failed: ${err.message}` }], isError: true });
                }
            }
        }
        
        res.status(404).json({ error: 'Method or tool not found' });
    } catch (err: any) {
        console.error('MCP proxy error:', err);
        res.status(500).json({ error: err.message, isError: true });
    }
});

// Fallback to index.html for SPA routing (if any)
app.get('*', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'dashboard', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
