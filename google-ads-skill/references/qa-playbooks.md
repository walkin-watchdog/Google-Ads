# Q&A Playbooks

## General Answer Rules

1. Use dashboard data and candidate signals.
2. Read `decisionContext` or call `get_decision_context` before proposal-style answers.
3. Cite exact metrics and date windows.
4. Separate facts from inference.
5. Name missing, stale, failed, and empty decision data.
6. Search semantic memory once with relevant batched scopes when account, proposal, campaign, ad-group, keyword, or search-term context could change the answer.
7. If creating a proposal, follow `proposal-schema.json`.

## What changed this week?

Use `dailyTrend`, `summary`, and `periodComparison`.

Report spend, conversions, CPA, ROAS when available, CTR, CPC, biggest campaign/search-term contributors, and material device/day/hour shifts when relevant.

## Why did ROAS drop?

Use:

- `campaigns`,
- `dailyTrend`,
- `conversionActions`,
- `auctionInsights`,
- `landingPages`,
- `candidateSignals`.

Debate competitor pressure, conversion tracking/mix, bidding/budget/rank, and landing page issues. Do not invent target ROAS.

## Which keywords should I pause?

Use candidate signals, keyword rows, configured keyword status, Quality Score, and `leadAttribution` when available. Only recommend a pause when enough spend/click volume exists or first-party evidence shows repeated useless leads with no qualified/converted leads. Otherwise create a watchlist or bid/match-type/eligibility debate. A `WASTED_SPEND` candidate may include a `verificationSpec` for future keyword status detection; adjust it if the proposal action differs.

## Which search terms should become negatives?

Use search-term rows, `QUERY_MISMATCH` signals, negative coverage, configured keyword coverage, row-level `leadQuality`, and first-party UTM-term quality. Debate exact negative vs phrase/root negative. Avoid broad negatives when the root may appear in qualified traffic or when `leadAttribution` shows qualified/converted leads for that term. Do not recommend adding a negative for a term already covered by an active account, campaign, ad-group, or active shared-list negative; removed shared lists and removed shared-list campaign attachments are not active coverage. If campaign/ad-group scope is unknown, only account-level negatives prove account-wide coverage.

> **Privacy caveat**: Always note that Google may hide low-volume search terms per its privacy policy. The absence of a term in the dashboard does not prove that no queries occurred for that term. Do not overstate parity with Google Ads UI, which may show rows the API omits.

> **Source coverage caveat**: Empty or failed negative/configured-keyword reports do not prove the account has no negatives or configured keywords. Check `sourceCoverage.missingSources`, `staleSources`, `failedSources`, row `sourceFreshness`, and candidate `missing_data`/`missingData`.
> A stale source is valid local data older than the dashboard stale threshold (`DASHBOARD_SOURCE_STALE_HOURS`, default 48 hours); lower confidence even when row counts look healthy.
> A failed source can come from refresh metadata or local `data/latest/source-status.json`; a failed empty file is failed data, not a loaded empty account state.

> **Read-only scope**: The dashboard has no keyword creation, negative keyword mutation, or any other account mutation controls. All search term and landing page sections are read-only reporting only.


## Which terms should I scale?

Use search-term/keyword conversion performance, configured keyword coverage, Keyword Planner AMS/competition/bid context when available, target CPA where available, impression-share constraints, and first-party qualified/converted lead quality. Debate promote-only vs promote-and-isolate. If the term is already configured but paused, removed, limited, or the wrong match type, frame the action as review/reactivation/match adjustment rather than adding a duplicate keyword.

## Which new keywords should I test?

Use `keywordPlanner.ideas` or call `keyword_planner_generate_ideas` with the right seed mode: keyword-only for current winners/high-intent search terms, keyword + `url` when a page should filter unrelated ideas, `url` for page-only discovery, or `site` for entire-site discovery. Rank by commercial intent, AMS, lower competition, reasonable bid range versus CPA economics, local `plannerScore`, `relatedSearchTermEvidence`, and `leadQualityCounterEvidence`. Mark missing Planner data explicitly; `plannerScore` is calculated locally and deterministic `PLANNER_EXPANSION` uses the same score. Do not treat campaign/ad-group/shared-list negatives as blockers for account-wide planner ideas unless the applicable scope is known.

