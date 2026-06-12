# KPI Definitions

## Core Metrics

| KPI | Formula | Alert Threshold |
|-----|---------|-----------------|
| Spend | `cost_micros / 1_000_000` | — |
| Clicks | raw from API | — |
| Impressions | raw from API | — |
| CTR | `clicks / impressions` | < 2% warning, < 1% critical |
| Avg CPC | `cost / clicks` (₹) | > ₹100 warning |
| Conversions | raw from API | — |
| Conversion Rate (CVR) | `conversions / clicks` | < 2% warning |
| CPA (Cost Per Acquisition) | `cost / conversions` | > target CPA × 1.5 warning |
| Conversion Value | raw from API | — |
| ROAS | `conversion_value / cost` | < 1.0 critical |

## Derived / Composite Metrics

| KPI | Formula | Purpose |
|-----|---------|---------|
| Wasted Spend | Sum of cost for rows where conversions = 0 and clicks ≥ 3 | Identifies pure waste |
| Impression Share | raw `search_impression_share` | Budget/quality ceiling |
| Lost IS (Budget) | raw `search_budget_lost_impression_share` | Budget constraint signal |
| Lost IS (Rank) | raw `search_rank_lost_impression_share` | Quality/bid constraint signal |
| Competitor Spend Ratio | spend on competitor keywords / total spend | Competitor conquesting efficiency |

## Target CPA (Segmented)

Do NOT use a single blended Target CPA for the account. Instead, dynamically calculate historical averages per campaign category.

- **Brand Target CPA**: Calculate average CPA for campaigns containing "brand" in their name.
- **Competitor Target CPA**: Calculate average CPA for campaigns containing "comp" or "competitor" in their name.
- **Generic Target CPA**: Calculate average CPA for all other campaigns.

For proposal scoring, always compare the entity's CPA to its respective category Target CPA. Use `category Target CPA × 1.5` as the threshold for flagging high-CPA keywords and `category Target CPA × 0.5` as the threshold for scale candidates.

## SaaS Lead Quality (MQL/SQL)

Not all conversions are equal. You must prioritize High-Intent actions.

- **Primary Conversions (High-Intent)**: "Book Appointment", "Trial Signup"
- **Secondary Conversions (Low-Intent)**: Everything else

When evaluating keywords for pausing or scaling, you must verify if they are driving Primary Conversions.

## Currency & Micro Conversion

All `cost_micros` values from the API are in **micros** (1/1,000,000 of the
currency unit). Divide by `1_000_000` before display.

Display currency: **INR (₹)**
