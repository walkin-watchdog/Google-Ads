# Q&A Playbooks

## How to Answer User Questions

When the user asks a question, follow these steps:

1. **Parse intent** — Map the question to one or more named reports from `reports.yml`.
2. **Fetch data** — Use the `search_search` tool to pull live data directly via the custom MCP.
3. **Analyze** — Apply the relevant recommendation rules and KPI definitions.
4. **Respond** — Answer with specific numbers, not generic advice.
5. **Generate proposals** — If the analysis reveals actionable items, use the `create_proposal` tool to save them to the database.

---

## Playbook: "What changed this week?"

**Reports:** `daily_trend`, `account_summary` (current vs previous period)

**Analysis:**
- Compare last 7 days vs prior 7 days
- Highlight: spend delta, CPA delta, conversion delta, CPC delta, CTR delta
- Flag any metric that changed > 20%

**Response format:**
> This week (Jun 5–11) vs last week (May 28–Jun 4):
> - Spend: ₹X → ₹Y (▲/▼ Z%)
> - CPA: ₹X → ₹Y (▲/▼ Z%)
> ...

---

## Playbook: "Why did CPA increase?"

**Reports:** `keyword_performance`, `search_term_performance`, `daily_trend`

**Analysis:**
1. Find the day(s) CPA spiked
2. Identify which keywords or search terms drove spend on those days
3. Check if new low-intent search terms appeared
4. Check if a high-CPA competitor keyword consumed disproportionate budget

**Response format:**
> CPA increased from ₹X to ₹Y (+Z%) primarily because:
> 1. [keyword] spent ₹N with 0 conversions
> 2. New search term "[term]" triggered ₹N in spend

---

## Playbook: "Which keywords should I pause?"

**Reports:** `keyword_performance`

**Analysis:** Apply Rule 1 (Pause Keyword Candidate) from recommendation-rules.md

**Response format:**
> Recommended pause candidates:
> | Keyword | Spend | Clicks | Conv | CPA |
> |---------|-------|--------|------|-----|
> | ...     | ...   | ...    | ...  | ... |

---

## Playbook: "Which keywords should I scale?"

**Reports:** `keyword_performance`, `campaign_performance`

**Analysis:** Apply Rule 3 (Scale Keyword Candidate)

---

## Playbook: "Which search terms should I add as negatives?"

**Reports:** `search_term_performance`

**Analysis:** Apply Rule 2 (Negative Keyword Candidate)

---

## Playbook: "Where should I shift budget?"

**Reports:** `campaign_performance`, `keyword_performance`

**Analysis:**
- Find campaigns/keywords with CPA < target and room to grow (low IS)
- Find campaigns/keywords with CPA > target × 2 (candidates for reduction)

---

## Playbook: "Is competitor conquesting worth it?"

**Reports:** `keyword_performance`, `search_term_performance`

**Analysis:**
- Sum spend on competitor brand keywords (aisensy, wati, interakt, etc.)
- Calculate competitor conquesting CPA vs non-competitor CPA
- Compare conversion rates

---

## Playbook: "Generate proposal cards for the top N fixes"

**Reports:** All relevant reports

**Analysis:**
1. Run all recommendation rules
2. Score and rank by spend impact
3. Generate top N proposal JSON files
4. Confirm to user

---


## Playbook: "Where is the conversion exactly coming from (which keyword/search term)?"

**Reports:** `conversion_attribution_by_search_term`, `keyword_performance`

**Analysis:**
- Look at the `conversion_attribution_by_search_term` data (available in `conversionAttribution` payload).
- Identify which exact search term and keyword drove the conversions.
- Summarize the specific conversion actions and categories that were recorded.

**Response format:**
> Your conversions today were driven by the search term "[term]" matching the keyword "[keyword]".
> Specifically, this drove X [Category] conversions (e.g. "Book appointment").

---

## Playbook: "Did a single click lead to multiple conversions?"

**Analysis:**
- Due to Google Ads privacy constraints and the inability to join `metrics.conversions` with `click_view` (GCLIDs) securely, it is impossible to definitively prove that a single click resulted in multiple conversions using only Google Ads dashboard data.
- Do NOT guess or hallucinate user sessions based purely on shared Dates and Keywords.

**Response format:**
> Due to Google Ads privacy limitations, we cannot definitively trace multiple conversion actions back to a single specific click (GCLID) without joining offline CRM data (like HubSpot or Salesforce). While we can see multiple conversions on the same day for the same keyword, assuming they came from one click is unreliable.

---

## Playbook: "How much share are we taking and why are we losing share?"

**Reports:** `campaign_performance`, `keyword_performance`

**Analysis:**
- Look at `metrics.search_impression_share` for the campaign or specific keywords.
- To calculate total eligible Search Volume, divide `impressions` by `search_impression_share` (e.g. 243 impr / 0.3051 share = ~796 total searches).
- Compare `metrics.search_budget_lost_impression_share` (Lost IS Budget) vs `metrics.search_rank_lost_impression_share` (Lost IS Rank).
- If Lost IS Budget is high, recommend increasing budget.
- If Lost IS Rank is high, recommend improving Quality Score (Ad Relevance, Landing Page Experience).

**Response format:**
> Currently, you are capturing X% of the available impression share for "[Campaign/Keyword]".
> Based on your impressions, the total search volume is approximately [Volume].
> You are losing Y% due to Budget (your daily budget runs out) and Z% due to Rank (your bids or quality score are too low).
> To capture more share, you should [increase budget / improve ad relevance].

