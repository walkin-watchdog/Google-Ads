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

## Targets

Use fetched Google Ads targets only:

- `campaign.target_cpa.target_cpa_micros`
- `campaign.maximize_conversions.target_cpa_micros`
- `campaign.target_roas.target_roas`
- `campaign.maximize_conversion_value.target_roas`

If target CPA or target ROAS is missing, say it is missing. Do not invent a target from account averages. Account averages may be used only as rough context, not as a stated target.

## Auction Insights

Auction Insights are loaded from configured Google Sheets. Sheet names are saved per account, campaign, and ad group in the dashboard. If rows are missing, inspect `auctionInsightsStatus` for missing `GOOGLE_SHEETS_REFRESH_TOKEN`, missing sheet names, fetch errors, or empty sheets. Do not over-attribute account-scoped Auction Insights to one campaign.

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

`leadAttribution` metrics should be interpreted inside the selected dashboard date window. The dashboard exposes `leadAttribution.allLeads` so local filters can recompute `totals`, `byCampaign`, `bySearchTerm`, journey summaries, review rows, and offline export readiness for the active date range. Campaign-level lead metrics match `utm_campaign` to Google Ads campaign ID; do not imply ad-group lead attribution unless ad-group fields are captured by the webhook.

Google Ads conversion rows cannot prove whether one person triggered several actions. First-party webhook data can prove that only when the website captured `session_id`, click IDs, or lead IDs and the dashboard populated `leadAttribution`.

Offline conversion export rows are upload-ready only for `qualified` or `converted` lead sessions with at least one `gclid`, `gbraid`, or `wbraid`. Missing click IDs are counted as skipped rows, not failed conversions.

## Currency

Display currency is INR unless payload metadata says otherwise. Costs from Google Ads are micros and must be divided by `1_000_000`.
