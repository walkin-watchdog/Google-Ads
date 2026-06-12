# Q&A Playbooks

## General Answer Rules

1. Use dashboard data and candidate signals.
2. Read `decisionContext` or call `get_decision_context` before proposal-style answers.
3. Cite exact metrics and date windows.
4. Separate facts from inference.
5. Name missing, stale, failed, and empty decision data.
6. Search semantic memory once with relevant batched scopes when account, proposal, campaign, ad-group, keyword, or search-term context could change the answer.
7. If creating a proposal, follow `proposal-schema.json`.

For new MCP sessions, call `confirm_google_ads_skill` before workflow tools and read `structuredContent` as the canonical tool payload. If a tool fails because of missing scope, missing skill confirmation, rate limit, or invalid raw GAQL controls, resolve that policy/input issue before drawing account conclusions.

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

For Auction Insights, verify `auctionInsights.meta.scope`, requested/observed ranges, and source status before citing competitor movement. Use the domain summaries, not counts or arithmetic averages of daily source rows. Name weighted-daily reconstruction as a limitation when comparing against an unsegmented Google Ads report.

Debate competitor pressure, conversion tracking/mix, bidding/budget/rank, and landing page issues. Do not invent target ROAS.

## Which keywords should I pause?

Use candidate signals, keyword rows, configured keyword status, Quality Score, and `leadAttribution` when available. Only recommend a pause when enough spend/click volume exists or first-party evidence shows repeated useless leads with no qualified/converted leads in the same campaign/ad-group scope. Filtered candidate-signal reads can include parent-scope account or campaign rows; inspect the signal entity before treating it as proof about the selected keyword. Otherwise create a watchlist or bid/match-type/eligibility debate. A `WASTED_SPEND` candidate may include a `verificationSpec` for future keyword status detection; adjust it if the proposal action differs.

## Which search terms should become negatives?

Use search-term rows, `QUERY_MISMATCH` signals, negative coverage, configured keyword coverage, row-level `leadQuality`, and first-party UTM-term quality. Debate exact negative vs phrase/root negative. Avoid broad negatives when the root may appear in qualified traffic or when `leadAttribution` shows qualified/converted leads for that term in the same campaign/ad-group scope. Do not borrow useless or qualified lead quality from another campaign that happens to share the same search-term text. Do not recommend adding a negative for a term already covered by an active account, campaign, ad-group, or active shared-list negative; removed shared lists and removed shared-list campaign attachments are not active coverage. If campaign/ad-group scope is unknown, only account-level negatives prove account-wide coverage.

> **Privacy caveat**: Always note that Google may hide low-volume search terms per its privacy policy. The absence of a term in the dashboard does not prove that no queries occurred for that term. Do not overstate parity with Google Ads UI, which may show rows the API omits.

> **Source coverage caveat**: Empty or failed negative/configured-keyword reports do not prove the account has no negatives or configured keywords. Check `sourceCoverage.missingSources`, `staleSources`, `failedSources`, shared `decisionInputEnrichment.sourceFreshness`, and candidate `missing_data`/`missingData`.
> A stale source has warehouse coverage or refresh metadata older than the dashboard stale threshold (`DASHBOARD_SOURCE_STALE_HOURS`, default 48 hours); lower confidence even when row counts look healthy.
> A failed source comes from refresh-run/report-coverage metadata; a failed empty report is failed data, not a loaded empty account state.

> **Mutation scope**: Reporting sections are read-only. Browser mutation controls include campaign status on Campaigns, ad group status on Ad Groups, keywords on the Keywords subtab, negative keywords on the Negative Keywords subtab, schedules on Ad Schedule, and the Overview Search/Keywords shortcuts that reuse the same preview-confirm flow. Successful execution audit rows live on Activity History. A positive-keyword add may include one explicit user/evidence-backed HTTP(S) Final URL (maximum 2,048 characters); never infer one. Offline conversion uploads are pull-CSV/API-only; the Conversions page Auth tab only manages DB-backed Basic Auth credentials for the pull endpoint. Never execute mutations without explicit user instruction, preview diff review, and confirmation token confirmation.


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

Use `get_proposal_context` for enabled ad-group proposal generation, not as proof that paused, removed, limited, or historical entities do not exist. For those questions, fetch `configuredKeywords`, `keywords`, `searchTerms`, `campaigns`, or `adGroups` sections, and use bounded raw GAQL when the dashboard section is capped or missing the specific entity.

