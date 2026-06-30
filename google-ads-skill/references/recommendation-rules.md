# Recommendation Rules

The backend now produces **candidate signals**, not final recommendations. Candidate signals are evidence inputs. The AI agent must convert them into debated proposals only when the evidence supports a decision.

## Signal Types

- `ROAS_DROP`: ROAS below configured target ROAS, or down materially versus previous period when target ROAS is missing.
- `WASTED_SPEND`: enabled keyword spend with zero effective conversions after enough spend or click volume. When primary conversion action data exists, effective conversions means primary conversions; otherwise it falls back to total Google Ads conversions.
- `QUERY_MISMATCH`: low-intent or irrelevant query roots, first-party UTM terms with a high useless-lead rate, or learned semantic roots from repeated useless leads with no qualified pipeline counter-signal.
- `KEYWORD_SCALE`: profitable search term with room to grow; first-party qualified/converted lead quality can support the signal when present.
- `BUDGET_CONSTRAINT`: Target CPA campaign where CPA is below target, budget lost IS is meaningful, and budget loss exceeds rank loss.
- `TRACKING_RISK`: high spend with zero conversions or conversion inconsistency.
- `LANDING_PAGE_LEAK`: URL/ad-group variant underperforms the control.
- `COMPETITOR_PRESSURE`: auction/search-term evidence shows competitor pressure or conquesting waste.
- `BIDDING_TARGET_MISSING`: bidding strategy lacks a fetched target.
- `QUALITY_SCORE_RISK`: low Quality Score or weak ad relevance/landing-page/expected-CTR components on meaningful traffic.
- `LANDING_PAGE_TECH_RISK`: mobile-friendliness, AMP, speed, or expanded landing-page evidence suggests a technical page issue.
- `DEVICE_SEGMENT_RISK`: device-level spend or CPA is inefficient enough to review.
- `DAYPART_SEGMENT_RISK`: day/hour spend or CPA is inefficient enough to review.
- `PLANNER_EXPANSION`: Keyword Planner idea is not configured and not blocked by fetched negatives.
- `DATA_COVERAGE_RISK`: proposal-critical data is missing, stale, empty, or failed.
- `LOW_DATA_WATCHLIST`: possible issue, but not enough volume for a hard recommendation.

## Proposal Requirements

Every proposal must present debating sides:

- hypothesis,
- recommendation,
- evidence,
- counter-evidence,
- risks,
- manual steps,
- expected outcome,
- verification spec.

Do not call this machine learning. Historical `alpha/beta` success rates are only priors from past observed outcomes.

Before creating proposals, search semantic memory once when human context could matter for the account, campaign, ad group, keyword, search term, or related proposal. Use a batched scope list and the rules in `semantic-memory.md`. Memory can change framing, risk ranking, or whether an exception applies, but it never replaces current metrics or lead-quality evidence. When memory materially changes the proposal, populate `memory_context` so the dashboard can show users what was remembered and why it mattered.

Review proposal feedback when the user has left comments on prior recommendations. Feedback is raw context until reviewed; it should influence framing only when the comment is relevant to the same account/entity or expresses a clear durable preference, constraint, correction, exception, or postmortem. Convert durable feedback to semantic memory with `source = "proposal_feedback"` and then mark the feedback `converted_to_memory`.

Before creating a proposal, read `decisionContext` or call `get_decision_context`. Check negative coverage, configured keyword coverage, `sourceCoverage`, candidate-signal `missing_data`/`missingData`, lead attribution, Keyword Planner, Auction Insights status, Quality Score, landing-page technical fields, device segments, and daypart segments as relevant. Missing, stale, or failed data must be named in evidence or counter-evidence. A `stale` source means warehouse coverage or refresh metadata is older than the dashboard stale threshold (`DASHBOARD_SOURCE_STALE_HOURS`, default 48 hours). A `failed` source comes from refresh-run/report-coverage metadata; do not treat a failed empty report as proof of no rows.

Do not propose adding a negative when `negativeCoverage.isNegativeCovered` is true. If spend continues after coverage, propose verifying scope, match type, or reporting lag instead. Shared negative list coverage requires an active shared list and an active campaign attachment; removed shared lists or removed attachments are not valid coverage. Account-wide planner ideas without campaign scope should only be called blocked when the fetched negative really applies account-wide or the idea's campaign scope is known. Do not propose adding an exact keyword when `configuredKeywordCoverage.isConfiguredKeyword` is true. If the configured keyword is paused/removed/limited, frame the option as review, re-enable, or eligibility repair.

For competitor waste, distinguish visible search-term coverage from keyword-level spend. `COMPETITOR_PRESSURE` can emit a visible classified search-term signal and a separate `coverage_status = "unclassified_search_terms"` signal with `missing_data = ["complete_search_term_visibility"]` when keyword competitor spend is not visible in search-term rows. If `negativeCoverageKnown` is false or visible search-term rows are absent, describe the spend as unclassified instead of uncovered. Do not recommend fresh competitor negatives from unclassified spend alone; first ask for source coverage/search-term verification or use a lower-confidence investigation proposal.

When `leadAttribution` exists, do not rely on Google Ads conversion counts alone. Use deduped unique leads, useless leads, qualified open leads, qualified-lost leads, converted customers, True CPA, Qualified CPA, Customer CPA, and journey overlap as evidence or counter-evidence. When using search-term lead quality, keep it scoped to the campaign/ad group returned by the dashboard; do not apply a lead-quality label from another campaign just because the term text matches. If first-party lead data is absent, explicitly mark lead quality as missing.

