# Dashboard Sections

## MCP Contract

- MCP supports only protocol `2025-11-25`; clients must initialize, send `notifications/initialized`, then call `confirm_google_ads_skill` before workflow tools.
- Backend production MCP auth uses scoped `MCP_API_KEYS_JSON`; client/proxy auth uses `MCP_API_KEY`. `SECRET_API_KEY` is not MCP auth.
- Tool outputs use `structuredContent` as the canonical payload. `content` may be only a short text summary.
- Tools are registered with schemas, scopes, risk levels, rate limits, and audit redaction. Missing scope, missing skill confirmation, rate limit, and invalid input errors are policy failures, not missing data.

## Dashboard Access and Offline Boundaries

- Named-user logins are multi-session: logging in on a second browser/device creates another independent server-side session and does not revoke the first. Password reset, user disablement, and the explicit session-revocation admin tool revoke all sessions for that named user.
- The root PWA shell and an explicit static-asset allowlist are public, but private dashboard JSON remains session protected. Service-worker registration is non-blocking, auth/dashboard requests are time-bounded, and a pending browser promise must not hold the `Opening Zenseeo` screen indefinitely.
- Private offline snapshots and queued lead labels are namespaced by named-user ID in IndexedDB. Only transport failure/timeout permits cached fallback; HTTP auth/validation responses and malformed successful responses must remain visible rather than being replaced with stale data. Local `config.js` credentials are never service-worker cached.
- The same search term can have different first-party outcomes in different campaigns. Both overview and full `leadAttribution.bySearchTerm` rows retain campaign scope; do not merge or borrow lead quality across those rows.

## Overview

- `meta`: generated time, account ID, display currency, selected date range, account start date, and local historical CPA benchmarks.
- The browser fetches `/api/dashboard/filters` for server-owned date bounds before constructing the header date picker, then initial load uses `/api/dashboard?view=overview`, a partial first-paint payload. It includes overview KPIs, trend, campaign/ad-group summaries, small SQL-aggregated device/day-of-week/day-hour segment summaries for visible overview charts, lead aggregates, filter options, coverage, and diagnoses, but intentionally omits hidden-tab datasets such as search terms, configured keywords, negatives, Keyword Planner rows, Auction Insights, quality score, landing pages, candidate signals, and proposal detail until the matching tab view is requested. Keyword view may include quality score snapshots because its visible Keyword Efficiency panel includes a Quality Score Distribution card; broader quality-score diagnostics remain in Rank.
- The Searches/Words card loads independently from authenticated, no-store `/api/dashboard/widgets/searches` calls. Searches default to 20 rows with a hard maximum of 20; Words default to 30 with a hard maximum of 40. Metric changes, conversion action/category filters, mode changes, and pagination are server-side and reset to page 1. Search rows retain bounded campaign/ad-group scopes and matched-keyword context; Word rows are aggregate discovery chips with example searches and are not direct mutation targets.
- The Keywords summary card loads independently from authenticated, no-store `/api/dashboard/widgets/keywords` calls. It reads current configured keywords joined to selected-window performance, uses server-side sorting/direction/pagination (default 5, hard maximum 20), and supports Cost, Clicks, Impressions, CTR, Avg. CPC, Conversions, Conversion rate, Cost/conv., and Search impression share. It intentionally excludes conversion value, interactions, phone calls, and keyword-by-conversion-action columns.
- `decisionContext`: compact proposal-ready summary of negative rules, configured keywords, source coverage, search-term coverage, planner blocked/configured counts, and candidate signal counts.
- `sourceCoverage`: DB warehouse coverage, row counts, missing/stale/failed source names, and latest refresh-run/report-coverage metadata when available. A source is `stale` when warehouse coverage or refresh metadata exceeds `DASHBOARD_SOURCE_STALE_HOURS` (default 48 hours). `failedSources` can include reports whose previous warehouse rows were preserved after a refresh failure, so a failed first fetch remains `failed` instead of looking like a valid empty report.
- Executive KPI cards use the selected server-side `summary`, so date, campaign, and ad-group filters change these values.
- Period comparison is server-side. The default comparison and any custom comparison window should come from `/api/dashboard` slices, including first-party Leads/lead totals, not browser aggregation over `dailyTrend`.
- Daily trend charts.
- AI diagnoses.
- Candidate signal count and top deterministic signals.
- Attribution capability flags for conversion actions, search-term attribution, aggregated keyword click details, Auction Insights domains, and required website capture fields.

