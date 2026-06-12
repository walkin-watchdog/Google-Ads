import type { AuctionInsightsRow, DashboardFilters } from './adsWarehouse';

export type AuctionMetricKey =
    | 'impressionShare'
    | 'overlapRate'
    | 'positionAboveRate'
    | 'topImpressionRate'
    | 'absoluteTopImpressionRate'
    | 'outrankingShare';

type PerformanceRow = {
    date?: string | null;
    campaign_id?: string | null;
    ad_group_id?: string | null;
    impressions?: number | string | null;
};

type SummaryInput = {
    rows: AuctionInsightsRow[];
    previousRows?: AuctionInsightsRow[];
    accountDaily?: PerformanceRow[];
    campaignDaily?: PerformanceRow[];
    adGroupDaily?: PerformanceRow[];
    previousPerformanceRows?: PerformanceRow[];
    filters: DashboardFilters;
};

const METRIC_FIELDS: Record<AuctionMetricKey, keyof AuctionInsightsRow> = {
    impressionShare: 'impression_share',
    overlapRate: 'overlap_rate',
    positionAboveRate: 'position_above_rate',
    topImpressionRate: 'top_impression_percentage',
    absoluteTopImpressionRate: 'absolute_top_impression_percentage',
    outrankingShare: 'outranking_share'
};

const RAW_METRIC_HEADERS: Record<AuctionMetricKey, string> = {
    impressionShare: 'impression share',
    overlapRate: 'overlap rate',
    positionAboveRate: 'position above rate',
    topImpressionRate: 'top of page rate',
    absoluteTopImpressionRate: 'abs. top of page rate',
    outrankingShare: 'outranking share'
};

