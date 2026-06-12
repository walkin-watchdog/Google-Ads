---
name: google-ads-growth-diagnosis
description: Instructions for analyzing Google Ads dashboard data and generating Growth Diagnoses via the create_diagnosis MCP tool.
---

# Google Ads Growth Diagnosis

As an AI agent, you have the ability to generate "Growth Diagnoses" for the user's Google Ads dashboard. These diagnoses replace the old hardcoded rule-set with intelligent, context-aware analysis.

## Workflow

1. **Fetch Data**: Use the `get_dashboard_data` MCP tool to retrieve the latest Google Ads dashboard payload.
2. **Analyze**:
   - **Wasted Spend**: Look at the `keywords` array. Identify keywords with `spend > 0` and `conversions === 0`. Calculate total wasted spend.
   - **Competitor Conquesting**: Check `searchTerms` and `keywords` for known competitors. Analyze how much is being spent on them vs the conversions they yield.
   - **Top Performers**: Sort the keywords by CPA and identify the most efficient converters.
   - **Anomalies**: Review the `dailyTrend` or `anomalies` array for unexpected spikes or drops in spend/CPA.
3. **Generate Diagnoses**: Use the `create_diagnosis` MCP tool to push your insights to the dashboard. 

## Tool Usage

Call `create_diagnosis` with a JSON payload matching this schema:
```json
{
  "id": "unique-diagnosis-id",
  "title": "💰 Wasted Spend Analysis",
  "description": "You have spent ₹15,000 on terms yielding zero conversions. The biggest offender is 'free software' (₹5,000 wasted).",
  "severity": "warning"
}
```

### Valid Severities
- `warning` (Orange) - For wasted spend or high CPA.
- `primary` (Blue) - For competitor analysis or general info.
- `success` (Green) - For top performers or positive trends.
- `danger` (Red) - For critical anomalies or major misconfigurations.
- `info` (Light Blue) - For neutral observations (like attribution data).

## Best Practices
- Always calculate the percentage of total spend for any "wasted spend" metric to give the user perspective.
- Identify specific keywords or search terms by name when highlighting top performers or wasters.
- You can create multiple diagnoses (e.g., one for waste, one for competitors, one for top performers) by calling the tool multiple times.
