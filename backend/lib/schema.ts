import type { Pool } from 'pg';
import { ensureAdsWarehouseSchema } from './adsWarehouse';
import { ensureDashboardAuthSchema } from './dashboardAuth';
import { ensureDashboardPushSchema } from './dashboardPush';
import { ensureDashboardUsersSchema } from './dashboardUsers';
import { ensureGoogleAdsMutationSchema } from './googleAdsMutations';
import { ensureGoogleAdsQuotaSchema } from './googleAdsQuota';
import { ensureLeadSchema } from './leads';
import { ensureMcpCoreSchema } from './mcp/session';
import { ensureOfflineConversionsAuthSchema } from './offlineConversionsAuth';
import { ensureDatabaseSchema } from './proposals';
import { ensureRefreshQueueSchema } from './refreshQueue';
import { ensureUserPreferencesSchema } from './userPreferences';

export async function initializeCoreDatabaseSchema(pool: Pool): Promise<void> {
    await ensureDatabaseSchema(pool);
    await ensureAdsWarehouseSchema(pool);
    await ensureLeadSchema(pool);
    await ensureDashboardUsersSchema(pool);
    await ensureDashboardAuthSchema(pool);
    await ensureOfflineConversionsAuthSchema(pool);
    await ensureMcpCoreSchema(pool);
    await ensureGoogleAdsMutationSchema(pool);
    await ensureRefreshQueueSchema(pool);
    await ensureGoogleAdsQuotaSchema(pool);
    await ensureDashboardPushSchema(pool);
    await ensureUserPreferencesSchema(pool);
}
