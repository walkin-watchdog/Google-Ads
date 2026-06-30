import {
    AccountDailyRow,
    AccountNegativeListRow,
    AdGroupDailyRow,
    AdGroupSnapshotRow,
    AuctionInsightsRow,
    AuctionInsightsStatusRow,
    CampaignDailyRow,
    CampaignSharedSetRow,
    CampaignSnapshotRow,
    ClickEvidenceDailyRow,
    ConfiguredKeywordRow,
    ConversionActionDailyRow,
    ConversionScopedDailyRow,
    DayHourDailyRow,
    DayOfWeekDailyRow,
    DeviceDailyRow,
    dimensionHash,
    KeywordDailyRow,
    KeywordPlannerHistoricalRow,
    KeywordPlannerIdeaRow,
    LandingPageDailyRow,
    NegativeKeywordRow,
    QualityScoreRow,
    SearchTermDailyRow,
    SharedNegativeCriterionRow,
    SharedNegativeSetRow
} from './adsWarehouse';

export interface MappedReportRows {
    accountDaily?: AccountDailyRow[];
    campaignDaily?: CampaignDailyRow[];
    adGroupDaily?: AdGroupDailyRow[];
    keywordDaily?: KeywordDailyRow[];
    searchTermDaily?: SearchTermDailyRow[];
    deviceDaily?: DeviceDailyRow[];
    dayOfWeekDaily?: DayOfWeekDailyRow[];
    dayHourDaily?: DayHourDailyRow[];
    landingPageDaily?: LandingPageDailyRow[];
    expandedLandingPageDaily?: LandingPageDailyRow[];
    conversionActionDaily?: ConversionActionDailyRow[];
    conversionAdGroupDaily?: ConversionScopedDailyRow[];
    conversionSearchTermDaily?: ConversionScopedDailyRow[];
    clickEvidenceDaily?: ClickEvidenceDailyRow[];
    campaignSnapshot?: CampaignSnapshotRow[];
    adGroupSnapshot?: AdGroupSnapshotRow[];
    configuredKeywords?: ConfiguredKeywordRow[];
    qualityScores?: QualityScoreRow[];
    campaignNegatives?: NegativeKeywordRow[];
    adGroupNegatives?: NegativeKeywordRow[];
    accountNegativeLists?: AccountNegativeListRow[];
    sharedNegativeSets?: SharedNegativeSetRow[];
    sharedNegativeCriteria?: SharedNegativeCriterionRow[];
    campaignSharedSets?: CampaignSharedSetRow[];
}

function clean(value: any): string | null {
    const text = String(value ?? '').trim();
    return text || null;
}

function req(row: Record<string, any>, key: string, reportName: string): string {
    const value = clean(row[key]);
    if (!value) throw new Error(`${reportName} row missing required field ${key}`);
    return value;
}

