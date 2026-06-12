---
name: google-ads-growth-diagnosis
description: Instructions for creating evidence-based Google Ads diagnoses and proposals.
---

# Google Ads Growth Diagnosis

Use diagnoses for narrative observations and proposals for decisions.

## Diagnosis Workflow

1. Fetch relevant dashboard section with `get_dashboard_data`.
2. Fetch candidate signals with `get_candidate_signals`.
3. Read `decisionContext` or call `get_decision_context` when the diagnosis could involve negatives, configured keywords, source freshness, candidate signals, planner ideas, or proposal confidence.
4. Cite spend, clicks, conversions, CPA/ROAS, date window, and missing data.
5. Check `sourceCoverage.missingSources`, `staleSources`, and `failedSources`; missing, stale, or failed sources are not evidence that risk/opportunity is absent. `staleSources` are valid local files older than `DASHBOARD_SOURCE_STALE_HOURS` (default 48 hours). A failed source can come from refresh-run metadata or local `data/latest/source-status.json`, so a failed empty report is not proof of no rows.
6. Check row-level `leadQuality`, `leadQualityStatus`, and `sourceFreshness` on `searchTerms`, `keywordPlanner`, and competitor rows when first-party lead quality could change the answer.
7. Check `keywordPlanner` or call Keyword Planner MCP tools when the question is about AMS, competition, bid ranges, or new keyword discovery. Use explicit Planner seed intent: keyword-only, keyword + page URL filter, page-only URL, or entire-site domain. Treat `plannerScore` as the dashboard's local ranking helper, not a Google metric. Use planner `relatedSearchTermEvidence` and `leadQualityCounterEvidence` as context, not as proof of profitability.
8. Search semantic memory once with relevant batched scopes when human context could change the diagnosis.
9. Use `create_diagnosis` for non-actionable narrative findings.
10. Use `create_proposal` only when the user needs to choose between options.

## Proposal Workflow

For each proposal, present debating sides:

- evidence for the hypothesis,
- counter-evidence,
- risks,
- manual Google Ads steps,
- expected outcome,
- verification spec.

If the action cannot be verified later from fetched Google Ads data or first-party lead quality, use `diagnosis_only` and do not imply learning will score it.

Candidate signals may include both snake-case and camel-case aliases: `missing_data`/`missingData`, `counter_evidence`/`counterEvidence`, and `verification_spec`/`verificationSpec`. Use a candidate `verificationSpec` only when the proposal action matches the concrete observable account-state change; otherwise write a proposal-specific spec or use `diagnosis_only`.

Search semantic memory before proposal creation when account, campaign, ad-group, keyword, search-term, or related proposal context could matter. Use one batched search across relevant scopes. Treat memory as human context for framing and risk, not as performance evidence.

When first-party lead data is available, use new, useless, qualified open, qualified-lost, converted, journey-overlap, offline upload readiness, True CPA, Qualified CPA, and Customer CPA as evidence or counter-evidence. Impact voting can use lead-quality baseline/post windows when matched lead volume is sufficient; otherwise it falls back to Google Ads post-period metrics.

Before proposing negative keywords, verify active negative coverage. Shared-list negatives only count when the shared list and campaign attachment are active. If scope is unknown, do not treat campaign, ad-group, or shared-list negatives as account-wide coverage; only account negatives are account-wide. If competitor keyword spend exists but matching search-term rows are absent, or a candidate signal has `coverage_status = "unclassified_search_terms"` and `missing_data` includes `complete_search_term_visibility`, describe the spend as unclassified and lower confidence instead of saying uncovered spend is zero.

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
