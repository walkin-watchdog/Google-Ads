import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { stemmer } from 'stemmer';

export class SemanticMemoryValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SemanticMemoryValidationError';
    }
}

export class SemanticMemoryConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SemanticMemoryConflictError';
    }
}

export class SemanticMemoryNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SemanticMemoryNotFoundError';
    }
}

export class SemanticMemoryConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SemanticMemoryConfigurationError';
    }
}

const SCOPE_TYPES = ['global', 'campaign', 'ad_group', 'keyword', 'search_term', 'proposal', 'account_note'] as const;
const CATEGORIES = ['preference', 'constraint', 'exception', 'postmortem', 'business_context', 'risk'] as const;
const VERIFICATION_STATUSES = ['user_confirmed', 'agent_extracted', 'inferred_from_postmortem', 'imported'] as const;
const AUTHORITIES = ['hard_constraint', 'soft_preference', 'observation'] as const;
const SOURCES = ['user_chat', 'proposal_feedback', 'proposal_postmortem', 'manual_note', 'imported_doc'] as const;

type ScopeType = typeof SCOPE_TYPES[number];
type SemanticRelationshipColumn = 'supersedes_memory_id' | 'exception_to_memory_id';

const EMBEDDING_TABLES = {
    1536: 'semantic_memory_embeddings_1536'
} as const;

const MAX_TRAVERSAL_DEPTH = 50;
const MAX_CONTENT_LENGTH = 20000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface NormalizedMemoryInput {
    customer_id: string;
    scope_type: ScopeType;
    customer_resource_name: string;
    campaign_resource_name: string | null;
    ad_group_resource_name: string | null;
    criterion_resource_name: string | null;
    proposal_id: string | null;
    related_proposal_id: string | null;
    search_term: string | null;
    search_term_normalized: string | null;
    scope_hash: string;
    campaign_id: string | null;
    ad_group_id: string | null;
    criterion_id: string | null;
    category: string;
    content: string;
    content_hash: string;
    verification_status: string;
    authority: string;
    source: string;
    source_ref: string | null;
    valid_until: string | null;
    supersedes_memory_id: string | null;
    exception_to_memory_id: string | null;
    created_by: string | null;
}

interface SearchScopes {
    customer_resource_names: string[];
    campaign_resource_names: string[];
    ad_group_resource_names: string[];
    criterion_resource_names: string[];
    proposal_ids: string[];
    search_terms_normalized: string[];
}

interface EmbeddingMemoryLocks {
    memory: any;
    superseded_memory_id: string | null;
    superseded_exception_ids: string[];
    locked: Map<string, any>;
}

export const SEMANTIC_MEMORY_MCP_TOOLS = [
    {
        name: 'create_memory',
        description: 'Creates a deterministic semantic memory row. The backend validates metadata, normalizes scope fields, and stores hashes; it never calls an LLM or embedding provider.',
        inputSchema: {
            type: 'object',
            properties: {
                customer_id: { type: 'string' },
                scope_type: { type: 'string', enum: [...SCOPE_TYPES] },
                customer_resource_name: { type: 'string' },
                campaign_resource_name: { type: 'string' },
                ad_group_resource_name: { type: 'string' },
                criterion_resource_name: { type: 'string' },
                proposal_id: { type: 'string' },
                related_proposal_id: { type: 'string' },
                search_term: { type: 'string' },
                campaign_id: { type: 'string' },
                ad_group_id: { type: 'string' },
                criterion_id: { type: 'string' },
                category: { type: 'string', enum: [...CATEGORIES] },
                content: { type: 'string' },
                verification_status: { type: 'string', enum: [...VERIFICATION_STATUSES] },
                authority: { type: 'string', enum: [...AUTHORITIES] },
                source: { type: 'string', enum: [...SOURCES] },
                source_ref: { type: 'string' },
                valid_until: { type: 'string' },
                supersedes_memory_id: { type: ['string', 'null'] },
                exception_to_memory_id: { type: ['string', 'null'] },
                created_by: { type: 'string' }
            },
            required: ['customer_id', 'scope_type', 'category', 'content', 'verification_status', 'authority', 'source']
        }
    },
    {
        name: 'store_memory_embedding',
        description: 'Stores an externally generated embedding for an active memory. customer_id is required for tenant scoping; the backend copies tenant data from the memory row.',
        inputSchema: {
            type: 'object',
            properties: {
                customer_id: { type: 'string' },
                memory_id: { type: 'string' },
                embedding_model: { type: 'string' },
                dimensions: { type: 'number', enum: [1536] },
                embedding: { type: 'array', items: { type: 'number' } }
            },
            required: ['customer_id', 'memory_id', 'embedding_model', 'dimensions', 'embedding']
        }
    },
    {
        name: 'search_memories',
        description: 'Runs one tenant-scoped, model-scoped vector search over active semantic memories for a batched set of relevant scopes.',
        inputSchema: {
            type: 'object',
            properties: {
                customer_id: { type: 'string' },
                query: { type: 'string' },
                query_embedding: { type: 'array', items: { type: 'number' } },
                embedding_model: { type: 'string' },
                dimensions: { type: 'number', enum: [1536] },
                scopes: {
                    type: 'object',
                    properties: {
                        customer_resource_names: { type: 'array', items: { type: 'string' } },
                        campaign_resource_names: { type: 'array', items: { type: 'string' } },
                        ad_group_resource_names: { type: 'array', items: { type: 'string' } },
                        criterion_resource_names: { type: 'array', items: { type: 'string' } },
                        proposal_ids: { type: 'array', items: { type: 'string' } },
                        search_terms: { type: 'array', items: { type: 'string' } },
                        search_terms_normalized: { type: 'array', items: { type: 'string' } }
                    }
                },
                limit: { type: 'number' }
            },
            required: ['customer_id', 'query_embedding', 'embedding_model', 'dimensions']
        }
    },
    {
        name: 'deactivate_memory',
        description: 'Deactivates a semantic memory in a transaction, optionally verifying a replacement memory. Embeddings are removed in the same transaction.',
        inputSchema: {
            type: 'object',
            properties: {
                customer_id: { type: 'string' },
                memory_id: { type: 'string' },
                reason: { type: 'string' },
                replacement_memory_id: { type: ['string', 'null'] },
                expected_version: { type: 'number' },
                deactivated_by: { type: 'string' }
            },
            required: ['customer_id', 'memory_id']
        }
    },
    {
        name: 'link_memory_exception',
        description: 'Links a narrower active memory as an exception to a broader active memory after scope and cycle checks.',
        inputSchema: {
            type: 'object',
            properties: {
                customer_id: { type: 'string' },
                exception_memory_id: { type: 'string' },
                general_memory_id: { type: 'string' },
                reason: { type: 'string' }
            },
            required: ['customer_id', 'exception_memory_id', 'general_memory_id']
        }
    }
] as const;