## Tables

- Campaigns: includes IDs, status, spend, CPA/ROAS, targets, impression share, lost IS.
- Ad groups: campaign/ad group performance.
- Keywords (Configured): includes campaign/ad group/criterion IDs, status (including REMOVED), Eligibility (system serving status & reasons), final URL, and standard performance metrics over the selected date range.
- Keyword Performance: includes campaign/ad group/criterion IDs for verification, and includes Keyword Planner enrichment when available: `avgMonthlySearches`, `competition`, `competitionIndex`, `lowBid`, `highBid`, `plannerScore`, and `plannerSource`.
- Negative Keywords: shows account, shared-list, campaign, and ad-group negative keywords, where they are added, match types, source level, status fields, and shared-list campaign attachments where available. Shared-list rows only count as active negative coverage when the shared list is not removed/disabled and at least one relevant campaign attachment is active.
- Audiences: the `audiences` partial view joins campaign/ad-group audience performance, age/gender/household-income/parental-status performance, configured audience and demographic criteria, account/public audience catalogs, exclusions, bid adjustments, and current targeting restrictions. Campaign and ad-group criteria remain separate. An absent explicit `AUDIENCE` restriction is represented as Google Ads' actual default Targeting state, not Observation; `bidOnly=true` is Observation and `bidOnly=false` is Targeting. The editor may recommend Observation for reach-preserving measurement, but must not relabel the current state. Recent and website-derived audience ideas are intentionally omitted. Desktop exclusion rows and mobile exclusion cards are rendered from one filtered collection and share selection state, select-all behavior, review flow, and exact campaign/ad-group scope.
- Search terms: includes campaign/ad group IDs, current search-term status, matched keyword (`matchedKeyword`), keyword match type (`keywordMatchType`), search term match type (`searchTermMatchType`), match source (`searchTermMatchSource`), configured keyword coverage, negative coverage, decision classification, `leadQuality`, `leadQualityStatus`, `leadQualityReason`, and the same compact Keyword Planner enrichment when available. Shared source freshness lives at `decisionInputEnrichment.sourceFreshness` and `sourceCoverage` instead of being repeated on every row. Row-level `leadQuality` is campaign-scoped when campaign identity is known; if the same search term has lead quality only in another campaign, the current campaign row should remain missing rather than inheriting it. Match source values include ADVERTISER_PROVIDED_KEYWORD, AI_MAX_BROAD_MATCH, AI_MAX_KEYWORDLESS, DYNAMIC_SEARCH_ADS, PERFORMANCE_MAX, UNKNOWN, and UNSPECIFIED. **Google may hide low-volume queries per its privacy policy; absence of a term does not prove no queries occurred.** Ordinary reporting grids remain read-only; supported Overview Search chips may open the existing preview-confirm controls for positive or campaign/ad-group negative keyword adds.
- Keyword Planner: `keywordPlanner.status`, `keywordPlanner.ideas`, and `keywordPlanner.historicalMetrics` from official Google Ads Keyword Planner endpoints. Stored dashboard rows are compact: ideas include `source`, `seedType`, AMS, competition, bid range, `blockedByNegative`, `plannerClassification`, negative coverage, configured keyword coverage, optional `leadQuality`, optional `leadQualityCounterEvidence`, optional `relatedSearchTermEvidence`, and the local `plannerScore` used by both dashboard enrichment and deterministic `PLANNER_EXPANSION` signals. Full raw planner arrays such as monthly volume history, seed keyword arrays, close variants, geo targets, language, and network stay in warehouse audit storage or live Keyword Planner responses, not normal `/api/dashboard` rows. `blockedByNegative` only means fetched negative coverage applies to the known scope; planner ideas without campaign scope are not suppressed by unrelated campaign/ad-group/shared-list negatives. Use Planner for keyword mining and bid/competition context, not as account performance proof.
- Attribution: conversion actions, conversion attribution, aggregated keyword/date/slot/device click details, offline conversion CSV export, lead-review CSV export, Basic Auth credential management for the Google Ads Data Manager pull endpoint, and `leadAttribution` when first-party website capture is active. Conversion-attributed search-term warehouse rows preserve matched keyword text and match type in their identity alongside scope, date, search term, conversion action, and category so distinct aggregate rows are not overwritten.
- First-Party Lead Quality: summary cards for deduped leads, new leads, useless leads, qualified open leads, qualified-lost terminal leads, converted customers, terminal outcomes, in-progress leads, qualified pipeline, and qualified-or-converted leads.
- Lead Journey Overlap: `leadAttribution.journeySummary` with multi-action sessions, action overlap percentages, top paths, flow edges, path outcomes, and recent session paths.
- Incoming Lead Review & Activity: `leadAttribution.recentLeads` with session key, name, email, phone, matched campaign, review status, keyword/match type, lead action path, click-ID availability, offline upload readiness, event count, and `updatedAt` for optimistic offline-label conflict detection. `pendingSync` is a browser-only presentation state and is not server evidence. Full selected-window lead rows are exported from `/api/leads/review.csv`; normal `/api/dashboard` payloads intentionally do not include full `allLeads`, `filteredLeads`, or `recentSessions` arrays.
- Lead Quality by Campaign: `leadAttribution.byCampaign` with matched campaign name, UTM campaign ID, spend, unique leads, qualified/converted/useless counts, True CPA, Qualified CPA, Converted CPA, and Customer CPA.
- Lead Quality by Search Term: `leadAttribution.bySearchTerm` with deduped status counts by campaign, captured UTM term, keyword, and match type when available. Rows can include `campaignId`/`campaignName`; use those fields to keep quality evidence scoped when the same term appears in multiple campaigns.
- Rank diagnostics: quality score, landing pages (normal unexpanded URLs and expanded final URLs in a subtab toggle), Auction Insights, and Auction Sheet Settings for persisted account/campaign/ad-group Google Sheet names.
  - **Auction Insights**: `auctionInsights.meta` states the exact selected scope, requested/observed date ranges, daily source-row count, domain count, prior comparison availability, suppression handling, and aggregation method. `auctionInsights.rows` contains one summary per advertiser ordered by impression share; `trend` contains You plus the four largest rivals; `highlights` contains absolute-top leaders, overlap leaders, and entrants/exits. The browser does not receive or render the raw daily row table.
  - **Landing pages** (`landing_page_view.unexpanded_final_url`): Final URL, campaign/ad group, spend/clicks/impressions/CTR/Avg CPC/Conv./CVR/CPA, Mobile-friendly % (click-weighted), Valid AMP % (click-weighted), Speed Score. Missing diagnostics render as `n/a`.
  - **Expanded landing pages** (`expanded_landing_page_view.expanded_final_url`): Same metrics for ValueTrack-substituted URLs. Data may be absent for campaigns without sufficient traffic.
  - URL cells link to the page in a new tab plus a PageSpeed Insights diagnostic link. No mutation buttons are present.
