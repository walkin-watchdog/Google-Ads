---
name: google-ads-growth-diagnosis
description: Instructions for creating evidence-based Google Ads diagnoses and proposals.
---

# Google Ads Growth Diagnosis

Use diagnoses for narrative observations and proposals for decisions.

## Diagnosis Workflow

1. Fetch relevant dashboard section with `get_dashboard_data`.
2. Fetch candidate signals with `get_candidate_signals`.
3. Cite spend, clicks, conversions, CPA/ROAS, date window, and missing data.
4. Check `leadAttribution` when first-party lead quality could change the answer.
5. Check `keywordPlanner` or call Keyword Planner MCP tools when the question is about AMS, competition, bid ranges, or new keyword discovery. Use explicit Planner seed intent: keyword-only, keyword + page URL filter, page-only URL, or entire-site domain.
6. Search semantic memory once with relevant batched scopes when human context could change the diagnosis.
7. Use `create_diagnosis` for non-actionable narrative findings.
8. Use `create_proposal` only when the user needs to choose between options.

## Proposal Workflow

For each proposal, present debating sides:

- evidence for the hypothesis,
- counter-evidence,
- risks,
- manual Google Ads steps,
- expected outcome,
- verification spec.

If the action cannot be verified later from fetched Google Ads data or first-party lead quality, use `diagnosis_only` and do not imply learning will score it.

Search semantic memory before proposal creation when account, campaign, ad-group, keyword, search-term, or related proposal context could matter. Use one batched search across relevant scopes. Treat memory as human context for framing and risk, not as performance evidence.

When first-party lead data is available, use useless, qualified open, qualified-lost, converted, journey-overlap, True CPA, Qualified CPA, and Customer CPA as evidence or counter-evidence. Impact voting can use lead-quality baseline/post windows when matched lead volume is sufficient; otherwise it falls back to Google Ads post-period metrics.

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