export async function ensureSemanticMemorySchema(pool: Pool): Promise<void> {
    try {
        await pool.query(`
            CREATE EXTENSION IF NOT EXISTS pgcrypto;
            CREATE EXTENSION IF NOT EXISTS vector;
            CREATE EXTENSION IF NOT EXISTS pg_trgm;

            CREATE TABLE IF NOT EXISTS semantic_memories (
                memory_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                customer_id VARCHAR(50) NOT NULL,
                scope_type VARCHAR(50) NOT NULL,
                customer_resource_name TEXT,
                campaign_resource_name TEXT,
                ad_group_resource_name TEXT,
                criterion_resource_name TEXT,
                proposal_id VARCHAR(100),
                related_proposal_id VARCHAR(100),
                search_term TEXT,
                search_term_normalized TEXT,
                scope_hash VARCHAR(64) NOT NULL,
                campaign_id VARCHAR(100),
                ad_group_id VARCHAR(100),
                criterion_id VARCHAR(100),
                category VARCHAR(80) NOT NULL,
                content TEXT NOT NULL,
                content_hash VARCHAR(64) NOT NULL,
                verification_status VARCHAR(50) NOT NULL,
                authority VARCHAR(50) NOT NULL,
                source VARCHAR(80) NOT NULL,
                source_ref TEXT,
                is_active BOOLEAN DEFAULT TRUE NOT NULL,
                version INTEGER DEFAULT 1 NOT NULL,
                valid_until TIMESTAMP WITH TIME ZONE,
                supersedes_memory_id UUID REFERENCES semantic_memories(memory_id),
                exception_to_memory_id UUID REFERENCES semantic_memories(memory_id),
                deactivated_at TIMESTAMP WITH TIME ZONE,
                deactivation_reason TEXT,
                deactivated_by VARCHAR(120),
                created_by VARCHAR(120),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            CREATE UNIQUE INDEX IF NOT EXISTS semantic_memories_exact_dedupe_idx
            ON semantic_memories (customer_id, scope_hash, content_hash)
            WHERE is_active = TRUE;

            CREATE INDEX IF NOT EXISTS semantic_memories_scope_idx
            ON semantic_memories (
                customer_id,
                scope_type,
                campaign_resource_name,
                ad_group_resource_name,
                criterion_resource_name,
                proposal_id,
                search_term_normalized
            )
            WHERE is_active = TRUE;

            CREATE INDEX IF NOT EXISTS semantic_memories_search_term_trgm_idx
            ON semantic_memories USING gin (search_term_normalized gin_trgm_ops)
            WHERE is_active = TRUE;

            CREATE OR REPLACE FUNCTION update_semantic_memories_updated_at()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = now();
                NEW.version = COALESCE(OLD.version, 0) + 1;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS update_semantic_memories_modtime ON semantic_memories;
            CREATE TRIGGER update_semantic_memories_modtime
            BEFORE UPDATE ON semantic_memories
            FOR EACH ROW
            EXECUTE PROCEDURE update_semantic_memories_updated_at();

            CREATE TABLE IF NOT EXISTS semantic_memory_embeddings_1536 (
                memory_id UUID PRIMARY KEY REFERENCES semantic_memories(memory_id) ON DELETE CASCADE,
                customer_id VARCHAR(50) NOT NULL,
                embedding_model VARCHAR(120) NOT NULL,
                embedding VECTOR(1536) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS semantic_memory_embeddings_1536_model_idx
            ON semantic_memory_embeddings_1536 (customer_id, embedding_model);

            CREATE INDEX IF NOT EXISTS semantic_memory_embeddings_1536_embedding_hnsw_cosine_idx
            ON semantic_memory_embeddings_1536
            USING hnsw (embedding vector_cosine_ops);
        `);
    } catch (err: any) {
        throw new SemanticMemoryConfigurationError(`Semantic memory schema could not be initialized. Confirm PostgreSQL pgvector is available. ${err.message}`);
    }
}

export async function createMemory(pool: Pool, raw: any): Promise<any> {
    const memory = normalizeMemoryInput(raw);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await validateReferencedMemories(client, memory);
        const result = await client.query(
            `INSERT INTO semantic_memories (
                customer_id, scope_type, customer_resource_name, campaign_resource_name, ad_group_resource_name,
                criterion_resource_name, proposal_id, related_proposal_id, search_term, search_term_normalized,
                scope_hash, campaign_id, ad_group_id, criterion_id, category, content, content_hash,
                verification_status, authority, source, source_ref, valid_until, supersedes_memory_id,
                exception_to_memory_id, created_by
             )
             VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17,
                $18, $19, $20, $21, $22, $23,
                $24, $25
             )
             RETURNING *`,
            [
                memory.customer_id,
                memory.scope_type,
                memory.customer_resource_name,
                memory.campaign_resource_name,
                memory.ad_group_resource_name,
                memory.criterion_resource_name,
                memory.proposal_id,
                memory.related_proposal_id,
                memory.search_term,
                memory.search_term_normalized,
                memory.scope_hash,
                memory.campaign_id,
                memory.ad_group_id,
                memory.criterion_id,
                memory.category,
                memory.content,
                memory.content_hash,
                memory.verification_status,
                memory.authority,
                memory.source,
                memory.source_ref,
                memory.valid_until,
                memory.supersedes_memory_id,
                memory.exception_to_memory_id,
                memory.created_by
            ]
        );
        await client.query('COMMIT');
        return rowToMemory(result.rows[0]);
    } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err?.code === '23505') {
            throw new SemanticMemoryConflictError('An active exact duplicate memory already exists for this customer and scope.');
        }
        throw err;
    } finally {
        client.release();
    }
}

