import crypto from 'crypto';

const name = String(process.argv[2] || 'codex-prod').trim() || 'codex-prod';
const key = crypto.randomBytes(32).toString('base64url');
const sha256 = crypto.createHash('sha256').update(key).digest('hex');
const scopes = [
    'mcp:read',
    'mcp:raw_gaql',
    'mcp:proposal',
    'mcp:refresh',
    'mcp:mutate_preview',
    'mcp:mutate_confirm',
    'mcp:admin'
];

console.log(`MCP_API_KEY=${key}`);
console.log('MCP_API_KEYS_JSON=' + JSON.stringify([{ name, sha256, scopes }]));