function dateValue(row: Record<string, any>, key: string, reportName: string): string {
    const value = req(row, key, reportName);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${reportName} row has invalid date ${key}: ${value}`);
    return value;
}

function num(value: any): number | null {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function intValue(value: any): number | null {
    const n = num(value);
    return n === null ? null : Math.trunc(n);
}

function metricBase(row: Record<string, any>) {
    return {
        cost_micros: intValue(row['metrics.cost_micros']) || 0,
        clicks: intValue(row['metrics.clicks']) || 0,
        impressions: intValue(row['metrics.impressions']) || 0,
        conversions: num(row['metrics.conversions']) || 0,
        all_conversions: num(row['metrics.all_conversions']) || 0,
        conversions_value: num(row['metrics.conversions_value']) || 0,
        ctr: num(row['metrics.ctr']),
        average_cpc_micros: intValue(row['metrics.average_cpc']),
        cost_per_conversion_micros: intValue(row['metrics.cost_per_conversion'])
    };
}

function campaignBase(row: Record<string, any>, reportName: string) {
    return {
        campaign_id: req(row, 'campaign.id', reportName),
        campaign_name: clean(row['campaign.name'])
    };
}

function adGroupBase(row: Record<string, any>, reportName: string) {
    return {
        ...campaignBase(row, reportName),
        ad_group_id: req(row, 'ad_group.id', reportName),
        ad_group_name: clean(row['ad_group.name'])
    };
}

function keywordKey(row: Record<string, any>, reportName: string) {
    return {
        ...adGroupBase(row, reportName),
        criterion_id: req(row, 'ad_group_criterion.criterion_id', reportName),
        criterion_resource_name: clean(row['ad_group_criterion.resource_name']),
        keyword_text: clean(row['ad_group_criterion.keyword.text']),
        match_type: clean(row['ad_group_criterion.keyword.match_type'])
    };
}

function withRaw<T extends Record<string, any>>(row: Record<string, any>, mapped: T): T {
    return { ...mapped, raw_payload: row };
}

function normalizedKeywordKey(value: any): string {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function mapReportRows(reportName: string, customerId: string, rows: any[]): MappedReportRows {
    const name = reportName.replace(/-/g, '_');
    if (name === 'account_summary') return { accountDaily: rows.map(row => mapAccountDaily(customerId, row, name)) };
    if (name === 'campaign_performance') return { campaignDaily: rows.map(row => mapCampaignDaily(customerId, row, name)) };
    if (name === 'ad_group_performance') return { adGroupDaily: rows.map(row => mapAdGroupDaily(customerId, row, name)) };
    if (name === 'keyword_performance') return { keywordDaily: rows.map(row => mapKeywordDaily(customerId, row, name)) };
    if (name === 'search_term_performance') return { searchTermDaily: rows.map(row => mapSearchTermDaily(customerId, row, name)) };
    if (name === 'device_performance') return { deviceDaily: rows.map(row => mapDeviceDaily(customerId, row, name)) };
    if (name === 'day_of_week_performance') return { dayOfWeekDaily: rows.map(row => mapDayOfWeekDaily(customerId, row, name)) };
    if (name === 'day_and_hour_performance') return { dayHourDaily: rows.map(row => mapDayHourDaily(customerId, row, name)) };
    if (name === 'landing_page_performance') return { landingPageDaily: rows.map(row => mapLandingPageDaily(customerId, row, name, false)) };
    if (name === 'expanded_landing_page_performance') return { expandedLandingPageDaily: rows.map(row => mapLandingPageDaily(customerId, row, name, true)) };
    if (name === 'conversion_action_performance') return { conversionActionDaily: rows.map(row => mapConversionActionDaily(customerId, row, name)) };
    if (name === 'conversion_action_metrics_by_ad_group') return { conversionAdGroupDaily: rows.map(row => mapConversionAdGroupDaily(customerId, row, name)) };
    if (name === 'conversion_attribution_by_search_term') return { conversionSearchTermDaily: rows.map(row => mapConversionSearchTermDaily(customerId, row, name)) };
    if (name === 'click_evidence_by_day') return { clickEvidenceDaily: rows.map(row => mapClickEvidenceDaily(customerId, row, name)) };
    if (name === 'campaign_config') return { campaignSnapshot: rows.map(row => mapCampaignSnapshot(customerId, row, name)) };
    if (name === 'ad_group_config') return { adGroupSnapshot: rows.map(row => mapAdGroupSnapshot(customerId, row, name)) };
    if (name === 'configured_keywords') return { configuredKeywords: rows.map(row => mapConfiguredKeyword(customerId, row, name)) };
    if (name === 'quality_score') return { qualityScores: rows.map(row => mapQualityScore(customerId, row, name)) };
    if (name === 'campaign_negatives') return { campaignNegatives: rows.map(row => mapCampaignNegative(customerId, row, name)) };
    if (name === 'ad_group_negatives') return { adGroupNegatives: rows.map(row => mapAdGroupNegative(customerId, row, name)) };
    if (name === 'account_negatives') return { accountNegativeLists: rows.map(row => mapAccountNegativeList(customerId, row, name)) };
    if (name === 'shared_negative_sets') return { sharedNegativeSets: rows.map(row => mapSharedNegativeSet(customerId, row, name)) };
    if (name === 'shared_negative_criteria') return { sharedNegativeCriteria: rows.map(row => mapSharedNegativeCriterion(customerId, row, name)) };
    if (name === 'campaign_shared_sets') return { campaignSharedSets: rows.map(row => mapCampaignSharedSet(customerId, row, name)) };
    return {};
}

function mapAccountDaily(customerId: string, row: Record<string, any>, reportName: string): AccountDailyRow {
    return withRaw(row, {
        customer_id: clean(row['customer.id']) || customerId,
        date: dateValue(row, 'segments.date', reportName),
        currency_code: clean(row['customer.currency_code']),
        ...metricBase(row)
    });
}

function mapCampaignDaily(customerId: string, row: Record<string, any>, reportName: string): CampaignDailyRow {
    return withRaw(row, {
        customer_id: customerId,
        date: dateValue(row, 'segments.date', reportName),
        ...campaignBase(row, reportName),
        campaign_status: clean(row['campaign.status']),
        bidding_strategy_type: clean(row['campaign.bidding_strategy_type']),
        campaign_budget_resource_name: clean(row['campaign_budget.resource_name']),
        budget_amount_micros: intValue(row['campaign_budget.amount_micros']),
        target_cpa_micros: intValue(row['campaign.target_cpa.target_cpa_micros']) ?? intValue(row['campaign.maximize_conversions.target_cpa_micros']),
        target_roas: num(row['campaign.target_roas.target_roas']) ?? num(row['campaign.maximize_conversion_value.target_roas']),
        ...metricBase(row),
        search_impression_share: num(row['metrics.search_impression_share']),
        search_budget_lost_impression_share: num(row['metrics.search_budget_lost_impression_share']),
        search_rank_lost_impression_share: num(row['metrics.search_rank_lost_impression_share'])
    });
}

function mapAdGroupDaily(customerId: string, row: Record<string, any>, reportName: string): AdGroupDailyRow {
    return withRaw(row, {
        customer_id: customerId,
        date: dateValue(row, 'segments.date', reportName),
        ...adGroupBase(row, reportName),
        ad_group_status: clean(row['ad_group.status']),
        ...metricBase(row),
        search_impression_share: num(row['metrics.search_impression_share'])
    });
}

function mapKeywordDaily(customerId: string, row: Record<string, any>, reportName: string): KeywordDailyRow {
    return withRaw(row, {
        customer_id: customerId,
        date: dateValue(row, 'segments.date', reportName),
        ...keywordKey(row, reportName),
        criterion_status: clean(row['ad_group_criterion.status']),
        cpc_bid_micros: intValue(row['ad_group_criterion.cpc_bid_micros']),
        bidding_strategy_type: clean(row['campaign.bidding_strategy_type']),
        ...metricBase(row),
        search_impression_share: num(row['metrics.search_impression_share'])
    });
}

function mapSearchTermDaily(customerId: string, row: Record<string, any>, reportName: string): SearchTermDailyRow {
    const base = adGroupBase(row, reportName);
    const searchTerm = req(row, 'search_term_view.search_term', reportName);
    const matchedKeyword = clean(row['segments.keyword.info.text']);
    const matchedMatchType = clean(row['segments.keyword.info.match_type']);
    const termMatchType = clean(row['segments.search_term_match_type']);
    const matchSource = clean(row['segments.search_term_match_source']);
    return withRaw(row, {
        customer_id: customerId,
        date: dateValue(row, 'segments.date', reportName),
        dimension_hash: dimensionHash([base.campaign_id, base.ad_group_id, searchTerm, matchedKeyword, matchedMatchType, termMatchType, matchSource]),
        ...base,
        search_term: searchTerm,
        search_term_status: clean(row['search_term_view.status']),
        matched_keyword_text: matchedKeyword,
        matched_keyword_match_type: matchedMatchType,
        search_term_match_type: termMatchType,
        search_term_match_source: matchSource,
        ...metricBase(row)
    });
}

function mapDeviceDaily(customerId: string, row: Record<string, any>, reportName: string): DeviceDailyRow {
    return withRaw(row, {
        customer_id: customerId,
        date: dateValue(row, 'segments.date', reportName),
        ...adGroupBase(row, reportName),
        device: req(row, 'segments.device', reportName),
        ...metricBase(row)
    });
}

function mapDayOfWeekDaily(customerId: string, row: Record<string, any>, reportName: string): DayOfWeekDailyRow {
    return withRaw(row, {
        customer_id: customerId,
        date: dateValue(row, 'segments.date', reportName),
        ...adGroupBase(row, reportName),
        day_of_week: req(row, 'segments.day_of_week', reportName),
        ...metricBase(row)
    });
}

function mapDayHourDaily(customerId: string, row: Record<string, any>, reportName: string): DayHourDailyRow {
    return withRaw(row, {
        customer_id: customerId,
        date: dateValue(row, 'segments.date', reportName),
        ...adGroupBase(row, reportName),
        day_of_week: req(row, 'segments.day_of_week', reportName),
        hour: intValue(row['segments.hour']) || 0,
        ...metricBase(row)
    });
}

function mapLandingPageDaily(customerId: string, row: Record<string, any>, reportName: string, expanded: boolean): LandingPageDailyRow {
    const urlKey = expanded ? 'expanded_landing_page_view.expanded_final_url' : 'landing_page_view.unexpanded_final_url';
    const url = req(row, urlKey, reportName);
    const base: LandingPageDailyRow = {
        customer_id: customerId,
        date: dateValue(row, 'segments.date', reportName),
        url_hash: dimensionHash([url]),
        ...adGroupBase(row, reportName),
        ...metricBase(row),
        mobile_friendly_clicks_percentage: num(row['metrics.mobile_friendly_clicks_percentage']),
        valid_amp_clicks_percentage: num(row['metrics.valid_accelerated_mobile_pages_clicks_percentage']),
        speed_score: num(row['metrics.speed_score'])
    };
    if (expanded) base.expanded_final_url = url;
    else base.unexpanded_final_url = url;
    return withRaw(row, base);
}

function mapConversionActionDaily(customerId: string, row: Record<string, any>, reportName: string): ConversionActionDailyRow {
    const conversions = num(row['metrics.conversions']) ?? num(row['metrics.all_conversions']) ?? 0;
    const conversionsValue = num(row['metrics.conversions_value']) ?? num(row['metrics.all_conversions_value']) ?? 0;
    return withRaw(row, {
        customer_id: customerId,
        date: dateValue(row, 'segments.date', reportName),
        conversion_action_resource_name: req(row, 'conversion_action.resource_name', reportName),
        conversion_action_name: clean(row['conversion_action.name']),
        conversion_action_category: clean(row['conversion_action.category']),
        conversion_action_status: clean(row['conversion_action.status']),
        primary_for_goal: row['conversion_action.primary_for_goal'] === true || String(row['conversion_action.primary_for_goal']) === 'true',
        conversions,
        conversions_value: conversionsValue,
        all_conversions: num(row['metrics.all_conversions']) || 0
    });
}

function mapConversionAdGroupDaily(customerId: string, row: Record<string, any>, reportName: string): ConversionScopedDailyRow {
    const base = adGroupBase(row, reportName);
    const actionName = clean(row['segments.conversion_action_name']);
    const category = clean(row['segments.conversion_action_category']);
    return withRaw(row, {
        customer_id: customerId,
        date: dateValue(row, 'segments.date', reportName),
        dimension_hash: dimensionHash([base.campaign_id, base.ad_group_id, actionName, category]),
        ...base,
        conversion_action_name: actionName,
        conversion_action_category: category,
        conversions: num(row['metrics.conversions']) || 0,
        conversions_value: num(row['metrics.conversions_value']) || 0
    });
}

function mapConversionSearchTermDaily(customerId: string, row: Record<string, any>, reportName: string): ConversionScopedDailyRow {
    const base = adGroupBase(row, reportName);
    const searchTerm = req(row, 'search_term_view.search_term', reportName);
    const actionName = clean(row['segments.conversion_action_name']);
    const category = clean(row['segments.conversion_action_category']);
    return withRaw(row, {
        customer_id: customerId,
        date: dateValue(row, 'segments.date', reportName),
        dimension_hash: dimensionHash([base.campaign_id, base.ad_group_id, searchTerm, actionName, category]),
        ...base,
        search_term: searchTerm,
        conversion_action_name: actionName,
        conversion_action_category: category,
        conversions: num(row['metrics.conversions']) || 0,
        conversions_value: num(row['metrics.conversions_value']) || 0
    });
}

function mapClickEvidenceDaily(customerId: string, row: Record<string, any>, reportName: string): ClickEvidenceDailyRow {
    const gclid = clean(row['click_view.gclid']);
    const campaignId = clean(row['campaign.id']);
    const adGroupId = clean(row['ad_group.id']);
    const keywordText = clean(row['segments.keyword.info.text']) || clean(row['click_view.keyword_info.text']);
    const keywordMatchType = clean(row['segments.keyword.info.match_type']) || clean(row['click_view.keyword_info.match_type']);
    const clickType = clean(row['click_view.click_type']) || clean(row['segments.click_type']);
    const rawKey = gclid || JSON.stringify(row);
    return withRaw(row, {
        customer_id: customerId,
        date: dateValue(row, 'segments.date', reportName),
        dimension_hash: dimensionHash([
            rawKey,
            campaignId,
            adGroupId,
            keywordText,
            keywordMatchType,
            clickType,
            row['segments.device']
        ]),
        gclid,
        campaign_id: campaignId,
        ad_group_id: adGroupId,
        keyword_text: keywordText,
        keyword_match_type: keywordMatchType,
        click_type: clickType,
        device: clean(row['segments.device'])
    });
}

function mapCampaignSnapshot(customerId: string, row: Record<string, any>, reportName: string): CampaignSnapshotRow {
    return withRaw(row, {
        customer_id: customerId,
        ...campaignBase(row, reportName),
        campaign_status: clean(row['campaign.status']),
        bidding_strategy_type: clean(row['campaign.bidding_strategy_type']),
        campaign_budget_resource_name: clean(row['campaign_budget.resource_name']),
        budget_amount_micros: intValue(row['campaign_budget.amount_micros']),
        target_cpa_micros: intValue(row['campaign.target_cpa.target_cpa_micros']) ?? intValue(row['campaign.maximize_conversions.target_cpa_micros']),
        target_roas: num(row['campaign.target_roas.target_roas']) ?? num(row['campaign.maximize_conversion_value.target_roas'])
    });
}

function mapAdGroupSnapshot(customerId: string, row: Record<string, any>, reportName: string): AdGroupSnapshotRow {
    return withRaw(row, {
        customer_id: customerId,
        ...adGroupBase(row, reportName),
        ad_group_status: clean(row['ad_group.status'])
    });
}

function mapConfiguredKeyword(customerId: string, row: Record<string, any>, reportName: string): ConfiguredKeywordRow {
    return withRaw(row, {
        customer_id: customerId,
        ...keywordKey(row, reportName),
        keyword_text: req(row, 'ad_group_criterion.keyword.text', reportName),
        status: clean(row['ad_group_criterion.status']),
        primary_status: clean(row['ad_group_criterion.primary_status']),
        primary_status_reasons: Array.isArray(row['ad_group_criterion.primary_status_reasons'])
            ? row['ad_group_criterion.primary_status_reasons']
            : [],
        final_urls: Array.isArray(row['ad_group_criterion.final_urls']) ? row['ad_group_criterion.final_urls'] : [],
        cpc_bid_micros: intValue(row['ad_group_criterion.cpc_bid_micros'])
    });
}

function mapQualityScore(customerId: string, row: Record<string, any>, reportName: string): QualityScoreRow {
    return withRaw(row, {
        customer_id: customerId,
        ...keywordKey(row, reportName),
        status: clean(row['ad_group_criterion.status']),
        quality_score: intValue(row['ad_group_criterion.quality_info.quality_score']),
        creative_quality_score: clean(row['ad_group_criterion.quality_info.creative_quality_score']),
        post_click_quality_score: clean(row['ad_group_criterion.quality_info.post_click_quality_score']),
        search_predicted_ctr: clean(row['ad_group_criterion.quality_info.search_predicted_ctr'])
    });
}

function mapCampaignNegative(customerId: string, row: Record<string, any>, reportName: string): NegativeKeywordRow {
    const base = campaignBase(row, reportName);
    return withRaw(row, {
        customer_id: customerId,
        ...base,
        criterion_id: req(row, 'campaign_criterion.criterion_id', reportName),
        keyword_text: req(row, 'campaign_criterion.keyword.text', reportName),
        match_type: clean(row['campaign_criterion.keyword.match_type']),
        status: clean(row['campaign_criterion.status'])
    });
}

function mapAdGroupNegative(customerId: string, row: Record<string, any>, reportName: string): NegativeKeywordRow {
    const base = adGroupBase(row, reportName);
    return withRaw(row, {
        customer_id: customerId,
        ...base,
        criterion_id: req(row, 'ad_group_criterion.criterion_id', reportName),
        keyword_text: req(row, 'ad_group_criterion.keyword.text', reportName),
        match_type: clean(row['ad_group_criterion.keyword.match_type']),
        status: clean(row['ad_group_criterion.status'])
    });
}

function mapAccountNegativeList(customerId: string, row: Record<string, any>, reportName: string): AccountNegativeListRow {
    return withRaw(row, {
        customer_id: customerId,
        customer_negative_criterion_id: req(row, 'customer_negative_criterion.id', reportName),
        resource_name: clean(row['customer_negative_criterion.resource_name']),
        shared_set_resource_name: req(row, 'customer_negative_criterion.negative_keyword_list.shared_set', reportName)
    });
}

function mapSharedNegativeSet(customerId: string, row: Record<string, any>, reportName: string): SharedNegativeSetRow {
    return withRaw(row, {
        customer_id: customerId,
        shared_set_id: req(row, 'shared_set.id', reportName),
        shared_set_resource_name: req(row, 'shared_set.resource_name', reportName),
        shared_set_name: clean(row['shared_set.name']),
        shared_set_type: clean(row['shared_set.type']),
        shared_set_status: clean(row['shared_set.status'])
    });
}

function mapSharedNegativeCriterion(customerId: string, row: Record<string, any>, reportName: string): SharedNegativeCriterionRow {
    return withRaw(row, {
        customer_id: customerId,
        shared_set_resource_name: req(row, 'shared_criterion.shared_set', reportName),
        criterion_id: req(row, 'shared_criterion.criterion_id', reportName),
        keyword_text: req(row, 'shared_criterion.keyword.text', reportName),
        match_type: clean(row['shared_criterion.keyword.match_type'])
    });
}

function mapCampaignSharedSet(customerId: string, row: Record<string, any>, reportName: string): CampaignSharedSetRow {
    return withRaw(row, {
        customer_id: customerId,
        ...campaignBase(row, reportName),
        campaign_resource_name: clean(row['campaign_shared_set.campaign']),
        shared_set_resource_name: req(row, 'campaign_shared_set.shared_set', reportName),
        status: clean(row['campaign_shared_set.status'])
    });
}

export function mapKeywordPlannerIdeas(customerId: string, rows: any[]): KeywordPlannerIdeaRow[] {
    return rows.map(row => ({
        customer_id: customerId,
        keyword_key: normalizedKeywordKey(row.keyword || row.text),
        keyword: String(row.keyword || row.text || '').trim(),
        avg_monthly_searches: intValue(row.avgMonthlySearches),
        competition: clean(row.competition),
        competition_index: intValue(row.competitionIndex),
        low_bid_micros: intValue(row.lowBidMicros),
        high_bid_micros: intValue(row.highBidMicros),
        seed_type: clean(row.seedType),
        seed_keywords: Array.isArray(row.seedKeywords) ? row.seedKeywords : [],
        seed_url: clean(row.seedUrl),
        seed_site: clean(row.seedSite),
        geo_target_constants: Array.isArray(row.geoTargetConstants) ? row.geoTargetConstants : [],
        language: clean(row.language),
        keyword_plan_network: clean(row.keywordPlanNetwork),
        monthly_search_volumes: Array.isArray(row.monthlySearchVolumes) ? row.monthlySearchVolumes : [],
        raw_payload: row
    })).filter(row => row.keyword_key && row.keyword);
}

export function mapKeywordPlannerHistorical(customerId: string, rows: any[]): KeywordPlannerHistoricalRow[] {
    return rows.map(row => ({
        customer_id: customerId,
        keyword_key: normalizedKeywordKey(row.keyword || row.text),
        keyword: String(row.keyword || row.text || '').trim(),
        close_variants: Array.isArray(row.closeVariants) ? row.closeVariants : [],
        avg_monthly_searches: intValue(row.avgMonthlySearches),
        competition: clean(row.competition),
        competition_index: intValue(row.competitionIndex),
        low_bid_micros: intValue(row.lowBidMicros),
        high_bid_micros: intValue(row.highBidMicros),
        geo_target_constants: Array.isArray(row.geoTargetConstants) ? row.geoTargetConstants : [],
        language: clean(row.language),
        keyword_plan_network: clean(row.keywordPlanNetwork),
        monthly_search_volumes: Array.isArray(row.monthlySearchVolumes) ? row.monthlySearchVolumes : [],
        raw_payload: row
    })).filter(row => row.keyword_key && row.keyword);
}

export function mapAuctionInsightRows(customerId: string, rows: any[]): AuctionInsightsRow[] {
    return rows.map(row => {
        const domain = String(row['segments.auction_insight_domain'] || '').trim();
        const sourceScope = String(row['auction_insights.source_scope'] || 'account').trim();
        const entityId = clean(row['auction_insights.entity_id']);
        const campaignId = clean(row['campaign.id']);
        const adGroupId = clean(row['ad_group.id']);
        const auctionDate = clean(row['segments.date'] || row['segments.week'] || row['segments.month']);
        return {
            customer_id: customerId,
            dimension_hash: dimensionHash([sourceScope, entityId, campaignId, adGroupId, auctionDate, domain]),
            source_scope: sourceScope,
            entity_id: entityId,
            entity_name: clean(row['auction_insights.entity_name']),
            campaign_id: campaignId,
            campaign_name: clean(row['campaign.name']),
            ad_group_id: adGroupId,
            ad_group_name: clean(row['ad_group.name']),
            auction_date: auctionDate && /^\d{4}-\d{2}-\d{2}$/.test(auctionDate) ? auctionDate : null,
            domain,
            impression_share: num(row['metrics.auction_insight_search_impression_share']),
            overlap_rate: num(row['metrics.auction_insight_search_overlap_rate']),
            position_above_rate: num(row['metrics.auction_insight_search_position_above_rate']),
            top_impression_percentage: num(row['metrics.auction_insight_search_top_impression_percentage']),
            absolute_top_impression_percentage: num(row['metrics.auction_insight_search_absolute_top_impression_percentage']),
            outranking_share: num(row['metrics.auction_insight_search_outranking_share']),
            raw_payload: row
        };
    }).filter(row => row.domain);
}

export function mapAuctionInsightStatus(customerId: string, rows: any[]): AuctionInsightsStatusRow[] {
    return rows.map(row => ({
        customer_id: customerId,
        entity_type: String(row.entityType || row.entity_type || 'account'),
        entity_id: String(row.entityId || row.entity_id || 'account'),
        entity_name: clean(row.entityName || row.entity_name),
        status: String(row.status || 'empty'),
        sheet_name: clean(row.sheetName || row.sheet_name),
        rows_fetched: intValue(row.rows) || 0,
        message: clean(row.message),
        spreadsheet_id: clean(row.spreadsheetId || row.spreadsheet_id),
        spreadsheet_modified_time: clean(row.spreadsheetModifiedTime || row.spreadsheet_modified_time)
    }));
}
