import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { ensureDatabaseSchema } from '../lib/proposals';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const ROOT = path.resolve(__dirname, '..');
const LATEST = path.join(ROOT, 'data', 'latest');
const HISTORY = path.join(ROOT, 'data', 'history');

// Parse CLI arguments
let startD = '';
let endD = '';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start-date') startD = args[i + 1];
    if (args[i] === '--end-date') endD = args[i + 1];
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function readJSON(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJSON(filePath: string, data: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function micros(v: number | string): number {
  return +(Number(v) / 1_000_000).toFixed(2);
}

function pct(v: number | string): number {
  return +(Number(v) * 100).toFixed(2);
}

function safeDiv(a: number, b: number): number {
  return b ? +(a / b).toFixed(2) : 0;
}

function hasValue(obj: any, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== null && obj[key] !== undefined;
}

function fromPctMetric(obj: any, key: string): number | null {
  return hasValue(obj, key) ? pct(obj[key]) : null;
}

function normKey(v: any): string {
  return String(v || '').trim().toLowerCase();
}

function sum(rows: any[], key: string): number {
  return rows.reduce((acc, row) => acc + (+row[key] || 0), 0);
}

// ── Typed normalization helpers ────────────────────────────────────────────────

/** Returns a number or null — never coerces a missing API field to 0. */
function nullableNumber(v: any): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Converts a Google Ads fractional metric (0–1) to a percentage, or null if missing. */
function nullablePctMetric(obj: any, key: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(obj, key) || obj[key] === null || obj[key] === undefined) return null;
  const n = Number(obj[key]);
  return Number.isFinite(n) ? +(n * 100).toFixed(2) : null;
}

/**
 * Click-weighted average of a metric across rows.
 * Returns null when total clicks is zero (avoids 0% display for missing data).
 */
function weightedAverage(rows: any[], valueKey: string, weightKey: string): number | null {
  let totalWeight = 0;
  let totalValue = 0;
  for (const row of rows) {
    const w = Number(row[weightKey] || 0);
    const v = row[valueKey];
    if (v === null || v === undefined || !Number.isFinite(Number(v))) continue;
    totalWeight += w;
    totalValue += Number(v) * w;
  }
  return totalWeight > 0 ? +(totalValue / totalWeight).toFixed(2) : null;
}

/** Returns the first argument that is a non-empty string/number, or null. */
function firstNonEmpty(...vals: any[]): string | null {
  for (const v of vals) {
    const s = v === null || v === undefined ? '' : String(v).trim();
    if (s) return s;
  }
  return null;
}


function plannerNumber(value: any): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function plannerMap(rows: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const row of rows) {
    const key = normKey(row.keyword || row.text);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || Number(row.avgMonthlySearches || 0) > Number(existing.avgMonthlySearches || 0)) {
      map.set(key, row);
    }
    for (const variant of Array.isArray(row.closeVariants) ? row.closeVariants : []) {
      const variantKey = normKey(variant);
      if (variantKey && !map.has(variantKey)) map.set(variantKey, row);
    }
  }
  return map;
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
  const lower = normKey(text);
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