export async function storeMemoryEmbedding(pool: Pool, raw: any): Promise<any> {
    const customerId = requireClean(raw?.customer_id, 'customer_id is required.', 50);
    const memoryId = requireUuid(raw?.memory_id, 'memory_id is required.');
    const embeddingModel = requireClean(raw?.embedding_model, 'embedding_model is required.', 120);
    const dimensions = supportedDimensions(raw?.dimensions);
    const embedding = normalizeEmbedding(raw?.embedding, dimensions);
    const table = embeddingTableForDimensions(dimensions);
    const vector = vectorLiteral(embedding);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const lockContext = await lockMemoryForEmbedding(client, customerId, memoryId);
        const memory = lockContext.memory;
        if (!memory.is_active) throw new SemanticMemoryValidationError('Cannot store an embedding for an inactive memory.');

        const existing = await client.query(
            `SELECT embedding_model
             FROM ${table}
             WHERE customer_id = $1 AND memory_id = $2
             FOR UPDATE`,
            [customerId, memoryId]
        );
        if (existing.rows[0] && existing.rows[0].embedding_model !== embeddingModel) {
            throw new SemanticMemoryConflictError(`Memory already has a ${dimensions}-dimension embedding for model ${existing.rows[0].embedding_model}.`);
        }

        const result = await client.query(
            `INSERT INTO ${table} (memory_id, customer_id, embedding_model, embedding)
             VALUES ($1, $2, $3, $4::vector)
             ON CONFLICT (memory_id) DO UPDATE SET
                embedding = EXCLUDED.embedding,
                created_at = CURRENT_TIMESTAMP
             RETURNING memory_id, customer_id, embedding_model, created_at`,
            [memoryId, customerId, embeddingModel, vector]
        );
        await finalizeSupersessionAfterEmbedding(client, customerId, memoryId, lockContext);
        await client.query('COMMIT');
        return { ...result.rows[0], dimensions };
    } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err?.message === 'Concurrent exception links changed while storing memory embedding. Retry the request.' && !raw?._retry) {
            return storeMemoryEmbedding(pool, { ...raw, _retry: true });
        }
        throw err;
    } finally {
        client.release();
    }
}

export async function searchMemories(pool: Pool, raw: any): Promise<any> {
    const customerId = requireClean(raw?.customer_id, 'customer_id is required.', 50);
    const embeddingModel = requireClean(raw?.embedding_model, 'embedding_model is required.', 120);
    const dimensions = supportedDimensions(raw?.dimensions);
    const embedding = normalizeEmbedding(raw?.query_embedding, dimensions, 'query_embedding');
    const table = embeddingTableForDimensions(dimensions);
    const vector = vectorLiteral(embedding);
    const limit = boundedInteger(raw?.limit, 50, 1, 200);
    const scopes = normalizeSearchScopes(raw?.scopes || {}, customerId);

    const params: any[] = [customerId, embeddingModel, vector];
    const scopeConditions: string[] = [];
    if (scopes.customer_resource_names.length > 0) {
        params.push(scopes.customer_resource_names);
        scopeConditions.push(`(m.scope_type IN ('global', 'account_note') AND m.customer_resource_name = ANY($${params.length}::text[]))`);
    } else {
        scopeConditions.push(`m.scope_type IN ('global', 'account_note')`);
    }
    addScopedAnyCondition(scopeConditions, params, 'campaign', 'm.campaign_resource_name', scopes.campaign_resource_names);
    addScopedAnyCondition(scopeConditions, params, 'ad_group', 'm.ad_group_resource_name', scopes.ad_group_resource_names);
    addScopedAnyCondition(scopeConditions, params, 'keyword', 'm.criterion_resource_name', scopes.criterion_resource_names);
    addScopedAnyCondition(scopeConditions, params, 'proposal', 'm.proposal_id', scopes.proposal_ids);
    addAnyCondition(scopeConditions, params, 'm.related_proposal_id', scopes.proposal_ids);
    addSearchTermCondition(scopeConditions, params, scopes.search_terms_normalized);
    params.push(limit);
    const limitParam = params.length;

    const result = await pool.query(
        `SELECT m.*, e.embedding_model, (e.embedding <=> $3::vector) AS distance
         FROM ${table} e
         JOIN semantic_memories m
            ON m.memory_id = e.memory_id
           AND m.customer_id = e.customer_id
         LEFT JOIN semantic_memories exception_parent
            ON exception_parent.memory_id = m.exception_to_memory_id
           AND exception_parent.customer_id = m.customer_id
         WHERE e.customer_id = $1
           AND m.customer_id = $1
           AND e.embedding_model = $2
           AND m.is_active = TRUE
           AND (m.valid_until IS NULL OR m.valid_until > CURRENT_TIMESTAMP)
           AND (m.exception_to_memory_id IS NULL OR exception_parent.is_active = TRUE)
           AND (${scopeConditions.join(' OR ')})
         ORDER BY e.embedding <=> $3::vector ASC
         LIMIT $${limitParam}`,
        params
    );

    const normalizedTermSet = new Set(scopes.search_terms_normalized);
    return {
        customer_id: customerId,
        embedding_model: embeddingModel,
        dimensions,
        count: result.rows.length,
        memories: result.rows.map(row => ({
            ...rowToMemory(row),
            distance: Number(row.distance),
            exact_search_term_match: Boolean(row.search_term_normalized && normalizedTermSet.has(row.search_term_normalized))
        }))
    };
}