- Device performance: spend, clicks, impressions, conversions, and CPA by device.
- Day-of-week and day/hour performance: time breakdowns for schedule analysis.
- Competitor waste/pressure: competitor keyword spend can differ from visible competitor search-term spend because Google may omit search-term rows. Use `negativeCoverageKnown`, `searchTermSpend`, `negativeCoveredSpend`, `negativeUncoveredSpend`, `competitorLeadQuality`/`leadQuality`, candidate-signal `coverage_status`, and unclassified spend context before recommending negatives. If coverage is unknown, do not describe uncovered spend as zero.
- Controls and mutation surfaces: browser preview-confirm-execute controls are distributed by entity. Campaign status controls live inline on the `Campaigns` page status column; ad group status controls live inline on the `Ad Groups` page status column. Keyword add/remove controls live in the `Keywords` table card under the `Keywords` subtab on the `Keywords` page; negative keyword add/remove controls live in the `Negative Keywords` table card on that same page. The configured Keywords grid hides rows carrying Google Ads' `AD_GROUP_REMOVED` primary-status reason by default to keep inactive parent entities from overwhelming daily management; the explicit “Show removed ad groups” control restores them without changing payload contents, sorting semantics, or saved evidence. The Audiences page reviews exact-scope segment additions/removals, supported exclusions, demographic exclusions, bid modifiers, targeting mode, and separate custom-segment creation. It validates current Google Ads state again at confirmation; custom-segment creation cannot be atomically attached and therefore uses a separate reviewed operation. Ad schedule controls live on a dedicated `Ad Schedule` page and support edit by removing the old criterion and creating the new schedule criteria during confirmation. Schedule day presets expand into individual days; when the proposed interval overlaps existing schedules for any selected day, the dashboard requires the operator to either replace the existing conflicting schedules or keep them and skip the overlapping proposed days before preview. Successfully executed mutation history is available on the `Activity History` page. Keyword, negative, schedule, and activity rows use the standard dashboard grid/search/save/load pattern. The Conversions page Auth tab manages DB-backed Basic Auth credentials for `/api/analytics/offline-conversions.csv`; offline conversion uploads still remain pull-CSV/API-only, not direct Google Ads mutations. Preview routes return a diff, warnings, operation summary, confirmation token, and expiry; preview state is transient and is not shown in Activity History. Confirm execution requires the same token and the backend `GOOGLE_ADS_MUTATIONS_ENABLED=true` flag, and only successful executions are persisted. Shared-list/account-level negative creation remains read-only coverage in this phase.
- Overview mutation shortcuts reuse those controls: the Keywords card opens positive-keyword preview, while Search chips can open positive- or campaign/ad-group negative-keyword preview. A selected ad-group filter preselects scope; account-level use requires an explicit ad group for a positive keyword or campaign/ad group for a negative. Positive-keyword adds may carry one optional explicit HTTP(S) Final URL (maximum 2,048 characters), which must appear in the preview diff and must not be inferred by the dashboard.

