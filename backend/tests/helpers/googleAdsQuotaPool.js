export function createGoogleAdsQuotaTestPool() {
    const buckets = new Map();
    const operationUsage = [];
    const resourceUsage = new Map();
    const pool = {
        buckets,
        operationUsage,
        resourceUsage,
        async query(sql, params = []) {
            const text = String(sql);
            if (text.includes('CREATE TABLE IF NOT EXISTS google_ads_quota_buckets')) return { rows: [] };
            if (text.includes('INSERT INTO google_ads_quota_buckets')) {
                const [bucketKey, capacity, refillPerSecond] = params;
                if (!buckets.has(bucketKey)) {
                    buckets.set(bucketKey, {
                        bucket_key: bucketKey,
                        capacity,
                        tokens: capacity,
                        refill_per_second: refillPerSecond,
                        blocked_until: null,
                        last_refill_at: new Date(),
                        updated_at: new Date()
                    });
                }
                return { rows: [] };
            }
            if (text.includes('SELECT bucket_key')) {
                return { rows: (params[0] || []).map(key => buckets.get(key)).filter(Boolean) };
            }
            if (text.includes('DELETE FROM google_ads_api_operation_usage')) {
                const cutoff = Date.now() - 24 * 60 * 60 * 1000;
                for (let index = operationUsage.length - 1; index >= 0; index -= 1) {
                    if (operationUsage[index].developer_key === params[0]
                        && new Date(operationUsage[index].occurred_at).getTime() <= cutoff) {
                        operationUsage.splice(index, 1);
                    }
                }
                return { rows: [] };
            }
            if (text.includes('SELECT operation_count, occurred_at')) {
                return {
                    rows: operationUsage
                        .filter(row => row.developer_key === params[0])
                        .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime())
                };
            }
            if (text.includes('INSERT INTO google_ads_api_operation_usage')) {
                operationUsage.push({
                    id: operationUsage.length + 1,
                    developer_key: params[0],
                    operation_count: params[1],
                    occurred_at: new Date()
                });
                return { rows: [] };
            }
            if (text.includes('INSERT INTO google_ads_query_resource_usage_hourly')) {
                const key = `${params[0]}|${params[1]}|${params[2]}`;
                const current = resourceUsage.get(key) || { resource_consumption: 0, sample_count: 0 };
                resourceUsage.set(key, {
                    developer_key: params[0],
                    customer_id: params[1],
                    path: params[2],
                    resource_consumption: current.resource_consumption + Number(params[3]),
                    sample_count: current.sample_count + 1
                });
                return { rows: [] };
            }
            if (text.includes('SET capacity =')) {
                const [bucketKey, capacity, tokens, refillPerSecond] = params;
                const row = buckets.get(bucketKey);
                Object.assign(row, {
                    capacity,
                    tokens,
                    refill_per_second: refillPerSecond,
                    last_refill_at: new Date(),
                    updated_at: new Date()
                });
                return { rows: [] };
            }
            if (text.includes('SET tokens = 0')) {
                for (const key of params[0] || []) {
                    const row = buckets.get(key);
                    if (row) {
                        row.tokens = 0;
                        row.blocked_until = new Date(Date.now() + Number(params[1] || 0));
                    }
                }
                return { rows: [] };
            }
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].some(token => text.includes(token))) return { rows: [] };
            throw new Error(`Unexpected quota SQL: ${text}`);
        },
        async connect() {
            return {
                query: pool.query,
                release() {}
            };
        }
    };
    return pool;
}