Candidate signals include a suggested `verificationSpec`/`verification_spec` when the deterministic signal points to a concrete observable account-state change, such as pausing a keyword, adding an exact keyword, or adding a negative for a specific search term. Treat it as a starting point, not a substitute for proposal-specific manual steps and expected outcomes. If the candidate signal's spec is `diagnosis_only`, do not invent an observable action unless your proposal has a concrete Google Ads state change to verify.

Do not create an observable action unless telemetry can verify it from future Google Ads data. If the proposal is only an investigation, use:

```json
{
  "kind": "diagnosis_only",
  "observable": false,
  "entity": {},
  "expected": {}
}
```

## ROAS Drop Debate

For `ROAS_DROP`, debate at least these causes when evidence exists:

1. Competitor pressure from Auction Insights.
2. Conversion tracking or conversion mix change.
3. Bidding, budget, rank, ad relevance, or landing-page degradation.

If target ROAS is missing, state that explicitly. Do not invent a target from account averages.

## First-Party Lead Quality

The backend can ingest website lead webhooks into `lead_events` and dedupe them into `lead_sessions`. Candidate signals may include lead-quality evidence by captured UTM term and by learned semantic roots extracted from useless lead terms.

- For `QUERY_MISMATCH`, treat a high useless-lead share as stronger evidence than zero Google Ads conversions alone.
- For learned semantic roots, require repeated first-party lead volume, a high useless rate, and no qualified/qualified-lost/converted counter-signal before proposing a phrase-match negative.
- For `KEYWORD_SCALE`, prefer terms with qualified or converted first-party leads over terms with only raw Google Ads conversions.
- Candidate-signal lead-quality maps are built from stored lead sessions and can include evidence outside the Google Ads evidence window. Before turning a lead-quality signal into a proposal, re-check date/campaign/ad-group-aware `leadAttribution.byCampaign`, campaign-scoped `bySearchTerm`, journey summaries, and offline CSV readiness for the active dashboard slice. Campaign matching accepts lead `utm_campaign` equal to the selected campaign ID or a known campaign name; duplicate campaign names are ambiguous and should lower attribution confidence. Ad-group matching is available only when the webhook captured an ad-group ID/name field.
- Use Keyword Planner fields as market context: high `avgMonthlySearches`, lower competition, reasonable `lowBid`/`highBid`, and any present `relatedSearchTermEvidence` or `leadQualityCounterEvidence` can support or reduce expansion priority. Do not treat Keyword Planner volume as proof that the current account can profitably scale.
- 14/30 day impact scoring can use lead-quality baseline/post windows when enough matched first-party lead volume exists. Google Ads post-period metrics remain the fallback when lead quality is insufficient. The evaluator also checks similar unchanged traffic and archived Google Ads change history. If other edits happened in the same measurement window, the result should be treated as confounded rather than a clean win/loss.

## Keyword Mining

Use three evidence layers together:

- Current performance: spend, clicks, conversions, CPA/ROAS, impression share, and lead quality.
- Search-term intent: query text, low-intent roots, competitor terms, whether the term is already excluded by negatives, and whether the term already exists as a configured keyword.
- Keyword Planner context: AMS, competition, top-of-page bid range, negative-blocked status, configured-keyword status, row-level `leadQuality`, optional `relatedSearchTermEvidence`, and related ideas generated from current keywords, search terms, a page URL seed, or an entire-site domain seed. Treat `plannerScore` as a local dashboard ranking helper, not a Google-returned metric. Dashboard enrichment and deterministic `PLANNER_EXPANSION` signals use the same shared scoring formula, so do not prefer a raw planner row's `plannerScore` if one appears.

For `LANDING_PAGE_TECH_RISK`, inspect `mobile_friendly_clicks_percentage`, `valid_amp_clicks_percentage`, and `speed_score` together. Null diagnostic fields mean Google did not return enough data; null is not a bad score.

When a dashboard or MCP section is present but empty, treat it as loaded empty data, not as an unknown section. Empty negatives, candidate signals, or planner rows still require `sourceCoverage` checks before making absence-based claims.

Good expansion candidates usually have clear commercial intent, enough AMS, competition/bids that fit the account CPA economics, and no first-party useless-lead warning. Low-data Planner ideas should become tests/watchlist items, not hard scale recommendations.

## User Decision Loop

The app is read-only. User decisions only record intent:

- `accepted`: user chose a plan.
- `user_marked_implemented`: user says it was already done.
- `rejected`: user disagrees.
- `ignored`: user does not want to act.

Telemetry later detects whether the selected option actually appeared in Google Ads. When detected, the proposal enters `monitoring_14`; after the 14-day check it enters `monitoring_30`; after the 30-day check it becomes `completed`.

Impact labels are explanatory, not causal proof:

- `success_high_confidence` / `failure_high_confidence`: changed item moved in the expected good/bad direction versus similar unchanged traffic, with no major confounders.
- `success_low_confidence` / `failure_low_confidence`: direction is visible, but volume, controls, or caveats lowered confidence.
- `neutral_insufficient_data`: not enough activity to judge.
- `neutral_confounded`: other Google Ads changes or overlapping proposal implementations polluted the window.
- `neutral_mixed`: Google Ads metrics, control comparison, or lead quality disagreed.

When a completed proposal produces a durable lesson that is not already captured by impact labels or strategy priors, create or update semantic memory as a `postmortem` with source `proposal_postmortem`. Scope the memory to the affected account, campaign, ad group, keyword, or search term, and store the proposal ID in `related_proposal_id`; use proposal scope only for notes about the proposal artifact itself. Store the embedding after creating the memory, and deactivate or supersede older conflicting memories instead of leaving stale guidance active.
