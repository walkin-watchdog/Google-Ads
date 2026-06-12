import { describe, expect, test } from 'bun:test';
import { createMemory, ensureSemanticMemorySchema, searchMemories, storeMemoryEmbedding } from '../lib/semanticMemory.ts';

const CUSTOMER_ID = '1234567890';
const REPLACEMENT_ID = '22222222-2222-4222-8222-222222222222';
const SUPERSEDED_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_EXCEPTION_ID = '33333333-3333-4333-8333-333333333333';

function baseMemory(overrides = {}) {
    return {
        customer_id: CUSTOMER_ID,
        scope_type: 'campaign',
        campaign_resource_name: `customers/${CUSTOMER_ID}/campaigns/4444`,
        category: 'business_context',
        content: 'Keep this campaign protected during launch unless spend is extreme.',
        verification_status: 'user_confirmed',
        authority: 'hard_constraint',
        source: 'user_chat',
        ...overrides
    };
}

function noConnectPool() {
    return {
        connect() {
            throw new Error('Validation should fail before opening a database connection.');
        }
    };
}

describe('semantic memory validation', () => {
    test('rejects resource names that only match the customer prefix', async () => {
        await expect(createMemory(noConnectPool(), baseMemory({
            campaign_resource_name: `customers/${CUSTOMER_ID}/adGroups/9999`
        }))).rejects.toThrow(/campaign_resource_name must be a valid Google Ads campaign_resource_name resource name/);
    });

    test('rejects mismatched ad group and criterion resource names', async () => {
        await expect(createMemory(noConnectPool(), baseMemory({
            scope_type: 'keyword',
            campaign_resource_name: null,
            ad_group_resource_name: `customers/${CUSTOMER_ID}/adGroups/1111`,
            criterion_resource_name: `customers/${CUSTOMER_ID}/adGroupCriteria/2222~3333`
        }))).rejects.toThrow(/ad_group_resource_name does not match criterion_resource_name/);
    });
});

describe('semantic memory search', () => {
    test('matches entity scopes by declared memory scope_type', async () => {
        let captured = null;
        const pool = {
            async query(sql, params) {
                captured = { sql, params };
                return { rows: [] };
            }
        };

        await searchMemories(pool, {
            customer_id: CUSTOMER_ID,
            embedding_model: 'text-embedding-3-small',
            dimensions: 1536,
            query_embedding: Array(1536).fill(0),
            scopes: {
                campaign_resource_names: [`customers/${CUSTOMER_ID}/campaigns/4444`],
                ad_group_resource_names: [`customers/${CUSTOMER_ID}/adGroups/5555`],
                criterion_resource_names: [`customers/${CUSTOMER_ID}/adGroupCriteria/5555~6666`],
                proposal_ids: ['prop_123']
            }
        });

        expect(captured.sql).toContain("(m.scope_type = 'campaign' AND m.campaign_resource_name = ANY");
        expect(captured.sql).toContain("(m.scope_type = 'ad_group' AND m.ad_group_resource_name = ANY");
        expect(captured.sql).toContain("(m.scope_type = 'keyword' AND m.criterion_resource_name = ANY");
        expect(captured.sql).toContain("(m.scope_type = 'proposal' AND m.proposal_id = ANY");
        expect(captured.sql).toContain('m.related_proposal_id = ANY');
        expect(captured.sql).not.toContain('OR m.campaign_resource_name = ANY');
    });

    test('uses exact/trigram search-term candidates instead of customer-wide search-term scope', async () => {
        let captured = null;
        const pool = {
            async query(sql, params) {
                captured = { sql, params };
                return { rows: [] };
            }
        };

        await searchMemories(pool, {
            customer_id: CUSTOMER_ID,
            embedding_model: 'text-embedding-3-small',
            dimensions: 1536,
            query_embedding: Array(1536).fill(0),
            scopes: {
                search_terms: ['Free WhatsApp API']
            }
        });

        expect(captured.sql).toContain("m.scope_type = 'search_term' AND");
        expect(captured.sql).toContain('similarity(m.search_term_normalized, search_terms.term) >= 0.35');
        expect(captured.sql).not.toContain("OR m.scope_type = 'search_term'");
        expect(captured.params[3]).toEqual(['api free whatsapp']);
    });
});

