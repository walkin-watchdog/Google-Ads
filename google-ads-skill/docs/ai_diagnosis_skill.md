---
name: google-ads-growth-diagnosis
description: Instructions for creating evidence-based Google Ads diagnoses and proposals.
---

# Google Ads Growth Diagnosis

Use diagnoses for narrative observations and proposals for decisions.

For a new MCP session, ensure the `saas-google-ads-dashboard-analyst` skill has been confirmed through `confirm_google_ads_skill` before using dashboard, proposal, raw GAQL, refresh, memory, or mutation tools. Read tool `structuredContent`; do not depend on duplicated JSON text in `content`.

## Diagnosis Workflow

1. Fetch relevant dashboard section with `get_dashboard_data`.
2. Fetch candidate signals with `get_candidate_signals`.
3. Read `decisionContext` or call `get_decision_context` when the diagnosis could involve negatives, configured keywords, source freshness, candidate signals, planner ideas, or proposal confidence.
4. Cite spend, clicks, conversions, CPA/ROAS, date window, and missing data.
5. Check `sourceCoverage.missingSources`, `staleSources`, and `failedSources`; missing, stale, or failed warehouse sources are not evidence that risk/opportunity is absent. `staleSources` come from warehouse coverage or refresh metadata older than `DASHBOARD_SOURCE_STALE_HOURS` (default 48 hours). A failed source comes from refresh-run/report-coverage metadata, so a failed empty report is not proof of no rows.
6. Check row-level `leadQuality` and `leadQualityStatus` on `searchTerms`, `keywordPlanner`, and competitor rows when first-party lead quality could change the answer. Keep search-term lead quality scoped to its campaign/ad group; if the same term has quality evidence only in another campaign, treat the current row as missing lead quality. Use `decisionInputEnrichment.sourceFreshness` and `sourceCoverage` for shared freshness context.
7. Check `keywordPlanner` or call Keyword Planner MCP tools when the question is about AMS, competition, bid ranges, or new keyword discovery. Use explicit Planner seed intent: keyword-only, keyword + page URL filter, page-only URL, or entire-site domain. Treat `plannerScore` as the dashboard's local ranking helper, not a Google metric. Use planner `relatedSearchTermEvidence` and `leadQualityCounterEvidence` when present as context, not as proof of profitability.
8. Search semantic memory once with relevant batched scopes when human context could change the diagnosis.
9. Use `create_diagnosis` for non-actionable narrative findings.
10. Use `create_proposal` only when the user needs to choose between options.

## Proposal Workflow

For each proposal, present debating sides:

- evidence for the hypothesis,
- counter-evidence,
- risks,
- manual steps or the supported preview-confirm mutation path,
- expected outcome,
- verification spec.

If the action cannot be verified later from fetched Google Ads data or first-party lead quality, use `diagnosis_only` and do not imply learning will score it.

Candidate signals may include both snake-case and camel-case aliases: `missing_data`/`missingData`, `counter_evidence`/`counterEvidence`, and `verification_spec`/`verificationSpec`. Filtered campaign/ad-group reads may include parent-scope signals where `campaign_id` or `ad_group_id` is null; inspect the entity before applying the signal to a selected child. Use a candidate `verificationSpec` only when the proposal action matches the concrete observable account-state change; otherwise write a proposal-specific spec or use `diagnosis_only`.

Search semantic memory before proposal creation when account, campaign, ad-group, keyword, search-term, or related proposal context could matter. Use one batched search across relevant scopes. Treat memory as human context for framing and risk, not as performance evidence.

When first-party lead data is available, use new, useless, qualified open, qualified-lost, converted, journey-overlap, offline upload readiness, True CPA, Qualified CPA, and Customer CPA as evidence or counter-evidence. Impact voting can use lead-quality baseline/post windows when matched lead volume is sufficient; otherwise it falls back to Google Ads post-period metrics.

For Google Ads Data Manager pull readiness, use `offline_conversions_endpoint_status`. Basic Auth credentials are DB-backed and managed from the browser Conversions page Auth tab; do not ask the user to paste the password into chat.

Recommendations, diagnoses, and proposal creation do not execute account changes. If the user explicitly asks to make a supported change, inspect current evidence, preview with the relevant `google_ads_preview_*` tool or supported browser control, show the diff/warnings/operation count/confirmation token expiry, ask for explicit confirmation, and execute only with `google_ads_confirm_mutation`. Supported browser controls include the entity pages plus the Overview Search and Keywords shortcuts, all of which reuse the same preview-confirm flow. Supported direct changes are positive keyword add/remove, campaign/ad-group negative keyword add/remove, campaign ad schedule add/remove/replace, and campaign/ad-group pause/resume. A positive-keyword add may include one explicit user/evidence-backed HTTP(S) `finalUrl` of at most 2,048 characters; never infer it or attach it to negatives/removals. Account-level/shared-list negative creation, campaign/ad-group removal, budget/bid/ad edits, and direct offline conversion uploads are out of scope.

Raw GAQL diagnosis queries must stay bounded: include `LIMIT`, include an explicit `segments.date` filter for metric queries, narrow by campaign/ad-group/criterion when using several segments, and surface `warnings`, `truncated`, `requestId`, and `apiVersion` when relevant.

Before proposing negative keywords, verify active negative coverage. Shared-list negatives only count when the shared list and campaign attachment are active. If scope is unknown, do not treat campaign, ad-group, or shared-list negatives as account-wide coverage; only account negatives are account-wide. For Google Ads API v24 account negatives, account-level coverage comes from `customer_negative_criterion.negative_keyword_list.shared_set` attachments resolved through `shared_negative_criteria`; do not query `customer_negative_criterion.keyword.*`, `customer_negative_criterion.criterion_id`, `customer_negative_criterion.status`, or `shared_criterion.status`. If competitor keyword spend exists but matching search-term rows are absent, or a candidate signal has `coverage_status = "unclassified_search_terms"` and `missing_data` includes `complete_search_term_visibility`, describe the spend as unclassified and lower confidence instead of saying uncovered spend is zero.

Before proposing an exact keyword, verify configured keyword coverage from `configuredKeywords`, not only `keyword-performance`. If the term is already configured, frame the action as status, eligibility, match-type, or landing-page review instead of duplicate creation.

For landing-page diagnoses, evaluate mobile-friendly percentage, valid AMP percentage, and speed score together when Google returns them. Null page diagnostics mean missing diagnostic coverage, not a failed page.

## ROAS Drop

Always check:

- fetched target ROAS,
- prior-period ROAS,
- Auction Insights competitor pressure,
- conversion action mix,
- first-party lead quality when available,
- budget/rank loss,
- landing page performance.

If Auction Insights are account-scoped, state that campaign attribution is weaker.
If Auction Insights are missing, check whether `GOOGLE_SHEETS_REFRESH_TOKEN` is configured and whether the account/campaign/ad-group sheet names have been saved in the Rank tab.
When Auction Insights are present, verify `auctionInsights.meta.scope`, `requestedRange`, and `observedRange` before diagnosing pressure. Use the server's metric-specific weighted domain summaries; do not average daily percentages or combine account, campaign, and ad-group exports. Small differences from Google's unsegmented range remain possible because daily Sheets exports omit competitor-specific aggregation denominators.
