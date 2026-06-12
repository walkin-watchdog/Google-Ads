# Dashboard Sections

## Overview

- `meta`: generated time, account ID, display currency, selected date range, and local historical CPA benchmarks.
- `decisionContext`: compact proposal-ready summary of negative rules, configured keywords, source coverage, search-term coverage, planner blocked/configured counts, and candidate signal counts.
- `sourceCoverage`: report freshness, row counts, missing/stale/failed source names, malformed-file failures, and latest refresh-run metadata when available. A source is `stale` when the file age exceeds `DASHBOARD_SOURCE_STALE_HOURS` (default 48 hours). `failedSources` can include reports that preserved stale local files after a refresh failure. Local file-only refreshes also write `data/latest/source-status.json`, so a failed first fetch remains `failed` instead of looking like a valid empty report.
- Executive KPI cards.
- Period comparison.
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
- Search terms: includes campaign/ad group IDs, current search-term status, matched keyword (`matchedKeyword`), keyword match type (`keywordMatchType`), search term match type (`searchTermMatchType`), match source (`searchTermMatchSource`), configured keyword coverage, negative coverage, decision classification, `leadQuality`, `leadQualityStatus`, `leadQualityReason`, `sourceFreshness`, and the same Keyword Planner enrichment when available. Match source values include ADVERTISER_KEYWORD, DSA, SMART_CAMPAIGN, PERFORMANCE_MAX, AI_MAX, and VERTICAL_FEED. **Google may hide low-volume queries per its privacy policy; absence of a term does not prove no queries occurred.** The dashboard is read-only — no keyword creation, negative addition, or other account mutations are available here.
- Keyword Planner: `keywordPlanner.status`, `keywordPlanner.ideas`, and `keywordPlanner.historicalMetrics` from official Google Ads Keyword Planner endpoints. Ideas include `source = "idea"` and may include `seedType` (`keyword`, `keyword_and_url`, `url`, or `site`), `seedKeywords`, `seedUrl`, and `seedSite`. Historical metric rows use `source = "historical"`. Planner rows include `blockedByNegative`, `plannerClassification`, negative coverage, configured keyword coverage, `leadQuality`, `leadQualityCounterEvidence`, `relatedSearchTermEvidence`, `sourceFreshness`, and the local `plannerScore` used by both dashboard enrichment and deterministic `PLANNER_EXPANSION` signals. `blockedByNegative` only means fetched negative coverage applies to the known scope; planner ideas without campaign scope are not suppressed by unrelated campaign/ad-group/shared-list negatives. Use Planner for keyword mining and bid/competition context, not as account performance proof.
- Attribution: conversion actions, conversion attribution, click evidence caveats, offline conversion CSV export, and `leadAttribution` when first-party website capture is active.
- First-Party Lead Quality: summary cards for deduped leads, new leads, useless leads, qualified open leads, qualified-lost terminal leads, converted customers, terminal outcomes, in-progress leads, qualified pipeline, and qualified-or-converted leads.
- Lead Journey Overlap: `leadAttribution.journeySummary` with multi-action sessions, action overlap percentages, top paths, flow edges, path outcomes, and recent session paths.
- Incoming Lead Review & Activity: `leadAttribution.recentLeads` with session key, name, email, phone, matched campaign, review status, keyword/match type, lead action path, click-ID availability, offline upload readiness, and event count.
- Lead Quality by Campaign: `leadAttribution.byCampaign` with matched campaign name, UTM campaign ID, spend, unique leads, qualified/converted/useless counts, True CPA, Qualified CPA, Converted CPA, and Customer CPA.
- Lead Quality by Search Term: `leadAttribution.bySearchTerm` with deduped status counts by captured UTM term, keyword, and match type when available.
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
- `DATA_COVERAGE_RISK.metrics.stale_sources` lists critical report files that exist and parse but are older than the dashboard stale threshold.

The Proposals tab shows only the top signals after local dashboard date filtering. Use `get_candidate_signals` for the raw latest signal set before creating proposal cards.

For MCP dashboard section calls, an empty section such as `candidateSignals: []` or `negatives: []` is valid loaded data, not an unknown section. Interpret emptiness using `sourceCoverage` and candidate `missing_data`.

## Proposals

Proposal cards are decision cards, not execution buttons.

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

Local dashboard filters do not change a proposal's evidence window. Each proposal must display its own evidence window.

## Date Range Behavior

- Standard Google Ads performance sections use the selected dashboard date range.
- First-party `leadAttribution` is also date-range aware. Local dashboard filtering rebuilds lead totals, review rows, campaign quality, search-term quality, journey summaries, and offline CSV readiness from `leadAttribution.allLeads`.
- Device, day-of-week, day/hour, search-term, landing-page, and candidate-signal displays are locally filtered/rebuilt from the full payload where possible.
- Lead campaign matching uses webhook `utm_campaign` as the Google Ads campaign ID. Campaign filtering is reliable when that ID is present; ad-group filtering is unavailable unless the webhook starts sending ad-group fields.
- Offline conversion CSV export must use the selected dashboard `startDate`/`endDate` and selected `campaignId` when a campaign filter is active.
- Quality Score snapshots, Keyword Planner data, proposals, AI diagnoses, and Auction Insights settings/status rows are not normal date-range performance tables.
