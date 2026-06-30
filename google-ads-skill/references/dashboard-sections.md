# Dashboard Sections

## Overview

- `meta`: generated time, account ID, display currency, selected date range, and local historical CPA benchmarks.
- The browser initial load uses `/api/dashboard?view=overview`, a partial first-paint payload. It includes overview KPIs, trend, campaign/ad-group summaries, small SQL-aggregated device/day-of-week/day-hour segment summaries for visible overview charts, lead aggregates, filter options, coverage, and diagnoses, but intentionally omits hidden-tab datasets such as search terms, configured keywords, negatives, Keyword Planner rows, Auction Insights, quality score, landing pages, candidate signals, and proposal detail until the matching tab view is requested. Keyword view may include quality score snapshots because its visible Keyword Efficiency panel includes a Quality Score Distribution card; broader quality-score diagnostics remain in Rank.
- `decisionContext`: compact proposal-ready summary of negative rules, configured keywords, source coverage, search-term coverage, planner blocked/configured counts, and candidate signal counts.
- `sourceCoverage`: DB warehouse coverage, row counts, missing/stale/failed source names, and latest refresh-run/report-coverage metadata when available. A source is `stale` when warehouse coverage or refresh metadata exceeds `DASHBOARD_SOURCE_STALE_HOURS` (default 48 hours). `failedSources` can include reports whose previous warehouse rows were preserved after a refresh failure, so a failed first fetch remains `failed` instead of looking like a valid empty report.
- Executive KPI cards use the selected server-side `summary`, so date, campaign, and ad-group filters change these values.
- Period comparison is server-side. The default comparison and any custom comparison window should come from `/api/dashboard` slices, including first-party Real Conversions/lead totals, not browser aggregation over `dailyTrend`.
- Daily trend charts.
- AI diagnoses.
- Candidate signal count and top deterministic signals.
- Attribution capability flags for conversion actions, search-term attribution, click IDs, Auction Insights domains, and required website capture fields.

## Tables

- Campaigns: includes IDs, status, spend, CPA/ROAS, targets, impression share, lost IS.
- Ad groups: campaign/ad group performance.
- Keywords (Configured): includes campaign/ad group/criterion IDs, status (including REMOVED), Eligibility (system serving status & reasons), final URL, and standard performance metrics over the selected date range.
- Keyword Performance: includes campaign/ad group/criterion IDs for verification, and includes Keyword Planner enrichment when available: `avgMonthlySearches`, `competition`, `competitionIndex`, `lowBid`, `highBid`, `plannerScore`, and `plannerSource`.
- Negative Keywords: shows account, shared-list, campaign, and ad-group negative keywords, where they are added, match types, source level, status fields, and shared-list campaign attachments where available. Shared-list rows only count as active negative coverage when the shared list is not removed/disabled and at least one relevant campaign attachment is active.
- Search terms: includes campaign/ad group IDs, current search-term status, matched keyword (`matchedKeyword`), keyword match type (`keywordMatchType`), search term match type (`searchTermMatchType`), match source (`searchTermMatchSource`), configured keyword coverage, negative coverage, decision classification, `leadQuality`, `leadQualityStatus`, `leadQualityReason`, and the same compact Keyword Planner enrichment when available. Shared source freshness lives at `decisionInputEnrichment.sourceFreshness` and `sourceCoverage` instead of being repeated on every row. Row-level `leadQuality` is campaign-scoped when campaign identity is known; if the same search term has lead quality only in another campaign, the current campaign row should remain missing rather than inheriting it. Match source values include ADVERTISER_PROVIDED_KEYWORD, AI_MAX_BROAD_MATCH, AI_MAX_KEYWORDLESS, DYNAMIC_SEARCH_ADS, PERFORMANCE_MAX, UNKNOWN, and UNSPECIFIED. **Google may hide low-volume queries per its privacy policy; absence of a term does not prove no queries occurred.** The dashboard is read-only -- no keyword creation, negative addition, or other account mutations are available here.
- Keyword Planner: `keywordPlanner.status`, `keywordPlanner.ideas`, and `keywordPlanner.historicalMetrics` from official Google Ads Keyword Planner endpoints. Stored dashboard rows are compact: ideas include `source`, `seedType`, AMS, competition, bid range, `blockedByNegative`, `plannerClassification`, negative coverage, configured keyword coverage, optional `leadQuality`, optional `leadQualityCounterEvidence`, optional `relatedSearchTermEvidence`, and the local `plannerScore` used by both dashboard enrichment and deterministic `PLANNER_EXPANSION` signals. Full raw planner arrays such as monthly volume history, seed keyword arrays, close variants, geo targets, language, and network stay in warehouse audit storage or live Keyword Planner responses, not normal `/api/dashboard` rows. `blockedByNegative` only means fetched negative coverage applies to the known scope; planner ideas without campaign scope are not suppressed by unrelated campaign/ad-group/shared-list negatives. Use Planner for keyword mining and bid/competition context, not as account performance proof.
- Attribution: conversion actions, conversion attribution, click evidence caveats, offline conversion CSV export, lead-review CSV export, and `leadAttribution` when first-party website capture is active.
- First-Party Lead Quality: summary cards for deduped leads, new leads, useless leads, qualified open leads, qualified-lost terminal leads, converted customers, terminal outcomes, in-progress leads, qualified pipeline, and qualified-or-converted leads.
- Lead Journey Overlap: `leadAttribution.journeySummary` with multi-action sessions, action overlap percentages, top paths, flow edges, path outcomes, and recent session paths.
- Incoming Lead Review & Activity: `leadAttribution.recentLeads` with session key, name, email, phone, matched campaign, review status, keyword/match type, lead action path, click-ID availability, offline upload readiness, and event count. Full selected-window lead rows are exported from `/api/leads/review.csv`; normal `/api/dashboard` payloads intentionally do not include full `allLeads`, `filteredLeads`, or `recentSessions` arrays.
- Lead Quality by Campaign: `leadAttribution.byCampaign` with matched campaign name, UTM campaign ID, spend, unique leads, qualified/converted/useless counts, True CPA, Qualified CPA, Converted CPA, and Customer CPA.
- Lead Quality by Search Term: `leadAttribution.bySearchTerm` with deduped status counts by campaign, captured UTM term, keyword, and match type when available. Rows can include `campaignId`/`campaignName`; use those fields to keep quality evidence scoped when the same term appears in multiple campaigns.
- Rank diagnostics: quality score, landing pages (normal unexpanded URLs and expanded final URLs in a subtab toggle), Auction Insights, and Auction Sheet Settings for persisted account/campaign/ad-group Google Sheet names.
  - **Landing pages** (`landing_page_view.unexpanded_final_url`): Final URL, campaign/ad group, spend/clicks/impressions/CTR/Avg CPC/Conv./CVR/CPA, Mobile-friendly % (click-weighted), Valid AMP % (click-weighted), Speed Score. Missing diagnostics render as `n/a`.
  - **Expanded landing pages** (`expanded_landing_page_view.expanded_final_url`): Same metrics for ValueTrack-substituted URLs. Data may be absent for campaigns without sufficient traffic.
  - URL cells link to the page in a new tab plus a PageSpeed Insights diagnostic link. No mutation buttons are present.