describe('semantic memory schema', () => {
    test('initialization includes idempotent repair for semantic memory columns', async () => {
        let sql = '';
        const pool = {
            async query(query) {
                sql += `\n${query}`;
                return { rows: [] };
            }
        };

        await ensureSemanticMemorySchema(pool);

        expect(sql).toContain('ALTER TABLE semantic_memories ADD COLUMN IF NOT EXISTS customer_id VARCHAR(50)');
        expect(sql).toContain('ALTER TABLE semantic_memories ADD COLUMN IF NOT EXISTS scope_hash VARCHAR(64)');
        expect(sql).toContain('ALTER TABLE semantic_memory_embeddings_1536 ADD COLUMN IF NOT EXISTS embedding VECTOR(1536)');
        expect(sql).toContain('UPDATE semantic_memory_embeddings_1536 e');
        expect(sql).toContain('SELECT memory_id, customer_id, scope_type');
        expect(sql).toContain("conrelid = 'semantic_memories'::regclass");
    });
});

describe('semantic memory supersession', () => {
    test('storing a replacement embedding deactivates the superseded memory and active child exceptions', async () => {
        const calls = [];
        let updatedIds = null;
        let deletedIds = null;
        const client = {
            async query(sql, params = []) {
                calls.push({ sql, params });
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
                if (sql.includes('SELECT memory_id, supersedes_memory_id')) {
                    return { rows: [{ memory_id: REPLACEMENT_ID, supersedes_memory_id: SUPERSEDED_ID }] };
                }
                if (sql.includes('WITH RECURSIVE exception_tree')) {
                    return { rows: [{ memory_id: CHILD_EXCEPTION_ID, depth: 1, cycle: false }] };
                }
                if (sql.includes('SELECT *') && sql.includes('memory_id = ANY')) {
                    return {
                        rows: [
                            { memory_id: SUPERSEDED_ID, customer_id: CUSTOMER_ID, is_active: true, supersedes_memory_id: null },
                            { memory_id: REPLACEMENT_ID, customer_id: CUSTOMER_ID, is_active: true, supersedes_memory_id: SUPERSEDED_ID },
                            { memory_id: CHILD_EXCEPTION_ID, customer_id: CUSTOMER_ID, is_active: true, supersedes_memory_id: null, exception_to_memory_id: SUPERSEDED_ID }
                        ]
                    };
                }
                if (sql.includes('SELECT embedding_model')) return { rows: [] };
                if (sql.includes('INSERT INTO semantic_memory_embeddings_1536')) {
                    return {
                        rows: [{
                            memory_id: REPLACEMENT_ID,
                            customer_id: CUSTOMER_ID,
                            embedding_model: 'text-embedding-3-small',
                            created_at: '2026-06-21T00:00:00.000Z'
                        }]
                    };
                }
                if (sql.includes('WITH RECURSIVE chain')) {
                    return { rows: [{ reaches_child: false, max_depth: 1, existing_cycle: false }] };
                }
                if (sql.includes('UPDATE semantic_memories')) {
                    updatedIds = params[1];
                    return { rows: [] };
                }
                if (sql.includes('DELETE FROM semantic_memory_embeddings_1536')) {
                    deletedIds = params[1];
                    return { rows: [] };
                }
                throw new Error(`Unexpected SQL in test: ${sql}`);
            },
            release() {}
        };
        const pool = { connect: async () => client };

        const result = await storeMemoryEmbedding(pool, {
            customer_id: CUSTOMER_ID,
            memory_id: REPLACEMENT_ID,
            embedding_model: 'text-embedding-3-small',
            dimensions: 1536,
            embedding: Array(1536).fill(0.001)
        });

        expect(result.memory_id).toBe(REPLACEMENT_ID);
        expect(updatedIds).toEqual([SUPERSEDED_ID, CHILD_EXCEPTION_ID].sort());
        expect(deletedIds).toEqual(updatedIds);
        expect(calls.some(call => call.sql === 'COMMIT')).toBe(true);
    });
});
