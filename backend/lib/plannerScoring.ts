export interface PlannerPerformanceInput {
    spend?: number;
    clicks?: number;
    conversions?: number;
    cpa?: number;
}

export function plannerNumber(value: any): number | null {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function normalizedKeyword(value: any): string {
    return String(value || '').trim().toLowerCase();
}

function competitionScore(competition: any, index: any): number {
    const text = String(competition || '').toUpperCase();
    if (text === 'LOW') return 30;
    if (text === 'MEDIUM') return 18;
    if (text === 'HIGH') return 6;
    const n = plannerNumber(index);
    return n === null ? 10 : Math.max(0, 30 - (n * 0.24));
}

function intentScore(text: string): number {
    const lower = normalizedKeyword(text);
    let score = 0;
    if (/\b(price|pricing|cost|plan|plans|quote|demo|trial)\b/.test(lower)) score += 30;
    if (/\b(api|software|platform|provider|integration|automation|crm|marketing|chatbot)\b/.test(lower)) score += 18;
    if (/\b(business|official|solution|tool|service)\b/.test(lower)) score += 8;
    if (/\b(free|job|login|support|tutorial|template|meaning|download|salary|career|internship)\b/.test(lower)) score -= 35;
    return score;
}

function bidScore(lowBid: any, highBid: any, referenceCpa: number): number {
    const low = plannerNumber(lowBid);
    const high = plannerNumber(highBid);
    const bid = low ?? high;
    if (bid === null || referenceCpa <= 0) return 8;
    if (bid <= referenceCpa * 0.03) return 22;
    if (bid <= referenceCpa * 0.08) return 14;
    if (bid <= referenceCpa * 0.15) return 6;
    return -8;
}

function volumeScore(avgMonthlySearches: any): number {
    const volume = plannerNumber(avgMonthlySearches) || 0;
    if (volume <= 0) return 0;
    return Math.min(35, Math.log10(volume + 1) * 9);
}

function performanceScore(row: PlannerPerformanceInput, referenceCpa: number): number {
    const conversions = Number(row.conversions || 0);
    const spend = Number(row.spend || 0);
    const clicks = Number(row.clicks || 0);
    const cpa = Number(row.cpa || 0);
    if (conversions > 0 && cpa > 0 && cpa <= referenceCpa) return 28;
    if (conversions > 0) return 16;
    if (spend > referenceCpa && clicks >= 3) return -20;
    if (clicks > 0) return 2;
    return 0;
}

export function plannerFields(
    text: string,
    metric: any,
    perf: PlannerPerformanceInput,
    referenceCpa: number
): {
    avgMonthlySearches: number | null;
    competition: any;
    competitionIndex: number | null;
    lowBid: number | null;
    highBid: number | null;
    plannerScore: number | null;
    plannerSource: string | null;
    monthlySearchVolumes: any[];
} {
    if (!metric) {
        return {
            avgMonthlySearches: null,
            competition: null,
            competitionIndex: null,
            lowBid: null,
            highBid: null,
            plannerScore: null,
            plannerSource: null,
            monthlySearchVolumes: []
        };
    }
    const avgMonthlySearches = plannerNumber(metric.avgMonthlySearches);
    const competition = metric.competition || null;
    const competitionIndex = plannerNumber(metric.competitionIndex);
    const lowBid = plannerNumber(metric.lowBid);
    const highBid = plannerNumber(metric.highBid);
    const plannerScore = Math.round(Math.max(0, Math.min(100,
        volumeScore(avgMonthlySearches)
        + competitionScore(competition, competitionIndex)
        + bidScore(lowBid, highBid, referenceCpa)
        + intentScore(text)
        + performanceScore(perf, referenceCpa)
    )));
    return {
        avgMonthlySearches,
        competition,
        competitionIndex,
        lowBid,
        highBid,
        plannerScore,
        plannerSource: metric.source || 'historical',
        monthlySearchVolumes: Array.isArray(metric.monthlySearchVolumes) ? metric.monthlySearchVolumes : []
    };
}