- Device performance: spend, clicks, impressions, conversions, and CPA by device.
- Day-of-week and day/hour performance: time breakdowns for schedule analysis.
- Competitor waste/pressure: competitor keyword spend can differ from visible competitor search-term spend because Google may omit search-term rows. Use `negativeCoverageKnown`, `searchTermSpend`, `negativeCoveredSpend`, `negativeUncoveredSpend`, `competitorLeadQuality`/`leadQuality`, candidate-signal `coverage_status`, and unclassified spend context before recommending negatives. If coverage is unknown, do not describe uncovered spend as zero.

## Candidate Signals

`candidateSignals` are deterministic evidence inputs, not final recommendations. They include signal ID, type, severity, campaign ID, entity identifiers, evidence window, metrics, evidence, counter-evidence, missing data, camel-case aliases (`counterEvidence`, `missingData`), decision context/coverage, suggested `verificationSpec`/`verification_spec`, and recommended debate angles.

Important deterministic fields:

- `PLANNER_EXPANSION.metrics.planner_score` is the same local planner score shown in dashboard planner/search-term/keyword rows.
- `LANDING_PAGE_TECH_RISK.metrics.valid_amp_clicks_percentage` participates in technical risk when returned by Google.
- `COMPETITOR_PRESSURE.entity.coverage_status = "unclassified_search_terms"` means keyword-level competitor spend exists but complete matching search-term visibility is missing or hidden.
- `DATA_COVERAGE_RISK.metrics.stale_sources` lists critical warehouse sources older than the dashboard stale threshold.

The Proposals tab shows the top signals for the selected server-side dashboard filters, ordered by severity first and `generated_at` recency second. Campaign/ad-group filtered signal reads retain parent-scope rows (`campaign_id` or `ad_group_id` null) so higher-level coverage risks remain visible in selected views; inspect the signal entity before treating a parent-scope signal as proof about the selected child object. Use `get_candidate_signals` with the same date/campaign/ad-group filters before creating proposal cards.

For MCP dashboard section calls, an empty section such as `candidateSignals: []` or `negatives: []` is valid loaded data, not an unknown section. Interpret emptiness using `sourceCoverage` and candidate `missing_data`.

## Proposals

Proposal cards are decision cards, not execution buttons.

`get_proposal_context` is optimized for creating proposals around currently enabled ad groups in the selected server-side slice. It may omit paused, removed, limited, or otherwise inactive entities that still matter for historical/debug questions. When the user asks about those entities, use the relevant dashboard sections (`configuredKeywords`, `keywords`, `searchTerms`, `campaigns`, `adGroups`, `sourceCoverage`) or bounded raw GAQL with explicit dates and IDs before making absence-based claims.

Visible pending cards show:

- summary,
- evidence window,
- debated options,
- evidence/counter-evidence,
- risks,
- manual steps,
- expected outcome,
- user decision buttons.
- raw proposal feedback, if users have left comments.

Statuses:

