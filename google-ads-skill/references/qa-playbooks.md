# Q&A Playbooks

## General Answer Rules

1. Use dashboard data and candidate signals.
2. Cite exact metrics and date windows.
3. Separate facts from inference.
4. Name missing data.
5. Search semantic memory once with relevant batched scopes when account, proposal, campaign, ad-group, keyword, or search-term context could change the answer.
6. If creating a proposal, follow `proposal-schema.json`.

## What changed this week?

Use `dailyTrend`, `summary`, and `periodComparison`.

Report spend, conversions, CPA, ROAS when available, CTR, CPC, and biggest campaign/search-term contributors.

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

Use candidate signals, keyword rows, and `leadAttribution` when available. Only recommend a pause when enough spend/click volume exists or first-party evidence shows repeated useless leads with no qualified/converted leads. Otherwise create a watchlist or bid/match-type debate.

## Which search terms should become negatives?

Use search-term rows, `QUERY_MISMATCH` signals, and first-party UTM-term quality. Debate exact negative vs phrase/root negative. Avoid broad negatives when the root may appear in qualified traffic or when `leadAttribution` shows qualified/converted leads for that term.

## Which terms should I scale?

Use search-term/keyword conversion performance, Keyword Planner AMS/competition/bid context when available, target CPA where available, impression-share constraints, and first-party qualified/converted lead quality. Debate promote-only vs promote-and-isolate.

## Which new keywords should I test?

Use `keywordPlanner.ideas` or call `keyword_planner_generate_ideas` with the right seed mode: keyword-only for current winners/high-intent search terms, keyword + `url` when a page should filter unrelated ideas, `url` for page-only discovery, or `site` for entire-site discovery. Rank by commercial intent, AMS, lower competition, reasonable bid range versus CPA economics, and lead-quality risk. Mark missing Planner data explicitly.

## Where should I shift budget?

Use campaign target CPA/ROAS, lost IS budget/rank, recent trend, and `leadAttribution.byCampaign` where available. Budget increase must be staged and must not ignore tracking, landing-page, or lead-quality risks.

## Is competitor conquesting worth it?

Use competitor search-term spend, conversion count, CPA, first-party lead quality when available, and Auction Insights overlap/position-above evidence.

## Generate proposal cards

1. Fetch candidate signals.
2. Fetch learning priors.
3. Search semantic memory once for the relevant account, campaign, ad-group, keyword, search-term, and proposal scopes.
4. Rank by severity, spend impact, evidence quality, learning priors, and applicable memory context.
5. Create only the top few proposals the user can act on.
6. Each option needs a verification spec or `diagnosis_only`.

## Reset/Clear the dashboard

When the user asks to clear or reset all diagnostic and proposal cards from the dashboard, call `clear_proposals` and `clear_diagnoses` to empty the corresponding database tables.
