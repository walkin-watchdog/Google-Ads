# Recommendation Rules

The backend now produces **candidate signals**, not final recommendations. Candidate signals are evidence inputs. The AI agent must convert them into debated proposals only when the evidence supports a decision.

## Signal Types

- `ROAS_DROP`: ROAS below configured target ROAS, or down materially versus previous period when target ROAS is missing.
- `WASTED_SPEND`: keyword/search-term spend with zero conversions after enough spend or click volume.
- `QUERY_MISMATCH`: low-intent or irrelevant query roots, first-party UTM terms with a high useless-lead rate, or learned semantic roots from repeated useless leads with no qualified pipeline counter-signal.
- `KEYWORD_SCALE`: profitable search term or keyword with room to grow; first-party qualified/converted lead quality can support the signal when present.
- `BUDGET_CONSTRAINT`: profitable campaign losing more impression share to budget than rank.
- `TRACKING_RISK`: high spend with zero conversions or conversion inconsistency.
- `LANDING_PAGE_LEAK`: URL/ad-group variant underperforms the control.
- `COMPETITOR_PRESSURE`: auction/search-term evidence shows competitor pressure or conquesting waste.
- `BIDDING_TARGET_MISSING`: bidding strategy lacks a fetched target.
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

When `leadAttribution` exists, do not rely on Google Ads conversion counts alone. Use deduped unique leads, useless leads, qualified open leads, qualified-lost leads, converted customers, True CPA, Qualified CPA, Customer CPA, and journey overlap as evidence or counter-evidence. If first-party lead data is absent, explicitly mark lead quality as missing.

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
- Keep lead-quality evidence in the same date window as the Google Ads evidence. `leadAttribution.byCampaign`, `bySearchTerm`, journey summaries, and offline CSV readiness are date-range aware; campaign matching depends on webhook `utm_campaign` carrying the Google Ads campaign ID.
- Use Keyword Planner fields as market context: high `avgMonthlySearches`, lower competition, and reasonable `lowBid`/`highBid` can support expansion priority. Do not treat Keyword Planner volume as proof that the current account can profitably scale.
- 14/30 day impact scoring can use lead-quality baseline/post windows when enough matched first-party lead volume exists. Google Ads post-period metrics remain the fallback when lead quality is insufficient. The evaluator also checks similar unchanged traffic and archived Google Ads change history. If other edits happened in the same measurement window, the result should be treated as confounded rather than a clean win/loss.

## Keyword Mining

Use three evidence layers together:

- Current performance: spend, clicks, conversions, CPA/ROAS, impression share, and lead quality.
- Search-term intent: query text, low-intent roots, competitor terms, and whether the term already exists as a keyword.
- Keyword Planner context: AMS, competition, top-of-page bid range, and related ideas generated from current keywords, search terms, a page URL seed, or an entire-site domain seed. Treat `plannerScore` as a local dashboard ranking helper, not a Google-returned metric.

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
