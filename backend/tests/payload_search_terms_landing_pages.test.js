/**
 * Focused payload tests: Search Terms & Landing Pages report parity.
 * Tests the logic in build_dashboard_payload.ts without running the full script.
 */

import { describe, it, expect } from 'bun:test';

// ── Inline the helpers under test (mirrors build_dashboard_payload.ts) ───────

function nullableNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nullablePctMetric(obj, key) {
  if (!Object.prototype.hasOwnProperty.call(obj, key) || obj[key] === null || obj[key] === undefined) return null;
  const n = Number(obj[key]);
  return Number.isFinite(n) ? +(n * 100).toFixed(2) : null;
}

function weightedAverage(rows, valueKey, weightKey) {
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

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = v === null || v === undefined ? '' : String(v).trim();
    if (s) return s;
  }
  return null;
}

function micros(v) { return +(Number(v) / 1_000_000).toFixed(2); }
function pct(v) { return +(Number(v) * 100).toFixed(2); }

function mapSearchTermRow(s) {
  const term = s['search_term_view.search_term'];
  const spend = micros(s['metrics.cost_micros']);
  const clicks = Number(s['metrics.clicks']);
  const conv = Number(s['metrics.conversions']);
  return {
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
    conversions: conv,
    cvr: clicks > 0 ? pct(conv / clicks) : 0,
    cpa: conv > 0 ? micros(s['metrics.cost_per_conversion']) : 0,
  };
}

function mapLandingPageRow(l) {
  const clicks = Number(l['metrics.clicks'] || 0);
  const conv = Number(l['metrics.conversions'] || 0);
  return {
    finalUrl: l['landing_page_view.unexpanded_final_url'],
    campaign: l['campaign.name'] || null,
    clicks,
    conversions: conv,
    cvr: clicks > 0 ? pct(conv / clicks) : 0,
    mobileFriendlyClicksPct: nullablePctMetric(l, 'metrics.mobile_friendly_clicks_percentage'),
    validAmpClicksPct: nullablePctMetric(l, 'metrics.valid_accelerated_mobile_pages_clicks_percentage'),
    speedScore: nullableNumber(l['metrics.speed_score']),
  };
}

function mapExpandedLandingPageRow(l) {
  const clicks = Number(l['metrics.clicks'] || 0);
  const conv = Number(l['metrics.conversions'] || 0);
  return {
    expandedFinalUrl: l['expanded_landing_page_view.expanded_final_url'],
    campaign: l['campaign.name'] || null,
    clicks,
    conversions: conv,
    mobileFriendlyClicksPct: nullablePctMetric(l, 'metrics.mobile_friendly_clicks_percentage'),
    validAmpClicksPct: nullablePctMetric(l, 'metrics.valid_accelerated_mobile_pages_clicks_percentage'),
    speedScore: nullableNumber(l['metrics.speed_score']),
  };
}

// ────────────────────────────────────────────────────────────────────────────

describe('nullableNumber', () => {
  it('returns null for undefined', () => expect(nullableNumber(undefined)).toBeNull());
  it('returns null for null', () => expect(nullableNumber(null)).toBeNull());
  it('returns null for empty string', () => expect(nullableNumber('')).toBeNull());
  it('returns null for NaN string', () => expect(nullableNumber('NaN')).toBeNull());
  it('returns number for valid value', () => expect(nullableNumber('72')).toBe(72));
  it('returns 0 for explicit zero', () => expect(nullableNumber(0)).toBe(0));
});

describe('nullablePctMetric', () => {
  it('returns null when key absent', () => expect(nullablePctMetric({}, 'metrics.mobile_friendly_clicks_percentage')).toBeNull());
  it('returns null when value is null', () => expect(nullablePctMetric({ 'metrics.speed_score': null }, 'metrics.speed_score')).toBeNull());
  it('converts fractional to pct', () => expect(nullablePctMetric({ 'metrics.mobile_friendly_clicks_percentage': 0.85 }, 'metrics.mobile_friendly_clicks_percentage')).toBe(85));
  it('returns 0 for explicit zero', () => expect(nullablePctMetric({ 'metrics.speed_score': 0 }, 'metrics.speed_score')).toBe(0));
});

describe('weightedAverage', () => {
  it('returns null when all weights are zero', () => {
    expect(weightedAverage([{ clicks: 0, v: 85 }], 'v', 'clicks')).toBeNull();
  });
  it('returns null when value fields are null', () => {
    expect(weightedAverage([{ clicks: 100, v: null }], 'v', 'clicks')).toBeNull();
  });
  it('computes weighted average correctly', () => {
    const rows = [{ clicks: 100, v: 80 }, { clicks: 200, v: 50 }];
    expect(weightedAverage(rows, 'v', 'clicks')).toBe(60);
  });
});

describe('firstNonEmpty', () => {
  it('returns null when all empty', () => expect(firstNonEmpty(null, undefined, '')).toBeNull());
  it('returns first non-empty', () => expect(firstNonEmpty(null, 'whatsapp', 'other')).toBe('whatsapp'));
  it('skips whitespace-only', () => expect(firstNonEmpty('   ', 'found')).toBe('found'));
});