## Candidate Signals

`candidateSignals` are deterministic evidence inputs, not final recommendations. They include signal ID, type, severity, campaign ID, entity identifiers, evidence window, metrics, evidence, counter-evidence, missing data, camel-case aliases (`counterEvidence`, `missingData`), decision context/coverage, suggested `verificationSpec`/`verification_spec`, and recommended debate angles.

Important deterministic fields:

- `PLANNER_EXPANSION.metrics.planner_score` is the same local planner score shown in dashboard planner/search-term/keyword rows.
- `LANDING_PAGE_TECH_RISK.metrics.valid_amp_clicks_percentage` participates in technical risk when returned by Google.
- `COMPETITOR_PRESSURE.entity.coverage_status = "unclassified_search_terms"` means keyword-level competitor spend exists but complete matching search-term visibility is missing or hidden.
- `DATA_COVERAGE_RISK.metrics.stale_sources` lists critical warehouse sources older than the dashboard stale threshold.

The Proposals tab shows the top signals for the selected server-side dashboard filters, ordered by severity first and `generated_at` recency second. Campaign/ad-group filtered signal reads retain parent-scope rows (`campaign_id` or `ad_group_id` null) so higher-level coverage risks remain visible in selected views; inspect the signal entity before treating a parent-scope signal as proof about the selected child object. Use `get_candidate_signals` with the same date/campaign/ad-group filters before creating proposal cards.

For MCP dashboard section calls, an empty section such as `candidateSignals: []` or `negatives: []` is valid loaded data, not an unknown section. Interpret emptiness using `sourceCoverage` and candidate `missing_data`.

MCP `tools/list` may be paginated. Do not assume a tool is absent until all pages are read or the client has resolved the registry entry.

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
- `GOOGLE_ADS_WAREHOUSE_START_DATE` is treated as the account start date. `/api/dashboard/filters`, `/api/dashboard` `meta.accountStartDate`, and `filterOptions.accountStartDate` expose it server-side; do not rely on browser `config.js` for this value.
- The browser header picker disables dates before `accountStartDate`. Its "All Time" preset selects `accountStartDate` through the browser-local current date, inclusive.
- MCP dashboard tools accept `dateRangePreset: "all_time"` to select `accountStartDate` through the server current date, inclusive. Use explicit `startDate`/`endDate` for any other range.
- First-party `leadAttribution` is also date/campaign/ad-group-scope aware. Request the selected dashboard slice from the server so lead totals, recent review rows, campaign quality, search-term quality, journey summaries, and offline CSV readiness match the active window and filters.
- Device, day-of-week, day/hour, search-term, landing-page, and candidate-signal displays are built from the selected server-side warehouse slice, not by filtering one all-time browser payload.
- Auction Insights is also selected server-side by `auction_date` and one exact hierarchy scope. Account selection reads only account exports; campaign selection reads only that campaign export; ad-group selection reads only that ad-group export. The browser's recent preset uses the last seven completed days so it aligns with Google's "last seen days" convention instead of including the current partial day.
- Lead campaign/ad-group matching is server-side. Campaign scope matches lead `utm_campaign` against the selected campaign ID plus known campaign names; ad-group scope matches captured ad-group attribution (`ad_group_id`/`adGroupId`/`google_ad_group_id`/`utm_ad_group`) against the selected ad-group ID plus known ad-group names. Duplicate campaign names are ambiguous, so do not overstate campaign-level attribution when only a non-unique name was captured. If the site has not captured ad-group attribution, ad-group lead totals can be incomplete.
- Offline conversion CSV export must use the selected dashboard `startDate`/`endDate` and selected `campaignId` when a campaign filter is active.
- The Google Ads Data Manager pull endpoint `/api/analytics/offline-conversions.csv` uses HTTP Basic Auth credentials stored in the database. Check `offline_conversions_endpoint_status` for readiness; configure, reveal, or rotate credentials from the browser Conversions page Auth tab.
- Lead review CSV export must use `/api/leads/review.csv` with the selected `startDate`/`endDate`, `campaignId`, and `adGroupId` when filters are active. Do not expect full lead arrays in dashboard JSON for bulk export.
- Quality Score snapshots, Keyword Planner data, proposals, AI diagnoses, and Auction Insights settings/status rows are not normal date-range performance tables.