function numberOrNull(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function isoDate(value: unknown): string | null {
    if (!value) return null;
    const text = value instanceof Date ? value.toISOString() : String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function normalizedDomain(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

function rawMetricValue(row: AuctionInsightsRow, metric: AuctionMetricKey): string {
    const rawPayload = row.raw_payload || {};
    const rawValues = rawPayload['auction_insights.raw_values']
        || rawPayload.auctionInsightsRawValues
        || rawPayload.rawValues
        || {};
    const header = RAW_METRIC_HEADERS[metric];
    const fallbackHeader = metric === 'absoluteTopImpressionRate' ? 'absolute top of page rate' : null;
    return String(rawValues[header] ?? (fallbackHeader ? rawValues[fallbackHeader] : '') ?? '').trim();
}

function isSuppressed(row: AuctionInsightsRow, metric: AuctionMetricKey): boolean {
    return rawMetricValue(row, metric).startsWith('<');
}

function metricValue(row: AuctionInsightsRow, metric: AuctionMetricKey): number | null {
    const raw = rawMetricValue(row, metric);
    if (raw.startsWith('<')) {
        const threshold = Number(raw.match(/[\d.]+/)?.[0]);
        if (Number.isFinite(threshold) && threshold > 0) {
            // Google exports only a bound (normally <10%), not the hidden value.
            // The midpoint is the least-biased estimate; treating the bound as
            // 9.99% systematically inflates every suppressed competitor.
            return threshold / 200;
        }
    }
    return numberOrNull(row[METRIC_FIELDS[metric]]);
}

function selectedPerformanceRows(input: SummaryInput): PerformanceRow[] {
    if (input.filters.adGroupId) {
        return (input.adGroupDaily || []).filter(row => String(row.ad_group_id || '') === input.filters.adGroupId);
    }
    if (input.filters.campaignId) {
        return (input.campaignDaily || []).filter(row => String(row.campaign_id || '') === input.filters.campaignId);
    }
    return input.accountDaily || [];
}

function impressionsByRows(rows: PerformanceRow[]): Map<string, number> {
    const totals = new Map<string, number>();
    for (const row of rows) {
        const date = isoDate(row.date);
        const impressions = numberOrNull(row.impressions);
        if (!date || impressions === null || impressions < 0) continue;
        totals.set(date, (totals.get(date) || 0) + impressions);
    }
    return totals;
}

function impressionsByDate(input: SummaryInput): Map<string, number> {
    return impressionsByRows(selectedPerformanceRows(input));
}

function ownShareByDate(rows: AuctionInsightsRow[]): Map<string, number> {
    const shares = new Map<string, number>();
    for (const row of rows) {
        if (normalizedDomain(row.domain) !== 'you') continue;
        const date = isoDate(row.auction_date);
        const share = numberOrNull(row.impression_share);
        if (date && share !== null && share > 0) shares.set(date, share);
    }
    return shares;
}

function metricWeight(
    row: AuctionInsightsRow,
    metric: AuctionMetricKey,
    scopeImpressions: Map<string, number>,
    ownShares: Map<string, number>
): number {
    const date = isoDate(row.auction_date);
    if (!date) return 1;
    const ownImpressions = Math.max(scopeImpressions.get(date) || 0, 0);
    const ownShare = ownShares.get(date) || 0;
    const eligibleAuctionEstimate = ownImpressions > 0 && ownShare > 0
        ? ownImpressions / ownShare
        : ownImpressions;
    if (metric === 'overlapRate') return ownImpressions || 1;
    if (metric === 'positionAboveRate') {
        const overlap = metricValue(row, 'overlapRate') || 0;
        return ownImpressions * overlap || ownImpressions || 1;
    }
    if (metric === 'topImpressionRate' || metric === 'absoluteTopImpressionRate') {
        const share = metricValue(row, 'impressionShare') || 0;
        return eligibleAuctionEstimate * share || ownImpressions || 1;
    }
    if (metric === 'outrankingShare') {
        const share = metricValue(row, 'impressionShare') || 0;
        const overlap = metricValue(row, 'overlapRate') || 0;
        const rivalImpressions = eligibleAuctionEstimate * share;
        const sharedImpressions = ownImpressions * overlap;
        return Math.max(ownImpressions + rivalImpressions - sharedImpressions, 1);
    }
    return eligibleAuctionEstimate || ownImpressions || 1;
}

function aggregateMetric(
    rows: AuctionInsightsRow[],
    metric: AuctionMetricKey,
    scopeImpressions: Map<string, number>,
    ownShares: Map<string, number>,
    isYou: boolean
): { value: number | null; suppressed: boolean } {
    const usable = rows
        .map(row => ({ row, value: metricValue(row, metric) }))
        .filter((entry): entry is { row: AuctionInsightsRow; value: number } => entry.value !== null);
    if (!usable.length) return { value: null, suppressed: false };

    if (isYou && metric === 'impressionShare') {
        let impressions = 0;
        let eligible = 0;
        for (const { row, value } of usable) {
            const date = isoDate(row.auction_date);
            const dailyImpressions = date ? scopeImpressions.get(date) || 0 : 0;
            if (dailyImpressions > 0 && value > 0) {
                impressions += dailyImpressions;
                eligible += dailyImpressions / value;
            }
        }
        if (eligible > 0) {
            return {
                value: impressions / eligible,
                suppressed: usable.some(entry => isSuppressed(entry.row, metric))
            };
        }
    }

    let weightedValue = 0;
    let totalWeight = 0;
    for (const { row, value } of usable) {
        const weight = metricWeight(row, metric, scopeImpressions, ownShares);
        weightedValue += value * weight;
        totalWeight += weight;
    }
    return {
        value: totalWeight > 0 ? weightedValue / totalWeight : null,
        suppressed: usable.some(entry => isSuppressed(entry.row, metric))
    };
}

function percent(value: number | null): number | null {
    return value === null ? null : +((value * 100).toFixed(2));
}

function metricDisplay(value: number | null, suppressed: boolean): string {
    const pct = percent(value);
    if (pct === null) return '—';
    if (suppressed && pct < 10) return '<10%';
    if (suppressed) return `≈${pct.toFixed(2)}%`;
    return `${pct.toFixed(2)}%`;
}

function observedRange(rows: AuctionInsightsRow[]): { start: string | null; end: string | null } {
    const dates = Array.from(new Set(rows.map(row => isoDate(row.auction_date)).filter(Boolean) as string[])).sort();
    return { start: dates[0] || null, end: dates[dates.length - 1] || null };
}

function previousRange(filters: DashboardFilters): { start: string; end: string } | null {
    const start = new Date(`${filters.startDate}T00:00:00.000Z`);
    const end = new Date(`${filters.endDate}T00:00:00.000Z`);
    const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (days < 1 || days > 31) return null;
    const previousEnd = new Date(start);
    previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
    const previousStart = new Date(previousEnd);
    previousStart.setUTCDate(previousStart.getUTCDate() - days + 1);
    return {
        start: previousStart.toISOString().slice(0, 10),
        end: previousEnd.toISOString().slice(0, 10)
    };
}

function aggregateDomains(
    rows: AuctionInsightsRow[],
    scopeImpressions: Map<string, number>,
    ownShares: Map<string, number>
): any[] {
    const groups = new Map<string, AuctionInsightsRow[]>();
    for (const row of rows) {
        const domain = normalizedDomain(row.domain);
        if (!domain) continue;
        const group = groups.get(domain) || [];
        group.push(row);
        groups.set(domain, group);
    }

    const metricKeys = Object.keys(METRIC_FIELDS) as AuctionMetricKey[];
    return Array.from(groups.entries()).map(([domain, domainRows]) => {
        const isYou = domain === 'you';
        const aggregated = Object.fromEntries(metricKeys.map(metric => [
            metric,
            aggregateMetric(domainRows, metric, scopeImpressions, ownShares, isYou)
        ])) as Record<AuctionMetricKey, { value: number | null; suppressed: boolean }>;
        const dates = Array.from(new Set(domainRows.map(row => isoDate(row.auction_date)).filter(Boolean) as string[])).sort();
        const impressionShare = percent(aggregated.impressionShare.value);
        const overlapRate = percent(aggregated.overlapRate.value);
        const positionAboveRate = percent(aggregated.positionAboveRate.value);
        const topImpressionRate = percent(aggregated.topImpressionRate.value);
        const absoluteTopImpressionRate = percent(aggregated.absoluteTopImpressionRate.value);
        const outrankingShare = percent(aggregated.outrankingShare.value);
        const pressureValues = [impressionShare, overlapRate, positionAboveRate, absoluteTopImpressionRate]
            .filter((value): value is number => value !== null);
        return {
            domain: isYou ? 'You' : domain,
            isYou,
            rowCount: domainRows.length,
            observedDays: dates.length,
            firstSeen: dates[0] || null,
            lastSeen: dates[dates.length - 1] || null,
            impressionShare,
            overlapRate: isYou ? null : overlapRate,
            positionAboveRate: isYou ? null : positionAboveRate,
            topImpressionRate,
            absoluteTopImpressionRate,
            outrankingShare: isYou ? null : outrankingShare,
            pressureScore: pressureValues.length
                ? +(pressureValues.reduce((sum, value) => sum + value, 0) / pressureValues.length).toFixed(2)
                : null,
            display: Object.fromEntries(metricKeys.map(metric => [
                metric,
                metricDisplay(aggregated[metric].value, aggregated[metric].suppressed)
            ])),
            suppressed: Object.fromEntries(metricKeys.map(metric => [metric, aggregated[metric].suppressed]))
        };
    }).sort((a, b) =>
        (b.impressionShare ?? -1) - (a.impressionShare ?? -1)
        || Number(b.isYou) - Number(a.isYou)
        || a.domain.localeCompare(b.domain)
    );
}

function trend(rows: AuctionInsightsRow[], summaries: any[]): any {
    const dates = Array.from(new Set(rows.map(row => isoDate(row.auction_date)).filter(Boolean) as string[])).sort();
    const you = summaries.find(row => row.isYou);
    const rivals = summaries.filter(row => !row.isYou).slice(0, 4);
    const selected = you ? [you, ...rivals] : rivals;
    return {
        dates,
        series: selected.map(summary => ({
            domain: summary.domain,
            isYou: summary.isYou,
            values: dates.map(date => {
                const row = rows.find(candidate =>
                    isoDate(candidate.auction_date) === date
                    && normalizedDomain(candidate.domain) === normalizedDomain(summary.domain)
                );
                return row ? percent(metricValue(row, 'impressionShare')) : null;
            }),
            suppressed: dates.map(date => {
                const row = rows.find(candidate =>
                    isoDate(candidate.auction_date) === date
                    && normalizedDomain(candidate.domain) === normalizedDomain(summary.domain)
                );
                return row ? isSuppressed(row, 'impressionShare') : false;
            })
        }))
    };
}

function topRows(rows: any[], metric: AuctionMetricKey, includeYou: boolean): any[] {
    return rows
        .filter(row => (includeYou || !row.isYou) && Number.isFinite(row[metric]))
        .slice()
        .sort((a, b) => b[metric] - a[metric] || a.domain.localeCompare(b.domain))
        .slice(0, 5);
}

export function buildAuctionInsightsSummary(input: SummaryInput): any {
    const scopeImpressions = impressionsByDate(input);
    const ownShares = ownShareByDate(input.rows);
    const rows = aggregateDomains(input.rows, scopeImpressions, ownShares);
    const previousRawRows = input.previousRows || [];
    const previousRows = aggregateDomains(
        previousRawRows,
        impressionsByRows(input.previousPerformanceRows || []),
        ownShareByDate(previousRawRows)
    );
    const previousByDomain = new Map(previousRows.map(row => [normalizedDomain(row.domain), row]));
    for (const row of rows) {
        const previous = previousByDomain.get(normalizedDomain(row.domain));
        row.change = Object.fromEntries((Object.keys(METRIC_FIELDS) as AuctionMetricKey[]).map(metric => [
            metric,
            previous
                && !row.suppressed?.[metric]
                && !previous.suppressed?.[metric]
                && Number.isFinite(row[metric])
                && Number.isFinite(previous[metric])
                ? +(row[metric] - previous[metric]).toFixed(2)
                : null
        ]));
    }

    const currentDomains = new Set(rows.filter(row => !row.isYou).map(row => normalizedDomain(row.domain)));
    const previousDomains = new Set(previousRows.filter(row => !row.isYou).map(row => normalizedDomain(row.domain)));
    const entered = rows.filter(row => !row.isYou && !previousDomains.has(normalizedDomain(row.domain))).map(row => row.domain);
    const exited = previousRows.filter(row => !row.isYou && !currentDomains.has(normalizedDomain(row.domain))).map(row => row.domain);
    const scope = input.filters.adGroupId
        ? { type: 'ad_group', id: input.filters.adGroupId }
        : input.filters.campaignId
            ? { type: 'campaign', id: input.filters.campaignId }
            : { type: 'account', id: input.filters.customerId };
    const comparisonRange = previousRange(input.filters);

    return {
        meta: {
            scope,
            requestedRange: { start: input.filters.startDate, end: input.filters.endDate },
            observedRange: observedRange(input.rows),
            comparisonRange,
            sourceRows: input.rows.length,
            previousSourceRows: input.previousRows?.length || 0,
            domainCount: rows.length,
            aggregationMethod: 'auction-volume-weighted daily segments',
            exactRangeAggregation: false,
            accuracyNote: 'Daily Auction Insights percentages are weighted by the best available auction-volume denominators. Google does not export every competitor denominator needed to reconstruct arbitrary ranges exactly, and suppressed bounds such as <10% use their midpoint for internal rollups.',
            suppressionPreserved: true,
            comparisonAvailable: comparisonRange !== null && (input.previousRows?.length || 0) > 0
        },
        rows,
        trend: trend([...previousRawRows, ...input.rows], rows),
        highlights: {
            absoluteTop: topRows(rows, 'absoluteTopImpressionRate', true),
            overlap: topRows(rows, 'overlapRate', false),
            entered,
            exited
        }
    };
}