describe('searchTermData — new match fields', () => {
  const row = mapSearchTermRow({
    'search_term_view.search_term': 'whatsapp business api',
    'search_term_view.status': 'ADDED',
    'campaign.name': 'Brand',
    'ad_group.name': 'Core',
    'segments.keyword.info.text': 'whatsapp api',
    'segments.keyword.info.match_type': 'BROAD',
    'segments.search_term_match_type': 'BROAD',
    'segments.search_term_match_source': 'ADVERTISER_KEYWORD',
    'metrics.cost_micros': '1200000',
    'metrics.clicks': '40',
    'metrics.impressions': '800',
    'metrics.conversions': '2',
    'metrics.ctr': '0.05',
    'metrics.average_cpc': '30000',
    'metrics.cost_per_conversion': '600000',
  });

  it('matchedKeyword', () => expect(row.matchedKeyword).toBe('whatsapp api'));
  it('keywordMatchType', () => expect(row.keywordMatchType).toBe('BROAD'));
  it('searchTermMatchType', () => expect(row.searchTermMatchType).toBe('BROAD'));
  it('searchTermMatchSource', () => expect(row.searchTermMatchSource).toBe('ADVERTISER_KEYWORD'));
  it('spend in dollars', () => expect(row.spend).toBe(1.2));
  it('cvr computed', () => expect(row.cvr).toBeGreaterThan(0));
});

describe('searchTermData — missing keyword fields', () => {
  const row = mapSearchTermRow({
    'search_term_view.search_term': 'buy crm',
    'search_term_view.status': 'NONE',
    'campaign.name': 'Generic',
    'ad_group.name': 'SaaS',
    'metrics.cost_micros': '500000',
    'metrics.clicks': '10',
    'metrics.impressions': '200',
    'metrics.conversions': '0',
    'metrics.ctr': '0.05',
    'metrics.average_cpc': '50000',
    'metrics.cost_per_conversion': '0',
  });

  it('matchedKeyword is null', () => expect(row.matchedKeyword).toBeNull());
  it('keywordMatchType is null', () => expect(row.keywordMatchType).toBeNull());
  it('searchTermMatchSource is null', () => expect(row.searchTermMatchSource).toBeNull());
  it('cpa is 0 with no conversions', () => expect(row.cpa).toBe(0));
});

describe('landingPageData — mobile/AMP/speed present', () => {
  const row = mapLandingPageRow({
    'landing_page_view.unexpanded_final_url': 'https://example.com/page',
    'campaign.name': 'Test',
    'metrics.clicks': '150',
    'metrics.conversions': '5',
    'metrics.ctr': '0.05',
    'metrics.mobile_friendly_clicks_percentage': 0.92,
    'metrics.valid_accelerated_mobile_pages_clicks_percentage': 0.12,
    'metrics.speed_score': 68,
  });

  it('mobileFriendlyClicksPct = 92', () => expect(row.mobileFriendlyClicksPct).toBe(92));
  it('validAmpClicksPct = 12', () => expect(row.validAmpClicksPct).toBe(12));
  it('speedScore = 68', () => expect(row.speedScore).toBe(68));
  it('finalUrl preserved', () => expect(row.finalUrl).toBe('https://example.com/page'));
});

describe('landingPageData — null-safe when Google omits metrics', () => {
  const row = mapLandingPageRow({
    'landing_page_view.unexpanded_final_url': 'https://example.com/other',
    'campaign.name': 'PMax',
    'metrics.clicks': '30',
    'metrics.conversions': '1',
    'metrics.ctr': '0.075',
  });

  it('mobileFriendlyClicksPct is null', () => expect(row.mobileFriendlyClicksPct).toBeNull());
  it('validAmpClicksPct is null', () => expect(row.validAmpClicksPct).toBeNull());
  it('speedScore is null', () => expect(row.speedScore).toBeNull());
});

describe('expandedLandingPages mapping', () => {
  const row = mapExpandedLandingPageRow({
    'expanded_landing_page_view.expanded_final_url': 'https://example.com/page?utm_source=google',
    'campaign.name': 'Brand',
    'metrics.clicks': '80',
    'metrics.conversions': '3',
    'metrics.mobile_friendly_clicks_percentage': 0.95,
    'metrics.valid_accelerated_mobile_pages_clicks_percentage': null,
    'metrics.speed_score': 55,
  });

  it('expandedFinalUrl', () => expect(row.expandedFinalUrl).toBe('https://example.com/page?utm_source=google'));
  it('mobileFriendlyClicksPct = 95', () => expect(row.mobileFriendlyClicksPct).toBe(95));
  it('validAmpClicksPct is null (API returned null)', () => expect(row.validAmpClicksPct).toBeNull());
  it('speedScore = 55', () => expect(row.speedScore).toBe(55));
});

describe('expandedLandingPages — empty array when report absent', () => {
  const expandedLandingPages = [].map(mapExpandedLandingPageRow);
  it('is an array', () => expect(Array.isArray(expandedLandingPages)).toBe(true));
  it('is empty', () => expect(expandedLandingPages.length).toBe(0));
});

describe('plannerSource formatter', () => {
  const formatter = ({ value }) =>
    ({ idea: 'Keyword idea', historical: 'Historical metrics' }[String(value || '')] || String(value || ''));
  it('idea maps to Keyword idea', () => expect(formatter({ value: 'idea' })).toBe('Keyword idea'));
  it('historical maps to Historical metrics', () => expect(formatter({ value: 'historical' })).toBe('Historical metrics'));
  it('unknown value passes through', () => expect(formatter({ value: 'unknown' })).toBe('unknown'));
});