## Where should I shift budget?

Use campaign target CPA/ROAS, lost IS budget/rank, recent trend, and `leadAttribution.byCampaign` where available. Budget increase must be staged and must not ignore tracking, landing-page, or lead-quality risks.

## Is competitor conquesting worth it?

Use competitor keyword spend, visible competitor search-term spend, conversion count, CPA, first-party lead quality when available, and Auction Insights overlap/position-above evidence. Separate `negativeCoveredSpend`, `negativeUncoveredSpend`, and unclassified competitor spend. If matching search-term rows are absent, candidate `coverage_status` is `unclassified_search_terms`, or `negativeCoverageKnown` is false, say competitor coverage is unknown instead of saying uncovered spend is zero.

## Generate proposal cards

1. Fetch candidate signals.
2. Fetch `decisionContext` or call `get_decision_context`.
3. Fetch learning priors.
4. Search semantic memory once for the relevant account, campaign, ad-group, keyword, search-term, and proposal scopes.
5. Rank by severity, spend impact, evidence quality, source freshness, learning priors, and applicable memory context.
6. Create only the top few proposals the user can act on.
7. Each option needs a proposal-specific verification spec or `diagnosis_only`; candidate `verificationSpec` is a starting point only when the proposal action matches it.

## Save proposal feedback

When the user gives proposal-specific feedback, correction, or context that should be preserved, call `create_proposal_feedback` with the proposal ID, optional option ID, feedback type, comment, and customer ID when known. Do not convert it to memory in the same step unless the user explicitly asks and the feedback is durable enough.

Review feedback with `list_proposal_feedback`. After review, mark it `reviewed`, `ignored`, or `converted_to_memory`. Use `converted_to_memory` only after `create_memory` and `store_memory_embedding` have succeeded.

## Lead quality and offline conversions

Use `leadAttribution.totals`, `byCampaign`, `bySearchTerm`, `recentLeads`, `journeySummary`, and `offlineExport`.

Separate Google Ads CPA from True CPA, Qualified CPA, and Customer CPA. For offline conversion upload readiness, count only qualified/converted leads with `gclid`, `gbraid`, or `wbraid`; skipped missing-click-ID rows are a tracking limitation, not a negative performance signal.

## Reset/Clear the dashboard

When the user asks to clear or reset all diagnostic and proposal cards from the dashboard, call `clear_proposals` and `clear_diagnoses` to empty the corresponding database tables.

## Search Terms and Landing Pages analysis

- Use `searchTerms` payload for matched keyword, match types, and match source. Always note that Google may hide low-volume rows.
- `matchedKeyword` and `searchTermMatchSource` enrich the context but may be null for some campaign types (Performance Max, Smart campaigns).
- For landing pages, use the "Landing pages" subtab for `landing_page_view.unexpanded_final_url` and the "Expanded landing pages" subtab for `expanded_landing_page_view.expanded_final_url`.
- `mobileFriendlyClicksPct`, `validAmpClicksPct`, and `speedScore` may be `null` or `n/a` when Google does not return diagnostic data for the campaign type; never treat null as "0%" or "poor". Deterministic `LANDING_PAGE_TECH_RISK` evaluates valid AMP percentage alongside mobile friendliness and speed when the field is present.
- `plannerScore` is calculated locally from search volume, competition, bid range, intent words, and account performance. Google Ads API does not return this score. Always label it as a local ranking helper when surfacing it to analysts.
- The dashboard does not have "Add as keyword", "Add as negative", or any other account mutation buttons. All reporting is read-only.
- Empty dashboard/MCP sections are valid loaded sections. For example, `candidateSignals: []` means no candidate signals in the loaded payload, not that the section is unknown. Use `sourceCoverage` to decide whether the empty data is trustworthy.