## Payload Boundaries

- Dashboard and MCP responses expose typed, whitelisted fields derived from warehouse rows.
- The Overview widget endpoints are bounded browser support payloads, not additions to `/api/dashboard?view=overview` and not MCP section names. `/api/dashboard/widgets/searches` caps Searches at 20 and Words at 40 rows; `/api/dashboard/widgets/keywords` caps keyword rows at 20. All sorting and pagination happen in PostgreSQL before response construction.
- Partial dashboard payload views (`overview`, `performance`, `keywords`, `audiences`, `attribution`, `rank`, and `proposals`) omit top-level fields that are not needed by that view and are built from bounded warehouse bundles before payload construction. They must not build the full dashboard and project it afterward. Audiences reads only its base snapshot plus audience performance, demographics, criteria, and catalogs. Overview includes small SQL-aggregated device/day-of-week/day-hour segment summaries because those cards are visible on first paint. Keywords and Rank read aggregate rows from PostgreSQL for heavy daily tables, then apply deployment-tunable row caps (`DASHBOARD_KEYWORD_ROW_LIMIT`, `DASHBOARD_SEARCH_TERM_ROW_LIMIT`, `DASHBOARD_PLANNER_ROW_LIMIT`, `DASHBOARD_RANK_KEYWORD_ROW_LIMIT`, `DASHBOARD_RANK_SEARCH_TERM_ROW_LIMIT`, `DASHBOARD_LANDING_PAGE_ROW_LIMIT`, and `DASHBOARD_CANDIDATE_SIGNAL_ROW_LIMIT`). Auction Insights instead reads every row in the exact selected scope/date slice and collapses them server-side to a small domain summary; there is no alphabetical row cap and no daily Auction grid in the payload. Keyword view also includes filtered quality-score snapshots for its visible distribution card and keyword enrichment; this should not trigger landing page, auction, attribution, or proposal-detail reads. Treat omitted fields as not requested, not as loaded-empty evidence. Loaded-empty arrays/objects are still interpreted through `sourceCoverage`.
- Partial browser views use lightweight lead attribution when lead data is needed: aggregate `lead_sessions`, recent lead snippets, and source freshness. Full lead-event journeys remain a full compatibility/detail path, not a prerequisite for every page load.
- Partial browser views can be served from short in-process caches after live attachment/projection, for shared base warehouse bundles, and for filter options. Warehouse-backed caches are keyed by the selected slice and warehouse watermark; repeated identical view/filter loads still check the lightweight write-maintained slice fingerprint watermark but should not rebuild warehouse bundles or live dashboard SQL while the watermark is unchanged. Proposal, diagnosis, lead, and confirmed Google Ads mutation changes clear final response caches.
- `/api/dashboard` emits `Server-Timing` phases for filter resolution, partial-view cache lookup, warehouse bundle reads, filter options, payload build, live attachment, and total dashboard build. Use these timings to identify whether a deployed slow request is DB wake/connection, warehouse SQL, JSON construction, or live attachment.
- The no-`view` `/api/dashboard` response remains the full compatibility payload for MCP/backward-compatible consumers, but browser first paint and tab switches should use partial views to reduce transfer, TTFB, and main-thread grid/chart work.
- Warehouse `raw_payload` fields are audit/debug storage only. They may support internal normalization, but raw flattened GAQL, Keyword Planner, and Auction Insights blobs must not be treated as public dashboard sections or copied into user-facing evidence.