Bounded raw GAQL means explicit `LIMIT`, explicit `segments.date` filtering for metric queries, and narrow entity filters when using multiple segments. Surface `warnings` or `truncated` from `search_search` rather than treating partial rows as complete account truth.

## Save proposal feedback

When the user gives proposal-specific feedback, correction, or context that should be preserved, call `create_proposal_feedback` with the proposal ID, optional option ID, feedback type, comment, and customer ID when known. Do not convert it to memory in the same step unless the user explicitly asks and the feedback is durable enough.

Review feedback with `list_proposal_feedback`. After review, mark it `reviewed`, `ignored`, or `converted_to_memory`. Use `converted_to_memory` only after `create_memory` and `store_memory_embedding` have succeeded.

## Lead quality and offline conversions

Use `leadAttribution.totals`, `byCampaign`, `bySearchTerm`, `recentLeads`, `journeySummary`, and `offlineExport`.

Separate Google Ads CPA from True CPA, Qualified CPA, and Customer CPA. For offline conversion upload readiness, count only qualified/converted leads with `gclid`, `gbraid`, or `wbraid`; skipped missing-click-ID rows are a tracking limitation, not a negative performance signal.

For Google Ads Data Manager pull readiness, call `offline_conversions_endpoint_status`. Basic Auth credentials come from the database and are configured, revealed, or rotated in the browser Conversions page Auth tab; do not request the password in chat.

## Reset/Clear the dashboard

When the user asks to clear or reset all diagnostic and proposal cards from the dashboard, call `clear_proposals` and `clear_diagnoses` to empty the corresponding database tables.

## Search Terms and Landing Pages analysis

- Use `searchTerms` payload for matched keyword, match types, and match source. Always note that Google may hide low-volume rows.
- `matchedKeyword` and `searchTermMatchSource` enrich the context but may be null for some campaign types (Performance Max, Smart campaigns).
- For landing pages, use the "Landing pages" subtab for `landing_page_view.unexpanded_final_url` and the "Expanded landing pages" subtab for `expanded_landing_page_view.expanded_final_url`.
- `mobileFriendlyClicksPct`, `validAmpClicksPct`, and `speedScore` may be `null` or `n/a` when Google does not return diagnostic data for the campaign type; never treat null as "0%" or "poor". Deterministic `LANDING_PAGE_TECH_RISK` evaluates valid AMP percentage alongside mobile friendliness and speed when the field is present.
- `plannerScore` is calculated locally from search volume, competition, bid range, intent words, and account performance. Google Ads API does not return this score. Always label it as a local ranking helper when surfacing it to analysts.
- Reporting grids remain read-only. The separate Overview Search chip popover can offer "Add as keyword" and campaign/ad-group "Add as negative" shortcuts, and the Overview Keywords card can offer positive-keyword add; these reuse the existing browser preview-confirm flow. Use them or MCP preview-confirm tools only after explicit user intent.
- Empty dashboard/MCP sections are valid loaded sections. For example, `candidateSignals: []` means no candidate signals in the loaded payload, not that the section is unknown. Use `sourceCoverage` to decide whether the empty data is trustworthy.

## Audience and demographic analysis

- Load the `audiences` section/view for the selected dates and exact campaign/ad-group slice. Check performance, criteria, catalogs, demographics, exclusions, and targeting settings together; a missing criterion is not proof of missing performance when source coverage is stale or failed.
- Keep campaign and ad-group ownership distinct. A criterion at one level neither duplicates nor replaces the other level.
- Interpret no explicit `AUDIENCE` target restriction as Targeting, because Google Ads defaults `bid_only` to false. Observation requires `bid_only=true`. “Observation (recommended)” is editor guidance, not a description of an absent setting.
- Explain that Targeting narrows reach, while Observation measures the selected audience without narrowing reach. Treat switching to Targeting or excluding all values in a demographic dimension as high-impact and surface the warning before confirmation.
- Use `google_ads_preview_audience_changes` only after explicit user intent. Review the exact owner, add/remove operations, mode, bid modifier, demographic selection, warnings, operation count, and expiry; then wait for explicit confirmation before `google_ads_confirm_mutation`.
- Custom-segment creation is reviewed separately from attachment. After creation succeeds, refresh the audience catalog and perform attachment as a second reviewed change.
- Recent and website-derived segment ideas are intentionally unavailable; do not imply that their absence is a data failure.
- Treat `EXTENDED_DEMOGRAPHIC` as the dashboard's normalized detailed-demographic subtype, not as a raw Google Ads v24 `CriterionType` enum. In GAQL, select `extended_demographic.extended_demographic_id` and use only valid generic criterion types in `WHERE` filters.