- `pending_review`: user needs to decide.
- `accepted`: user chose a plan; telemetry waits for proof.
- `user_marked_implemented`: user says it was done; telemetry still verifies.
- `detected_implemented`: implementation was detected or normalized from older records; active telemetry normally advances to `monitoring_14`.
- `monitoring_14`: future data confirmed the selected option and the 14-day outcome window is open.
- `monitoring_30`: the 14-day check has run and the 30-day outcome window is open.
- `completed`: learning window closed.
- `expired` / `superseded`: no active decision.
- `rejected` / `ignored`: no telemetry or impact vote.

Lifecycle cards can include `impact_tracking`, `latest_impact`, and feedback rows. Impact details come from `outcome_details_14` or `outcome_details_30`; present them as observed outcomes, not causal proof.

Dashboard filters do not change a proposal's evidence window. Each proposal must display its own evidence window.

## Date Range Behavior

- Standard Google Ads performance sections use the selected dashboard date range.
- First-party `leadAttribution` is also date/campaign/ad-group-scope aware. Request the selected dashboard slice from the server so lead totals, recent review rows, campaign quality, search-term quality, journey summaries, and offline CSV readiness match the active window and filters.
- Device, day-of-week, day/hour, search-term, landing-page, and candidate-signal displays are built from the selected server-side warehouse slice, not by filtering one all-time browser payload.
- Lead campaign/ad-group matching is server-side. Campaign scope matches lead `utm_campaign` against the selected campaign ID plus known campaign names; ad-group scope matches captured ad-group attribution (`ad_group_id`/`adGroupId`/`google_ad_group_id`/`utm_ad_group`) against the selected ad-group ID plus known ad-group names. Duplicate campaign names are ambiguous, so do not overstate campaign-level attribution when only a non-unique name was captured. If the site has not captured ad-group attribution, ad-group lead totals can be incomplete.
- Offline conversion CSV export must use the selected dashboard `startDate`/`endDate` and selected `campaignId` when a campaign filter is active.
- Lead review CSV export must use `/api/leads/review.csv` with the selected `startDate`/`endDate`, `campaignId`, and `adGroupId` when filters are active. Do not expect full lead arrays in dashboard JSON for bulk export.
- Quality Score snapshots, Keyword Planner data, proposals, AI diagnoses, and Auction Insights settings/status rows are not normal date-range performance tables.

## Payload Boundaries

- Dashboard and MCP responses expose typed, whitelisted fields derived from warehouse rows.
- Partial dashboard payload views (`overview`, `performance`, `keywords`, `attribution`, `rank`, and `proposals`) omit top-level fields that are not needed by that view and are built from bounded warehouse bundles before payload construction. They must not build the full dashboard and project it afterward. Overview includes small SQL-aggregated device/day-of-week/day-hour segment summaries because those cards are visible on first paint. Keyword Discovery and Rank read aggregate rows from PostgreSQL for heavy daily tables, then apply deployment-tunable row caps (`DASHBOARD_KEYWORD_ROW_LIMIT`, `DASHBOARD_SEARCH_TERM_ROW_LIMIT`, `DASHBOARD_PLANNER_ROW_LIMIT`, `DASHBOARD_RANK_KEYWORD_ROW_LIMIT`, `DASHBOARD_RANK_SEARCH_TERM_ROW_LIMIT`, `DASHBOARD_LANDING_PAGE_ROW_LIMIT`, `DASHBOARD_AUCTION_INSIGHTS_ROW_LIMIT`, and `DASHBOARD_CANDIDATE_SIGNAL_ROW_LIMIT`). Keyword view also includes filtered quality-score snapshots for its visible distribution card and keyword enrichment; this should not trigger landing page, auction, attribution, or proposal-detail reads. Treat omitted fields as not requested, not as loaded-empty evidence. Loaded-empty arrays/objects are still interpreted through `sourceCoverage`.
- Partial browser views use lightweight lead attribution when lead data is needed: aggregate `lead_sessions`, recent lead snippets, and source freshness. Full lead-event journeys remain a full compatibility/detail path, not a prerequisite for every page load.
- Partial browser views can be served from short in-process caches after live attachment/projection, for shared base warehouse bundles, and for filter options. Warehouse-backed caches are keyed by the selected slice and warehouse watermark; repeated identical view/filter loads still check the lightweight watermark but should not rebuild warehouse bundles or live dashboard SQL while the watermark is unchanged. Proposal, diagnosis, and lead mutations clear final response caches.
- `/api/dashboard` emits `Server-Timing` phases for filter resolution, partial-view cache lookup, warehouse bundle reads, filter options, payload build, live attachment, and total dashboard build. Use these timings to identify whether a deployed slow request is DB wake/connection, warehouse SQL, JSON construction, or live attachment.
- The no-`view` `/api/dashboard` response remains the full compatibility payload for MCP/backward-compatible consumers, but browser first paint and tab switches should use partial views to reduce transfer, TTFB, and main-thread grid/chart work.
- Warehouse `raw_payload` fields are audit/debug storage only. They may support internal normalization, but raw flattened GAQL, Keyword Planner, and Auction Insights blobs must not be treated as public dashboard sections or copied into user-facing evidence.