function performanceScore(row: { spend?: number; clicks?: number; conversions?: number; cpa?: number }, referenceCpa: number): number {
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

function plannerFields(text: string, metric: any, perf: { spend?: number; clicks?: number; conversions?: number; cpa?: number }, referenceCpa: number) {
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

// ────────────────────────────────────────────────────────────────────────────
// Load data
// ────────────────────────────────────────────────────────────────────────────

const accountSummary = readJSON(path.join(LATEST, 'account-summary.json'));
const campaigns = readJSON(path.join(LATEST, 'campaign-performance.json'));
const adGroups = readJSON(path.join(LATEST, 'ad-group-performance.json'));
const keywords = readJSON(path.join(LATEST, 'keyword-performance.json'));
const searchTerms = readJSON(path.join(LATEST, 'search-term-performance.json'));
const dailyTrend = readJSON(path.join(LATEST, 'daily-trend.json'));
const configuredKeywordsRaw = readJSON(path.join(LATEST, 'configured-keywords.json')) || [];
const campaignNegativesRaw = readJSON(path.join(LATEST, 'campaign-negatives.json')) || [];
const adGroupNegativesRaw = readJSON(path.join(LATEST, 'ad-group-negatives.json')) || [];
const conversionActionsRaw = readJSON(path.join(LATEST, 'conversion-action-performance.json')) || [];
const conversionMetricsRaw = readJSON(path.join(LATEST, 'conversion-action-metrics-by-ad-group.json')) || [];
const conversionAttributionRaw = readJSON(path.join(LATEST, 'conversion-attribution-by-search-term.json')) || [];
const clickPathsRaw = readJSON(path.join(LATEST, 'click-evidence-by-day.json')) || [];
const qualityScoreRaw = readJSON(path.join(LATEST, 'quality-score.json')) || [];
const landingPagesRaw = readJSON(path.join(LATEST, 'landing-page-performance.json')) || [];
const expandedLandingPagesRaw = readJSON(path.join(LATEST, 'expanded-landing-page-performance.json')) || [];

const auctionInsightsRaw = readJSON(path.join(LATEST, 'auction-insights-domains.json')) || [];
const auctionInsightsStatusRaw = readJSON(path.join(LATEST, 'auction-insights-status.json')) || [];
const deviceRaw = readJSON(path.join(LATEST, 'device-performance.json')) || [];
const dayOfWeekRaw = readJSON(path.join(LATEST, 'day-of-week-performance.json')) || [];
const dayAndHourRaw = readJSON(path.join(LATEST, 'day-and-hour-performance.json')) || [];
const candidateSignalsRaw = readJSON(path.join(LATEST, 'deterministic_insights.json')) || [];
const keywordPlannerIdeasRaw = readJSON(path.join(LATEST, 'keyword-planner-ideas.json')) || [];
const keywordPlannerHistoricalRaw = readJSON(path.join(LATEST, 'keyword-planner-historical-metrics.json')) || [];
const keywordPlannerStatusRaw = readJSON(path.join(LATEST, 'keyword-planner-status.json')) || null;

if (!accountSummary || !campaigns || !keywords || !searchTerms || !dailyTrend) {
  console.error('Missing data files in data/latest/. Run a data refresh first.');
  process.exit(1);
}

if (Array.isArray(accountSummary) && accountSummary.length === 0) {
  console.warn('Warning: account-summary.json is empty. Dashboard will show zeroes for this period.');
}
if (Array.isArray(dailyTrend) && dailyTrend.length === 0) {
  console.warn('Warning: daily-trend.json is empty. Trend charts will be empty.');
}

// ────────────────────────────────────────────────────────────────────────────
// Normalize account summary
// ────────────────────────────────────────────────────────────────────────────

const acct = (Array.isArray(accountSummary) ? accountSummary[0] : accountSummary) || {};
const summary = {
  spend: micros(acct['metrics.cost_micros'] || 0),
  clicks: acct['metrics.clicks'] || 0,
  impressions: acct['metrics.impressions'] || 0,
  conversions: acct['metrics.conversions'] || 0,
  ctr: pct(acct['metrics.ctr'] || 0),
  avgCpc: micros(acct['metrics.average_cpc'] || 0),
  cpa: (acct['metrics.conversions'] || 0) > 0 ? micros(acct['metrics.cost_per_conversion'] || 0) : 0,
  cvr: (acct['metrics.clicks'] || 0) > 0
    ? pct((acct['metrics.conversions'] || 0) / acct['metrics.clicks'])
    : 0,
  conversionsValue: acct['metrics.conversions_value'] || 0,
};

const currency = acct['customer.currency_code'] || 'INR';
const isUSDStyle = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'].includes(currency);
const defaultCpaBenchmark = isUSDStyle ? 25 : 2000;
const fallbackCpaBenchmark = summary.cpa || defaultCpaBenchmark;

// Define categories
function getCampaignCategory(name: string) {
  const lower = String(name || '').toLowerCase();
  if (lower.includes('comp') || lower.includes('competitor')) return 'competitor';
  return 'generic';
}

const catStats = { competitor: { spend: 0, conv: 0 }, generic: { spend: 0, conv: 0 } };
const campaignDataRaw = (Array.isArray(campaigns) ? campaigns : [campaigns]);
campaignDataRaw.forEach(c => {
  const cat = getCampaignCategory(c['campaign.name']);
  catStats[cat].spend += micros(c['metrics.cost_micros'] || 0);
  catStats[cat].conv += Number(c['metrics.conversions'] || 0);
});

const historicalCpaBenchmarks = {
  competitor: catStats.competitor.conv > 0 ? safeDiv(catStats.competitor.spend, catStats.competitor.conv) : fallbackCpaBenchmark,
  generic: catStats.generic.conv > 0 ? safeDiv(catStats.generic.spend, catStats.generic.conv) : fallbackCpaBenchmark
};

// ────────────────────────────────────────────────────────────────────────────
// Normalize campaigns
// ────────────────────────────────────────────────────────────────────────────

const campaignData = (Array.isArray(campaigns) ? campaigns : [campaigns])
  .filter(c => c['campaign.status'] !== 'REMOVED')
  .map(c => ({
    date: c['segments.date'] || null,
    name: c['campaign.name'],
    id: c['campaign.id'],
    status: c['campaign.status'],
    biddingStrategy: c['campaign.bidding_strategy_type'],
    targetCpa: c['campaign.target_cpa.target_cpa_micros']
      ? micros(c['campaign.target_cpa.target_cpa_micros'])
      : c['campaign.maximize_conversions.target_cpa_micros']
        ? micros(c['campaign.maximize_conversions.target_cpa_micros'])
        : null,
    targetRoas: c['campaign.target_roas.target_roas'] || c['campaign.maximize_conversion_value.target_roas'] || null,
    budget: c['campaign_budget.amount_micros'] ? micros(c['campaign_budget.amount_micros']) : null,
    budgetResourceName: c['campaign_budget.resource_name'] || null,
    spend: micros(c['metrics.cost_micros']),
    clicks: c['metrics.clicks'],
    impressions: c['metrics.impressions'],
    conversions: c['metrics.conversions'],
    ctr: pct(c['metrics.ctr']),
    avgCpc: micros(c['metrics.average_cpc']),
    cpa: c['metrics.conversions'] > 0 ? micros(c['metrics.cost_per_conversion']) : 0,
    cvr: c['metrics.clicks'] > 0 ? pct(c['metrics.conversions'] / c['metrics.clicks']) : 0,
    impressionShare: fromPctMetric(c, 'metrics.search_impression_share'),
    lostISBudget: fromPctMetric(c, 'metrics.search_budget_lost_impression_share'),
    lostISRank: fromPctMetric(c, 'metrics.search_rank_lost_impression_share'),
    label: '',
  }));

const campaignNameById = new Map(campaignData.map(c => [String(c.id), c.name]));

const devicePerformance = (Array.isArray(deviceRaw) ? deviceRaw : [deviceRaw]).filter(Boolean).map(d => ({
  date: d['segments.date'] || null,
  campaign: d['campaign.name'] || null,
  adGroup: d['ad_group.name'] || null,
  device: d['segments.device'],
  spend: micros(d['metrics.cost_micros']),
  clicks: d['metrics.clicks'],
  impressions: d['metrics.impressions'],
  conversions: d['metrics.conversions'],
  cpa: d['metrics.conversions'] > 0 ? micros(d['metrics.cost_per_conversion']) : 0,
}));

const dayAndHourPerformance = (Array.isArray(dayAndHourRaw) ? dayAndHourRaw : [dayAndHourRaw]).filter(Boolean).map(d => ({
  date: d['segments.date'] || null,
  campaign: d['campaign.name'] || null,
  adGroup: d['ad_group.name'] || null,
  day: d['segments.day_of_week'],
  hour: d['segments.hour'],
  spend: micros(d['metrics.cost_micros']),
  clicks: d['metrics.clicks'],
  impressions: d['metrics.impressions'],
  conversions: d['metrics.conversions'],
  ctr: pct(d['metrics.ctr']),
  avgCpc: micros(d['metrics.average_cpc']),
  cpa: d['metrics.conversions'] > 0 ? micros(d['metrics.cost_per_conversion']) : 0,
}));

const dayOfWeekPerformance = (Array.isArray(dayOfWeekRaw) ? dayOfWeekRaw : [dayOfWeekRaw]).filter(Boolean).map(d => ({
  date: d['segments.date'] || null,
  campaign: d['campaign.name'] || null,
  adGroup: d['ad_group.name'] || null,
  day: d['segments.day_of_week'],
  spend: micros(d['metrics.cost_micros']),
  clicks: d['metrics.clicks'],
  impressions: d['metrics.impressions'],
  conversions: d['metrics.conversions'],
  cpa: d['metrics.conversions'] > 0 ? micros(d['metrics.cost_per_conversion']) : 0,
}));

// ────────────────────────────────────────────────────────────────────────────
// Normalize ad groups
// ────────────────────────────────────────────────────────────────────────────

const adGroupData = (Array.isArray(adGroups) ? adGroups : [adGroups]).filter(Boolean).map(a => ({
  date: a['segments.date'] || null,
  name: a['ad_group.name'],
  id: a['ad_group.id'],
  status: a['ad_group.status'],
  campaignId: a['campaign.id'] || null,
  campaign: a['campaign.name'],
  spend: micros(a['metrics.cost_micros']),
  clicks: a['metrics.clicks'],
  impressions: a['metrics.impressions'],
  conversions: a['metrics.conversions'],
  ctr: pct(a['metrics.ctr']),
  avgCpc: micros(a['metrics.average_cpc']),
  cpa: a['metrics.conversions'] > 0 ? micros(a['metrics.cost_per_conversion']) : 0,
  cvr: a['metrics.clicks'] > 0 ? pct(a['metrics.conversions'] / a['metrics.clicks']) : 0,
  impressionShare: fromPctMetric(a, 'metrics.search_impression_share'),
  lostISBudget: fromPctMetric(a, 'metrics.search_budget_lost_impression_share'),
  lostISRank: fromPctMetric(a, 'metrics.search_rank_lost_impression_share'),
}));

// ────────────────────────────────────────────────────────────────────────────
// Normalize keywords
// ────────────────────────────────────────────────────────────────────────────

const COMPETITORS = ['aisensy', 'wati', 'interakt', 'doubletick', 'gallabox', 'sendwo', 'whatsbox', 'alvo chat', 'rocketsend io'];

const qualityScoreData = (Array.isArray(qualityScoreRaw) ? qualityScoreRaw : [qualityScoreRaw]).filter(Boolean).map(q => ({
  campaignId: q['campaign.id'] || null,
  campaign: q['campaign.name'] || null,
  adGroupId: q['ad_group.id'] || null,
  adGroup: q['ad_group.name'] || null,
  criterionId: q['ad_group_criterion.criterion_id'] || null,
  keyword: q['ad_group_criterion.keyword.text'],
  matchType: q['ad_group_criterion.keyword.match_type'],
  status: q['ad_group_criterion.status'],
  qualityScore: q['ad_group_criterion.quality_info.quality_score'] || 0,
  adRelevance: q['ad_group_criterion.quality_info.creative_quality_score'] || 'UNSPECIFIED',
  landingPageExperience: q['ad_group_criterion.quality_info.post_click_quality_score'] || 'UNSPECIFIED',
  expectedCtr: q['ad_group_criterion.quality_info.search_predicted_ctr'] || 'UNSPECIFIED',
}));

const qualityByKeyword = new Map(qualityScoreData.map(q => [`${normKey(q.keyword)}|${q.matchType}`, q]));
const plannerHistoricalByKeyword = plannerMap(Array.isArray(keywordPlannerHistoricalRaw) ? keywordPlannerHistoricalRaw : [keywordPlannerHistoricalRaw].filter(Boolean));
const plannerIdeasByKeyword = plannerMap(Array.isArray(keywordPlannerIdeasRaw) ? keywordPlannerIdeasRaw : [keywordPlannerIdeasRaw].filter(Boolean));
const plannerMetricFor = (text: string) => plannerHistoricalByKeyword.get(normKey(text)) || plannerIdeasByKeyword.get(normKey(text)) || null;

const keywordData = (Array.isArray(keywords) ? keywords : [keywords]).map(k => {
  const text = k['ad_group_criterion.keyword.text'] || '';
  const campaignName = k['campaign.name'] || '';
  const spend = micros(k['metrics.cost_micros']);
  const clicks = Number(k['metrics.clicks']);
  const conv = Number(k['metrics.conversions']);
  const cpa = conv > 0 ? micros(k['metrics.cost_per_conversion']) : 0;
  const isCompetitor = COMPETITORS.some(c => text.toLowerCase().includes(c));
  const quality = qualityByKeyword.get(`${normKey(text)}|${k['ad_group_criterion.keyword.match_type']}`) || qualityByKeyword.get(`${normKey(text)}|undefined`) || null;
  const cat = getCampaignCategory(campaignName);
  const catCpaBenchmark = historicalCpaBenchmarks[cat as keyof typeof historicalCpaBenchmarks] || historicalCpaBenchmarks.generic;

  // Primary Conversion Check
  const matchType = k['ad_group_criterion.keyword.match_type'];
  const hasPrimaryConv = (Array.isArray(conversionAttributionRaw) ? conversionAttributionRaw : []).some(a => 
    (a['segments.keyword.info.text'] === text || a['ad_group_criterion.keyword.text'] === text) && 
    (a['segments.keyword.info.match_type'] === matchType || a['ad_group_criterion.keyword.match_type'] === matchType) &&
    a['campaign.name'] === campaignName &&
    (a['segments.conversion_action_name']?.toLowerCase().includes('book appointment') || 
     a['segments.conversion_action_name']?.toLowerCase().includes('trial signup')) &&
    Number(a['metrics.conversions']) > 0
  );

  let label = '';
  if (spend > 0 && conv === 0 && clicks >= 3) label = '⛔ Pause candidate';
  else if (hasPrimaryConv && cpa > 0 && cpa < catCpaBenchmark) label = '🚀 Scale candidate';
  else if (spend > 0 && conv === 0 && clicks >= 1) label = '👀 Watch';
  else if (isCompetitor && conv === 0 && spend > 0) label = '⚠️ Competitor waste';
  
  return {
    date: k['segments.date'] || null,
    campaignId: k['campaign.id'] || null,
    adGroupId: k['ad_group.id'] || null,
    criterionId: k['ad_group_criterion.criterion_id'] || null,
    resourceName: k['ad_group_criterion.resource_name'] || null,
    cpcBidMicros: k['ad_group_criterion.cpc_bid_micros'] || null,
    keyword: text,
    matchType: k['ad_group_criterion.keyword.match_type'],
    status: k['ad_group_criterion.status'],
    campaign: k['campaign.name'],
    biddingStrategy: k['campaign.bidding_strategy_type'] || null,
    adGroup: k['ad_group.name'],
    spend,
    clicks,
    impressions: Number(k['metrics.impressions']),
    ctr: pct(k['metrics.ctr']),
    avgCpc: micros(k['metrics.average_cpc']),
    conversions: conv,
    cvr: clicks > 0 ? pct(conv / clicks) : 0,
    cpa,
    impressionShare: fromPctMetric(k, 'metrics.search_impression_share'),
    ...plannerFields(text, plannerMetricFor(text), { spend, clicks, conversions: conv, cpa }, fallbackCpaBenchmark),
    isCompetitor,
    label,
  };
});

// Aggregate performance metrics from keywordData by campaign, ad group, keyword text, and match type
const keywordPerfMap = new Map<string, { spend: number; clicks: number; impressions: number; conversions: number }>();
for (const kw of keywordData) {
  const key = `${kw.campaignId}|${kw.adGroupId}|${normKey(kw.keyword)}|${kw.matchType}`;
  const existing = keywordPerfMap.get(key) || { spend: 0, clicks: 0, impressions: 0, conversions: 0 };
  existing.spend += kw.spend || 0;
  existing.clicks += kw.clicks || 0;
  existing.impressions += kw.impressions || 0;
  existing.conversions += kw.conversions || 0;
  keywordPerfMap.set(key, existing);
}

// Normalize configured keywords (additive Keywords table, queries ad_group_criterion directly)
const configuredKeywordData = (Array.isArray(configuredKeywordsRaw) ? configuredKeywordsRaw : [configuredKeywordsRaw]).filter(Boolean).map(k => {
  const text = k['ad_group_criterion.keyword.text'] || '';
  const matchType = k['ad_group_criterion.keyword.match_type'] || '';
  const campaignId = k['campaign.id'] || null;
  const adGroupId = k['ad_group.id'] || null;

  const key = `${campaignId}|${adGroupId}|${normKey(text)}|${matchType}`;
  const perf = keywordPerfMap.get(key) || { spend: 0, clicks: 0, impressions: 0, conversions: 0 };

  const spend = +perf.spend.toFixed(2);
  const clicks = perf.clicks;
  const impressions = perf.impressions;
  const conversions = perf.conversions;
  
  const ctr = impressions > 0 ? pct(clicks / impressions) : 0;
  const avgCpc = clicks > 0 ? +(spend / clicks).toFixed(2) : 0;
  const cvr = clicks > 0 ? pct(conversions / clicks) : 0;
  const cpa = conversions > 0 ? +(spend / conversions).toFixed(2) : 0;

  const primaryStatus = k['ad_group_criterion.primary_status'] || '';
  const primaryStatusReasons = k['ad_group_criterion.primary_status_reasons'] || [];

  const finalUrls = k['ad_group_criterion.final_urls'] || [];
  const finalUrl = Array.isArray(finalUrls) && finalUrls.length > 0 ? finalUrls[0] : (typeof finalUrls === 'string' ? finalUrls : '');

  return {
    campaignId,
    adGroupId,
    criterionId: k['ad_group_criterion.criterion_id'] || null,
    resourceName: k['ad_group_criterion.resource_name'] || null,
    keyword: text,
    matchType,
    status: k['ad_group_criterion.status'] || '',
    campaign: k['campaign.name'] || '',
    adGroup: k['ad_group.name'] || '',
    spend,
    clicks,
    impressions,
    ctr,
    avgCpc,
    conversions,
    cvr,
    cpa,
    finalUrl,
    primaryStatus,
    primaryStatusReasons
  };
});

// Normalize negative keywords (additive Negatives table, queries campaign_criterion & ad_group_criterion)
const campaignNegatives = (Array.isArray(campaignNegativesRaw) ? campaignNegativesRaw : [campaignNegativesRaw]).filter(Boolean).map(n => {
  return {
    campaignId: n['campaign.id'] || null,
    campaign: n['campaign.name'] || null,
    adGroupId: null,
    adGroup: null,
    keyword: n['campaign_criterion.keyword.text'] || '',
    matchType: n['campaign_criterion.keyword.match_type'] || '',
    addedTo: n['campaign.name'] || '',
    level: 'Campaign'
  };
});

const adGroupNegatives = (Array.isArray(adGroupNegativesRaw) ? adGroupNegativesRaw : [adGroupNegativesRaw]).filter(Boolean).map(n => {
  return {
    campaignId: n['campaign.id'] || null,
    campaign: n['campaign.name'] || null,
    adGroupId: n['ad_group.id'] || null,
    adGroup: n['ad_group.name'] || null,
    keyword: n['ad_group_criterion.keyword.text'] || '',
    matchType: n['ad_group_criterion.keyword.match_type'] || '',
    addedTo: n['ad_group.name'] || '',
    level: 'Ad Group'
  };
});

const negativesData = [...campaignNegatives, ...adGroupNegatives];

// ────────────────────────────────────────────────────────────────────────────
// Normalize search terms
// ────────────────────────────────────────────────────────────────────────────

const LOW_INTENT = ['free', 'job', 'login', 'support', 'tutorial', 'template', 'meaning', 'how to', 'download', 'salary', 'career', 'internship'];

const searchTermData = (Array.isArray(searchTerms) ? searchTerms : [searchTerms])
  .filter(s => s['metrics.clicks'] > 0 || s['metrics.cost_micros'] > 0)
  .map(s => {
    const term = s['search_term_view.search_term'];
    const spend = micros(s['metrics.cost_micros']);
    const clicks = Number(s['metrics.clicks']);
    const conv = Number(s['metrics.conversions']);
    const hasLowIntent = LOW_INTENT.some(w => term.toLowerCase().includes(w));
    const isCompetitor = COMPETITORS.some(c => term.toLowerCase().includes(c));
    let label = '';
    if (spend > 0 && conv === 0 && (hasLowIntent || clicks >= 2)) label = '🚫 Negative candidate';
    else if (conv >= 1 && spend > 0) label = '✅ Promote candidate';
    else if (isCompetitor && conv === 0 && spend > 0) label = '⚠️ Competitor';
    else if (spend > 0 && conv === 0) label = '👀 Watch';
    return {
      date: s['segments.date'] || null,
      campaignId: s['campaign.id'] || null,
      adGroupId: s['ad_group.id'] || null,
      searchTerm: term,
      status: s['search_term_view.status'],
      campaign: s['campaign.name'],
      adGroup: s['ad_group.name'],
      matchedKeyword: firstNonEmpty(s['segments.keyword.info.text']),
      keywordMatchType: s['segments.keyword.info.match_type'] || null,
      searchTermMatchType: s['segments.search_term_match_type'] || null,
      searchTermMatchSource: s['segments.search_term_match_source'] || null,
      spend,
      clicks,
      impressions: Number(s['metrics.impressions']),
      ctr: pct(s['metrics.ctr']),
      avgCpc: micros(s['metrics.average_cpc']),
      conversions: conv,
      cvr: clicks > 0 ? pct(conv / clicks) : 0,
      cpa: conv > 0 ? micros(s['metrics.cost_per_conversion']) : 0,
      ...plannerFields(term, plannerMetricFor(term), { spend, clicks, conversions: conv, cpa: conv > 0 ? micros(s['metrics.cost_per_conversion']) : 0 }, fallbackCpaBenchmark),
      label,
      isCompetitor,
      hasLowIntent,
    };
  });


const existingKeywordSet = new Set(keywordData.map(row => normKey(row.keyword)));
const existingSearchTermSet = new Set(searchTermData.map(row => normKey(row.searchTerm)));
const keywordPlannerIdeas = (Array.isArray(keywordPlannerIdeasRaw) ? keywordPlannerIdeasRaw : [keywordPlannerIdeasRaw])
  .filter(Boolean)
  .map(row => ({
    ...row,
    ...plannerFields(row.keyword, row, {}, fallbackCpaBenchmark),
    inAccountKeyword: existingKeywordSet.has(normKey(row.keyword)),
    inAccountSearchTerm: existingSearchTermSet.has(normKey(row.keyword))
  }))
  .sort((a, b) => Number(b.plannerScore || 0) - Number(a.plannerScore || 0) || Number(b.avgMonthlySearches || 0) - Number(a.avgMonthlySearches || 0));

const keywordPlannerHistoricalMetrics = (Array.isArray(keywordPlannerHistoricalRaw) ? keywordPlannerHistoricalRaw : [keywordPlannerHistoricalRaw])
  .filter(Boolean)
  .map(row => ({
    ...row,
    ...plannerFields(row.keyword, row, {}, fallbackCpaBenchmark),
    inAccountKeyword: existingKeywordSet.has(normKey(row.keyword)),
    inAccountSearchTerm: existingSearchTermSet.has(normKey(row.keyword))
  }))
  .sort((a, b) => Number(b.plannerScore || 0) - Number(a.plannerScore || 0) || Number(b.avgMonthlySearches || 0) - Number(a.avgMonthlySearches || 0));

const keywordPlanner = {
  status: keywordPlannerStatusRaw || {
    status: 'empty',
    message: 'Keyword Planner has not run yet.',
    seeds: null
  },
  ideas: keywordPlannerIdeas,
  historicalMetrics: keywordPlannerHistoricalMetrics
};

// ────────────────────────────────────────────────────────────────────────────
// Normalize daily trend
// ────────────────────────────────────────────────────────────────────────────

const trendData = (Array.isArray(dailyTrend) ? dailyTrend : [dailyTrend]).map(d => ({
  date: d['segments.date'],
  campaign: d['campaign.name'] || null,
  adGroup: d['ad_group.name'] || null,
  spend: micros(d['metrics.cost_micros']),
  clicks: Number(d['metrics.clicks']),
  impressions: Number(d['metrics.impressions']),
  conversions: Number(d['metrics.conversions']),
  ctr: pct(d['metrics.ctr']),
  avgCpc: micros(d['metrics.average_cpc']),
  cpa: d['metrics.conversions'] > 0 ? micros(d['metrics.cost_per_conversion']) : 0,
  cvr: d['metrics.clicks'] > 0 ? pct(d['metrics.conversions'] / d['metrics.clicks']) : 0,
}));

// ────────────────────────────────────────────────────────────────────────────
// Normalize attribution, click evidence, and landing pages
// ────────────────────────────────────────────────────────────────────────────

// Join conversion metrics with conversion actions configuration
const conversionMetrics = (Array.isArray(conversionMetricsRaw) ? conversionMetricsRaw : [conversionMetricsRaw]).filter(Boolean);

const conversionActions = (Array.isArray(conversionActionsRaw) ? conversionActionsRaw : [conversionActionsRaw]).filter(Boolean).flatMap(a => {
  const actionName = a['conversion_action.name'];
  const actionDate = a['segments.date'] || null;
  const metricsForAction = conversionMetrics.filter(m => {
    if (m['segments.conversion_action_name'] !== actionName) return false;
    if (actionDate && m['segments.date'] && m['segments.date'] !== actionDate) return false;
    return true;
  });

  if (metricsForAction.length === 0) {
    // If no specific campaign metrics exist, return account-wide totals with null campaign/adGroup
    return [{
      date: a['segments.date'] || null,
      sourceScope: 'account',
      campaign: null,
      adGroup: null,
      campaignId: null,
      adGroupId: null,
      id: a['conversion_action.id'],
      name: actionName,
      type: a['conversion_action.type'],
      category: a['conversion_action.category'],
      status: a['conversion_action.status'],
      includeInConversions: Boolean(a['conversion_action.include_in_conversions_metric']),
      primaryForGoal: Boolean(a['conversion_action.primary_for_goal']),
      countingType: a['conversion_action.counting_type'],
      attributionModel: a['conversion_action.attribution_model_settings.attribution_model'],
      conversions: Number(a['metrics.all_conversions'] || a['metrics.conversions'] || 0),
      conversionsValue: Number(a['metrics.all_conversions_value'] || a['metrics.conversions_value'] || 0),
    }];
  }

  // Multiply the config into each campaign/adGroup that has metrics for this action
  return metricsForAction.map(m => ({
    date: m['segments.date'] || a['segments.date'] || null,
    sourceScope: 'ad_group',
    campaignId: m['campaign.id'] || null,
    campaign: m['campaign.name'] || null,
    adGroupId: m['ad_group.id'] || null,
    adGroup: m['ad_group.name'] || null,
    id: a['conversion_action.id'],
    name: actionName,
    type: a['conversion_action.type'],
    category: a['conversion_action.category'],
    status: a['conversion_action.status'],
    includeInConversions: Boolean(a['conversion_action.include_in_conversions_metric']),
    primaryForGoal: Boolean(a['conversion_action.primary_for_goal']),
    countingType: a['conversion_action.counting_type'],
    attributionModel: a['conversion_action.attribution_model_settings.attribution_model'],
    conversions: Number(m['metrics.conversions'] || 0),
    conversionsValue: Number(m['metrics.conversions_value'] || 0),
  }));
});

const conversionAttribution = (Array.isArray(conversionAttributionRaw) ? conversionAttributionRaw : [conversionAttributionRaw]).filter(Boolean).map(a => ({
  date: a['segments.date'],
  campaign: a['campaign.name'] || null,
  adGroup: a['ad_group.name'] || null,
  searchTerm: a['search_term_view.search_term'],
  searchTermStatus: a['search_term_view.status'],
  keyword: a['segments.keyword.info.text'] || a['ad_group_criterion.keyword.text'],
  matchType: a['segments.keyword.info.match_type'] || a['ad_group_criterion.keyword.match_type'],
  conversionAction: a['segments.conversion_action_name'],
  conversionCategory: a['segments.conversion_action_category'],
  conversions: Number(a['metrics.conversions'] || 0),
  allConversions: Number(a['metrics.all_conversions'] || a['metrics.conversions'] || 0),
}));

const clickPaths = (Array.isArray(clickPathsRaw) ? clickPathsRaw : [clickPathsRaw]).filter(Boolean).map(c => ({
  date: c['segments.date'],
  campaign: c['campaign.name'] || null,
  adGroup: c['ad_group.name'] || null,
  gclid: c['click_view.gclid'],
  keyword: c['click_view.keyword_info.text'],
  matchType: c['click_view.keyword_info.match_type'],
  device: c['segments.device'],
  clickType: c['segments.click_type'],
  slot: c['segments.slot'],
  clicks: Number(c['metrics.clicks'] || 1),
}));

const landingPages = (Array.isArray(landingPagesRaw) ? landingPagesRaw : [landingPagesRaw]).filter(Boolean).map(l => {
  const clicks = Number(l['metrics.clicks'] || 0);
  const conv = Number(l['metrics.conversions'] || 0);
  const campaignId = l['campaign.id'] || null;
  return {
    date: l['segments.date'] || null,
    campaignId,
    campaign: l['campaign.name'] || (campaignId ? campaignNameById.get(String(campaignId)) : null) || null,
    adGroupId: l['ad_group.id'] || null,
    adGroup: l['ad_group.name'] || null,
    finalUrl: l['landing_page_view.unexpanded_final_url'],
    spend: micros(l['metrics.cost_micros']),
    clicks,
    impressions: Number(l['metrics.impressions'] || 0),
    conversions: conv,
    ctr: pct(l['metrics.ctr'] || 0),
    avgCpc: micros(l['metrics.average_cpc'] || 0),
    cpa: conv > 0 ? micros(l['metrics.cost_per_conversion']) : 0,
    cvr: clicks > 0 ? pct(conv / clicks) : 0,
    mobileFriendlyClicksPct: nullablePctMetric(l, 'metrics.mobile_friendly_clicks_percentage'),
    validAmpClicksPct: nullablePctMetric(l, 'metrics.valid_accelerated_mobile_pages_clicks_percentage'),
    speedScore: nullableNumber(l['metrics.speed_score']),
  };
});

const expandedLandingPages = (Array.isArray(expandedLandingPagesRaw) ? expandedLandingPagesRaw : [expandedLandingPagesRaw]).filter(Boolean).map(l => {
  const clicks = Number(l['metrics.clicks'] || 0);
  const conv = Number(l['metrics.conversions'] || 0);
  const campaignId = l['campaign.id'] || null;
  return {
    date: l['segments.date'] || null,
    campaignId,
    campaign: l['campaign.name'] || (campaignId ? campaignNameById.get(String(campaignId)) : null) || null,
    adGroupId: l['ad_group.id'] || null,
    adGroup: l['ad_group.name'] || null,
    expandedFinalUrl: l['expanded_landing_page_view.expanded_final_url'],
    spend: micros(l['metrics.cost_micros']),
    clicks,
    impressions: Number(l['metrics.impressions'] || 0),
    conversions: conv,
    ctr: pct(l['metrics.ctr'] || 0),
    avgCpc: micros(l['metrics.average_cpc'] || 0),
    cpa: conv > 0 ? micros(l['metrics.cost_per_conversion']) : 0,
    cvr: clicks > 0 ? pct(conv / clicks) : 0,
    mobileFriendlyClicksPct: nullablePctMetric(l, 'metrics.mobile_friendly_clicks_percentage'),
    validAmpClicksPct: nullablePctMetric(l, 'metrics.valid_accelerated_mobile_pages_clicks_percentage'),
    speedScore: nullableNumber(l['metrics.speed_score']),
  };
});


const auctionInsights = (Array.isArray(auctionInsightsRaw) ? auctionInsightsRaw : [auctionInsightsRaw]).filter(Boolean).map(a => {
  const domain = a['segments.auction_insight_domain'];
  const metrics = {
    impressionShare: fromPctMetric(a, 'metrics.auction_insight_search_impression_share'),
    overlapRate: fromPctMetric(a, 'metrics.auction_insight_search_overlap_rate'),
    positionAboveRate: fromPctMetric(a, 'metrics.auction_insight_search_position_above_rate'),
    outrankingShare: fromPctMetric(a, 'metrics.auction_insight_search_outranking_share'),
    topImpressionRate: fromPctMetric(a, 'metrics.auction_insight_search_top_impression_percentage'),
    absoluteTopImpressionRate: fromPctMetric(a, 'metrics.auction_insight_search_absolute_top_impression_percentage')
  };
  const pressureInputs = [
    metrics.impressionShare,
    metrics.overlapRate,
    metrics.positionAboveRate,
    metrics.topImpressionRate,
    metrics.absoluteTopImpressionRate
  ].filter((value): value is number => value !== null && Number.isFinite(value));

  return {
    date: a['segments.date'] || null,
    week: a['segments.week'] || null,
    month: a['segments.month'] || null,
    quarter: a['segments.quarter'] || null,
    year: a['segments.year'] || null,
    dayOfWeek: a['segments.day_of_week'] || null,
    campaign: a['campaign.name'] || null,
    campaignId: a['campaign.id'] || null,
    adGroup: a['ad_group.name'] || null,
    adGroupId: a['ad_group.id'] || null,
    domain,
    isYou: normKey(domain) === 'you',
    pressureScore: pressureInputs.length ? +(pressureInputs.reduce((acc, value) => acc + value, 0) / pressureInputs.length).toFixed(2) : null,
    ...metrics,
    sourceScope: a['auction_insights.source_scope'] || null,
    entityId: a['auction_insights.entity_id'] || null,
    entityName: a['auction_insights.entity_name'] || null,
    rawValues: a['auction_insights.raw_values'] || null,
  };
});

const auctionInsightsStatus = (Array.isArray(auctionInsightsStatusRaw) ? auctionInsightsStatusRaw : [auctionInsightsStatusRaw]).filter(Boolean);

// multiActionSessions removed

const campaignShareProxy = campaignData.find(c => c.impressionShare !== null)?.impressionShare ?? null;
const competitorSet = ['aisensy', 'interakt', 'wati', 'gallabox', 'doubletick'];
const competitorBreakdown = competitorSet.map(name => {
  const rows = keywordData.filter(k => normKey(k.keyword).includes(name));
  const impressions = sum(rows, 'impressions');
  const clicks = sum(rows, 'clicks');
  const spend = +sum(rows, 'spend').toFixed(2);
  const conversions = +sum(rows, 'conversions').toFixed(2);
  const exactShareRows = rows.filter(r => r.impressionShare !== null);
  const impressionShare = exactShareRows.length
    ? +(exactShareRows.reduce((acc, row) => acc + (row.impressionShare || 0), 0) / exactShareRows.length).toFixed(2)
    : campaignShareProxy;
  return {
    competitor: name,
    spend,
    clicks,
    impressions,
    conversions,
    cpa: conversions > 0 ? safeDiv(spend, conversions) : 0,
    ctr: impressions > 0 ? pct(clicks / impressions) : 0,
    impressionShare,
    impressionShareSource: exactShareRows.length ? 'keyword' : 'campaign_proxy',
    qualityScore: qualityScoreData.find(q => normKey(q.keyword).includes(name))?.qualityScore || null,
  };
});

// FIX: Define the missing variables
const competitorSpend = +sum(competitorBreakdown, 'spend').toFixed(2);
const competitorConv = +sum(competitorBreakdown, 'conversions').toFixed(2);
const competitorSpendShare = safeDiv(competitorSpend, summary.spend);

// ────────────────────────────────────────────────────────────────────────────
// Generate proposals
// ────────────────────────────────────────────────────────────────────────────

const proposals: any[] = [];

// ────────────────────────────────────────────────────────────────────────────
// Compute period comparison (split trend in half)
// ────────────────────────────────────────────────────────────────────────────

const midpoint = Math.floor(trendData.length / 2);
const firstHalf = trendData.slice(0, midpoint);
const secondHalf = trendData.slice(midpoint);

function sumPeriod(arr: any[]) {
  return {
    spend: +arr.reduce((s, d) => s + d.spend, 0).toFixed(2),
    clicks: arr.reduce((s, d) => s + d.clicks, 0),
    impressions: arr.reduce((s, d) => s + d.impressions, 0),
    conversions: arr.reduce((s, d) => s + d.conversions, 0),
  };
}

const prev = sumPeriod(firstHalf);
const curr = sumPeriod(secondHalf);

function delta(c: number, p: number) {
  return p === 0 ? (c > 0 ? 100 : 0) : +((c - p) / p * 100).toFixed(1);
}

const periodComparison = {
  previousPeriod: { label: `${firstHalf[0]?.date || '?'} – ${firstHalf[firstHalf.length - 1]?.date || '?'}`, ...prev, cpa: safeDiv(prev.spend, prev.conversions) },
  currentPeriod: { label: `${secondHalf[0]?.date || '?'} – ${secondHalf[secondHalf.length - 1]?.date || '?'}`, ...curr, cpa: safeDiv(curr.spend, curr.conversions) },
  deltas: {
    spend: delta(curr.spend, prev.spend),
    clicks: delta(curr.clicks, prev.clicks),
    impressions: delta(curr.impressions, prev.impressions),
    conversions: delta(curr.conversions, prev.conversions),
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Anomaly detection
// ────────────────────────────────────────────────────────────────────────────

const anomalies: any[] = [];
if (trendData.length >= 7) {
  const avgSpend = trendData.reduce((s, d) => s + d.spend, 0) / trendData.length;
  trendData.forEach(d => {
    if (d.spend > avgSpend * 1.8) {
      anomalies.push({ date: d.date, metric: 'spend', value: d.spend, avg: +avgSpend.toFixed(2), message: `Spend spike: ₹${d.spend} vs avg ₹${avgSpend.toFixed(0)}` });
    }
    const cat = getCampaignCategory(d.campaign || '');
    const catCpaBenchmark = historicalCpaBenchmarks[cat as keyof typeof historicalCpaBenchmarks] || historicalCpaBenchmarks.generic;
    if (d.cpa > 0 && d.cpa > catCpaBenchmark * 2) {
      anomalies.push({ date: d.date, metric: 'cpa', value: d.cpa, threshold: catCpaBenchmark * 2, message: `CPA spike: ₹${d.cpa} (2× ${cat} historical benchmark)` });
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Auxiliary Data
// ────────────────────────────────────────────────────────────────────────────

const conversionActionTotals = Object.values(conversionActions.reduce((acc: any, row) => {
  const key = row.name || 'Unknown';
  if (!acc[key]) {
    acc[key] = { name: key, category: row.category, status: row.status, conversions: 0, primaryForGoal: row.primaryForGoal };
  }
  acc[key].conversions += row.conversions;
  return acc;
}, {})).sort((a: any, b: any) => b.conversions - a.conversions);

const insights = {
  conversionActionTotals,
  constraints: campaignData.map(c => ({
    campaign: c.name,
    impressionShare: c.impressionShare,
    lostISBudget: c.lostISBudget,
    lostISRank: c.lostISRank,
  }))
};

// ────────────────────────────────────────────────────────────────────────────
// Assemble dashboard payload
// ────────────────────────────────────────────────────────────────────────────

const todayStr = new Date().toISOString().slice(0, 10);
const thirtyDaysAgoStr = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    accountId: '6780466013',
    currency,
    dateRange: { start: startD || thirtyDaysAgoStr, end: endD || todayStr },
    historicalCpaBenchmarks,
  },
  summary,
  periodComparison,
  anomalies,
  insights,
  dailyTrend: trendData,
  campaigns: campaignData,
  adGroups: adGroupData,
  keywords: keywordData,
  configuredKeywords: configuredKeywordData,
  negatives: negativesData,
  searchTerms: searchTermData,
  keywordPlanner,
  conversionActions,
  conversionAttribution,
  clickPaths,
  qualityScores: qualityScoreData,
  landingPages,
  expandedLandingPages,

  auctionInsights,
  auctionInsightsStatus,
  competitorBreakdown,
  competitorSpend,
  competitorConv,
  competitorSpendShare,
  devicePerformance,
  dayOfWeekPerformance,
  dayAndHourPerformance,
  attributionCapability: {
    canReadConversionActions: conversionActions.length > 0,
    canAttributeActionsToSearchTerms: conversionAttribution.length > 0,
    canReadClickIds: clickPaths.length > 0,
    canReadAuctionInsightDomains: auctionInsights.length > 0,
    exactSessionProofRequiresSiteCapture: true,
    requiredSiteFields: ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'session_id', 'lead_id'],
  },
  candidateSignals: Array.isArray(candidateSignalsRaw) ? candidateSignalsRaw : [],
  proposals,
};

async function savePayload(payload: any) {
    if (process.env.DATABASE_URL) {
        try {
            const pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
            });
            
            await ensureDatabaseSchema(pool);

            // Fetch proposals from PostgreSQL (inserted earlier by deterministic_rules)
            try {
                const dbProposals = await pool.query("SELECT payload FROM proposals ORDER BY updated_at DESC NULLS LAST, created_at DESC");
                payload.proposals = dbProposals.rows.map(r => r.payload);
            } catch (e) {
                console.warn('Could not fetch proposals from DB, skipping...');
            }
            await pool.query(
                `INSERT INTO dashboard_payloads (id, payload) 
                 VALUES ($1, $2) 
                 ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = CURRENT_TIMESTAMP`,
                ['latest', payload]
            );
            console.log('✅ Dashboard payload written to PostgreSQL Database');
            await pool.end();
        } catch (err) {
            console.error('❌ Failed to write to PostgreSQL:', err);
        }
    } else {
        console.error('❌ No DATABASE_URL configured. Skipping database write.');
    }

    // Also write a history snapshot locally
    const historyFile = path.join(HISTORY, `${new Date().toISOString().replace(/:/g, '-').slice(0, 16)}.json`);
    writeJSON(historyFile, payload);

    console.log(`✅ ${(payload.candidateSignals || []).length} candidate signals loaded`);
    console.log(`✅ History snapshot written to ${path.relative(ROOT, historyFile)}`);
}

savePayload(payload).catch(console.error);
