# Dashboard Sections

## Overview

- Executive KPI cards.
- Period comparison.
- Daily trend charts.
- AI diagnoses.
- Candidate signal count.

## Tables

- Campaigns: includes IDs, status, spend, CPA/ROAS, targets, impression share, lost IS.
- Ad groups: campaign/ad group performance.
- Keywords (Configured): includes campaign/ad group/criterion IDs, status (including REMOVED), Eligibility (system serving status & reasons), final URL, and standard performance metrics over the selected date range.
- Keyword Performance: includes campaign/ad group/criterion IDs for verification, and includes Keyword Planner enrichment when available: `avgMonthlySearches`, `competition`, `competitionIndex`, `lowBid`, `highBid`, `plannerScore`, and `plannerSource`.
- Negative Keywords: shows campaign and ad-group level negative keywords, where they are added, and match types.
- Search terms: includes campaign/ad group IDs, current search-term status, matched keyword (`matchedKeyword`), keyword match type (`keywordMatchType`), search term match type (`searchTermMatchType`), match source (`searchTermMatchSource`), and the same Keyword Planner enrichment when available. Match source values include ADVERTISER_KEYWORD, DSA, SMART_CAMPAIGN, PERFORMANCE_MAX, AI_MAX, and VERTICAL_FEED. **Google may hide low-volume queries per its privacy policy; absence of a term does not prove no queries occurred.** The dashboard is read-only — no keyword creation, negative addition, or other account mutations are available here.
- Keyword Planner: `keywordPlanner.status`, `keywordPlanner.ideas`, and `keywordPlanner.historicalMetrics` from official Google Ads Keyword Planner endpoints. Ideas include `source = "idea"` and may include `seedType` (`keyword`, `keyword_and_url`, `url`, or `site`), `seedKeywords`, `seedUrl`, and `seedSite`. Historical metric rows use `source = "historical"`. Status seed metadata can include keywords, URL/page seed, site seed, language, geo targets, and network. Use Planner for keyword mining and bid/competition context, not as account performance proof.
- Attribution: conversion actions, conversion attribution, click evidence caveats, offline conversion CSV export, and `leadAttribution` when first-party website capture is active.
- First-Party Lead Quality: summary cards for deduped leads, qualified open leads, qualified-lost terminal leads, converted customers, useless leads, terminal outcomes, and in-progress leads.
- Lead Journey Overlap: `leadAttribution.journeySummary` with multi-action sessions, action overlap percentages, top paths, and recent session paths.
- Incoming Lead Review & Activity: `leadAttribution.recentLeads` with name, email, phone, matched campaign, review status, keyword/match type, lead action, and event count.
- Lead Quality by Campaign: `leadAttribution.byCampaign` with matched campaign name, UTM campaign ID, spend, unique leads, qualified/converted/useless counts, True CPA, Qualified CPA, and Customer CPA.
- Lead Quality by Search Term: `leadAttribution.bySearchTerm` with deduped status counts by captured UTM term.
- Rank diagnostics: quality score, landing pages (normal unexpanded URLs and expanded final URLs in a subtab toggle), Auction Insights, and Auction Sheet Settings for persisted account/campaign/ad-group Google Sheet names.
  - **Landing pages** (`landing_page_view.unexpanded_final_url`): Final URL, campaign/ad group, spend/clicks/impressions/CTR/Avg CPC/Conv./CVR/CPA, Mobile-friendly % (click-weighted), Valid AMP % (click-weighted), Speed Score. Missing diagnostics render as `n/a`.
  - **Expanded landing pages** (`expanded_landing_page_view.expanded_final_url`): Same metrics for ValueTrack-substituted URLs. Data may be absent for campaigns without sufficient traffic.
  - URL cells link to the page in a new tab plus a PageSpeed Insights diagnostic link. No mutation buttons are present.

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

Statuses:

- `pending_review`: user needs to decide.
- `accepted`: user chose a plan; telemetry waits for proof.
- `user_marked_implemented`: user says it was done; telemetry still verifies.
- `monitoring_14`: future data confirmed the selected option and the 14-day outcome window is open.
- `monitoring_30`: the 14-day check has run and the 30-day outcome window is open.
- `completed`: learning window closed.
- `rejected` / `ignored`: no telemetry or impact vote.

Local dashboard filters do not change a proposal's evidence window. Each proposal must display its own evidence window.

## Date Range Behavior

- Standard Google Ads performance sections use the selected dashboard date range.
- First-party `leadAttribution` is also date-range aware. Local dashboard filtering rebuilds lead totals, review rows, campaign quality, search-term quality, journey summaries, and offline CSV readiness from `leadAttribution.allLeads`.
- Lead campaign matching uses webhook `utm_campaign` as the Google Ads campaign ID. Campaign filtering is reliable when that ID is present; ad-group filtering is unavailable unless the webhook starts sending ad-group fields.
- Offline conversion CSV export must use the selected dashboard `startDate`/`endDate` and selected `campaignId` when a campaign filter is active.
- Quality Score snapshots, Keyword Planner data, proposals, AI diagnoses, and Auction Insights settings/status rows are not normal date-range performance tables.
