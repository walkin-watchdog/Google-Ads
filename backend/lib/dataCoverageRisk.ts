export type DataCoverageSeverity = 'medium' | 'low';

export interface DataCoverageSourceStatus {
    name: string;
    status: string;
    rows?: number | null;
    ageHours?: number | null;
    message?: string | null;
}

export interface DataCoverageGaps {
    missingOrFailedSources: string[];
    staleSources: string[];
    emptyDecisionSources: string[];
    missingData: string[];
    severity: DataCoverageSeverity;
    hasGap: boolean;
}

export const DECISION_SOURCE_STATUS_REPORTS = [
    'keyword-performance',
    'search-term-performance',
    'configured-keywords',
    'campaign-negatives',
    'ad-group-negatives',
    'account-negatives',
    'shared-negative-sets',
    'shared-negative-criteria',
    'campaign-shared-sets',
    'keyword-planner-ideas',
    'keyword-planner-historical-metrics',
    'auction-insights-domains',
    'auction-insights-status',
    'quality-score',
    'landing-page-performance',
    'expanded-landing-page-performance',
    'device-performance',
    'day-of-week-performance',
    'day-and-hour-performance'
];

export const CRITICAL_DATA_COVERAGE_SOURCES = [
    'keyword-performance',
    'search-term-performance',
    'configured-keywords',
    'campaign-negatives',
    'ad-group-negatives',
    'account-negatives',
    'shared-negative-criteria',
    'campaign-shared-sets',
    'keyword-planner-ideas',
    'auction-insights-domains',
    'auction-insights-status',
    'quality-score',
    'landing-page-performance',
    'device-performance',
    'day-and-hour-performance'
];

export const EMPTY_DECISION_SOURCE_NAMES = [
    'search-term-performance',
    'configured-keywords',
    'campaign-negatives',
    'ad-group-negatives'
];

export function classifyDataCoverageGaps(
    sourceStatuses: DataCoverageSourceStatus[],
    hasLeadData: boolean
): DataCoverageGaps {
    const critical = sourceStatuses.filter(status => CRITICAL_DATA_COVERAGE_SOURCES.includes(status.name));
    const missingOrFailedSources = critical
        .filter(status => status.status === 'missing' || status.status === 'failed')
        .map(status => status.name);
    const staleSources = critical
        .filter(status => status.status === 'stale')
        .map(status => status.name);
    const emptyDecisionSources = sourceStatuses
        .filter(status => EMPTY_DECISION_SOURCE_NAMES.includes(status.name))
        .filter(status => status.status === 'empty')
        .map(status => status.name);
    const sourceGaps = [...missingOrFailedSources, ...staleSources];
    const missingData = [
        ...missingOrFailedSources,
        ...staleSources.map(source => `stale_source:${source}`),
        ...(hasLeadData ? [] : ['first_party_lead_quality'])
    ];

    return {
        missingOrFailedSources,
        staleSources,
        emptyDecisionSources,
        missingData,
        severity: sourceGaps.some(name => name.includes('negative') || name.includes('configured')) ? 'medium' : 'low',
        hasGap: missingData.length > 0 || emptyDecisionSources.length > 0
    };
}