export async function deactivateMemory(pool: Pool, raw: any): Promise<any> {
    const customerId = requireClean(raw?.customer_id, 'customer_id is required.', 50);
    const memoryId = requireUuid(raw?.memory_id, 'memory_id is required.');
    const replacementMemoryId = optionalUuid(raw?.replacement_memory_id, 'replacement_memory_id must be a UUID.');
    const expectedVersion = raw?.expected_version == null ? null : positiveInteger(raw.expected_version, 'expected_version');
    const reason = optionalClean(raw?.reason, 500);
    const deactivatedBy = optionalClean(raw?.deactivated_by, 120);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const initialChildIds = await getActiveExceptionDescendantIds(client, customerId, memoryId);
        let idsToLock = sortedUnique([memoryId, replacementMemoryId, ...initialChildIds]);
        let locked = await lockMemoryRows(client, customerId, idsToLock);
        const latestChildIds = await getActiveExceptionDescendantIds(client, customerId, memoryId);
        const missedChild = latestChildIds.some(id => !idsToLock.includes(id));
        if (missedChild) {
            await client.query('ROLLBACK');
            if (raw?._retry) {
                throw new SemanticMemoryConflictError('Concurrent exception links changed while deactivating memory. Retry the request.');
            }
            return deactivateMemory(pool, { ...raw, _retry: true });
        }

        const target = locked.get(memoryId);
        if (!target) throw new SemanticMemoryNotFoundError(`Memory not found: ${memoryId}`);
        if (!target.is_active) throw new SemanticMemoryValidationError('Memory is already inactive.');
        if (expectedVersion !== null && Number(target.version) !== expectedVersion) {
            throw new SemanticMemoryConflictError(`Memory version mismatch. Expected ${expectedVersion}, found ${target.version}.`);
        }

        if (replacementMemoryId) {
            const replacement = locked.get(replacementMemoryId);
            if (!replacement) throw new SemanticMemoryNotFoundError(`Replacement memory not found: ${replacementMemoryId}`);
            if (!replacement.is_active) throw new SemanticMemoryValidationError('Replacement memory must be active.');
            if (replacement.supersedes_memory_id !== memoryId) {
                throw new SemanticMemoryValidationError('replacement_memory_id must point to a memory whose supersedes_memory_id matches the memory being deactivated.');
            }
            await assertNoRelationshipCycle(client, customerId, replacementMemoryId, memoryId, 'supersedes_memory_id');
        }

        const childIds = latestChildIds.filter(id => id !== memoryId);
        const deactivatedIds = sortedUnique([memoryId, ...childIds]);
        await client.query(
            `UPDATE semantic_memories
             SET is_active = FALSE,
                 deactivated_at = CURRENT_TIMESTAMP,
                 deactivation_reason = COALESCE($3, deactivation_reason),
                 deactivated_by = COALESCE($4, deactivated_by)
             WHERE customer_id = $1 AND memory_id = ANY($2::uuid[])`,
            [customerId, deactivatedIds, reason, deactivatedBy]
        );
        await deleteEmbeddings(client, customerId, deactivatedIds);
        await client.query('COMMIT');

        return {
            memory_id: memoryId,
            customer_id: customerId,
            replacement_memory_id: replacementMemoryId,
            deactivated_memory_ids: deactivatedIds,
            child_exceptions_deactivated: childIds
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

export async function linkMemoryException(pool: Pool, raw: any): Promise<any> {
    const customerId = requireClean(raw?.customer_id, 'customer_id is required.', 50);
    const exceptionMemoryId = requireUuid(raw?.exception_memory_id, 'exception_memory_id is required.');
    const generalMemoryId = requireUuid(raw?.general_memory_id, 'general_memory_id is required.');
    if (exceptionMemoryId === generalMemoryId) {
        throw new SemanticMemoryValidationError('A memory cannot be an exception to itself.');
    }
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const locked = await lockMemoryRows(client, customerId, sortedUnique([exceptionMemoryId, generalMemoryId]));
        const exceptionMemory = locked.get(exceptionMemoryId);
        const generalMemory = locked.get(generalMemoryId);
        if (!exceptionMemory) throw new SemanticMemoryNotFoundError(`Exception memory not found: ${exceptionMemoryId}`);
        if (!generalMemory) throw new SemanticMemoryNotFoundError(`General memory not found: ${generalMemoryId}`);
        if (!exceptionMemory.is_active) throw new SemanticMemoryValidationError('Exception memory must be active.');
        if (!generalMemory.is_active) throw new SemanticMemoryValidationError('General memory must be active.');
        if (!scopeIsEqualOrNarrower(exceptionMemory, generalMemory)) {
            throw new SemanticMemoryValidationError('Exception scope must be equal to or narrower than the general memory scope, with matching parent scope identifiers.');
        }
        await assertNoRelationshipCycle(client, customerId, exceptionMemoryId, generalMemoryId, 'exception_to_memory_id');
        const result = await client.query(
            `UPDATE semantic_memories
             SET exception_to_memory_id = $3
             WHERE customer_id = $1 AND memory_id = $2
             RETURNING *`,
            [customerId, exceptionMemoryId, generalMemoryId]
        );
        await client.query('COMMIT');
        return rowToMemory(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

function normalizeMemoryInput(raw: any): NormalizedMemoryInput {
    if (!raw || typeof raw !== 'object') throw new SemanticMemoryValidationError('Memory payload must be an object.');
    const customerId = requireClean(raw.customer_id, 'customer_id is required.', 50);
    const scopeType = enumValue(raw.scope_type, SCOPE_TYPES, 'scope_type') as ScopeType;
    const customerResourceName = optionalClean(raw.customer_resource_name, 200) || `customers/${customerId}`;
    const campaignIdFromInput = optionalClean(raw.campaign_id, 100);
    const adGroupIdFromInput = optionalClean(raw.ad_group_id, 100);
    const criterionIdFromInput = optionalClean(raw.criterion_id, 100);
    const campaignResourceName = optionalClean(raw.campaign_resource_name, 240) || deriveCampaignResourceName(customerId, campaignIdFromInput);
    const adGroupResourceName = optionalClean(raw.ad_group_resource_name, 240) || deriveAdGroupResourceName(customerId, adGroupIdFromInput);
    const criterionResourceName = optionalClean(raw.criterion_resource_name, 260) || deriveCriterionResourceName(customerId, adGroupIdFromInput, criterionIdFromInput);
    const proposalId = optionalClean(raw.proposal_id, 100);
    const relatedProposalId = optionalClean(raw.related_proposal_id, 100);
    const searchTerm = optionalClean(raw.search_term, 1000);
    const searchTermNormalized = searchTerm ? normalizeSearchTerm(searchTerm) : null;
    const campaignId = campaignIdFromInput || idFromResource(campaignResourceName, /\/campaigns\/([^/]+)$/);
    const adGroupId = adGroupIdFromInput || idFromResource(adGroupResourceName, /\/adGroups\/([^/]+)$/);
    const criterionId = criterionIdFromInput || idFromResource(criterionResourceName, /\/adGroupCriteria\/[^~]+~([^/]+)$/);
    validateResourceName(customerResourceName, customerId, 'customer_resource_name');
    validateResourceName(campaignResourceName, customerId, 'campaign_resource_name');
    validateResourceName(adGroupResourceName, customerId, 'ad_group_resource_name');
    validateResourceName(criterionResourceName, customerId, 'criterion_resource_name');
    assertMatchingResourceId(campaignIdFromInput, idFromResource(campaignResourceName, /\/campaigns\/([^/]+)$/), 'campaign_id', 'campaign_resource_name');
    assertMatchingResourceId(adGroupIdFromInput, idFromResource(adGroupResourceName, /\/adGroups\/([^/]+)$/), 'ad_group_id', 'ad_group_resource_name');
    const criterionParts = criterionPartsFromResource(criterionResourceName);
    assertMatchingResourceId(idFromResource(adGroupResourceName, /\/adGroups\/([^/]+)$/), criterionParts?.adGroupId || null, 'ad_group_resource_name', 'criterion_resource_name');
    assertMatchingResourceId(adGroupIdFromInput, criterionParts?.adGroupId || null, 'ad_group_id', 'criterion_resource_name');
    assertMatchingResourceId(criterionIdFromInput, criterionParts?.criterionId || null, 'criterion_id', 'criterion_resource_name');
    const category = enumValue(raw.category, CATEGORIES, 'category');
    const content = requireClean(raw.content, 'content is required.', MAX_CONTENT_LENGTH);
    const verificationStatus = enumValue(raw.verification_status, VERIFICATION_STATUSES, 'verification_status');
    const authority = enumValue(raw.authority, AUTHORITIES, 'authority');
    const source = enumValue(raw.source, SOURCES, 'source');
    const sourceRef = optionalClean(raw.source_ref, 1000);
    const validUntil = optionalTimestamp(raw.valid_until, 'valid_until must be a valid date/time.');
    const supersedesMemoryId = optionalUuid(raw.supersedes_memory_id, 'supersedes_memory_id must be a UUID.');
    const exceptionToMemoryId = optionalUuid(raw.exception_to_memory_id, 'exception_to_memory_id must be a UUID.');
    const createdBy = optionalClean(raw.created_by, 120);

    validateScopeRequirements(scopeType, {
        campaignResourceName,
        adGroupResourceName,
        criterionResourceName,
        proposalId,
        searchTermNormalized
    });
    const scopeHash = hashScope({
        scope_type: scopeType,
        customer_resource_name: customerResourceName,
        campaign_resource_name: campaignResourceName,
        ad_group_resource_name: adGroupResourceName,
        criterion_resource_name: criterionResourceName,
        proposal_id: proposalId,
        related_proposal_id: relatedProposalId,
        search_term_normalized: searchTermNormalized
    });

    return {
        customer_id: customerId,
        scope_type: scopeType,
        customer_resource_name: customerResourceName,
        campaign_resource_name: campaignResourceName,
        ad_group_resource_name: adGroupResourceName,
        criterion_resource_name: criterionResourceName,
        proposal_id: proposalId,
        related_proposal_id: relatedProposalId,
        search_term: searchTerm,
        search_term_normalized: searchTermNormalized,
        scope_hash: scopeHash,
        campaign_id: campaignId,
        ad_group_id: adGroupId,
        criterion_id: criterionId,
        category,
        content,
        content_hash: sha256(content.trim().replace(/\s+/g, ' ')),
        verification_status: verificationStatus,
        authority,
        source,
        source_ref: sourceRef,
        valid_until: validUntil,
        supersedes_memory_id: supersedesMemoryId,
        exception_to_memory_id: exceptionToMemoryId,
        created_by: createdBy
    };
}

async function validateReferencedMemories(client: PoolClient, memory: NormalizedMemoryInput): Promise<void> {
    const refs = sortedUnique([memory.supersedes_memory_id, memory.exception_to_memory_id]);
    if (refs.length === 0) return;
    const locked = await lockMemoryRows(client, memory.customer_id, refs);
    if (memory.supersedes_memory_id) {
        const superseded = locked.get(memory.supersedes_memory_id);
        if (!superseded) throw new SemanticMemoryNotFoundError(`Superseded memory not found: ${memory.supersedes_memory_id}`);
        if (!superseded.is_active) throw new SemanticMemoryValidationError('Superseded memory must still be active.');
        const competingReplacement = await client.query(
            `SELECT memory_id
             FROM semantic_memories
             WHERE customer_id = $1
               AND supersedes_memory_id = $2
               AND is_active = TRUE
             ORDER BY memory_id ASC
             FOR UPDATE`,
            [memory.customer_id, memory.supersedes_memory_id]
        );
        if (competingReplacement.rows.length > 0) {
            throw new SemanticMemoryConflictError(`Memory ${memory.supersedes_memory_id} already has an active replacement.`);
        }
    }
    if (memory.exception_to_memory_id) {
        const parent = locked.get(memory.exception_to_memory_id);
        if (!parent) throw new SemanticMemoryNotFoundError(`Exception parent memory not found: ${memory.exception_to_memory_id}`);
        if (!parent.is_active) throw new SemanticMemoryValidationError('Exception parent memory must be active.');
        if (!scopeIsEqualOrNarrower(memory, parent)) {
            throw new SemanticMemoryValidationError('Exception memory scope must be equal to or narrower than its parent memory scope.');
        }
    }
}

async function lockMemoryForEmbedding(
    client: PoolClient,
    customerId: string,
    memoryId: string
): Promise<EmbeddingMemoryLocks> {
    const lookup = await client.query(
        `SELECT memory_id, supersedes_memory_id
         FROM semantic_memories
         WHERE customer_id = $1 AND memory_id = $2`,
        [customerId, memoryId]
    );
    const row = lookup.rows[0];
    if (!row) throw new SemanticMemoryNotFoundError(`Memory not found: ${memoryId}`);

    const supersededMemoryId = row.supersedes_memory_id || null;
    const initialChildIds = supersededMemoryId ? await getActiveExceptionDescendantIds(client, customerId, supersededMemoryId) : [];
    const idsToLock = sortedUnique([memoryId, supersededMemoryId, ...initialChildIds]);
    const locked = await lockMemoryRows(client, customerId, idsToLock);
    const latestChildIds = supersededMemoryId ? await getActiveExceptionDescendantIds(client, customerId, supersededMemoryId) : [];
    const missedChild = latestChildIds.some(id => !idsToLock.includes(id));
    if (missedChild) {
        throw new SemanticMemoryConflictError('Concurrent exception links changed while storing memory embedding. Retry the request.');
    }

    const memory = locked.get(memoryId);
    if (!memory) throw new SemanticMemoryNotFoundError(`Memory not found: ${memoryId}`);
    return {
        memory,
        superseded_memory_id: supersededMemoryId,
        superseded_exception_ids: latestChildIds,
        locked
    };
}

async function finalizeSupersessionAfterEmbedding(
    client: PoolClient,
    customerId: string,
    replacementMemoryId: string,
    lockContext: EmbeddingMemoryLocks
): Promise<void> {
    const supersededMemoryId = lockContext.superseded_memory_id;
    if (!supersededMemoryId) return;

    const replacement = lockContext.locked.get(replacementMemoryId);
    const superseded = lockContext.locked.get(supersededMemoryId);
    if (!replacement || !replacement.is_active) {
        throw new SemanticMemoryValidationError('Replacement memory must be active while finalizing supersession.');
    }
    if (!superseded) throw new SemanticMemoryNotFoundError(`Superseded memory not found: ${supersededMemoryId}`);
    if (replacement.supersedes_memory_id !== supersededMemoryId) {
        throw new SemanticMemoryValidationError('Replacement memory no longer points to the superseded memory.');
    }

    await assertNoRelationshipCycle(client, customerId, replacementMemoryId, supersededMemoryId, 'supersedes_memory_id');

    const deactivatedIds = sortedUnique([
        superseded.is_active ? supersededMemoryId : null,
        ...lockContext.superseded_exception_ids
    ]);
    if (deactivatedIds.length === 0) return;

    await client.query(
        `UPDATE semantic_memories
         SET is_active = FALSE,
             deactivated_at = COALESCE(deactivated_at, CURRENT_TIMESTAMP),
             deactivation_reason = COALESCE(deactivation_reason, $3)
         WHERE customer_id = $1 AND memory_id = ANY($2::uuid[])`,
        [customerId, deactivatedIds, `Superseded by replacement memory ${replacementMemoryId}.`]
    );
    await deleteEmbeddings(client, customerId, deactivatedIds);
}

async function lockMemoryRows(client: PoolClient, customerId: string, memoryIds: string[]): Promise<Map<string, any>> {
    const ids = sortedUnique(memoryIds);
    const rows = new Map<string, any>();
    if (ids.length === 0) return rows;
    const result = await client.query(
        `SELECT *
         FROM semantic_memories
         WHERE customer_id = $1 AND memory_id = ANY($2::uuid[])
         ORDER BY memory_id ASC
         FOR UPDATE`,
        [customerId, ids]
    );
    for (const row of result.rows) rows.set(row.memory_id, row);
    return rows;
}

async function getActiveExceptionDescendantIds(client: PoolClient, customerId: string, memoryId: string): Promise<string[]> {
    const result = await client.query(
        `WITH RECURSIVE exception_tree(memory_id, depth, path, cycle) AS (
            SELECT memory_id, 1, ARRAY[memory_id], FALSE
            FROM semantic_memories
            WHERE customer_id = $1 AND exception_to_memory_id = $2 AND is_active = TRUE
            UNION ALL
            SELECT child.memory_id,
                   exception_tree.depth + 1,
                   exception_tree.path || child.memory_id,
                   child.memory_id = ANY(exception_tree.path)
            FROM semantic_memories child
            JOIN exception_tree ON child.exception_to_memory_id = exception_tree.memory_id
            WHERE child.customer_id = $1
              AND child.is_active = TRUE
              AND exception_tree.depth < $3
              AND exception_tree.cycle = FALSE
         )
         SELECT memory_id, depth, cycle
         FROM exception_tree
         ORDER BY memory_id ASC`,
        [customerId, memoryId, MAX_TRAVERSAL_DEPTH]
    );
    if (result.rows.some(row => row.cycle) || result.rows.some(row => Number(row.depth || 0) >= MAX_TRAVERSAL_DEPTH)) {
        throw new SemanticMemoryValidationError('Exception chain is cyclic or exceeds max traversal depth.');
    }
    return result.rows.map(row => row.memory_id);
}

async function deleteEmbeddings(client: PoolClient, customerId: string, memoryIds: string[]): Promise<void> {
    const ids = sortedUnique(memoryIds);
    if (ids.length === 0) return;
    for (const table of Object.values(EMBEDDING_TABLES)) {
        await client.query(
            `DELETE FROM ${table}
             WHERE customer_id = $1 AND memory_id = ANY($2::uuid[])`,
            [customerId, ids]
        );
    }
}

async function assertNoRelationshipCycle(
    client: PoolClient,
    customerId: string,
    childId: string,
    parentId: string,
    column: SemanticRelationshipColumn
): Promise<void> {
    if (!parentId || !childId) return;
    const result = await client.query(
        `WITH RECURSIVE chain(memory_id, next_id, depth, path) AS (
            SELECT memory_id, ${column}, 1, ARRAY[memory_id]
            FROM semantic_memories
            WHERE customer_id = $1 AND memory_id = $2
            UNION ALL
            SELECT m.memory_id, m.${column}, chain.depth + 1, chain.path || m.memory_id
            FROM semantic_memories m
            JOIN chain ON m.memory_id = chain.next_id
            WHERE m.customer_id = $1
              AND chain.next_id IS NOT NULL
              AND chain.depth < $4
              AND NOT m.memory_id = ANY(chain.path)
         )
         SELECT
            BOOL_OR(memory_id = $3) AS reaches_child,
            MAX(depth) AS max_depth,
            BOOL_OR(next_id = ANY(path)) AS existing_cycle
         FROM chain`,
        [customerId, parentId, childId, MAX_TRAVERSAL_DEPTH]
    );
    const row = result.rows[0] || {};
    if (row.reaches_child) {
        throw new SemanticMemoryValidationError(`Writing ${column} would create a memory relationship cycle.`);
    }
    if (row.existing_cycle || Number(row.max_depth || 0) >= MAX_TRAVERSAL_DEPTH) {
        throw new SemanticMemoryValidationError(`Existing ${column} chain is cyclic or exceeds max traversal depth.`);
    }
}

function scopeIsEqualOrNarrower(exceptionMemory: any, generalMemory: any): boolean {
    if (scopeRank(exceptionMemory.scope_type) < scopeRank(generalMemory.scope_type)) return false;
    const fields = [
        'customer_resource_name',
        'campaign_resource_name',
        'ad_group_resource_name',
        'criterion_resource_name',
        'proposal_id',
        'search_term_normalized'
    ];
    for (const field of fields) {
        if (generalMemory[field] && exceptionMemory[field] !== generalMemory[field]) return false;
    }
    return true;
}

function scopeRank(scopeType: string): number {
    if (scopeType === 'global' || scopeType === 'account_note') return 0;
    if (scopeType === 'campaign') return 1;
    if (scopeType === 'ad_group') return 2;
    if (scopeType === 'keyword' || scopeType === 'search_term' || scopeType === 'proposal') return 3;
    return -1;
}

function normalizeSearchScopes(raw: any, customerId: string): SearchScopes {
    const searchTerms = stringArray(raw.search_terms).map(normalizeSearchTerm);
    return {
        customer_resource_names: scopedResourceArray(raw.customer_resource_names, customerId, 'customer_resource_names'),
        campaign_resource_names: scopedResourceArray(raw.campaign_resource_names, customerId, 'campaign_resource_names'),
        ad_group_resource_names: scopedResourceArray(raw.ad_group_resource_names, customerId, 'ad_group_resource_names'),
        criterion_resource_names: scopedResourceArray(raw.criterion_resource_names, customerId, 'criterion_resource_names'),
        proposal_ids: stringArray(raw.proposal_ids),
        search_terms_normalized: sortedUnique([
            ...searchTerms,
            ...stringArray(raw.search_terms_normalized).map(normalizeSearchTerm)
        ])
    };
}

function rowToMemory(row: any): any {
    return {
        memory_id: row.memory_id,
        customer_id: row.customer_id,
        scope_type: row.scope_type,
        customer_resource_name: row.customer_resource_name,
        campaign_resource_name: row.campaign_resource_name,
        ad_group_resource_name: row.ad_group_resource_name,
        criterion_resource_name: row.criterion_resource_name,
        proposal_id: row.proposal_id,
        related_proposal_id: row.related_proposal_id,
        search_term: row.search_term,
        search_term_normalized: row.search_term_normalized,
        campaign_id: row.campaign_id,
        ad_group_id: row.ad_group_id,
        criterion_id: row.criterion_id,
        category: row.category,
        content: row.content,
        verification_status: row.verification_status,
        authority: row.authority,
        source: row.source,
        source_ref: row.source_ref,
        is_active: row.is_active,
        version: Number(row.version || 0),
        valid_until: row.valid_until,
        supersedes_memory_id: row.supersedes_memory_id,
        exception_to_memory_id: row.exception_to_memory_id,
        deactivated_at: row.deactivated_at,
        deactivation_reason: row.deactivation_reason,
        deactivated_by: row.deactivated_by,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function validateScopeRequirements(scopeType: ScopeType, fields: Record<string, string | null>): void {
    if (scopeType === 'campaign' && !fields.campaignResourceName) {
        throw new SemanticMemoryValidationError('campaign scope requires campaign_resource_name or campaign_id.');
    }
    if (scopeType === 'ad_group' && !fields.adGroupResourceName) {
        throw new SemanticMemoryValidationError('ad_group scope requires ad_group_resource_name or ad_group_id.');
    }
    if (scopeType === 'keyword' && !fields.criterionResourceName) {
        throw new SemanticMemoryValidationError('keyword scope requires criterion_resource_name or ad_group_id plus criterion_id.');
    }
    if (scopeType === 'proposal' && !fields.proposalId) {
        throw new SemanticMemoryValidationError('proposal scope requires proposal_id.');
    }
    if (scopeType === 'search_term' && !fields.searchTermNormalized) {
        throw new SemanticMemoryValidationError('search_term scope requires search_term.');
    }
}

function addAnyCondition(conditions: string[], params: any[], column: string, values: string[]): void {
    if (values.length === 0) return;
    params.push(values);
    conditions.push(`${column} = ANY($${params.length}::text[])`);
}

function addScopedAnyCondition(
    conditions: string[],
    params: any[],
    scopeType: ScopeType,
    column: string,
    values: string[]
): void {
    if (values.length === 0) return;
    params.push(values);
    conditions.push(`(m.scope_type = '${scopeType}' AND ${column} = ANY($${params.length}::text[]))`);
}

function addSearchTermCondition(conditions: string[], params: any[], values: string[]): void {
    if (values.length === 0) return;
    params.push(values);
    const param = `$${params.length}::text[]`;
    conditions.push(
        `(m.scope_type = 'search_term' AND (
            m.search_term_normalized = ANY(${param})
            OR EXISTS (
                SELECT 1
                FROM unnest(${param}) AS search_terms(term)
                WHERE similarity(m.search_term_normalized, search_terms.term) >= 0.35
            )
        ))`
    );
}

function enumValue(value: any, allowed: readonly string[], field: string): string {
    const text = requireClean(value, `${field} is required.`, 100);
    if (!allowed.includes(text)) {
        throw new SemanticMemoryValidationError(`${field} must be one of: ${allowed.join(', ')}.`);
    }
    return text;
}

function requireClean(value: any, message: string, maxLength: number): string {
    const text = String(value ?? '').trim();
    if (!text) throw new SemanticMemoryValidationError(message);
    if (text.length > maxLength) throw new SemanticMemoryValidationError(`${message.replace(/\.$/, '')} must be ${maxLength} characters or fewer.`);
    return text;
}

function optionalClean(value: any, maxLength: number): string | null {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (text.length > maxLength) throw new SemanticMemoryValidationError(`Value must be ${maxLength} characters or fewer.`);
    return text;
}

function requireUuid(value: any, message: string): string {
    const text = requireClean(value, message, 80);
    if (!UUID_RE.test(text)) throw new SemanticMemoryValidationError(message);
    return text;
}

function optionalUuid(value: any, message: string): string | null {
    if (value === undefined || value === null || value === '') return null;
    return requireUuid(value, message);
}

function optionalTimestamp(value: any, message: string): string | null {
    const text = optionalClean(value, 80);
    if (!text) return null;
    const time = new Date(text).getTime();
    if (!Number.isFinite(time)) throw new SemanticMemoryValidationError(message);
    return new Date(time).toISOString();
}

function supportedDimensions(value: any): keyof typeof EMBEDDING_TABLES {
    const dimensions = Number(value);
    if (!Number.isInteger(dimensions) || !(dimensions in EMBEDDING_TABLES)) {
        throw new SemanticMemoryValidationError(`dimensions must be one of: ${Object.keys(EMBEDDING_TABLES).join(', ')}.`);
    }
    return dimensions as keyof typeof EMBEDDING_TABLES;
}

function embeddingTableForDimensions(dimensions: keyof typeof EMBEDDING_TABLES): string {
    return EMBEDDING_TABLES[dimensions];
}

function normalizeEmbedding(value: any, dimensions: number, field = 'embedding'): number[] {
    if (!Array.isArray(value)) throw new SemanticMemoryValidationError(`${field} must be an array.`);
    if (value.length !== dimensions) {
        throw new SemanticMemoryValidationError(`${field} length ${value.length} does not match dimensions ${dimensions}.`);
    }
    return value.map((item, index) => {
        const numberValue = Number(item);
        if (!Number.isFinite(numberValue)) throw new SemanticMemoryValidationError(`${field}[${index}] must be a finite number.`);
        return numberValue;
    });
}

function vectorLiteral(embedding: number[]): string {
    return `[${embedding.map(value => Number(value).toString()).join(',')}]`;
}

function boundedInteger(value: any, fallback: number, min: number, max: number): number {
    const numberValue = value == null ? fallback : Number(value);
    if (!Number.isInteger(numberValue)) throw new SemanticMemoryValidationError('Expected an integer value.');
    return Math.min(max, Math.max(min, numberValue));
}

function positiveInteger(value: any, field: string): number {
    const numberValue = Number(value);
    if (!Number.isInteger(numberValue) || numberValue < 1) {
        throw new SemanticMemoryValidationError(`${field} must be a positive integer.`);
    }
    return numberValue;
}

function stringArray(value: any): string[] {
    const raw = Array.isArray(value) ? value : value ? [value] : [];
    return sortedUnique(raw.map(item => String(item ?? '').trim()).filter(Boolean));
}

function scopedResourceArray(value: any, customerId: string, field: string): string[] {
    const resources = stringArray(value);
    for (const resource of resources) validateResourceName(resource, customerId, field);
    return resources;
}

function sortedUnique(values: Array<string | null | undefined>): string[] {
    return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort();
}

function normalizeSearchTerm(value: string): string {
    const raw = String(value || '').toLowerCase();
    const tokens = raw.match(/[\p{L}\p{N}]+/gu) || [];
    return tokens.map(t => stemmer(t)).sort().join(' ');
}

function hashScope(scope: Record<string, any>): string {
    const normalized: Record<string, any> = {};
    for (const key of Object.keys(scope).sort()) {
        const value = scope[key];
        if (value !== null && value !== undefined && value !== '') normalized[key] = value;
    }
    return sha256(JSON.stringify(normalized));
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function deriveCampaignResourceName(customerId: string, campaignId: string | null): string | null {
    return campaignId ? `customers/${customerId}/campaigns/${campaignId}` : null;
}

function deriveAdGroupResourceName(customerId: string, adGroupId: string | null): string | null {
    return adGroupId ? `customers/${customerId}/adGroups/${adGroupId}` : null;
}

function deriveCriterionResourceName(customerId: string, adGroupId: string | null, criterionId: string | null): string | null {
    return adGroupId && criterionId ? `customers/${customerId}/adGroupCriteria/${adGroupId}~${criterionId}` : null;
}

function validateResourceNameCustomer(resourceName: string | null, customerId: string, field: string): void {
    if (!resourceName) return;
    const match = resourceName.match(/^customers\/([^/]+)(?:\/|$)/);
    if (!match) throw new SemanticMemoryValidationError(`${field} must be a Google Ads resource name starting with customers/{customer_id}.`);
    if (match[1] !== customerId) throw new SemanticMemoryValidationError(`${field} customer does not match customer_id.`);
}

function validateResourceName(resourceName: string | null, customerId: string, field: string): void {
    if (!resourceName) return;
    validateResourceNameCustomer(resourceName, customerId, field);

    const normalizedField = field.replace(/s$/, '');
    const patterns: Record<string, RegExp> = {
        customer_resource_name: /^customers\/([^/]+)$/,
        campaign_resource_name: /^customers\/([^/]+)\/campaigns\/([^/]+)$/,
        ad_group_resource_name: /^customers\/([^/]+)\/adGroups\/([^/]+)$/,
        criterion_resource_name: /^customers\/([^/]+)\/adGroupCriteria\/([^~/]+)~([^/]+)$/
    };
    const pattern = patterns[normalizedField];
    if (pattern && !pattern.test(resourceName)) {
        throw new SemanticMemoryValidationError(`${field} must be a valid Google Ads ${normalizedField} resource name.`);
    }
}

function assertMatchingResourceId(providedId: string | null, resourceId: string | null, idField: string, resourceField: string): void {
    if (providedId && resourceId && providedId !== resourceId) {
        throw new SemanticMemoryValidationError(`${idField} does not match ${resourceField}.`);
    }
}

function criterionPartsFromResource(resourceName: string | null): { adGroupId: string; criterionId: string } | null {
    if (!resourceName) return null;
    const match = resourceName.match(/\/adGroupCriteria\/([^~\/]+)~([^/]+)$/);
    return match ? { adGroupId: match[1], criterionId: match[2] } : null;
}

function idFromResource(resourceName: string | null, pattern: RegExp): string | null {
    if (!resourceName) return null;
    return resourceName.match(pattern)?.[1] || null;
}
