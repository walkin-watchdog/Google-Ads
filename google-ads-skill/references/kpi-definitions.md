# KPI Definitions

## Core Metrics

| KPI | Formula |
|---|---|
| Spend | `cost_micros / 1_000_000` |
| Clicks | Google Ads raw clicks |
| Impressions | Google Ads raw impressions |
| CTR | `clicks / impressions` |
| Avg CPC | `spend / clicks` |
| Conversions | Google Ads `metrics.conversions` |
| CVR | `conversions / clicks` |
| CPA | `spend / conversions` |
| Conversion Value | Google Ads `metrics.conversions_value` |
| ROAS | `conversion_value / spend` |
| Unique Leads | Deduped `lead_sessions` count |
| New Leads | Deduped lead sessions with `status = "new"` |
| Useless Leads | Deduped lead sessions with `status = "useless"` |
| Qualified Open Leads | Deduped lead sessions with `status = "qualified"` |
| Qualified-Lost Leads | Deduped lead sessions with `status = "qualified_lost"` |
| Converted Customers | Deduped lead sessions with `status = "converted"` |
| Terminal Outcomes | `qualified_lost + converted + useless` |
| In-Progress Leads | `qualified` |
| Qualified Pipeline | `qualified + qualified_lost + converted` |
| Qualified Or Converted | `qualified + converted` |
| True CPA | `campaign spend / unique leads` |
| Qualified CPA | `campaign spend / (qualified open + qualified-lost + converted)` |
| Converted CPA | `campaign spend / converted customers` |
| Customer CPA | `campaign spend / converted customers` |
| Useless Rate | `useless / unique leads` |
| Lead Qualified Rate | `(qualified + qualified_lost + converted) / unique leads` |
| Lead Conversion Rate | `converted / unique leads` |

MCP raw GAQL responses include `apiVersion`, `requestId`, `rowCount`, `truncated`, and `warnings` alongside `rows`. These fields are execution metadata, not performance KPIs. Use `requestId` for debugging Google Ads API failures and `truncated`/`warnings` to lower confidence in any aggregate conclusion.

## Targets

Use fetched Google Ads targets only:

- `campaign.target_cpa.target_cpa_micros`
- `campaign.maximize_conversions.target_cpa_micros`
- `campaign.target_roas.target_roas`
- `campaign.maximize_conversion_value.target_roas`

If target CPA or target ROAS is missing, say it is missing. Do not invent a target from account averages. Account averages may be used only as rough context, not as a stated target.

## Auction Insights

Auction Insights are loaded from configured daily Google Sheets exports. Sheet names are saved per account, campaign, and ad group in the dashboard. The selected dashboard range and exactly one hierarchy scope are applied before aggregation, so account, campaign, and ad-group exports must never be mixed.

`auctionInsights` is a summary object. Inspect `meta.requestedRange`, `meta.observedRange`, `meta.scope`, `meta.sourceRows`, and `meta.aggregationMethod` before using `rows`, `trend`, or `highlights`. Impression share, overlap, position-above, top-page, absolute-top, and outranking metrics use metric-specific auction-volume weights instead of simple daily averages. Google's `<10%` privacy/volume suppression remains a bound, not a value of exactly 10%; censored days use the bound midpoint only for internal rollups, and mixed results carry an `≈` display marker when they cross 10%.

Daily percentage exports do not contain all competitor-specific denominators needed to reconstruct every arbitrary unsegmented Google Ads range exactly. Treat the dashboard rollup as the best available weighted daily estimate and name that limitation when small differences affect a decision. If rows are missing, inspect `auctionInsightsStatus` for missing `GOOGLE_SHEETS_REFRESH_TOKEN`, missing sheet names, fetch errors, empty sheets, or a requested range outside the sheet's Day-segmented coverage.

## Keyword Planner

Keyword Planner enrichment comes from official Google Ads Keyword Plan Idea Service endpoints, not GAQL reports. It is market context:

- AMS: `avgMonthlySearches`.
- Competition: `LOW`, `MEDIUM`, or `HIGH`.
- Competition Index: `competitionIndex` when returned.
- Low/High Bid: `lowTopOfPageBidMicros` and `highTopOfPageBidMicros`, converted from micros to account currency display units.
- Source: `idea` means a row came from `generateKeywordIdeas`; `historical` means it came from `generateKeywordHistoricalMetrics`.
- Seed Type for ideas: `keyword` (keyword-only), `keyword_and_url` (keywords with a page URL filter), `url` (page-only), or `site` (entire-site domain seed).
- Planner Score: local ranking helper calculated by the dashboard, not returned by Google. It combines intent, volume, competition, bid fit, and current account performance where available.

Planner data does not replace actual account conversions, CPA, ROAS, or first-party lead quality.

## Conversion Quality

Primary conversions matter more than all conversions. When conversion action data is available, call out whether performance is driven by high-intent actions such as demo/book/trial events or by weaker secondary actions.

First-party lead quality is stronger than raw Google Ads conversion count when present. `leadAttribution` separates repeated conversion events from deduped people and reports `new`, `useless`, `qualified`, `qualified_lost`, and `converted` statuses. `qualified` is in progress; `qualified_lost`, `converted`, and `useless` are terminal. `qualifiedPipeline` means `qualified + qualified_lost + converted`; `qualifiedOrConverted` means `qualified + converted`. State clearly whether a CPA is Google Ads CPA, True CPA, Qualified CPA, Converted CPA, or Customer CPA.

`leadAttribution` metrics should be interpreted inside the selected dashboard date/campaign/ad-group slice. Request `dateRangePreset: "all_time"` for account-start-through-today analysis, or request the active `startDate`/`endDate`/`campaignId`/`adGroupId` from the server so `totals`, `byCampaign`, campaign-scoped `bySearchTerm`, journey summaries, recent review rows, and offline export readiness are rebuilt from DB-backed lead data for the same window and scope. Full lead-review rows are exported through `/api/leads/review.csv` rather than embedded in normal dashboard JSON. Campaign scope matches lead `utm_campaign` against the selected campaign ID plus known campaign names; duplicate campaign names are ambiguous, so raw UTM campaign names can be weaker evidence than canonical campaign IDs. Ad-group scope uses captured ad-group attribution fields when present, so missing ad-group capture means incomplete ad-group lead attribution.

Google Ads conversion rows cannot prove whether one person triggered several actions. First-party webhook data can prove that only when the website captured `session_id`, click IDs, or lead IDs and the dashboard populated `leadAttribution`.

Dashboard click details and the Overview Clicks Today KPI use aggregate Google Ads `metrics.clicks`/`keyword_view` data by date, keyword, match type, slot, and device. They are useful for click-volume inspection, not GCLID-level or person-level proof.

Offline conversion export rows are upload-ready only for `qualified` or `converted` lead sessions with at least one `gclid`, `gbraid`, or `wbraid`. Missing click IDs are counted as skipped rows, not failed conversions.

## Currency

Display currency is INR unless payload metadata says otherwise. Costs from Google Ads are micros and must be divided by `1_000_000`.
